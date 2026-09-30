import { toolNames, type Message, type ModelConfig, type ProviderConfig, type ToolCall, type ToolName } from '../shared/schema'
import { describeNetworkError, isNetworkError, statusHint } from './errors'

export interface ToolSpec {
  name: ToolName
  description: string
  parameters: Record<string, unknown>
}

export interface ChatTurn {
  content: string
  toolCalls: ToolCall[]
  usage?: { input: number; output: number }
}

export interface ChatRequest {
  provider: ProviderConfig
  apiKey: string | undefined
  model: ModelConfig
  system: string
  messages: Message[]
  tools: ToolSpec[]
  signal: AbortSignal
  onText: (delta: string) => void
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  retries?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRIES = 2

export async function streamChat(input: ChatRequest): Promise<ChatTurn> {
  const request = { ...input, messages: sanitizeHistory(input.messages) }
  if (request.provider.kind === 'anthropic') return anthropicChat(request)
  return openaiChat(request)
}

export interface ConnectionResult {
  ok: boolean
  latencyMs: number
  message: string
}

export async function testConnection(provider: ProviderConfig, apiKey: string | undefined, model: ModelConfig, signal?: AbortSignal): Promise<ConnectionResult> {
  const started = Date.now()
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let text = ''
  try {
    const turn = await streamChat({
      provider, apiKey, model,
      system: '这是一次连接测试，请只回复“好”。',
      messages: [{ id: 'probe', role: 'user', time: new Date().toISOString(), content: '回复“好”' }],
      tools: [],
      signal: controller.signal,
      onText: (delta) => { text += delta },
      maxTokens: 16,
      timeoutMs: 30_000,
      retries: 0,
    })
    const reply = (turn.content || text).trim().slice(0, 60)
    return { ok: true, latencyMs: Date.now() - started, message: reply ? `连接成功，模型回复：${reply}` : '连接成功，但模型没有返回文本' }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: error instanceof Error ? error.message : String(error) }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

interface Stream {
  response: Response
  signal: AbortSignal
  idleMs: number
  touch: () => void
  dispose: () => void
}

async function openStream(url: string, init: RequestInit, request: ChatRequest): Promise<Stream> {
  const idleMs = Math.max(5_000, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const retries = Math.max(0, Math.min(request.retries ?? DEFAULT_RETRIES, 5))
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (request.signal.aborted) throw new Error('已取消')
    const controller = new AbortController()
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, idleMs)
    }
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    const dispose = () => { clearTimeout(timer); request.signal.removeEventListener('abort', onAbort) }
    touch()
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (!response.ok) {
        const text = (await response.text().catch(() => '')).trim().slice(0, 600)
        const hint = statusHint(response.status)
        throw new HttpError(response.status, `模型服务返回 ${response.status}${text ? `：${text}` : ''}${hint ? `\n提示：${hint}` : ''}`)
      }
      if (!response.body) throw new Error('模型服务没有返回响应体')
      touch()
      return { response, signal: controller.signal, idleMs, touch, dispose }
    } catch (error) {
      dispose()
      if (request.signal.aborted) throw error
      const retryable = error instanceof HttpError ? error.status === 429 || error.status >= 500 : timedOut || isNetworkError(error)
      lastError = timedOut
        ? new Error(`等待模型服务响应超过 ${Math.round(idleMs / 1000)} 秒，已放弃。可在设置中调大请求超时。`)
        : error instanceof HttpError || !isNetworkError(error) ? error : new Error(describeNetworkError(error, url))
      if (!retryable || attempt === retries) break
      await sleep(Math.min(8_000, 800 * 2 ** attempt), request.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function* sseEvents(stream: Stream, userSignal: AbortSignal): AsyncGenerator<{ event?: string; data: string; raw?: boolean }> {
  const reader = stream.response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawEvent = false
  const parse = (chunk: string) => {
    let event: string | undefined
    const data: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    return data.length ? { event, data: data.join('\n') } : undefined
  }
  try {
    while (!userSignal.aborted) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error) {
        if (userSignal.aborted) return
        if (stream.signal.aborted) throw new Error(`模型服务超过 ${Math.round(stream.idleMs / 1000)} 秒没有输出，已中断。可在设置中调大请求超时。`, { cause: error })
        throw isNetworkError(error) ? new Error('读取模型输出时连接中断，请重试', { cause: error }) : error
      }
      if (result.done) break
      stream.touch()
      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n?/g, '\n')
      let index: number
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const parsed = parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        if (parsed) { sawEvent = true; yield parsed }
      }
    }
    buffer += decoder.decode().replace(/\r\n?/g, '\n')
    const rest = buffer.trim()
    if (rest && !userSignal.aborted) {
      const parsed = parse(rest)
      if (parsed) yield parsed
      else if (!sawEvent) yield { data: rest, raw: true }
    }
  } finally {
    stream.dispose()
    reader.releaseLock()
    if (userSignal.aborted) await stream.response.body!.cancel().catch(() => undefined)
  }
}

