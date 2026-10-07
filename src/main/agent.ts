import { randomUUID } from 'node:crypto'
import { mergeModelParams, type ActivityPhase, type AgentActivity, type AgentMode, type AssistantMessage, type Message, type MessageCard, type MessageImage, type PendingApproval, type PendingQuestion, type Settings, type StreamDelta, type Thread, type TodoItem, type ToolCall, type ToolResult } from '../shared/schema'
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

  async send(threadId: string, content: string, modelId?: string, card?: MessageCard, images?: MessageImage[]): Promise<void> {
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
    await this.start(threadId, content, modelId, card, images)
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
        const calls = message.toolCalls.map((call) => call.name).join('、')
        lines.push(`助手：${message.content.slice(0, 4000)}${calls ? `（调用工具：${calls}）` : ''}`)
      } else if (message.role === 'tool') {
        const out = message.results.map((result) => `- ${result.name} ${result.ok ? '成功' : '失败'}：${result.output.slice(0, 800)}`).join('\n')
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
    if (!failed && !signal.aborted && this.pendingSteering(threadId)) {
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

  private async start(threadId: string, content: string, modelId?: string, card?: MessageCard, images?: MessageImage[]): Promise<Run> {
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
        autoCompactions = 3
      }
      const steeringSeen = new Set(thread.messages.filter((item) => item.role === 'user' && item.steering).map((item) => item.id))

      const messageId = randomUUID()
      const projectFiles = await readProjectFiles(project.path)
      const baseSystem = buildSystemPrompt(state.settings, project, { projectContext: renderProjectContext(projectFiles), mode: thread.mode })
      const extraParts = [
        thread.todos && thread.todos.length > 0 ? `## 当前任务待办（这份清单始终可见，即使历史被裁剪也不会丢失，请据此判断做到哪一步、还剩什么，并及时用 manage_todos 更新状态）\n${renderTodos(thread.todos)}` : '',
        model.systemPromptExtra?.trim() ? `## 模型专属提示\n${model.systemPromptExtra.trim()}` : '',
      ].filter(Boolean)
      const system = extraParts.length ? `${baseSystem}\n\n${extraParts.join('\n\n')}` : baseSystem
      const reserve = estimateTokens(system) + (modelParams.maxTokens || 16_000) + 1_500
      const { messages: fitted } = fitContext(thread.messages, { contextWindow: model.contextWindow, reserve, limit: modelParams.historyLimit })
      const history = pendingNudge ? [...fitted, { id: randomUUID(), role: 'user' as const, time: new Date().toISOString(), content: pendingNudge }] : fitted
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
      for (const call of turn.toolCalls) {
        if (signal.aborted) return
        const signature = `${call.name}:${JSON.stringify(call.args)}`
        const seen = (callCounts.get(signature) ?? 0) + 1
        callCounts.set(signature, seen)
        if (seen > 3) {
          blockedCount++
          results.push({ callId: call.id, name: call.name, ok: false, output: '检测到重复调用：相同工具与参数已执行多次，本次已拦截。请更换方法或直接给出结论。' })
          continue
        }
        if (typeof call.args.__raw === 'string') {
          results.push({ callId: call.id, name: call.name, ok: false, output: '工具参数不是合法 JSON（可能因输出过长被截断），未执行。请重新调用该工具并提供完整参数。' })
          continue
        }
        if (call.name === 'delegate') {
          this.activity(threadId, 'delegating', '正在协调子智能体…', { step: step + 1, detail: summarizeCall(call) })
        } else if (!interactiveTools.has(call.name) && !todoTools.has(call.name)) {
          this.activity(threadId, 'tool', summarizeCall(call), { step: step + 1 })
        }
        if (interactiveTools.has(call.name)) {
          results.push(await this.askUser(threadId, run, call))
          continue
        }
        if (todoTools.has(call.name)) {
          results.push(await this.manageTodos(threadId, call))
          continue
        }
        if (delegateTools.has(call.name)) {
          results.push(await this.delegate(threadId, run, call, step + 1))
          continue
        }
        const decision = await this.authorize(threadId, run, call)
        if (!decision.approved) {
          results.push({ callId: call.id, name: call.name, ok: false, denied: true, output: decision.reason ?? '用户拒绝了此操作。' })
          continue
        }
        if (extensionToolNames.has(call.name)) {
          results.push(await this.runExtension(call, project.path, signal, threadId))
          continue
        }
        results.push(await runTool(call, { root: project.path, signal, commandTimeoutMs: agent.commandTimeoutSec * 1000, shell: agent.shell, sandbox: { enabled: state.settings.permissions.sandbox, allowNetwork: state.settings.permissions.sandboxNetwork } }))
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
    const system = `${baseSystem}\n\n## 你的身份\n你是一个名为「${task.name}」的 ${task.role} 子智能体，正在与其它子智能体协作完成一个更大的任务。请只专注于分配给你的子任务，完成后用简洁的中文总结你做了什么、改动了哪些文件、以及需要主智能体知道的关键结论。你不能再委派子任务，也不能向用户提问。不要修改其它子任务负责的文件。${task.toolAccess === 'read-only' ? '你只有读取与检索权限，不得修改文件或执行命令。' : ''}${ctx.model.systemPromptExtra?.trim() ? `\n\n## 模型专属提示\n${ctx.model.systemPromptExtra.trim()}` : ''}`
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
