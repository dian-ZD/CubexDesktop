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

vi.mock('../src/main/llm', () => ({
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

async function until(check: () => boolean, ms = 5000) {
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
  })

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

  it('缺少模型时拒绝发送', async () => {
    const { id } = await setup('ask')
    await store.update((draft) => {
      draft.settings.models = []
      draft.settings.defaultModelId = ''
      draft.threads[0].modelId = ''
    })
    await expect(runner.send(id, 'hi')).rejects.toThrow('请先在设置中添加模型')
  })
})
