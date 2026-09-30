import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRunner } from '../src/main/agent'
import { streamChat } from '../src/main/llm'
import type { SecretStore } from '../src/main/secrets'
import { StateStore } from '../src/main/store'
import { toolSpecs } from '../src/main/tools'
import type { StreamDelta } from '../src/shared/schema'

const baseUrl = process.env.CUBEX_LIVE_BASE_URL
const apiKey = process.env.CUBEX_LIVE_API_KEY
const modelId = process.env.CUBEX_LIVE_MODEL
const enabled = Boolean(baseUrl && apiKey && modelId)

const provider = { id: 'live', name: 'Live', kind: 'openai-compatible' as const, baseUrl: baseUrl ?? '', hasKey: true }
const model = { id: 'lm', providerId: 'live', name: modelId ?? '', modelId: modelId ?? '' }

async function until(check: () => boolean, ms: number) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!enabled)('真实模型', () => {
  it('流式输出文本', async () => {
    const deltas: string[] = []
    const turn = await streamChat({
      provider, apiKey, model,
      system: '你是测试助手。',
      messages: [{ id: 'u', role: 'user', content: '只回复“收到”两个字', time: new Date().toISOString() }],
      tools: toolSpecs,
      signal: new AbortController().signal,
      onText: (delta) => deltas.push(delta),
    })
    expect(turn.content).toContain('收到')
    expect(deltas.join('')).toBe(turn.content)
    console.log(`[live] 流式片段 ${deltas.length} 个，usage=${JSON.stringify(turn.usage)}`)
  }, 90_000)

  it('Agent 循环：读文件、写文件、执行命令', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cubex-live-'))
    await writeFile(join(root, 'input.txt'), '42\n')
    const store = new StateStore(join(await mkdtemp(join(tmpdir(), 'cubex-live-state-')), 'state.json'))
    await store.load()
    await store.update((draft) => {
      draft.projects.push({ id: 'p', name: 'live', path: root })
      draft.settings.providers = [provider]
      draft.settings.models = [model]
      draft.settings.defaultModelId = 'lm'
      draft.settings.approvalMode = 'full-auto'
    })
    const secrets = { get: () => apiKey } as unknown as SecretStore
    const deltas: StreamDelta[] = []
    const runner = new AgentRunner(store, secrets, (delta) => deltas.push(delta))
    const { id } = await runner.createThread('p', 'lm')

    await runner.send(id, '先用 read_file 读取 input.txt 中的数字，再用 write_file 把它乘以 2 的结果写入 output.txt（只写数字），然后用 run_command 执行 node -e "console.log(require(\'fs\').readFileSync(\'output.txt\',\'utf8\'))" 确认内容，最后用一句话汇报。')
    const thread = () => store.get().threads.find((item) => item.id === id)!
    await until(() => thread().status === 'idle' && runner.runningCount() === 0, 240_000)

    const messages = thread().messages
    for (const message of messages) {
      if (message.role === 'assistant') console.log(`[live] assistant: ${message.content.slice(0, 200)} | tools=${message.toolCalls.map((call) => call.name).join(',')}`)
      if (message.role === 'tool') for (const result of message.results) console.log(`[live] tool ${result.name}: ${result.output.slice(0, 120).replace(/\n/g, ' ')}`)
      if (message.role === 'system') console.log(`[live] system: ${message.content}`)
    }
    const used = messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls.map((call) => call.name) : [])
    expect(used).toContain('read_file')
    expect(used).toContain('write_file')
    expect(used).toContain('run_command')
    expect((await readFile(join(root, 'output.txt'), 'utf8')).trim()).toBe('84')
    expect(deltas.length).toBeGreaterThan(0)
    expect(messages.at(-1)?.role).toBe('assistant')
  }, 300_000)
})