function rawError(data: string): Error {
  const fallback = new Error(`模型服务返回了非流式内容：${data.slice(0, 300)}`)
  try {
    const payload = JSON.parse(data) as { error?: { message?: string } | string; message?: string }
    const message = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.message
    return message ? new Error(`模型服务返回错误：${message}`) : fallback
  } catch {
    return fallback
  }
}

export function sanitizeHistory(messages: Message[]): Message[] {
  const out: Message[] = []
  messages.forEach((message, index) => {
    if (message.role === 'system') return
    if (message.role === 'assistant') {
      const next = messages.slice(index + 1).find((item) => item.role !== 'system')
      const answered = new Set(next?.role === 'tool' ? next.results.map((result) => result.callId) : [])
      const toolCalls = message.toolCalls.filter((call) => answered.has(call.id))
      if (!message.content && toolCalls.length === 0) return
      out.push({ ...message, toolCalls })
      return
    }
    if (message.role === 'tool') {
      const previous = out[out.length - 1]
      const called = new Set(previous?.role === 'assistant' ? previous.toolCalls.map((call) => call.id) : [])
      const results = message.results.filter((result) => called.has(result.callId))
      if (results.length) out.push({ ...message, results })
      return
    }
    out.push(message)
  })
  return out
}

function toolCallId(prefix: string, index: number): string {
  return `${prefix}-${index}-${Date.now().toString(36)}`
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { __raw: raw }
  }
}

function finalizeCalls(entries: Array<[number, { id: string; name: string; args: string }]>): ToolCall[] {
  return entries
    .sort((a, b) => a[0] - b[0])
    .filter(([, call]) => (toolNames as readonly string[]).includes(call.name))
    .map(([index, call]) => ({ id: (call.id || toolCallId('call', index)).slice(0, 100), name: call.name as ToolName, args: safeArgs(call.args) }))
}

function toOpenAIMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.images?.length) {
        const parts: unknown[] = []
        if (message.content) parts.push({ type: 'text', text: message.content })
        for (const image of message.images) parts.push({ type: 'image_url', image_url: { url: image.dataUrl } })
        out.push({ role: 'user', content: parts })
      } else out.push({ role: 'user', content: message.content })
    }
    else if (message.role === 'assistant') {
      if (!message.content && message.toolCalls.length === 0) continue
      out.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}),
      })
    } else if (message.role === 'tool') {
      const pendingImages: string[] = []
      for (const result of message.results) {
        out.push({ role: 'tool', tool_call_id: result.callId, content: result.output })
        if (result.image) pendingImages.push(result.image)
      }
      if (pendingImages.length) {
        out.push({ role: 'user', content: pendingImages.map((url) => ({ type: 'image_url', image_url: { url } })) })
      }
    }
  }
  return out
}

type OpenAIChunk = {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string } | string
}

