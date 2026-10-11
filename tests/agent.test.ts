import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, ChatTurn } from '../src/main/llm'
import type { SecretStore } from '../src/main/secrets'
import { StateStore } from '../src/main/store'
import type { Settings, StreamDelta } from '../src/shared/schema'

const turns: ChatTurn[] = []
const requests: ChatRequest[] = []

vi.mock('../src/main/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/llm')>(),
  streamChat: vi.fn(async (request: ChatRequest) => {
    requests.push({ ...request, messages: structuredClone(request.messages) })
    const turn = turns.shift() ?? { content: '完成', toolCalls: [] }
    if (turn.content) request.onText(turn.content)
    return turn
  }),
}))

const { AgentRunner } = await import('../src/main/agent')

let root: string
let store: StateStore
let runner: InstanceType<typeof AgentRunner>
let deltas: StreamDelta[]

const secrets = { get: () => undefined } as unknown as SecretStore

async function until(check: () => boolean, ms = 15_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function setup(mode: Settings['approvalMode']) {
  root = await mkdtemp(join(tmpdir(), 'cubex-agent-'))
  store = new StateStore(join(await mkdtemp(join(tmpdir(), 'cubex-agent-state-')), 'state.json'))
  await store.load()
  await store.update((draft) => {
    draft.projects.push({ id: 'p', name: 'demo', path: root })
    draft.settings.providers = [{ id: 'local', name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', hasKey: false }]
    draft.settings.models = [{ id: 'm', providerId: 'local', name: 'Qwen', modelId: 'qwen' }]
    draft.settings.defaultModelId = 'm'
    draft.settings.approvalMode = mode
  })
  deltas = []
  runner = new AgentRunner(store, secrets, (delta) => deltas.push(delta))
  return runner.createThread('p', 'm')
}

const thread = (id: string) => store.get().threads.find((item) => item.id === id)!
const idle = (id: string) => () => thread(id).status === 'idle' && runner.runningCount() === 0
const writeCall = { id: 'w1', name: 'write_file' as const, args: { path: 'hello.txt', content: 'hi' } }

beforeEach(() => {
  turns.length = 0
  requests.length = 0
})

describe('AgentRunner', () => {
  it('模型流式输出后失败时保留已收到的文本，继续请求能读取该内容', async () => {
    const { id } = await setup('auto-edit')
    const { streamChat } = await import('../src/main/llm')
    vi.mocked(streamChat).mockImplementationOnce(async (request) => {
      request.onText('已完成第一部分。')
      request.onText('第二部分尚未完成。')
      throw new Error('模型服务返回错误：context deadline exceeded')
    })
    await runner.send(id, '完成两部分任务')
    await until(idle(id))
    expect(thread(id).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: '已完成第一部分。第二部分尚未完成。', toolCalls: [] }),
      expect.objectContaining({ role: 'system', level: 'error', content: expect.stringContaining('context deadline exceeded') }),
    ]))
    await runner.send(id, '继续')
    await until(idle(id))
    expect(requests.at(-1)?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: '已完成第一部分。第二部分尚未完成。' }),
      expect.objectContaining({ role: 'user', content: '继续' }),
    ]))
  })

  it('执行工具后把结果回传给模型，并流式推送文本', async () => {
    const { id } = await setup('auto-edit')
    turns.push({ content: '我来创建文件', toolCalls: [writeCall] }, { content: '已创建', toolCalls: [] })
    await runner.send(id, '创建 hello.txt')
    await until(idle(id))

    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hi')
    const roles = thread(id).messages.map((message) => message.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(thread(id).title).toBe('创建 hello.txt')
    expect(deltas.map((item) => item.delta)).toEqual(['我来创建文件', '已创建'])

    expect(requests).toHaveLength(2)
    expect(requests[0].messages.map((message) => message.role)).toEqual(['user'])
    expect(requests[1].messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('逐项确认模式下拒绝写入不会修改文件', async () => {
    const { id } = await setup('ask')
    turns.push({ content: '', toolCalls: [writeCall] })
    await runner.send(id, '写文件')
    await until(() => thread(id).status === 'awaiting-approval')
    expect(thread(id).pending?.summary).toBe('写入 hello.txt')

    await runner.resolveApproval(id, 'w1', false)
    await until(idle(id))
    await expect(readFile(join(root, 'hello.txt'), 'utf8')).rejects.toThrow()
    const tool = thread(id).messages.find((message) => message.role === 'tool')
    expect(tool?.role === 'tool' && tool.results[0].denied).toBe(true)
  })

  it('批准后执行写入', async () => {
    const { id } = await setup('ask')
    turns.push({ content: '', toolCalls: [writeCall] })
    await runner.send(id, '写文件')
    await until(() => thread(id).status === 'awaiting-approval')
    await expect(runner.resolveApproval(id, 'other', true)).rejects.toThrow('没有待处理的审批')
    await runner.resolveApproval(id, 'w1', true)
    await until(idle(id))
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hi')
  })

  it('自动编辑模式下执行命令仍需审批，停止后恢复空闲', async () => {
    const { id } = await setup('auto-edit')
    turns.push({ content: '', toolCalls: [{ id: 'r1', name: 'run_command', args: { command: 'echo hi' } }] })
    await runner.send(id, '跑命令')
    await until(() => thread(id).status === 'awaiting-approval')
    await runner.send(id, '再来')
    expect(thread(id).queue?.map((item) => item.content)).toEqual(['再来'])

    await runner.cancel(id)
    await until(idle(id))
    expect(thread(id).pending).toBeUndefined()
    expect(thread(id).queue ?? []).toEqual([])
    expect(thread(id).messages.some((message) => message.role === 'tool')).toBe(false)
    expect(thread(id).messages.at(-1)).toMatchObject({ role: 'system', content: '已停止本轮回复。' })
  })

  it('创建任务时自动补齐项目上下文文件，并注入系统提示词', async () => {
    const { id } = await setup('auto-edit')
    expect(await readFile(join(root, 'goal.md'), 'utf8')).toContain('# 目标')
    await runner.send(id, '你好')
    await until(idle(id))
    expect(requests[0].system).toContain('# 项目上下文文件（自动引用）')
    expect(requests[0].system).toContain('## plan.md')
  })

  it('ask_user 会挂起会话等待回答，回答后继续并把答案回传模型', async () => {
    const { id } = await setup('ask')
    turns.push({ content: '', toolCalls: [{ id: 'q1', name: 'ask_user', args: { question: '用哪种框架？', options: ['React', 'Vue'] } }] }, { content: '好的，用 React', toolCalls: [] })
    await runner.send(id, '搭个前端')
    await until(() => thread(id).status === 'awaiting-input')
    expect(thread(id).question).toMatchObject({ callId: 'q1', question: '用哪种框架？', options: ['React', 'Vue'] })

    await runner.answerQuestion(id, 'q1', 'React')
    await until(idle(id))
    expect(thread(id).question).toBeUndefined()
    const toolResult = thread(id).messages.find((message) => message.role === 'tool')
    expect(toolResult && toolResult.role === 'tool' ? toolResult.results[0].output : '').toContain('React')
    expect(thread(id).messages.at(-1)).toMatchObject({ role: 'assistant', content: '好的，用 React' })
  })

  it('排队消息在本轮结束后自动发送', async () => {
    const { id } = await setup('auto-edit')
    turns.push({ content: '', toolCalls: [{ id: 'r1', name: 'run_command', args: { command: 'echo hi' } }] }, { content: '第一轮完成', toolCalls: [] }, { content: '第二轮完成', toolCalls: [] })
    await runner.send(id, '第一条')
    await until(() => thread(id).status === 'awaiting-approval')
    await runner.send(id, '第二条')
    expect(thread(id).queue).toHaveLength(1)
    await runner.resolveApproval(id, 'r1', true)
    await until(() => idle(id)() && thread(id).messages.filter((message) => message.role === 'user').length === 2)
    expect(thread(id).queue ?? []).toEqual([])
    expect(thread(id).messages.at(-1)).toMatchObject({ role: 'assistant', content: '第二轮完成' })
  }, 30_000)

  it('推荐项默认仍等待用户，用户可选择其他选项', async () => {
    const { id } = await setup('ask')
    expect(store.get().settings.agent.autoSelectRecommended).toBe(false)
    turns.push({ content: '', toolCalls: [{ id: 'recommended-manual', name: 'ask_user', args: { question: '选择框架，推荐 React', options: ['React', 'Vue'], recommended: 'React' } }] })
    await runner.send(id, '选择实现方案')
    await until(() => thread(id).status === 'awaiting-input')
    expect(thread(id).question?.recommended).toBe('React')
    await runner.answerQuestion(id, 'recommended-manual', 'Vue')
    await until(idle(id))
    expect(thread(id).messages.some((message) => message.role === 'user' && message.content === 'Vue')).toBe(true)
  })

  it('开启自动推荐后不弹出询问，并明确记录自动选择来源', async () => {
    const { id } = await setup('ask')
    await store.update((draft) => { draft.settings.agent.autoSelectRecommended = true })
    let asked = false
    const unsubscribe = store.subscribe((state) => {
      if (state.threads.find((item) => item.id === id)?.status === 'awaiting-input') asked = true
    })
    turns.push({ content: '', toolCalls: [{ id: 'recommended-auto', name: 'ask_user', args: { question: '选择方案', options: ['A', 'B'], recommended: 'B', multiple: true } }] })
    try {
      await runner.send(id, '按推荐方案处理')
      await until(idle(id))
      expect(asked).toBe(false)
      expect(thread(id).question).toBeUndefined()
      const result = thread(id).messages.find((message) => message.role === 'tool')
      expect(result?.role === 'tool' && result.results[0].output).toBe('已按用户配置自动选择推荐项：B')
      expect(thread(id).messages.some((message) => message.role === 'system' && message.content === '已按设置自动选择推荐项：B')).toBe(true)
      expect(thread(id).messages.some((message) => message.role === 'user' && message.content === 'B')).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  it.each([undefined, '不存在'])('自动推荐遇到无效推荐 %s 时仍询问，取消可释放等待', async (recommended) => {
    const { id } = await setup('ask')
    await store.update((draft) => { draft.settings.agent.autoSelectRecommended = true })
    turns.push({ content: '', toolCalls: [{ id: 'recommended-invalid', name: 'ask_user', args: { question: '请选择', options: ['A', 'B'], recommended } }] })
    await runner.send(id, '需要用户决定')
    await until(() => thread(id).status === 'awaiting-input')
    expect(thread(id).question?.recommended).toBeUndefined()
    await runner.cancel(id)
    await until(idle(id))
    expect(thread(id).question).toBeUndefined()
  })

  it('自动推荐配置不绕过工具审批', async () => {
    const { id } = await setup('auto-edit')
    await store.update((draft) => { draft.settings.agent.autoSelectRecommended = true })
    turns.push({ content: '', toolCalls: [{ id: 'r1', name: 'run_command', args: { command: 'echo hi' } }] }, { content: '第一轮完成', toolCalls: [] }, { content: '第二轮完成', toolCalls: [] })
    await runner.send(id, '第一条')
    await until(() => thread(id).status === 'awaiting-approval')
    await runner.send(id, '第二条')
    expect(thread(id).queue).toHaveLength(1)
    await runner.resolveApproval(id, 'r1', true)
    await until(() => idle(id)() && thread(id).messages.filter((message) => message.role === 'user').length === 2)
    expect(thread(id).queue ?? []).toEqual([])
    expect(thread(id).messages.at(-1)).toMatchObject({ role: 'assistant', content: '第二轮完成' })
  }, 30_000)

  it('完全自动模式下电脑控制免审批直接执行，GitHub 推送在只读模式下被拒绝', async () => {
    const { id } = await setup('full-auto')
    turns.push({ content: '', toolCalls: [{ id: 'c1', name: 'computer_use', args: { action: 'screenshot' } }] })
    await runner.send(id, '截个屏')
    await until(() => idle(id)() && thread(id).messages.some((message) => message.role === 'tool'))
    expect(thread(id).pending).toBeUndefined()

    await store.update((draft) => { draft.settings.permissions.readOnly = true })
    turns.push({ content: '', toolCalls: [{ id: 'g1', name: 'github_push', args: {} }] })
    await runner.send(id, '推送')
    await until(() => idle(id)() && thread(id).messages.filter((message) => message.role === 'tool').length === 2)
    const last = thread(id).messages.filter((message) => message.role === 'tool').at(-1)
    expect(last?.role === 'tool' && last.results[0].denied).toBe(true)
  })

  it('按独立模型和只读角色执行配置，拒绝模型越权调用', async () => {
    const { id } = await setup('full-auto')
    await store.update((draft) => {
      draft.settings.models.push({ id: 'research-model', providerId: 'local', name: 'Research', modelId: 'research' })
      draft.settings.agent.subagentProfiles = [{ id: 'research-profile', name: '研究员', role: 'researcher', modelId: 'research-model', instruction: '只研究接口', toolAccess: 'project' }]
    })
    turns.push(
      { content: '', toolCalls: [{ id: 'delegate-1', name: 'delegate', args: { tasks: [{ profileId: 'research-profile', instruction: '检查接口' }] } }] },
      { content: '尝试写文件', toolCalls: [writeCall] },
      { content: '已完成只读研究', toolCalls: [] },
      { content: '研究已汇总', toolCalls: [] },
    )
    await runner.send(id, '委派研究')
    await until(idle(id))
    await expect(readFile(join(root, 'hello.txt'), 'utf8')).rejects.toThrow()
    const childRequests = requests.filter((request) => request.model.id === 'research-model')
    expect(childRequests).toHaveLength(2)
    expect(childRequests[0].system).toContain('researcher')
    const childInstruction = childRequests[0].messages[0]
    expect(childInstruction.role).toBe('user')
    expect(childInstruction.role === 'user' && childInstruction.content).toContain('只研究接口')
    expect(childRequests[0].tools?.some((tool) => tool.name === 'write_file' || tool.name === 'run_command' || tool.name === 'delegate')).toBe(false)
    expect(thread(id).subagentRuns).toEqual([expect.objectContaining({ modelId: 'research-model', role: 'researcher', status: 'completed', summary: '已完成只读研究' })])
  })

  it('单批超过四个子任务不被截断，并按并发上限排队', async () => {
    const { id } = await setup('full-auto')
    await store.update((draft) => { draft.settings.agent.maxConcurrentSubagents = 1 })
    let peak = 0
    let sawQueue = false
    const unsubscribe = store.subscribe((state) => {
      const runs = state.threads.find((item) => item.id === id)?.subagentRuns ?? []
      peak = Math.max(peak, runs.filter((item) => item.status === 'running').length)
      if (runs.some((item) => item.status === 'queued')) sawQueue = true
    })
    turns.push(
      { content: '', toolCalls: [{ id: 'delegate-many', name: 'delegate', args: { tasks: Array.from({ length: 6 }, (_, index) => ({ name: `任务${index}`, instruction: `读取模块${index}` })) } }] },
      ...Array.from({ length: 6 }, (_, index): ChatTurn => ({ content: `结果${index}`, toolCalls: [] })),
      { content: '六项已汇总', toolCalls: [] },
    )
    try {
      await runner.send(id, '并行处理六项任务')
      await until(idle(id))
      expect(peak).toBe(1)
      expect(sawQueue).toBe(true)
      expect(thread(id).subagentRuns).toHaveLength(6)
      expect(thread(id).subagentRuns?.every((item) => item.status === 'completed')).toBe(true)
      const result = thread(id).messages.find((message) => message.role === 'tool')
      expect(result?.role === 'tool' && result.results[0].output).toContain('已完成 6/6')
    } finally {
      unsubscribe()
    }
  })

  it('多个子智能体等待审批时取消会释放全部任务且不写文件', async () => {
    const { id } = await setup('ask')
    turns.push(
      { content: '', toolCalls: [{ id: 'delegate-cancel', name: 'delegate', args: { tasks: [{ instruction: '创建第一个文件' }, { instruction: '创建第二个文件' }] } }] },
      { content: '', toolCalls: [writeCall] },
      { content: '', toolCalls: [{ ...writeCall, args: { path: 'second.txt', content: 'second' } }] },
    )
    await runner.send(id, '创建两个文件')
    await until(() => thread(id).status === 'awaiting-approval' && requests.length >= 3)
    const pendingId = thread(id).pending?.callId
    expect(pendingId).toMatch(/:w1$/)
    await runner.cancel(id)
    await until(idle(id))
    expect(thread(id).pending).toBeUndefined()
    expect(thread(id).subagentRuns).toHaveLength(2)
    expect(thread(id).subagentRuns?.every((item) => item.status === 'cancelled')).toBe(true)
    await expect(readFile(join(root, 'hello.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'second.txt'), 'utf8')).rejects.toThrow()
  })

  it('缺少模型时拒绝发送', async () => {
    const { id } = await setup('ask')
    await store.update((draft) => {
      draft.settings.models = []
      draft.settings.defaultModelId = ''
      draft.threads[0].modelId = ''
    })
    await expect(runner.send(id, 'hi')).rejects.toThrow('请先在设置中添加模型')
  })

  it('并发子任务复用工具调用 ID 时仍逐项审批，不串审批结果', async () => {
    const { id } = await setup('ask')
    turns.push(
      { content: '', toolCalls: [{ id: 'delegate-approve', name: 'delegate', args: { tasks: [{ name: 'first', instruction: '创建第一个文件' }, { name: 'second', instruction: '创建第二个文件' }] } }] },
      { content: '', toolCalls: [writeCall] },
      { content: '', toolCalls: [{ ...writeCall, args: { path: 'second.txt', content: 'second' } }] },
      { content: '子任务完成', toolCalls: [] },
      { content: '子任务完成', toolCalls: [] },
      { content: '已汇总', toolCalls: [] },
    )
    await runner.send(id, '分别审批两个文件')
    await until(() => thread(id).status === 'awaiting-approval' && requests.length >= 3)
    const first = thread(id).pending!
    expect(first.callId).toMatch(/:w1$/)
    await runner.resolveApproval(id, first.callId, true)
    await until(() => thread(id).status === 'awaiting-approval' && thread(id).pending?.callId !== first.callId)
    const second = thread(id).pending!
    expect(second.callId).toMatch(/:w1$/)
    expect(second.callId).not.toBe(first.callId)
    await expect(runner.resolveApproval(id, first.callId, true)).rejects.toThrow('没有待处理的审批')
    await runner.resolveApproval(id, second.callId, false)
    await until(idle(id))
    expect(await readFile(join(root, String(first.args.path)), 'utf8')).toBe(first.args.content)
    await expect(readFile(join(root, String(second.args.path)), 'utf8')).rejects.toThrow()
    expect(thread(id).pending).toBeUndefined()
    expect(thread(id).subagentRuns).toHaveLength(2)
  })

  it('子任务模型不存在时保留失败结果，其余子任务继续执行', async () => {
    const { id } = await setup('ask')
    turns.push(
      { content: '', toolCalls: [{ id: 'delegate-partial', name: 'delegate', args: { tasks: [{ name: 'missing', modelId: 'deleted-model', instruction: '研究接口' }, { name: 'valid', instruction: '研究结构' }] } }] },
      { content: '结构分析完成', toolCalls: [] },
      { content: '一项失败，一项完成', toolCalls: [] },
    )
    await runner.send(id, '执行两个研究任务')
    await until(idle(id))
    expect(thread(id).subagentRuns).toEqual([
      expect.objectContaining({ name: 'missing', status: 'failed', summary: expect.stringContaining('deleted-model') }),
      expect.objectContaining({ name: 'valid', status: 'completed', summary: '结构分析完成' }),
    ])
    const result = thread(id).messages.find((message) => message.role === 'tool')
    expect(result?.role === 'tool' && result.results[0].ok).toBe(false)
    expect(result?.role === 'tool' && result.results[0].output).toContain('已完成 1/2')
  })
})
