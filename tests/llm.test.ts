import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamChat, type ChatRequest } from '../src/main/llm'

const encoder = new TextEncoder()

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const request = (kind: ChatRequest['provider']['kind'], onText: (delta: string) => void): ChatRequest => ({
  provider: { id: 'p', name: 'P', kind, baseUrl: kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1', hasKey: true },
  apiKey: 'sk-test',
  model: { id: 'm', providerId: 'p', name: 'M', modelId: 'model-x' },
  system: 'sys',
  messages: [{ id: 'u', role: 'user', time: new Date().toISOString(), content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
  onText,
})

afterEach(() => vi.unstubAllGlobals())

describe('streamChat', () => {
  it('OpenAI 兼容：拼接跨块的文本与工具参数', async () => {
    const payloads = [
      { choices: [{ delta: { content: '你' } }] },
      { choices: [{ delta: { content: '好' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]
    const raw = payloads.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n'
    const fetchMock = vi.fn(async () => sse([raw.slice(0, 37), raw.slice(37, 120), raw.slice(120)]))
    vi.stubGlobal('fetch', fetchMock)
    const deltas: string[] = []
    const turn = await streamChat(request('openai-compatible', (d) => deltas.push(d)))
    expect(deltas).toEqual(['你', '好'])
    expect(turn.content).toBe('你好')
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }])
    expect(turn.usage).toEqual({ input: 10, output: 4 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  it('Anthropic：解析 text_delta 与 tool_use', async () => {
    const events = [
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 7 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的' } }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_command' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"npm test"}' } }],
      ['message_delta', { type: 'message_delta', usage: { output_tokens: 9 } }],
    ] as const
    const raw = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
    const fetchMock = vi.fn(async () => sse([raw]))
    vi.stubGlobal('fetch', fetchMock)
    const turn = await streamChat(request('anthropic', () => undefined))
    expect(turn.content).toBe('好的')
    expect(turn.toolCalls).toEqual([{ id: 'toolu_1', name: 'run_command', args: { command: 'npm test' } }])
    expect(turn.usage).toEqual({ input: 7, output: 9 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test')
  })

  it('HTTP 错误转换为可读信息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })))
    await expect(streamChat(request('openai-compatible', () => undefined))).rejects.toThrow('模型服务返回 401：bad key')
  })
})
