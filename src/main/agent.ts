import { randomUUID } from 'node:crypto'
import { mergeModelParams, type ActivityPhase, type AgentActivity, type AssistantMessage, type Message, type MessageCard, type MessageImage, type PendingApproval, type PendingQuestion, type Settings, type StreamDelta, type Thread, type TodoItem, type ToolCall, type ToolResult } from '../shared/schema'
import { estimateTokens, fitContext } from './context'
import { describeError } from './errors'
import { streamChat, type ToolSpec } from './llm'
import { buildSystemPrompt } from './prompt'
import { ensureProjectFiles, PROJECT_FILES, readProjectFiles, renderProjectContext } from './projectFiles'
import type { SecretStore } from './secrets'
import type { StateStore } from './store'
import { commandTools, delegateTools, extensionToolNames, interactiveTools, matchesCommandRule, mutatingTools, runTool, sensitiveExtensionTools, summarizeCall, todoTools, toolSpecs } from './tools'

export interface ExtensionRunner {
  specs(settings: Settings): ToolSpec[]
  run(call: ToolCall, context: { root: string; signal: AbortSignal; threadId?: string }): Promise<{ output: string; image?: string }>
}

interface Run {
  controller: AbortController
  approval?: { callId: string; resolve: (approved: boolean) => void }
  question?: { callId: string; resolve: (answer: string | null) => void }
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

  async createThread(projectId: string, modelId: string): Promise<Thread> {
    const state = this.store.get()
    const project = state.projects.find((item) => item.id === projectId)
    if (!project) throw new Error('项目不存在，请重新选择目录')
    await ensureProjectFiles(project.path, project.name).catch(() => [])
    const now = new Date().toISOString()
    const thread: Thread = { id: randomUUID(), projectId, title: '新任务', modelId: modelId || state.settings.defaultModelId, status: 'idle', createdAt: now, updatedAt: now, messages: [] }
    await this.store.update((draft) => { draft.threads.push(thread) })
    return thread
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.cancel(threadId).catch(() => undefined)
    await this.store.update((draft) => { draft.threads = draft.threads.filter((item) => item.id !== threadId) })
  }

