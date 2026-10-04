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
  truncated?: boolean
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
const DEFAULT_MAX_TOKENS = 64_000
const MIN_MAX_TOKENS = 4_096

function resolveMaxTokens(request: ChatRequest): number {
  if (request.maxTokens && request.maxTokens > 0) return request.maxTokens
  const contextWindow = request.model.contextWindow
  if (contextWindow && contextWindow > 0) {
    const budget = Math.floor(contextWindow / 2)
    return Math.max(MIN_MAX_TOKENS, Math.min(DEFAULT_MAX_TOKENS, budget))
  }
  return DEFAULT_MAX_TOKENS
}

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

export interface DiscoveredModel {
  modelId: string
  contextWindow?: number
}

const KNOWN_CONTEXT_WINDOWS: Array<{ match: RegExp; window: number }> = [
  { match: /^(claude-3|claude-sonnet|claude-opus|claude-haiku|claude-3\.5|claude-3-5|claude-3\.7|claude-3-7|claude-4)/i, window: 200_000 },
  { match: /^(gpt-4\.1|gpt-4o|gpt-4-turbo|o1|o3|o4|gpt-5)/i, window: 128_000 },
  { match: /^gpt-4-32k/i, window: 32_768 },
  { match: /^gpt-4/i, window: 8_192 },
  { match: /^gpt-3\.5-turbo-16k/i, window: 16_384 },
  { match: /^gpt-3\.5/i, window: 16_385 },
  { match: /^(gemini-1\.5|gemini-2|gemini-exp)/i, window: 1_000_000 },
  { match: /^(deepseek-chat|deepseek-v3|deepseek-reasoner|deepseek-r1)/i, window: 64_000 },
  { match: /^(qwen2\.5|qwen-max|qwen-plus|qwen-turbo|qwen3)/i, window: 128_000 },
  { match: /^(llama-?3\.1|llama-?3\.3|llama3\.1|llama3\.3)/i, window: 128_000 },
  { match: /^(llama-?3|llama3)/i, window: 8_192 },
  { match: /^(mistral-large|mistral-small|mixtral|ministral)/i, window: 128_000 },
  { match: /^(moonshot|kimi)/i, window: 128_000 },
  { match: /^(glm-4|glm-4\.5|glm-z1)/i, window: 128_000 },
]

export function guessContextWindow(modelId: string): number | undefined {
  const id = modelId.trim().toLowerCase()
  for (const entry of KNOWN_CONTEXT_WINDOWS) if (entry.match.test(id)) return entry.window
  return undefined
}

const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context[_ ]?length/i,
  /maximum context/i,
  /max(?:imum)? (?:number of )?tokens/i,
  /too many tokens/i,
  /token limit/i,
  /reduce the length/i,
  /(?:input|prompt|request) is too long/i,
  /exceed(?:s|ed)?[^.\n]{0,40}(?:context|token)/i,
  /request entity too large/i,
  /\b413\b/,
]

/** 判断某个错误是否属于「输入超出模型上下文上限」类错误，用于触发自动压缩并重试。 */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))
}

export interface ContextProbe {
  contextWindow: number
  attempts: number
  capped: boolean
}

function buildFiller(tokens: number): string {
  const target = Math.max(1, Math.floor(tokens * 4))
  const unit = 'The quick brown fox jumps over the lazy dog and keeps walking. '
  let out = ''
  while (out.length < target) out += unit
  return out.slice(0, target)
}

/**
 * 通过二分法实测模型可接受的最大输入长度：发送递增的填充提示词，
 * 依据服务端返回的「上下文超限」错误确定上限。返回可行区间内最大的成功值。
 */
export async function probeContextWindow(input: {
  provider: ProviderConfig
  apiKey: string | undefined
  model: ModelConfig
  signal?: AbortSignal
  low?: number
  high?: number
  onProgress?: (info: { attempt: number; tokens: number; ok: boolean }) => void
}): Promise<ContextProbe> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const { signal } = controller
  const low0 = Math.max(2_000, Math.floor(input.low ?? 4_000))
  const cap = Math.min(4_000_000, Math.floor(input.high ?? 1_000_000))
  const guess = Math.max(low0, Math.min(cap, input.model.contextWindow ?? guessContextWindow(input.model.modelId) ?? 128_000))
  let attempts = 0
  let capped = false
  const probe = async (tokens: number): Promise<boolean> => {
    attempts++
    try {
      await streamChat({
        provider: input.provider,
        apiKey: input.apiKey,
        model: input.model,
        system: 'You are a helpful assistant.',
        messages: [{ id: 'probe', role: 'user', time: new Date().toISOString(), content: `请只回复“好”，不要重复我下面的填充文本。\n\n${buildFiller(tokens)}` }],
        tools: [],
        signal,
        onText: () => undefined,
        maxTokens: 16,
        timeoutMs: 60_000,
        retries: 0,
      })
      input.onProgress?.({ attempt: attempts, tokens, ok: true })
      return true
    } catch (error) {
      input.onProgress?.({ attempt: attempts, tokens, ok: false })
      if (signal.aborted) throw error
      if (isContextOverflowError(error)) return false
      throw error
    }
  }
  try {
    // 逐步抬高上界，直到超出上限或触顶
    let lo = low0
    let hi = guess
    if (!(await probe(guess))) {
      lo = Math.floor(guess / 2)
      while (lo > low0 && !(await probe(lo))) {
        hi = lo
        lo = Math.floor(lo / 2)
      }
      if (lo < low0) { lo = low0; hi = low0 * 2 }
    } else {
      lo = guess
      hi = Math.min(cap, guess * 2)
      while (hi > lo && (await probe(hi))) {
        lo = hi
        if (lo >= cap) { capped = true; return { contextWindow: cap, attempts, capped } }
        hi = Math.min(cap, lo * 2)
      }
    }
    const span = Math.max(1_024, Math.floor(lo * 0.05))
    while (hi - lo > span && attempts < 18) {
      const mid = Math.floor((lo + hi) / 2)
      if (await probe(mid)) lo = mid
      else hi = mid
    }
    // 若最低值本身都不被接受，返回一个保守的最小值
    return { contextWindow: lo, attempts, capped }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}

