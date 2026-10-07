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

  it.each(['openai-compatible', 'anthropic'] as const)('在 %s 响应体中遇到上游超时且尚无文本时重试', async (kind) => {
    const failure = kind === 'anthropic'
      ? { type: 'error', error: { message: 'context deadline exceeded (Client.Timeout or context cancellation while reading body)' } }
      : { error: { message: 'context deadline exceeded (Client.Timeout or context cancellation while reading body)' } }
    const success = kind === 'anthropic'
      ? `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '恢复成功' } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
      : `data: ${JSON.stringify({ choices: [{ delta: { content: '恢复成功' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([`data: ${JSON.stringify(failure)}\n\n`]))
      .mockResolvedValueOnce(sse([success]))
    vi.stubGlobal('fetch', fetchMock)
    const deltas: string[] = []
    const turn = await streamChat({ ...request(kind, (delta) => deltas.push(delta)), retries: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(deltas).toEqual(['恢复成功'])
    expect(turn.content).toBe('恢复成功')
  })

  it('已有文本后遇到上游超时不自动重放请求', async () => {
    const fetchMock = vi.fn(async () => sse([
      'data: {"choices":[{"delta":{"content":"已经收到的内容"}}]}\n\n',
      'data: {"error":{"message":"context deadline exceeded"}}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const deltas: string[] = []
    await expect(streamChat({ ...request('openai-compatible', (delta) => deltas.push(delta)), retries: 3 })).rejects.toThrow('本地请求超时设置不能改变服务端时限')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(deltas).toEqual(['已经收到的内容'])
  })

  it('重试耗尽后保留服务端原始错误和诊断信息', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'context deadline exceeded' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(streamChat({ ...request('openai-compatible', () => undefined), retries: 1 })).rejects.toThrow('context deadline exceeded')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('重试等待期间取消会立即结束且不再请求', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => sse(['data: {"error":{"message":"context deadline exceeded"}}\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const result = streamChat({ ...request('openai-compatible', () => undefined), signal: controller.signal, retries: 3 })
    const assertion = expect(result).rejects.toThrow('已取消')
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      await assertion
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(timer)
    }
  })

  it('收到结束标记后释放仍未关闭的响应体', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n'))
      },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const turn = await streamChat(request('openai-compatible', () => undefined))
    expect(turn.content).toBe('完成')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