  async deleteProject(projectId: string): Promise<void> {
    const ids = this.store.get().threads.filter((item) => item.projectId === projectId).map((item) => item.id)
    for (const id of ids) await this.cancel(id).catch(() => undefined)
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
    const run: Run = { controller: new AbortController() }
    this.runs.set(threadId, run)
    void this.loop(threadId, run).catch(async (error: unknown) => {
      await this.system(threadId, 'error', describeError(error))
    }).finally(async () => {
      this.runs.delete(threadId)
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)
        if (target) { target.status = 'idle'; target.pending = undefined; target.question = undefined; target.updatedAt = new Date().toISOString() }
      })
      void this.drain(threadId)
    })
  }

  async dequeue(threadId: string, queuedId: string): Promise<void> {
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (target?.queue) target.queue = target.queue.filter((item) => item.id !== queuedId)
    })
  }

  private async start(threadId: string, content: string, modelId?: string, card?: MessageCard, images?: MessageImage[]): Promise<void> {
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
    const run: Run = { controller: new AbortController() }
    this.runs.set(threadId, run)
    void this.loop(threadId, run).catch(async (error: unknown) => {
      await this.system(threadId, 'error', describeError(error))
    }).finally(async () => {
      this.runs.delete(threadId)
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)
        if (target) { target.status = 'idle'; target.pending = undefined; target.question = undefined; target.updatedAt = new Date().toISOString() }
      })
      void this.drain(threadId)
    })
  }

  private async drain(threadId: string): Promise<void> {
    const thread = this.store.get().threads.find((item) => item.id === threadId)
    const next = thread?.queue?.[0]
    if (!thread || !next || thread.status !== 'idle' || this.runs.has(threadId)) return
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

      const messageId = randomUUID()
      const projectFiles = await readProjectFiles(project.path)
      const baseSystem = buildSystemPrompt(state.settings, project, { projectContext: renderProjectContext(projectFiles) })
      const extraParts = [
        thread.todos && thread.todos.length > 0 ? `## 当前任务待办（这份清单始终可见，即使历史被裁剪也不会丢失，请据此判断做到哪一步、还剩什么，并及时用 manage_todos 更新状态）\n${renderTodos(thread.todos)}` : '',
        model.systemPromptExtra?.trim() ? `## 模型专属提示\n${model.systemPromptExtra.trim()}` : '',
      ].filter(Boolean)
      const system = extraParts.length ? `${baseSystem}\n\n${extraParts.join('\n\n')}` : baseSystem
      const reserve = estimateTokens(system) + (modelParams.maxTokens || 8_000) + 1_500
      const { messages: history } = fitContext(thread.messages, { contextWindow: model.contextWindow, reserve, limit: modelParams.historyLimit })
      const placeholder: AssistantMessage = { id: messageId, role: 'assistant', time: new Date().toISOString(), content: '', toolCalls: [], modelId: model.id }
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)!
        target.messages = this.append(target.messages, placeholder)
      })
      this.activity(threadId, step === 0 ? 'thinking' : 'planning', step === 0 ? '正在理解你的需求…' : '正在规划下一步…', { step: step + 1 })
      let wroteText = false
      let turn
      try {
        turn = await streamChat({
          provider, apiKey, model, tools: [...toolSpecs, ...(this.extensions?.specs(state.settings) ?? [])], signal,
          system,
          messages: history,
          temperature: modelParams.temperature ?? undefined,
          maxTokens: modelParams.maxTokens || undefined,
          timeoutMs: modelParams.timeoutSec * 1000,
          retries: modelParams.retries,
          onText: (delta) => {
            if (!wroteText && delta.trim()) { wroteText = true; this.activity(threadId, 'writing', '正在撰写回复…', { step: step + 1 }) }
            this.emitDelta({ threadId, messageId, delta })
          },
        })
      } catch (error) {
        await this.dropEmpty(threadId, messageId)
        if (signal.aborted) return
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
      if (turn.usage) void this.onUsage({ input: turn.usage.input, output: turn.usage.output, modelId: model.id }).catch(() => undefined)
      if (turn.toolCalls.length === 0 || signal.aborted) return

      const results: ToolResult[] = []
      for (const call of turn.toolCalls) {
        if (signal.aborted) return
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
      await this.store.update((draft) => {
        const target = draft.threads.find((item) => item.id === threadId)!
        target.messages = this.append(target.messages, { id: randomUUID(), role: 'tool', time: new Date().toISOString(), results })
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
    const options = Array.isArray(call.args.options) ? call.args.options.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200)).slice(0, 6) : []
    const pending: PendingQuestion = { callId: call.id, question, options, multiple: call.args.multiple === true || undefined }
    const answerPromise = new Promise<string | null>((resolve) => {
      run.question = { callId: call.id, resolve }
      run.controller.signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)!
      target.status = 'awaiting-input'
      target.question = pending
    })
    const answer = await answerPromise
    run.question = undefined
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)!
      target.status = 'running'
      target.question = undefined
      if (answer) target.messages = this.append(target.messages, { id: randomUUID(), role: 'user', time: new Date().toISOString(), content: answer })
    })
    if (answer === null) return { callId: call.id, name: call.name, ok: false, denied: true, output: '用户未回答（已停止）。' }
    return { callId: call.id, name: call.name, ok: true, output: `用户回答：${answer}` }
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
    const tasks = raw
      .map((item, index) => {
        if (!item || typeof item !== 'object') return null
        const record = item as { name?: unknown; instruction?: unknown }
        const instruction = typeof record.instruction === 'string' ? record.instruction.trim() : ''
        if (!instruction) return null
        const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 40) : `子智能体 ${index + 1}`
        return { name, instruction: instruction.slice(0, 8000) }
      })
      .filter((item): item is { name: string; instruction: string } => item !== null)
      .slice(0, 4)
    if (tasks.length === 0) return { callId: call.id, name: call.name, ok: false, output: 'tasks 至少需要一个包含 instruction 的子任务' }

    const { signal } = run.controller
    const state = this.store.get()
    const thread = this.find(threadId)
    const model = state.settings.models.find((item) => item.id === thread.modelId)
    if (!model) return { callId: call.id, name: call.name, ok: false, output: '模型配置已被删除' }
    const provider = state.settings.providers.find((item) => item.id === model.providerId)
    if (!provider) return { callId: call.id, name: call.name, ok: false, output: '模型所属的提供商已被删除' }
    const apiKey = this.secrets.get(provider.id)
    if (provider.kind !== 'ollama' && !apiKey) return { callId: call.id, name: call.name, ok: false, output: `提供商「${provider.name}」尚未配置 API Key` }
    const project = state.projects.find((item) => item.id === thread.projectId)
    if (!project) return { callId: call.id, name: call.name, ok: false, output: '项目不存在' }

    this.activity(threadId, 'delegating', `启动 ${tasks.length} 个子智能体…`, { step, agents: tasks.map((item) => item.name) })
    const outcomes = await Promise.all(tasks.map((task) => this.runSubAgent(task, { provider, apiKey, model, project, settings: state.settings, signal, threadId, step })))
    const merged = outcomes.map((item) => `### ${item.name}\n${item.summary}`).join('\n\n')
    const failed = outcomes.filter((item) => !item.ok).length
    return { callId: call.id, name: call.name, ok: failed === 0, output: `已完成 ${outcomes.length - failed}/${outcomes.length} 个子任务。\n\n${merged}`.slice(0, 60_000) }
  }

  private async runSubAgent(
    task: { name: string; instruction: string },
    ctx: { provider: Parameters<typeof streamChat>[0]['provider']; apiKey: string | undefined; model: Parameters<typeof streamChat>[0]['model']; project: Parameters<typeof buildSystemPrompt>[1]; settings: Settings; signal: AbortSignal; threadId: string; step: number },
  ): Promise<{ name: string; ok: boolean; summary: string }> {
    const { settings, project, signal, threadId } = ctx
    const modelParams = mergeModelParams(settings.modelParams, ctx.model.params)
    const subSteps = Math.max(3, Math.min(Math.ceil(settings.agent.maxSteps / 2), 20))
    const projectFiles = await readProjectFiles(project.path).catch(() => [])
    const baseSystem = buildSystemPrompt(settings, project, { projectContext: renderProjectContext(projectFiles) })
    const system = `${baseSystem}\n\n## 你的身份\n你是一个名为「${task.name}」的子智能体，正在与其它子智能体协作完成一个更大的任务。请只专注于分配给你的子任务，完成后用简洁的中文总结你做了什么、改动了哪些文件、以及需要主智能体知道的关键结论。你不能再委派子任务，也不能向用户提问。`
    const messages: Message[] = [{ id: randomUUID(), role: 'user', time: new Date().toISOString(), content: task.instruction }]
    const subTools = toolSpecs.filter((spec) => spec.name !== 'delegate' && spec.name !== 'ask_user')
    let finalText = ''
    try {
      for (let i = 0; i < subSteps && !signal.aborted; i++) {
        this.activity(threadId, 'delegating', `「${task.name}」执行中…`, { step: ctx.step, detail: `第 ${i + 1} 步`, agents: [task.name] })
        const reserve = estimateTokens(system) + (modelParams.maxTokens || 8_000) + 1_500
        const { messages: history } = fitContext(messages, { contextWindow: ctx.model.contextWindow, reserve, limit: modelParams.historyLimit })
        const turn = await streamChat({
          provider: ctx.provider, apiKey: ctx.apiKey, model: ctx.model, tools: subTools, signal,
          system, messages: history,
          temperature: modelParams.temperature ?? undefined,
          maxTokens: modelParams.maxTokens || undefined,
          timeoutMs: modelParams.timeoutSec * 1000,
          retries: modelParams.retries,
          onText: () => undefined,
        })
        if (turn.usage) void this.onUsage({ input: turn.usage.input, output: turn.usage.output, modelId: ctx.model.id }).catch(() => undefined)
        finalText = turn.content || finalText
        messages.push({ id: randomUUID(), role: 'assistant', time: new Date().toISOString(), content: turn.content, toolCalls: turn.toolCalls, modelId: ctx.model.id })
        if (turn.toolCalls.length === 0) break
        const results: ToolResult[] = []
        for (const sub of turn.toolCalls) {
          if (signal.aborted) break
          if (interactiveTools.has(sub.name) || todoTools.has(sub.name) || delegateTools.has(sub.name)) {
            results.push({ callId: sub.id, name: sub.name, ok: false, output: '子智能体不可使用该工具' })
            continue
          }
          const decision = await this.authorize(threadId, this.runs.get(threadId)!, sub)
          if (!decision.approved) {
            results.push({ callId: sub.id, name: sub.name, ok: false, denied: true, output: decision.reason ?? '被拒绝' })
            continue
          }
          if (extensionToolNames.has(sub.name)) results.push(await this.runExtension(sub, project.path, signal, threadId))
          else results.push(await runTool(sub, { root: project.path, signal, commandTimeoutMs: settings.agent.commandTimeoutSec * 1000, shell: settings.agent.shell, sandbox: { enabled: settings.permissions.sandbox, allowNetwork: settings.permissions.sandboxNetwork } }))
        }
        messages.push({ id: randomUUID(), role: 'tool', time: new Date().toISOString(), results })
      }
      return { name: task.name, ok: !signal.aborted, summary: (finalText || '（子智能体未产出文字总结）').slice(0, 12_000) }
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
    const approvedPromise = new Promise<boolean>((resolve) => {
      run.approval = { callId: call.id, resolve }
      run.controller.signal.addEventListener('abort', () => resolve(false), { once: true })
    })
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)!
      target.status = 'awaiting-approval'
      target.pending = pending
    })
    const approved = await approvedPromise
    run.approval = undefined
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)!
      target.status = 'running'
      target.pending = undefined
    })
    return { approved }
  }
}