async function openaiChat(request: ChatRequest): Promise<ChatTurn> {
  const base = request.provider.kind === 'ollama' && !/\/v1\/?$/.test(request.provider.baseUrl) ? endpoint(request.provider.baseUrl, '/v1') : request.provider.baseUrl
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`
  const body = {
    model: request.model.modelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAIMessages(request.system, request.messages),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
  }
  const stream = await openStream(endpoint(base, '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body) }, request)
  let content = ''
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let usage: ChatTurn['usage']
  for await (const event of sseEvents(stream, request.signal)) {
    if (event.data === '[DONE]') break
    let payload: OpenAIChunk
    try { payload = JSON.parse(event.data) as OpenAIChunk } catch {
      if (event.raw) throw rawError(event.data)
      continue
    }
    if (payload.error) throw new Error(`模型服务返回错误：${typeof payload.error === 'string' ? payload.error : payload.error.message ?? '未知错误'}`)
    if (payload.usage) usage = { input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 }
    const choice = payload.choices?.[0]
    if (choice?.message) {
      if (choice.message.content) {
        content += choice.message.content
        request.onText(choice.message.content)
      }
      choice.message.tool_calls?.forEach((call, index) => calls.set(index, { id: call.id ?? toolCallId('call', index), name: call.function?.name ?? '', args: call.function?.arguments ?? '' }))
    }
    const delta = choice?.delta
    if (!delta) continue
    if (delta.content) {
      content += delta.content
      request.onText(delta.content)
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? calls.size
      const existing = calls.get(index) ?? { id: call.id || toolCallId('call', index), name: '', args: '' }
      if (call.id) existing.id = call.id
      if (call.function?.name) existing.name += call.function.name
      if (call.function?.arguments) existing.args += call.function.arguments
      calls.set(index, existing)
    }
  }
  const toolCalls = finalizeCalls([...calls.entries()])
  return { content, toolCalls, usage }
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.images?.length) {
        const blocks: unknown[] = []
        for (const image of message.images) {
          const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(image.dataUrl)
          if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
        }
        if (message.content) blocks.push({ type: 'text', text: message.content })
        out.push({ role: 'user', content: blocks.length ? blocks : message.content })
      } else out.push({ role: 'user', content: message.content })
    }
    else if (message.role === 'assistant') {
      const blocks: unknown[] = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
    } else if (message.role === 'tool') {
      out.push({ role: 'user', content: message.results.map((result) => {
        if (result.image) {
          const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(result.image)
          if (match) {
            return {
              type: 'tool_result',
              tool_use_id: result.callId,
              is_error: !result.ok,
              content: [
                { type: 'text', text: result.output },
                { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } },
              ],
            }
          }
        }
        return { type: 'tool_result', tool_use_id: result.callId, content: result.output, is_error: !result.ok }
      }) })
    }
  }
  return out
}

async function anthropicChat(request: ChatRequest): Promise<ChatTurn> {
  if (!request.apiKey) throw new Error('Anthropic 提供商需要 API Key')
  const body = {
    model: request.model.modelId,
    max_tokens: request.maxTokens || 8192,
    stream: true,
    system: request.system,
    messages: toAnthropicMessages(request.messages),
    ...(request.temperature !== undefined ? { temperature: Math.min(request.temperature, 1) } : {}),
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
  }
  const stream = await openStream(endpoint(request.provider.baseUrl, '/v1/messages'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': request.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  }, request)
  let content = ''
  const blocks = new Map<number, { id: string; name: string; json: string }>()
  let usage: ChatTurn['usage']
  for await (const event of sseEvents(stream, request.signal)) {
    let payload: { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string }; message?: { usage?: { input_tokens?: number } }; usage?: { output_tokens?: number }; error?: { message?: string } }
    try { payload = JSON.parse(event.data) } catch {
      if (event.raw) throw rawError(event.data)
      continue
    }
    if (payload.type === 'error' || (event.raw && payload.error)) throw new Error(`模型服务返回错误：${payload.error?.message ?? '未知错误'}`)
    if (payload.type === 'message_start') usage = { input: payload.message?.usage?.input_tokens ?? 0, output: 0 }
    else if (payload.type === 'message_delta' && payload.usage) usage = { input: usage?.input ?? 0, output: payload.usage.output_tokens ?? 0 }
    else if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
      blocks.set(payload.index ?? blocks.size, { id: payload.content_block.id ?? toolCallId('toolu', payload.index ?? 0), name: payload.content_block.name ?? '', json: '' })
    } else if (payload.type === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && payload.delta.text) {
        content += payload.delta.text
        request.onText(payload.delta.text)
      } else if (payload.delta?.type === 'input_json_delta') {
        const block = blocks.get(payload.index ?? 0)
        if (block) block.json += payload.delta.partial_json ?? ''
      }
    }
  }
  const toolCalls = finalizeCalls([...blocks.entries()].map(([index, block]) => [index, { id: block.id, name: block.name, args: block.json }]))
  return { content, toolCalls, usage }
}
