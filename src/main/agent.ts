import { randomUUID } from 'node:crypto'
import { mergeModelParams, type ActivityPhase, type AgentActivity, type AgentMode, type AssistantMessage, type Message, type MessageCard, type MessageImage, type PendingApproval, type PendingQuestion, type Settings, type SkillDetail, type SkillMeta, type StreamDelta, type Thread, type TodoItem, type ToolCall, type ToolResult } from '../shared/schema'
import { estimateTokens, historyTokens } from '../shared/tokens'
import { fitContext } from './context'
import { describeError } from './errors'
import { isContextOverflowError, streamChat, type ToolSpec } from './llm'
import { buildSystemPrompt } from './prompt'
import { nextNoToolStep, resolveLoopPolicy } from './loopPolicy'
import { ensureProjectFiles, PROJECT_FILES, readProjectFiles, renderProjectContext } from './projectFiles'
import type { SecretStore } from './secrets'
import type { StateStore } from './store'
import { commandTools, delegateTools, extensionToolNames, interactiveTools, matchesCommandRule, mutatingTools, runTool, sensitiveExtensionTools, summarizeCall, todoTools, toolSpecs } from './tools'
import { browserEngine } from './browser'
import { subagentRoles, type SubagentRun } from '../shared/schema'

interface SubagentTask {
  id: string
  name: string
  instruction: string
  role: SubagentRun['role']
  modelId: string
  toolAccess: 'read-only' | 'project'
}

export interface ExtensionRunner {
  specs(settings: Settings, mode?: AgentMode): ToolSpec[]
  run(call: ToolCall, context: { root: string; signal: AbortSignal; threadId?: string }): Promise<{ output: string; image?: string }>
}

interface Run {
  controller: AbortController
  approvalQueue?: Promise<void>
  approval?: { callId: string; resolve: (approved: boolean) => void }
  question?: { callId: string; resolve: (answer: string | null) => void }
  /** 一次性指令（如技能全文）：仅随本轮第一次请求发送，消费后置空，不写入历史 */
  instruction?: string
  outcome: { ok: boolean; cancelled?: boolean; error?: string; lastText: string }
  settled: Promise<void>
  settle: () => void
}

export interface NodeMeta {
  index: number
  total: number
  title: string
  attempt: number
  card?: MessageCard
}

export interface NodeRunOutcome {
  ok: boolean
  cancelled?: boolean
  error?: string
  output?: string
}

function createRun(): Run {
  let settle = (): void => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  return { controller: new AbortController(), outcome: { ok: true, lastText: '' }, settled, settle }
}

interface Decision {
  approved: boolean
  reason?: string
}

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '（待办清单为空）'
  const mark = { done: '[x]', active: '[~]', pending: '[ ]' } as const
  const doneCount = todos.filter((item) => item.status === 'done').length
  const lines = todos.map((item, i) => `${mark[item.status]} ${i + 1}. ${item.content}`)
  return `待办进度 ${doneCount}/${todos.length}：\n${lines.join('\n')}`
}