async function fetchJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim().slice(0, 400)
      const hint = statusHint(response.status)
      throw new HttpError(response.status, `模型服务返回 ${response.status}${text ? `：${text}` : ''}${hint ? `\n提示：${hint}` : ''}`)
    }
    return await response.json()
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (isNetworkError(error)) throw new Error(describeNetworkError(error, url), { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function listModels(provider: ProviderConfig, apiKey: string | undefined, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  if (provider.kind === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic 提供商需要 API Key 才能列出模型')
    const data = await fetchJson(endpoint(provider.baseUrl, '/v1/models'), { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal)
    const items = (data as { data?: Array<{ id?: string }> }).data ?? []
    return dedupeModels(items.map((item) => item.id).filter((id): id is string => !!id))
  }
  if (provider.kind === 'ollama') {
    const base = /\/v1\/?$/.test(provider.baseUrl) ? provider.baseUrl.replace(/\/v1\/?$/, '') : provider.baseUrl
    const data = await fetchJson(endpoint(base, '/api/tags'), {}, signal)
    const items = (data as { models?: Array<{ name?: string; model?: string; details?: { parameter_size?: string } }> }).models ?? []
    return dedupeModels(items.map((item) => item.name ?? item.model).filter((id): id is string => !!id))
  }
  const headers: Record<string, string> = {}
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const data = await fetchJson(endpoint(provider.baseUrl, '/models'), headers, signal)
  const items = (data as { data?: Array<{ id?: string; context_length?: number; context_window?: number }> }).data
    ?? (data as { models?: Array<{ id?: string }> }).models
    ?? []
  const out: DiscoveredModel[] = []
  for (const item of items) {
    const id = (item as { id?: string }).id
    if (!id) continue
    const raw = (item as { context_length?: number; context_window?: number }).context_length ?? (item as { context_window?: number }).context_window
    const contextWindow = typeof raw === 'number' && raw >= 4000 ? Math.min(raw, 4_000_000) : guessContextWindow(id)
    out.push({ modelId: id, contextWindow })
  }
  return dedupeDiscovered(out)
}

function dedupeModels(ids: string[]): DiscoveredModel[] {
  return dedupeDiscovered(ids.map((modelId) => ({ modelId, contextWindow: guessContextWindow(modelId) })))
}

function dedupeDiscovered(list: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Map<string, DiscoveredModel>()
  for (const item of list) if (!seen.has(item.modelId)) seen.set(item.modelId, item)
  return [...seen.values()].sort((a, b) => a.modelId.localeCompare(b.modelId))
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function repairJson(raw: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let out = raw
  if (inString) out += escaped ? '\\"' : '"'
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i]
  return out
}

function safeArgs(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = asObject(JSON.parse(text))
    if (parsed) return parsed
  } catch {
    try {
      const repaired = asObject(JSON.parse(repairJson(text)))
      if (repaired) return { ...repaired, __truncated: true }
    } catch {
      // 无法恢复，落到下方 __raw 分支
    }
  }
  return { __raw: raw }
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
    finish_reason?: string | null
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
    max_tokens: resolveMaxTokens(request),
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
  }
  const stream = await openStream(endpoint(base, '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body) }, request)
  let content = ''
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let usage: ChatTurn['usage']
  let truncated = false
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
    if (choice?.finish_reason === 'length') truncated = true
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
  return { content, toolCalls, usage, truncated }
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
    max_tokens: resolveMaxTokens(request),
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
  let truncated = false
  for await (const event of sseEvents(stream, request.signal)) {
    let payload: { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }; message?: { usage?: { input_tokens?: number } }; usage?: { output_tokens?: number }; error?: { message?: string } }
    try { payload = JSON.parse(event.data) } catch {
      if (event.raw) throw rawError(event.data)
      continue
    }
    if (payload.type === 'error' || (event.raw && payload.error)) throw new Error(`模型服务返回错误：${payload.error?.message ?? '未知错误'}`)
    if (payload.type === 'message_start') usage = { input: payload.message?.usage?.input_tokens ?? 0, output: 0 }
    else if (payload.type === 'message_delta') {
      if (payload.usage) usage = { input: usage?.input ?? 0, output: payload.usage.output_tokens ?? 0 }
      if (payload.delta?.stop_reason === 'max_tokens') truncated = true
    }
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
  return { content, toolCalls, usage, truncated }
}