function isProjectFileEdit(call: ToolCall): boolean {
  const path = typeof call.args.path === 'string' ? call.args.path.replace(/\\/g, '/').replace(/^\.\//, '') : ''
  return (PROJECT_FILES as readonly string[]).includes(path)
}

export class AgentRunner {
  private runs = new Map<string, Run>()

  constructor(
    private readonly store: StateStore,
    private readonly secrets: SecretStore,
    private readonly emitDelta: (delta: StreamDelta) => void,
    private readonly onUsage: (usage: { input: number; output: number; modelId?: string }) => Promise<void> = async () => undefined,
    private readonly extensions?: ExtensionRunner,
    private readonly emitActivity: (activity: AgentActivity) => void = () => undefined,
    private readonly skills?: { list: () => Promise<SkillMeta[]>; read: (id: string) => Promise<SkillDetail> },
  ) {}

  private activity(threadId: string, phase: ActivityPhase, label: string, extra?: { detail?: string; step?: number; agents?: string[] }): void {
    try {
      this.emitActivity({ threadId, phase, label, ...(extra?.detail ? { detail: extra.detail } : {}), ...(typeof extra?.step === 'number' ? { step: extra.step } : {}), ...(extra?.agents?.length ? { agents: extra.agents } : {}) })
    } catch {
      // 广播失败不应影响主流程
    }
  }

  runningCount(): number {
    return this.runs.size
  }

  async createThread(projectId: string, modelId: string, mode?: AgentMode): Promise<Thread> {
    const state = this.store.get()
    const project = state.projects.find((item) => item.id === projectId)
    if (!project) throw new Error('项目不存在，请重新选择目录')
    await ensureProjectFiles(project.path, project.name).catch(() => [])
    const now = new Date().toISOString()
    const thread: Thread = { id: randomUUID(), projectId, title: '新任务', modelId: modelId || state.settings.defaultModelId, status: 'idle', createdAt: now, updatedAt: now, messages: [], ...(mode && mode !== 'code' ? { mode } : {}) }
    await this.store.update((draft) => { draft.threads.push(thread) })
    return thread
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.cancel(threadId).catch(() => undefined)
    browserEngine.close(threadId)
    await this.store.update((draft) => { draft.threads = draft.threads.filter((item) => item.id !== threadId) })
  }

  async deleteProject(projectId: string): Promise<void> {
    const ids = this.store.get().threads.filter((item) => item.projectId === projectId).map((item) => item.id)
    for (const id of ids) { await this.cancel(id).catch(() => undefined); browserEngine.close(id) }
    await this.store.update((draft) => {
      draft.projects = draft.projects.filter((item) => item.id !== projectId)
      draft.threads = draft.threads.filter((item) => item.projectId !== projectId)
    })
  }

  async send(threadId: string, content: string, modelId?: string, card?: MessageCard, images?: MessageImage[], instruction?: string): Promise<void> {
    const thread = this.find(threadId)
    if (thread.status !== 'idle' || this.runs.has(threadId)) {
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)!
        const queue = target.queue ?? []
        if (queue.length >= 20) throw new Error('排队消息已达上限（20 条）')
        target.queue = [...queue, { id: randomUUID(), content, modelId, time: new Date().toISOString(), ...(images?.length ? { images } : {}) }]
      })
      return
    }
    await this.start(threadId, content, modelId, card, images, instruction)
  }

  async steer(threadId: string, content: string): Promise<void> {
    const thread = this.find(threadId)
    if (thread.status === 'idle' || !this.runs.has(threadId)) throw new Error('当前没有正在进行的回复，请直接发送消息')
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)!
      target.messages = this.append(target.messages, { id: randomUUID(), role: 'user', time: new Date().toISOString(), content, steering: true })
      target.updatedAt = new Date().toISOString()
    })
  }

  async regenerateMessage(threadId: string, messageId: string, modelId?: string): Promise<void> {
    const thread = this.find(threadId)
    if (thread.status !== 'idle' || this.runs.has(threadId)) throw new Error('当前会话正在运行，请先停止后再重新生成')
    const index = thread.messages.findIndex((item) => item.id === messageId)
    if (index < 0) throw new Error('消息不存在')
    const target = thread.messages[index]
    if (target.role !== 'assistant') throw new Error('只能重新生成 AI 回复')
    let userIndex = -1
    for (let i = index - 1; i >= 0; i--) {
      if (thread.messages[i].role === 'user') { userIndex = i; break }
    }
    if (userIndex < 0) throw new Error('未找到对应的用户消息')
    await this.store.update((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)!
      t.messages = t.messages.slice(0, userIndex + 1)
      t.updatedAt = new Date().toISOString()
    })
    await this.resume(threadId, modelId)
  }

  async rollbackMessage(threadId: string, messageId: string): Promise<void> {
    const thread = this.find(threadId)
    if (thread.status !== 'idle' || this.runs.has(threadId)) throw new Error('当前会话正在运行，请先停止后再回退')
    const index = thread.messages.findIndex((item) => item.id === messageId)
    if (index < 0) throw new Error('消息不存在')
    if (thread.messages[index].role !== 'user') throw new Error('只能回退到用户消息之前')
    await this.store.update((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)!
      t.messages = t.messages.slice(0, index)
      t.updatedAt = new Date().toISOString()
    })
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const thread = this.find(threadId)
    if (thread.status !== 'idle' || this.runs.has(threadId)) throw new Error('当前会话正在运行，请先停止后再删除消息')
    if (!thread.messages.some((item) => item.id === messageId)) throw new Error('消息不存在')
    await this.store.update((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)!
      t.messages = t.messages.filter((item) => item.id !== messageId)
      t.updatedAt = new Date().toISOString()
    })
  }

  async compactThread(threadId: string): Promise<{ removed: number }> {
    const thread = this.find(threadId)
    if (thread.status !== 'idle' || this.runs.has(threadId)) throw new Error('当前会话正在运行，请先停止后再压缩上下文')
    return this.compactMessages(threadId)
  }

  /**
   * 摘要式压缩：用模型把较早的消息总结成结构化摘要，保留最近若干条原始消息。
   * 可在会话运行中调用（自动压缩）；模型不可用时退化为普通移除标记，保证始终能释放空间。
   */
  private async compactMessages(threadId: string): Promise<{ removed: number }> {
    const thread = this.find(threadId)
    const keep = 10
    if (thread.messages.length <= keep + 1) return { removed: 0 }
    let start = thread.messages.length - keep
    while (start > 0 && thread.messages[start].role !== 'user') start--
    if (start <= 0) return { removed: 0 }
    const older = thread.messages.slice(0, start)
    const removed = older.length
    const summary = await this.summarize(thread, older)
    const marker: Message = { id: randomUUID(), role: 'system', time: new Date().toISOString(), level: 'info', content: summary.slice(0, 24_000) }
    await this.store.update((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)!
      t.messages = [marker, ...t.messages.slice(start)]
      t.updatedAt = new Date().toISOString()
    })
    return { removed }
  }

  private renderTranscript(messages: Message[]): string {
    const lines: string[] = []
    for (const message of messages) {
      if (message.role === 'user') lines.push(`用户：${message.content.slice(0, 4000)}`)
      else if (message.role === 'assistant') {
        // 助手行带上工具的参数摘要（路径/命令等），read_file 等工具结果的首行是内容而非路径，摘要模型需要知道操作对象
        const calls = message.toolCalls.map((call) => summarizeCall(call)).join('、')
        lines.push(`助手：${message.content.slice(0, 4000)}${calls ? `（调用：${calls}）` : ''}`)
      } else if (message.role === 'tool') {
        // 分层摘要：每个工具结果只保留首行结论与关键状态，避免摘要请求本身把旧上下文原样重放一遍
        const out = message.results.map((result) => {
          const firstLine = result.output.split('\n').find((line) => line.trim())?.slice(0, 200) ?? ''
          const extra = result.ok ? '' : ' [失败]'
          const diffNote = result.diff ? ` [改动：${result.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length} 行新增 / ${result.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length} 行删除]` : ''
          return `- ${result.name}${extra}${diffNote}：${firstLine}`
        }).join('\n')
        if (out) lines.push(`工具结果：\n${out}`)
      } else if (message.role === 'system') {
        lines.push(`系统：${message.content.slice(0, 1000)}`)
      }
    }
    const text = lines.join('\n\n')
    return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…（历史过长，已截断）` : text
  }

  private async summarize(thread: Thread, older: Message[]): Promise<string> {
    const plain = `（已压缩上下文：较早的 ${older.length} 条消息已移除以节省空间。请依据其余上下文继续任务。）`
    const state = this.store.get()
    const model = state.settings.models.find((item) => item.id === thread.modelId)
    const provider = model ? state.settings.providers.find((item) => item.id === model.providerId) : undefined
    if (!model || !provider) return plain
    const apiKey = this.secrets.get(provider.id)
    if (provider.kind !== 'ollama' && !apiKey) return plain
    const transcript = this.renderTranscript(older)
    if (!transcript.trim()) return plain
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const turn = await streamChat({
        provider, apiKey, model, tools: [],
        system: '你是一个对话摘要助手。请把给定的历史对话压缩成一份结构化的中文摘要，务必保留：①用户的目标与需求；②已确认的结论与决策；③涉及的文件路径与关键代码位置；④未完成事项与下一步；⑤重要约束与偏好。只依据给定对话，不要编造。',
        messages: [{ id: randomUUID(), role: 'user', time: new Date().toISOString(), content: `请总结以下对话历史：\n\n${transcript}` }],
        signal: controller.signal,
        onText: () => undefined,
        temperature: 0,
        maxTokens: 2000,
        timeoutMs: 90_000,
        retries: 1,
      })
      const summary = turn.content.trim()
      if (!summary) return plain
      return `（上下文已压缩：较早的 ${older.length} 条消息已总结为以下摘要，供你继续任务参考）\n\n${summary}`
    } catch {
      return plain
    } finally {
      clearTimeout(timer)
    }
  }

  private async resume(threadId: string, modelId?: string): Promise<void> {
    const thread = this.find(threadId)
    const model = this.store.get().settings.models.find((item) => item.id === (modelId || thread.modelId || this.store.get().settings.defaultModelId))
    if (!model) throw new Error('请先在设置中添加模型并选择')
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)!
      target.modelId = model.id
      target.status = 'running'
      target.updatedAt = new Date().toISOString()
    })
    const run = createRun()
    this.runs.set(threadId, run)
    let failed = false
    void this.loop(threadId, run).catch(async (error: unknown) => {
      failed = true
      run.outcome.ok = false
      run.outcome.error = describeError(error)
      await this.system(threadId, 'error', describeError(error))
    }).finally(async () => {
      if (run.controller.signal.aborted) run.outcome.cancelled = true
      try {
        await this.finish(threadId, run.controller.signal, failed)
      } finally {
        run.settle()
      }
    })
  }

  private async finish(threadId: string, signal: AbortSignal, failed: boolean): Promise<void> {
    this.runs.delete(threadId)
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (target) { target.status = 'idle'; target.pending = undefined; target.question = undefined; target.updatedAt = new Date().toISOString() }
    })
    if (!failed && !signal.aborted && !this.find(threadId).workflowRun?.status && this.pendingSteering(threadId)) {
      // 工作流运行期间不自动 resume：下一节点会再次 runNode → start，此时 runs 里已有 run 会抛「会话正在运行」误失败
      await this.resume(threadId).catch(() => undefined)
      return
    }
    void this.drain(threadId)
  }

  private pendingSteering(threadId: string): boolean {
    const thread = this.store.get().threads.find((item) => item.id === threadId)
    if (!thread) return false
    let lastAssistant = -1
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      if (thread.messages[i].role === 'assistant') { lastAssistant = i; break }
    }
    return thread.messages.some((item, index) => index > lastAssistant && item.role === 'user' && item.steering === true)
  }

  async dequeue(threadId: string, queuedId: string): Promise<void> {
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (target?.queue) target.queue = target.queue.filter((item) => item.id !== queuedId)
    })
  }

  private async start(threadId: string, content: string, modelId?: string, card?: MessageCard, images?: MessageImage[], instruction?: string): Promise<Run> {
    const thread = this.find(threadId)
    const model = this.store.get().settings.models.find((item) => item.id === (modelId || thread.modelId || this.store.get().settings.defaultModelId))
    if (!model) throw new Error('请先在设置中添加模型并选择')
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)!
      if (target.messages.length === 0) target.title = (card ? card.name : content || '图片消息').replace(/\s+/g, ' ').trim().slice(0, 60) || '新任务'
      target.modelId = model.id
      target.status = 'running'
      target.updatedAt = new Date().toISOString()
      target.messages = this.append(target.messages, { id: randomUUID(), role: 'user', time: new Date().toISOString(), content, ...(card ? { card } : {}), ...(images?.length ? { images } : {}) })
    })
    // 技能全文等一次性指令：随本轮第一次请求发送（不写入历史，重试/续轮不重复注入）
    const runInstruction = instruction?.trim()
    const run = createRun()
    if (runInstruction) run.instruction = runInstruction
    this.runs.set(threadId, run)
    let failed = false
    void this.loop(threadId, run).catch(async (error: unknown) => {
      failed = true
      run.outcome.ok = false
      run.outcome.error = describeError(error)
      await this.system(threadId, 'error', describeError(error))
    }).finally(async () => {
      if (run.controller.signal.aborted) run.outcome.cancelled = true
      try {
        await this.finish(threadId, run.controller.signal, failed)
      } finally {
        run.settle()
      }
    })
    return run
  }

  // 工作流节点执行入口（SPEC-003）：与 send 共用同一条 run 路径，额外提供完成信号与产出文本
  async runNode(threadId: string, instruction: string, meta: NodeMeta): Promise<NodeRunOutcome> {
    const thread = this.find(threadId)
    if (thread.status !== 'idle' || this.runs.has(threadId)) throw new Error('会话正在运行，无法启动工作流步骤')
    const boundary = `▶ 步骤 ${meta.index}/${meta.total}：${meta.title}${meta.attempt > 0 ? `（重试 ${meta.attempt}）` : ''}`
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (!target) throw new Error('会话不存在')
      target.messages = this.append(target.messages, { id: randomUUID(), role: 'system', time: new Date().toISOString(), level: 'info', content: boundary })
      target.updatedAt = new Date().toISOString()
    })
    const run = await this.start(threadId, instruction, undefined, meta.card)
    await run.settled
    const text = run.outcome.lastText.trim()
    return {
      ok: run.outcome.ok,
      ...(run.outcome.cancelled ? { cancelled: true } : {}),
      ...(run.outcome.error ? { error: run.outcome.error } : {}),
      ...(text ? { output: text } : {}),
    }
  }

  // 中止当前 run 但保留队列与工作流状态（供工作流暂停使用，区别于 cancel）
  abortRun(threadId: string): boolean {
    const run = this.runs.get(threadId)
    if (!run) return false
    run.controller.abort()
    run.approval?.resolve(false)
    run.question?.resolve(null)
    return true
  }

  drainQueue(threadId: string): Promise<void> {
    return this.drain(threadId)
  }

  private async drain(threadId: string): Promise<void> {
    const thread = this.store.get().threads.find((item) => item.id === threadId)
    const next = thread?.queue?.[0]
    if (!thread || !next || thread.status !== 'idle' || this.runs.has(threadId) || thread.workflowRun?.status === 'running') return
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (target) target.queue = (target.queue ?? []).slice(1)
    })
    await this.start(threadId, next.content, next.modelId, undefined, next.images).catch(async (error: unknown) => {
      await this.system(threadId, 'error', describeError(error))
    })
  }

  async cancel(threadId: string): Promise<void> {
    const run = this.runs.get(threadId)
    if (!run) {
      const thread = this.store.get().threads.find((item) => item.id === threadId)
      if (thread && thread.status !== 'idle') await this.store.update((draft) => { const t = draft.threads.find((item) => item.id === threadId)!; t.status = 'idle'; t.pending = undefined; t.question = undefined })
      return
    }
    run.controller.abort()
    run.approval?.resolve(false)
    run.question?.resolve(null)
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (target) target.queue = undefined
    })
    await this.system(threadId, 'info', '已停止本轮回复。')
  }

  async resolveApproval(threadId: string, callId: string, approved: boolean): Promise<void> {
    const run = this.runs.get(threadId)
    if (!run?.approval || run.approval.callId !== callId) throw new Error('没有待处理的审批')
    run.approval.resolve(approved)
  }

  async answerQuestion(threadId: string, callId: string, answer: string): Promise<void> {
    const run = this.runs.get(threadId)
    if (!run?.question || run.question.callId !== callId) throw new Error('没有待回答的问题')
    run.question.resolve(answer)
  }

  async terminateAll(): Promise<void> {
    for (const [threadId] of this.runs) await this.cancel(threadId).catch(() => undefined)
  }

  private find(threadId: string): Thread {
    const thread = this.store.get().threads.find((item) => item.id === threadId)
    if (!thread) throw new Error('会话不存在')
    return thread
  }

  private append(messages: Message[], message: Message): Message[] {
    return [...messages, message].slice(-400)
  }

  private system(threadId: string, level: 'info' | 'error', content: string): Promise<void> {
    return this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (target) target.messages = this.append(target.messages, { id: randomUUID(), role: 'system', time: new Date().toISOString(), level, content: content.slice(0, 4000) })
    })
  }

  private async loop(threadId: string, run: Run): Promise<void> {
    const { signal } = run.controller
    const maxSteps = this.store.get().settings.agent.maxSteps
    const loopOptimized = this.store.get().settings.beta.agentLoop
    const policy = resolveLoopPolicy(loopOptimized)
    const MAX_CONTINUATIONS = 5
    let continuations = 0
    let recoveries = 0
    let autoCompactions = 0
    let noToolCount = 0
    let pendingNudge = ''
    const callCounts = new Map<string, number>()
    const failureCounts = new Map<string, number>()
    let blockedStreak = 0
    for (let step = 0; step < maxSteps && !signal.aborted; step++) {
      const state = this.store.get()
      const { agent } = state.settings
      const thread = this.find(threadId)
      const project = state.projects.find((item) => item.id === thread.projectId)
      if (!project) throw new Error('项目不存在')
      const model = state.settings.models.find((item) => item.id === thread.modelId)
      if (!model) throw new Error('模型配置已被删除')
      const modelParams = mergeModelParams(state.settings.modelParams, model.params)
      const provider = state.settings.providers.find((item) => item.id === model.providerId)
      if (!provider) throw new Error('模型所属的提供商已被删除')
      const apiKey = this.secrets.get(provider.id)
      if (provider.kind !== 'ollama' && !apiKey) throw new Error(`提供商「${provider.name}」尚未配置 API Key`)

      // 接近上下文上限时先做摘要压缩，避免下一步请求直接超限
      const window = model.contextWindow
      if (window && autoCompactions < 3 && historyTokens(thread.messages) > window * policy.compactRatio) {
        const { removed } = await this.compactMessages(threadId).catch(() => ({ removed: 0 }))
        if (removed > 0) {
          autoCompactions++
          await this.system(threadId, 'info', `上下文接近上限，已自动把较早的 ${removed} 条消息压缩为摘要。`)
          step--
          continue
        }
        // 压缩失败（如摘要请求瞬时异常）：本轮跳过继续，不推进计数，上下文继续增长时仍会再次尝试
        autoCompactions = 3
      }
      const steeringSeen = new Set(thread.messages.filter((item) => item.role === 'user' && item.steering).map((item) => item.id))
      // 计划复盘：从第 3 步起偶尔注入一句轻量自查，抑制无效探索/跑偏（随请求发送，不写入历史）。
      let retrospective = ''
      if (step >= 2 && step % 4 === 2) {
        retrospective = '自查：目前完成了什么、与目标还差什么？是否存在在重复读取或偏离计划的步骤？接下来用最少步骤推进到目标；若目标已达成，直接给出结论并结束，不要再调用无关工具。'
      }

      const messageId = randomUUID()
      const projectFiles = await readProjectFiles(project.path)
      const baseSystem = buildSystemPrompt(state.settings, project, { projectContext: renderProjectContext(projectFiles), mode: thread.mode })
      // 可用技能清单：让模型按需自行 load_skill，而不是只能靠用户 /命令
      let skillHint = ''
      if (this.skills) {
        const metas = await this.skills.list().catch(() => [] as SkillMeta[])
        if (metas.length > 0) skillHint = `## 可用技能\n以下技能已安装，当任务与某个技能的适用场景匹配、或用户以 /名称 提到它时，先调用 load_skill(id) 加载完整指令，再严格按技能内容执行：\n${metas.map((skill) => `- ${skill.id}（${skill.name}）：${skill.description}`).join('\n')}`
      }
      // 上下文预算仪表：让模型知道还剩多少空间，主动控制输出与探索范围
      const usedTokens = historyTokens(thread.messages)
      const budget = model.contextWindow || 128_000
      const gauge = `上下文用量：约 ${Math.round(usedTokens / 1000)}k / ${Math.round(budget / 1000)}k tokens（${Math.round((usedTokens / budget) * 100)}%）。${usedTokens / budget > 0.7 ? '接近上限：避免输出冗长内容、不要重复读取已读过的文件，尽快收敛到结论。' : '正常：可正常探索，但避免重复读取与冗长输出。'}`
      const extraParts = [
        `## 上下文预算\n${gauge}`,
        skillHint,
        thread.todos && thread.todos.length > 0 ? `## 当前任务待办（这份清单始终可见，即使历史被裁剪也不会丢失，请据此判断做到哪一步、还剩什么，并及时用 manage_todos 更新状态）\n${renderTodos(thread.todos)}` : '',
        model.systemPromptExtra?.trim() ? `## 模型专属提示\n${model.systemPromptExtra.trim()}` : '',
      ].filter(Boolean)
      const system = extraParts.length ? `${baseSystem}\n\n${extraParts.join('\n\n')}` : baseSystem
      const reserve = estimateTokens(system) + (modelParams.maxTokens || 16_000) + 1_500
      const { messages: fitted } = fitContext(thread.messages, { contextWindow: model.contextWindow, reserve, limit: modelParams.historyLimit })
      // 一次性指令（技能全文）：仅第一步作为最后一条 user 消息随请求发送并立即消费；写入历史的只是占位消息
      const oneShot = step === 0 ? run.instruction : undefined
      if (step === 0 && run.instruction) run.instruction = undefined
      const history = pendingNudge ? [...fitted, { id: randomUUID(), role: 'user' as const, time: new Date().toISOString(), content: pendingNudge }]
        : retrospective ? [...fitted, { id: randomUUID(), role: 'user' as const, time: new Date().toISOString(), content: retrospective }]
        : oneShot ? [...fitted, { id: randomUUID(), role: 'user' as const, time: new Date().toISOString(), content: oneShot }]
        : fitted
      const placeholder: AssistantMessage = { id: messageId, role: 'assistant', time: new Date().toISOString(), content: '', toolCalls: [], modelId: model.id }
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)!
        target.messages = this.append(target.messages, placeholder)
      })
      this.activity(threadId, step === 0 ? 'thinking' : 'planning', step === 0 ? '正在理解你的需求…' : '正在规划下一步…', { step: step + 1 })
      let wroteText = false
      let partialText = ''
      let turn
      try {
        turn = await streamChat({
          provider, apiKey, model, tools: [...toolSpecs, ...(this.extensions?.specs(state.settings, thread.mode) ?? [])], signal,
          system,
          messages: history,
          temperature: modelParams.temperature ?? undefined,
          maxTokens: modelParams.maxTokens || undefined,
          timeoutMs: modelParams.timeoutSec * 1000,
          retries: modelParams.retries,
          thinkingLevel: modelParams.thinkingLevel ?? undefined,
          onText: (delta) => {
            partialText = (partialText + delta).slice(0, 200_000)
            if (!wroteText && delta.trim()) { wroteText = true; this.activity(threadId, 'writing', '正在撰写回复…', { step: step + 1 }) }
            this.emitDelta({ threadId, messageId, delta })
          },
        })
        pendingNudge = ''
      } catch (error) {
        if (partialText) {
          await this.store.update((draft) => {
            const target = draft.threads.find((item) => item.id === threadId)
            const message = target?.messages.find((item) => item.id === messageId)
            if (message?.role === 'assistant') message.content = partialText
          })
          run.outcome.lastText = partialText
        }
        await this.dropEmpty(threadId, messageId)
        if (signal.aborted) return
        if (isContextOverflowError(error) && recoveries < 3) {
          const { removed } = await this.compactMessages(threadId).catch(() => ({ removed: 0 }))
          if (removed > 0) {
            recoveries++
            await this.system(threadId, 'info', `检测到上下文超限，已自动把较早的 ${removed} 条消息压缩为摘要并重试。`)
            step--
            continue
          }
        }
        throw error
      }
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)!
        const message = target.messages.find((item) => item.id === messageId)
        if (message?.role === 'assistant') {
          message.content = turn.content.slice(0, 200_000)
          message.toolCalls = turn.toolCalls.slice(0, 20)
          message.usage = turn.usage
        }
        target.updatedAt = new Date().toISOString()
      })
      if (turn.content.trim()) run.outcome.lastText = turn.content
      // 与存储一致：只执行被保留的 toolCalls，避免第 21+ 个调用的结果因无对应 toolCall 被下一轮清洗丢弃
      turn.toolCalls = turn.toolCalls.slice(0, 20)
      if (turn.usage) void this.onUsage({ input: turn.usage.input, output: turn.usage.output, modelId: model.id }).catch(() => undefined)
      if (turn.toolCalls.length === 0) {
        if (turn.truncated && !signal.aborted && continuations < MAX_CONTINUATIONS) {
          continuations++
          await this.store.update((draft) => {
            const target = draft.threads.find((item) => item.id === threadId)
            if (target) target.messages = this.append(target.messages, { id: randomUUID(), role: 'user', time: new Date().toISOString(), content: '你的上一条回复因达到输出长度上限被截断了。请直接从截断处继续输出剩余内容，不要重复已经写过的部分。' })
          })
          continue
        }
        const steeringPending = this.store.get().threads.find((item) => item.id === threadId)?.messages
          .filter((item) => item.role === 'user' && item.steering && !steeringSeen.has(item.id)) ?? []
        if (steeringPending.length > 0 && !signal.aborted && step + 1 < maxSteps) {
          noToolCount = 0
          continue
        }
        if (!loopOptimized) return
        // 补问若干轮，而不是立刻结束：loop.js 的停机语义
        noToolCount += 1
        const nextStep = nextNoToolStep(noToolCount, policy.noToolRounds)
        if (nextStep.done) {
          await this.system(threadId, 'info', `连续 ${policy.noToolRounds} 轮模型都没有调用工具，已结束本轮；发送消息可继续。`)
          return
        }
        if (nextStep.nudge) pendingNudge = policy.noToolPrompt
        continue
      }
      noToolCount = 0
      if (signal.aborted) return

      const results: ToolResult[] = []
      let blockedCount = 0
      // 并行分组：同一批里相互独立的只读工具并行执行，其余（写操作、命令、审批、交互）保持串行。
      // 只列主进程内置工具；browser/web_search 属扩展工具（需审批语义），不进并行组。
      const readOnly = new Set(['read_file', 'list_directory', 'search_files'])
      const parallelCalls = turn.toolCalls.filter((call) => !extensionToolNames.has(call.name) && !interactiveTools.has(call.name) && !todoTools.has(call.name) && !delegateTools.has(call.name) && readOnly.has(call.name) && typeof call.args.__raw !== 'string')
      const sequentialCalls = turn.toolCalls.filter((call) => !parallelCalls.includes(call))
      const signatureOf = (call: ToolCall) => `${call.name}:${JSON.stringify(call.args)}`
      const guardAndRun = async (call: ToolCall): Promise<ToolResult | null> => {
        if (typeof call.args.__raw === 'string') {
          // 参数截断不属于「重复空转」，不占用重复计数
          return { callId: call.id, name: call.name, ok: false, output: '工具参数不是合法 JSON（可能因输出过长被截断），未执行。请重新调用该工具并提供完整参数。' }
        }
        const signature = signatureOf(call)
        const seen = (callCounts.get(signature) ?? 0) + 1
        callCounts.set(signature, seen)
        if (seen > 3) {
          blockedCount++
          return { callId: call.id, name: call.name, ok: false, output: '检测到重复调用：相同工具与参数已执行多次，本次已拦截。请更换方法或直接给出结论。' }
        }
        return null
      }
      // 先跑可并行的只读组
      if (parallelCalls.length > 1) this.activity(threadId, 'tool', `并行执行 ${parallelCalls.length} 个只读工具…`, { step: step + 1 })
      const parallelResults = await Promise.all(parallelCalls.map(async (call) => {
        const blocked = await guardAndRun(call)
        if (blocked) return blocked
        if (signal.aborted) return { callId: call.id, name: call.name, ok: false, output: '本轮已停止' } as ToolResult
        return this.condenseResult(call, await runTool(call, { root: project.path, signal, commandTimeoutMs: agent.commandTimeoutSec * 1000, shell: agent.shell, sandbox: { enabled: state.settings.permissions.sandbox, allowNetwork: state.settings.permissions.sandboxNetwork } }))
      }))
      // 其余按原顺序串行（保持审批、delegate、交互等原有语义）
      const sequentialResults: ToolResult[] = []
      for (const call of sequentialCalls) {
        if (signal.aborted) { sequentialResults.push({ callId: call.id, name: call.name, ok: false, output: '本轮已停止' }); continue }
        const blocked = await guardAndRun(call)
        if (blocked) { sequentialResults.push(blocked); continue }
        if (call.name === 'delegate') {
          this.activity(threadId, 'delegating', '正在协调子智能体…', { step: step + 1, detail: summarizeCall(call) })
          sequentialResults.push(await this.delegate(threadId, run, call, step + 1))
          continue
        }
        if (interactiveTools.has(call.name)) {
          sequentialResults.push(await this.askUser(threadId, run, call))
          continue
        }
        if (todoTools.has(call.name)) {
          sequentialResults.push(await this.manageTodos(threadId, call))
          continue
        }
        if (call.name === 'load_skill') {
          sequentialResults.push(await this.loadSkill(call))
          continue
        }
        if (call.name === 'create_workflow') {
          sequentialResults.push(await this.createWorkflow(threadId, call))
          continue
        }
        const decision = await this.authorize(threadId, run, call)
        if (!decision.approved) {
          sequentialResults.push({ callId: call.id, name: call.name, ok: false, denied: true, output: decision.reason ?? '用户拒绝了此操作。' })
          continue
        }
        if (extensionToolNames.has(call.name)) {
          sequentialResults.push(await this.runExtension(call, project.path, signal, threadId))
          continue
        }
        const executed = await runTool(call, { root: project.path, signal, commandTimeoutMs: agent.commandTimeoutSec * 1000, shell: agent.shell, sandbox: { enabled: state.settings.permissions.sandbox, allowNetwork: state.settings.permissions.sandboxNetwork } })
        // 失败根因反馈：同一工具连续失败时附带提示，避免模型反复撞同一堵墙
        if (!executed.ok) {
          const failKey = `${call.name}:${call.args.path ?? call.args.command ?? call.args.pattern ?? ''}`
          const failCount = (failureCounts.get(failKey) ?? 0) + 1
          failureCounts.set(failKey, failCount)
          if (failCount >= 2) {
            executed.output += `\n提示：该工具已连续失败 ${failCount} 次（相同目标）。请先分析失败原因，换一种方法（如先 list_directory 确认路径、用 search_files 定位、修改参数后重试），不要原样重复同一调用。`
          }
        } else {
          failureCounts.delete(`${call.name}:${call.args.path ?? call.args.command ?? call.args.pattern ?? ''}`)
        }
        sequentialResults.push(this.condenseResult(call, executed))
      }
      // 按模型原始调用顺序回填结果（provider 严格要求 callId 对应）
      const resultByCallId = new Map([...parallelResults, ...sequentialResults].map((result) => [result.callId, result]))
      for (const call of turn.toolCalls) {
        const result = resultByCallId.get(call.id)
        if (result) results.push(result)
      }
      if (signal.aborted) return
      // 空转治理：若整步工具调用都因重复被拦截，连续两次则中止本轮
      if (turn.toolCalls.length > 0 && blockedCount === turn.toolCalls.length) {
        blockedStreak++
        if (blockedStreak >= 2) {
          await this.system(threadId, 'info', '检测到重复空转（连续多次调用相同工具与参数），已中止本轮以避免浪费。请调整思路后重试。')
          return
        }
      } else {
        blockedStreak = 0
      }
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)!
        const toolMessage: Message = { id: randomUUID(), role: 'tool', time: new Date().toISOString(), results }
        const anchor = target.messages.findIndex((item) => item.id === messageId)
        if (anchor >= 0) {
          const messages = [...target.messages]
          messages.splice(anchor + 1, 0, toolMessage)
          target.messages = messages.slice(-400)
        } else {
          target.messages = this.append(target.messages, toolMessage)
        }
        target.updatedAt = new Date().toISOString()
      })
    }
    if (!signal.aborted) await this.system(threadId, 'info', `已达到单轮最多 ${maxSteps} 步，已暂停；发送消息可继续。`)
  }

  private dropEmpty(threadId: string, messageId: string): Promise<void> {
    return this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (!target) return
      target.messages = target.messages.filter((item) => item.id !== messageId || item.role !== 'assistant' || item.content.length > 0 || item.toolCalls.length > 0)
    })
  }

  private async askUser(threadId: string, run: Run, call: ToolCall): Promise<ToolResult> {
    const question = typeof call.args.question === 'string' ? call.args.question.trim().slice(0, 2000) : ''
    if (!question) return { callId: call.id, name: call.name, ok: false, output: 'question 不能为空' }
    const options = Array.isArray(call.args.options) ? [...new Set(call.args.options.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 200)).filter(Boolean))].slice(0, 6) : []
    const recommendation = typeof call.args.recommended === 'string' ? call.args.recommended.trim() : ''
    const recommended = recommendation && options.includes(recommendation) ? recommendation : undefined
    if (run.controller.signal.aborted || this.runs.get(threadId) !== run) return { callId: call.id, name: call.name, ok: false, denied: true, output: '本轮已停止' }
    if (recommended && this.store.get().settings.agent.autoSelectRecommended) {
      await this.system(threadId, 'info', `已按设置自动选择推荐项：${recommended}`)
      if (run.controller.signal.aborted) return { callId: call.id, name: call.name, ok: false, denied: true, output: '本轮已停止' }
      return { callId: call.id, name: call.name, ok: true, output: `已按用户配置自动选择推荐项：${recommended}` }
    }
    const pending: PendingQuestion = { callId: call.id, question, options, recommended, multiple: call.args.multiple === true || undefined }
    let abortQuestion = (): void => undefined
    const answerPromise = new Promise<string | null>((resolve) => {
      run.question = { callId: call.id, resolve }
      abortQuestion = () => resolve(null)
      run.controller.signal.addEventListener('abort', abortQuestion, { once: true })
    })
    try {
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)
        if (!target || run.controller.signal.aborted || this.runs.get(threadId) !== run) { abortQuestion(); return }
        target.status = 'awaiting-input'
        target.question = pending
      })
      const answer = await answerPromise
      if (answer === null || run.controller.signal.aborted) return { callId: call.id, name: call.name, ok: false, denied: true, output: '用户未回答（已停止）。' }
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)
        if (target && !run.controller.signal.aborted && this.runs.get(threadId) === run) target.messages = this.append(target.messages, { id: randomUUID(), role: 'user', time: new Date().toISOString(), content: answer })
      })
      return { callId: call.id, name: call.name, ok: true, output: `用户回答：${answer}` }
    } finally {
      run.controller.signal.removeEventListener('abort', abortQuestion)
      if (run.question?.callId === call.id) run.question = undefined
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)
        if (!target || this.runs.get(threadId) !== run || target.question?.callId !== call.id) return
        target.question = undefined
        if (target.status === 'awaiting-input') target.status = 'running'
      })
    }
  }

  private async manageTodos(threadId: string, call: ToolCall): Promise<ToolResult> {
    const action = typeof call.args.action === 'string' ? call.args.action : ''
    let todos: TodoItem[] = []
    let error: string | undefined
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (!target) { error = '会话不存在'; return }
      const current = target.todos ?? []
      if (action === 'set') {
        const items = Array.isArray(call.args.items) ? call.args.items : []
        const next = items
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 40)
          .map<TodoItem>((content) => ({ id: randomUUID(), content: content.slice(0, 300), status: 'pending' }))
        if (next.length === 0) { error = 'set 需要至少一条待办（items）'; return }
        target.todos = next
      } else if (action === 'clear') {
        target.todos = []
      } else if (action === 'start' || action === 'complete') {
        const index = typeof call.args.index === 'number' ? Math.trunc(call.args.index) - 1 : -1
        if (index < 0 || index >= current.length) { error = `index 超出范围（当前有 ${current.length} 条待办）`; return }
        target.todos = current.map((item, i) => i === index ? { ...item, status: action === 'start' ? 'active' : 'done' } : item)
      } else {
        error = `未知 action：${action}`
        return
      }
      todos = target.todos ?? []
      target.updatedAt = new Date().toISOString()
    })
    if (error) return { callId: call.id, name: call.name, ok: false, output: error }
    return { callId: call.id, name: call.name, ok: true, output: renderTodos(todos) }
  }

  /** load_skill：加载技能全文（无副作用、不需审批）；重复加载同一技能直接复用缓存内容 */
  private async loadSkill(call: ToolCall): Promise<ToolResult> {
    const id = typeof call.args.id === 'string' ? call.args.id.trim() : ''
    if (!this.skills) return { callId: call.id, name: call.name, ok: false, output: '技能服务不可用' }
    if (!id) return { callId: call.id, name: call.name, ok: false, output: '缺少 id 参数，请从系统提示的可用技能列表中选择' }
    try {
      const skill = await this.skills.read(id)
      return { callId: call.id, name: call.name, ok: true, output: `# 技能：${skill.name}\n\n${skill.content}`.slice(0, 60_000) }
    } catch (error) {
      return { callId: call.id, name: call.name, ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }

  /** create_workflow：把多步骤任务落成 Work 画布工作流（当前项目下），保存后即可在画布中查看与运行 */
  private async createWorkflow(threadId: string, call: ToolCall): Promise<ToolResult> {
    const name = typeof call.args.name === 'string' ? call.args.name.trim().slice(0, 60) : ''
    const raw = Array.isArray(call.args.nodes) ? call.args.nodes : []
    if (!name) return { callId: call.id, name: call.name, ok: false, output: '缺少 name（工作流名称）' }
    if (raw.length < 1 || raw.length > 20) return { callId: call.id, name: call.name, ok: false, output: 'nodes 必须包含 1–20 个节点' }
    const thread = this.find(threadId)
    const nodes = raw.map((item, index) => {
      const node = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const title = typeof node.title === 'string' && node.title.trim() ? node.title.trim().slice(0, 60) : `步骤 ${index + 1}`
      const prompt = typeof node.prompt === 'string' ? node.prompt.trim().slice(0, 8000) : ''
      const kind = typeof node.kind === 'string' ? node.kind : undefined
      return { id: randomUUID(), title, prompt, x: 0, y: index * 160, ...(kind ? { kind: kind as never } : {}) }
    })
    if (nodes.some((node) => !node.prompt)) return { callId: call.id, name: call.name, ok: false, output: '每个节点都需要 prompt（该步骤的完整执行指令）' }
    const workflow = {
      id: randomUUID(),
      projectId: thread.projectId,
      name,
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })),
      updatedAt: new Date().toISOString(),
    }
    try {
      const { workflowSchema } = await import('../shared/schema')
      const parsed = workflowSchema.parse(workflow)
      await this.store.update((draft) => { draft.workflows = [...(draft.workflows ?? []), parsed].slice(-50) })
      return { callId: call.id, name: call.name, ok: true, output: `已保存工作流「${name}」（${nodes.length} 个步骤，线性串联）。用户可在 Work 画布中查看、编辑和运行它。` }
    } catch (error) {
      return { callId: call.id, name: call.name, ok: false, output: `工作流校验失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async delegate(threadId: string, run: Run, call: ToolCall, step: number): Promise<ToolResult> {
    const raw = Array.isArray(call.args.tasks) ? call.args.tasks : []
    if (raw.length < 1 || raw.length > 32) return { callId: call.id, name: call.name, ok: false, output: 'tasks 必须包含 1–32 个子任务' }
    const { signal } = run.controller
    const state = this.store.get()
    const thread = this.find(threadId)
    const project = state.projects.find((item) => item.id === thread.projectId)
    if (!project) return { callId: call.id, name: call.name, ok: false, output: '项目不存在' }
    const tasks: SubagentTask[] = []
    for (const [index, item] of raw.entries()) {
      if (!item || typeof item !== 'object') return { callId: call.id, name: call.name, ok: false, output: `第 ${index + 1} 个子任务格式错误` }
      const record = item as Record<string, unknown>
      const profile = typeof record.profileId === 'string' ? state.settings.agent.subagentProfiles.find((entry) => entry.id === record.profileId) : undefined
      if (record.profileId != null && !profile) return { callId: call.id, name: call.name, ok: false, output: `第 ${index + 1} 个子任务的配置不存在` }
      const instruction = typeof record.instruction === 'string' ? record.instruction.trim() : ''
      const combined = [profile?.instruction, instruction].filter(Boolean).join('\n\n')
      if (!instruction || combined.length > 8000) return { callId: call.id, name: call.name, ok: false, output: `第 ${index + 1} 个子任务需要 instruction，合并角色指令后不得超过 8000 字符` }
      const role = profile?.role ?? record.role ?? 'general'
      if (!subagentRoles.includes(role as SubagentRun['role'])) return { callId: call.id, name: call.name, ok: false, output: `第 ${index + 1} 个子任务角色无效` }
      if (record.modelId != null && typeof record.modelId !== 'string') return { callId: call.id, name: call.name, ok: false, output: `第 ${index + 1} 个子任务 modelId 必须是字符串` }
      tasks.push({
        id: randomUUID(),
        name: (typeof record.name === 'string' && record.name.trim() ? record.name.trim() : profile?.name || `子智能体 ${index + 1}`).slice(0, 40),
        instruction: combined,
        role: role as SubagentRun['role'],
        modelId: profile?.modelId || (typeof record.modelId === 'string' ? record.modelId : '') || thread.modelId,
        toolAccess: role === 'researcher' || role === 'reviewer' || state.settings.permissions.readOnly ? 'read-only' : profile?.toolAccess ?? 'project',
      })
    }
    const batchId = randomUUID()
    const maxSteps = Math.max(3, Math.min(Math.ceil(state.settings.agent.maxSteps / 2), 20))
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (target) target.subagentRuns = [...(target.subagentRuns ?? []).slice(-32), ...tasks.map((task): SubagentRun => ({ id: task.id, batchId, name: task.name, role: task.role, modelId: task.modelId, instruction: task.instruction, status: 'queued', step: 0, maxSteps }))]
    })
    this.activity(threadId, 'delegating', `启动 ${tasks.length} 个子智能体…`, { step, agents: tasks.map((item) => item.name) })
    const outcomes: Array<{ name: string; ok: boolean; summary: string }> = new Array(tasks.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < tasks.length) {
        const index = cursor++
        const task = tasks[index]
        let outcome: { name: string; ok: boolean; summary: string }
        try {
          if (signal.aborted) throw new Error('本轮已停止')
          const model = state.settings.models.find((item) => item.id === task.modelId)
          if (!model) throw new Error(`模型配置不存在：${task.modelId}`)
          const provider = state.settings.providers.find((item) => item.id === model.providerId)
          if (!provider) throw new Error('模型所属的提供商已被删除')
          const apiKey = this.secrets.get(provider.id)
          if (provider.kind !== 'ollama' && !apiKey) throw new Error(`提供商「${provider.name}」尚未配置 API Key`)
          await this.updateSubagent(threadId, task.id, { status: 'running', startedAt: new Date().toISOString() })
          outcome = await this.runSubAgent(task, { provider, apiKey, model, project, settings: state.settings, signal, threadId, step })
        } catch (error) {
          outcome = { name: task.name, ok: false, summary: error instanceof Error ? error.message : String(error) }
        }
        outcomes[index] = outcome
        await this.updateSubagent(threadId, task.id, { status: signal.aborted ? 'cancelled' : outcome.ok ? 'completed' : 'failed', summary: outcome.summary.slice(0, 12000), finishedAt: new Date().toISOString(), detail: undefined })
      }
    }
    await Promise.all(Array.from({ length: Math.min(tasks.length, state.settings.agent.maxConcurrentSubagents) }, worker))
    const merged = outcomes.map((item) => `### ${item.name}\n${item.summary}`).join('\n\n')
    const failed = outcomes.filter((item) => !item.ok).length
    return { callId: call.id, name: call.name, ok: failed === 0, output: `已完成 ${outcomes.length - failed}/${outcomes.length} 个子任务。\n\n${merged}`.slice(0, 60_000) }
  }

  private updateSubagent(threadId: string, id: string, patch: Partial<SubagentRun>): Promise<void> {
    return this.store.update((draft) => {
      const agent = draft.threads.find((item) => item.id === threadId)?.subagentRuns?.find((item) => item.id === id)
      if (agent) Object.assign(agent, patch)
    })
  }

  private async runSubAgent(
    task: SubagentTask,
    ctx: { provider: Parameters<typeof streamChat>[0]['provider']; apiKey: string | undefined; model: Parameters<typeof streamChat>[0]['model']; project: Parameters<typeof buildSystemPrompt>[1]; settings: Settings; signal: AbortSignal; threadId: string; step: number },
  ): Promise<{ name: string; ok: boolean; summary: string }> {
    const { settings, project, signal, threadId } = ctx
    const modelParams = mergeModelParams(settings.modelParams, ctx.model.params)
    const subSteps = Math.max(3, Math.min(Math.ceil(settings.agent.maxSteps / 2), 20))
    const projectFiles = await readProjectFiles(project.path).catch(() => [])
    const mode = this.find(threadId).mode
    const effectiveSettings: Settings = { ...settings, agent: { ...settings.agent, autoTodo: false }, permissions: { ...settings.permissions, readOnly: settings.permissions.readOnly || task.toolAccess === 'read-only' } }
    const baseSystem = buildSystemPrompt(effectiveSettings, project, { projectContext: renderProjectContext(projectFiles), mode })
    const system = `${baseSystem}\n\n## 你的身份\n你是一个名为「${task.name}」的 ${task.role} 子智能体，正在与其它子智能体协作完成一个更大的任务。请只专注于分配给你的子任务，完成后用简洁的中文总结你做了什么、改动了哪些文件、以及需要主智能体知道的关键结论。你不能再委派子任务，也不能向用户提问。不要修改其它子任务负责的文件。${task.role === 'coder' ? '你是编码角色：负责实际修改文件，改动要完整可用并通过必要的验证。' : ''}${task.role === 'researcher' ? '你是调研角色：只读取和检索信息、汇总事实与结论，不修改任何文件。' : ''}${task.role === 'reviewer' ? '你是审查角色：客观复查给出的改动或代码，指出缺陷、边界问题与不符合要求的点，给出明确结论（通过/不通过及原因），不修改任何文件。' : ''}${task.toolAccess === 'read-only' ? '你只有读取与检索权限，不得修改文件或执行命令。' : ''}${ctx.model.systemPromptExtra?.trim() ? `\n\n## 模型专属提示\n${ctx.model.systemPromptExtra.trim()}` : ''}`
    const messages: Message[] = [{ id: randomUUID(), role: 'user', time: new Date().toISOString(), content: task.instruction }]
    const readTools = new Set(['read_file', 'list_directory', 'search_files', 'browser_open', 'web_search'])
    const subTools = [...toolSpecs, ...(this.extensions?.specs(effectiveSettings, mode) ?? [])].filter((spec) => spec.name !== 'delegate' && spec.name !== 'ask_user' && spec.name !== 'manage_todos' && (task.toolAccess !== 'read-only' || readTools.has(spec.name)))
    const allowedTools = new Set(subTools.map((spec) => spec.name))
    const loopOptimized = settings.beta.agentLoop
    const policy = resolveLoopPolicy(loopOptimized)
    let subNoToolCount = 0
    let subNudge = ''
    let finalText = ''
    try {
      for (let i = 0; i < subSteps && !signal.aborted; i++) {
        this.activity(threadId, 'delegating', `「${task.name}」执行中…`, { step: ctx.step, detail: `第 ${i + 1} 步`, agents: [task.name] })
        await this.updateSubagent(threadId, task.id, { step: i + 1, detail: '正在思考' })
        const reserve = estimateTokens(system) + (modelParams.maxTokens || 8_000) + 1_500
        const { messages: fitted } = fitContext(messages, { contextWindow: ctx.model.contextWindow, reserve, limit: modelParams.historyLimit })
        const history = subNudge ? [...fitted, { id: randomUUID(), role: 'user' as const, time: new Date().toISOString(), content: subNudge }] : fitted
        const turn = await streamChat({
          provider: ctx.provider, apiKey: ctx.apiKey, model: ctx.model, tools: subTools, signal,
          system, messages: history,
          temperature: modelParams.temperature ?? undefined,
          maxTokens: modelParams.maxTokens || undefined,
          timeoutMs: modelParams.timeoutSec * 1000,
          retries: modelParams.retries,
          thinkingLevel: modelParams.thinkingLevel ?? undefined,
          onText: () => undefined,
        })
        subNudge = ''
        if (turn.usage) void this.onUsage({ input: turn.usage.input, output: turn.usage.output, modelId: ctx.model.id }).catch(() => undefined)
        finalText = turn.content || finalText
        messages.push({ id: randomUUID(), role: 'assistant', time: new Date().toISOString(), content: turn.content, toolCalls: turn.toolCalls, modelId: ctx.model.id })
        if (turn.toolCalls.length === 0) {
          if (!loopOptimized) return { name: task.name, ok: !signal.aborted, summary: (finalText || '（子智能体未产出文字总结）').slice(0, 12000) }
          subNoToolCount += 1
          const nextStep = nextNoToolStep(subNoToolCount, policy.noToolRounds)
          if (nextStep.done) return { name: task.name, ok: !signal.aborted, summary: (finalText || '（子智能体未产出文字总结）').slice(0, 12000) }
          if (nextStep.nudge) subNudge = policy.noToolPrompt
          continue
        }
        subNoToolCount = 0
        const results: ToolResult[] = []
        for (const sub of turn.toolCalls) {
          if (signal.aborted) break
          if (typeof sub.args.__raw === 'string') {
            results.push({ callId: sub.id, name: sub.name, ok: false, output: '工具参数不是合法 JSON（可能因输出过长被截断），未执行。请重新调用该工具并提供完整参数。' })
            continue
          }
          if (!allowedTools.has(sub.name) || interactiveTools.has(sub.name) || todoTools.has(sub.name) || delegateTools.has(sub.name)) {
            results.push({ callId: sub.id, name: sub.name, ok: false, output: '子智能体不可使用该工具' })
            continue
          }
          const activeRun = this.runs.get(threadId)
          if (!activeRun || signal.aborted) break
          const isolatedCall = { ...sub, id: `${task.id}:${sub.id}` }
          await this.updateSubagent(threadId, task.id, { detail: summarizeCall(sub).slice(0, 2000) })
          const decision = await this.authorize(threadId, activeRun, isolatedCall)
          if (!decision.approved) {
            results.push({ callId: sub.id, name: sub.name, ok: false, denied: true, output: decision.reason ?? '被拒绝' })
            continue
          }
          if (signal.aborted) break
          if (extensionToolNames.has(sub.name)) results.push(await this.runExtension(sub, project.path, signal, threadId))
          else results.push(await runTool(sub, { root: project.path, signal, commandTimeoutMs: settings.agent.commandTimeoutSec * 1000, shell: settings.agent.shell, sandbox: { enabled: settings.permissions.sandbox, allowNetwork: settings.permissions.sandboxNetwork } }))
        }
        messages.push({ id: randomUUID(), role: 'tool', time: new Date().toISOString(), results })
      }
      return { name: task.name, ok: false, summary: `${signal.aborted ? '子任务已取消' : '子任务达到步数上限，尚未确认完成'}${finalText ? `\n\n${finalText}` : ''}`.slice(0, 12000) }
    } catch (error) {
      return { name: task.name, ok: false, summary: `执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * 工具结果智能裁剪：按工具类型收紧送回模型的内容，同样的上下文预算装更多有效信息。
   * list_directory 只留前 60 个条目；search_files 每个文件只留前 3 条命中；read_file 大结果砍半保留首尾。
   */
  private condenseResult(call: ToolCall, result: ToolResult): ToolResult {
    if (!result.ok || !result.output) return result
    const clipNote = (kept: string, total: number) => `${kept}\n…（其余 ${total - kept.split('\n').length} 行已省略；如需完整内容请用更精确的参数重试）`
    if (call.name === 'list_directory') {
      const lines = result.output.split('\n')
      if (lines.length > 60) result.output = clipNote(lines.slice(0, 60).join('\n'), lines.length)
    } else if (call.name === 'search_files') {
      const lines = result.output.split('\n')
      const perFile = new Map<string, number>()
      const kept: string[] = []
      let dropped = 0
      for (const line of lines) {
        if (line.startsWith('…（')) { kept.push(line); continue }
        const file = line.split(':')[0] ?? ''
        const count = perFile.get(file) ?? 0
        if (count >= 3) { dropped++; continue }
        perFile.set(file, count + 1)
        kept.push(line)
      }
      if (dropped > 0) result.output = `${kept.join('\n')}\n…（另有 ${dropped} 条同文件命中已省略）`
    } else if (call.name === 'read_file') {
      const lines = result.output.split('\n')
      // read_file 本身有 400 行/2000 行上限，只处理超过 250 行的大读取
      if (lines.length > 250) {
        // 尾部说明行（…共 N 行，已显示到第 X 行）不参与首尾裁剪，且保留它以传达完整行数
        let end = lines.length
        let trailer: string | undefined
        if (lines[end - 1]?.startsWith('…（')) { end--; trailer = lines[end] }
        const head = lines.slice(0, 150)
        const tail = lines.slice(Math.max(0, end - 60), end)
        const firstKept = 150 + 1 // read_file 输出行号从 1 开始（1-indexed）
        const lastKept = end - 60 + 1
        const note = `…（第 ${firstKept}–${lastKept - 1} 行已省略）`
        result.output = `${head.join('\n')}\n${note}\n${tail.join('\n')}${trailer ? `\n${trailer}` : ''}`
      }
    }
    return result
  }

  private async runExtension(call: ToolCall, root: string, signal: AbortSignal, threadId: string): Promise<ToolResult> {
    const started = Date.now()
    if (!this.extensions) return { callId: call.id, name: call.name, ok: false, output: '扩展工具不可用', durationMs: 0 }
    try {
      const { output, image } = await this.extensions.run(call, { root, signal, threadId })
      return { callId: call.id, name: call.name, ok: true, output, ...(image ? { image } : {}), durationMs: Date.now() - started }
    } catch (error) {
      return { callId: call.id, name: call.name, ok: false, output: (error instanceof Error ? error.message : String(error)).slice(0, 8000), durationMs: Date.now() - started }
    }
  }

  private async authorize(threadId: string, run: Run, call: ToolCall): Promise<Decision> {
    const previous = run.approvalQueue ?? Promise.resolve()
    let release = (): void => undefined
    run.approvalQueue = new Promise<void>((resolve) => { release = resolve })
    try {
      await previous
      if (run.controller.signal.aborted || this.runs.get(threadId) !== run) return { approved: false, reason: '本轮已停止' }
      return await this.authorizeNext(threadId, run, call)
    } finally {
      release()
    }
  }

  private async authorizeNext(threadId: string, run: Run, call: ToolCall): Promise<Decision> {
    const { approvalMode: mode, permissions } = this.store.get().settings
    const isCommand = commandTools.has(call.name)
    const isMutating = mutatingTools.has(call.name)
    const isSensitive = sensitiveExtensionTools.has(call.name)
    if (permissions.readOnly && (isCommand || isMutating || isSensitive)) return { approved: false, reason: '只读模式已开启，不允许修改文件、执行命令或调用外部操作。' }
    if (isCommand) {
      const command = typeof call.args.command === 'string' ? call.args.command : ''
      const denied = matchesCommandRule(command, permissions.denyCommands)
      if (denied) return { approved: false, reason: `命令命中禁止规则「${denied}」，已拒绝执行。` }
      if (matchesCommandRule(command, permissions.allowCommands)) return { approved: true }
    }
    const needs = isSensitive || isCommand ? mode !== 'full-auto'
      : isMutating ? mode === 'ask' && !isProjectFileEdit(call) : false
    if (!needs) return { approved: true }
    const pending: PendingApproval = { callId: call.id, name: call.name, args: call.args, summary: summarizeCall(call).slice(0, 2000) }
    let abortApproval = (): void => undefined
    const approvedPromise = new Promise<boolean>((resolve) => {
      run.approval = { callId: call.id, resolve }
      abortApproval = () => resolve(false)
      run.controller.signal.addEventListener('abort', abortApproval, { once: true })
    })
    try {
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)
        if (!target || run.controller.signal.aborted) { abortApproval(); return }
        target.status = 'awaiting-approval'
        target.pending = pending
      })
      const approved = await approvedPromise
      return { approved: approved && !run.controller.signal.aborted }
    } finally {
      run.controller.signal.removeEventListener('abort', abortApproval)
      run.approval = undefined
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)
        if (!target || this.runs.get(threadId) !== run || target.pending?.callId !== call.id) return
        target.pending = undefined
        if (target.status === 'awaiting-approval') target.status = 'running'
      })
    }
  }
}
