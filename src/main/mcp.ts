import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { McpServer, McpStatus } from '../shared/schema'

const PROTOCOL_VERSION = '2024-11-05'
const START_TIMEOUT = 60_000
const CALL_TIMEOUT = 120_000
const MAX_OUTPUT = 40_000

export interface McpTool {
  name: string
  description: string
  inputSchema?: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type RpcMessage = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }

const configKey = (server: McpServer) => JSON.stringify([server.command, server.args, server.env, server.name])
const quoteArg = (arg: string) => (/[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function formatToolResult(result: unknown): string {
  const data = (result ?? {}) as { content?: unknown; isError?: boolean; structuredContent?: unknown }
  const parts: string[] = []
  if (Array.isArray(data.content)) {
    for (const item of data.content as { type?: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]) {
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      else if (item.type === 'resource' && item.resource) parts.push(item.resource.text ?? `[资源] ${item.resource.uri ?? ''}`)
      else if (item.type === 'image' || item.type === 'audio') parts.push(`[${item.type === 'image' ? '图片' : '音频'} ${item.mimeType ?? ''}]`)
      else parts.push(JSON.stringify(item))
    }
  }
  if (!parts.length && data.structuredContent !== undefined) parts.push(JSON.stringify(data.structuredContent, null, 2))
  const text = parts.join('\n').trim() || '（无输出）'
  const clipped = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（已截断，共 ${text.length} 字符）` : text
  return data.isError ? `[工具返回错误]\n${clipped}` : clipped
}

export class McpClient {
  status: McpStatus['status'] = 'stopped'
  error?: string
  tools: McpTool[] = []
  private child?: ChildProcessWithoutNullStreams
  private buffer = ''
  private stderr = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private starting?: Promise<void>

  constructor(readonly server: McpServer) {}

  get key(): string {
    return configKey(this.server)
  }

  start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.connect().catch((error: unknown) => {
      this.status = 'error'
      this.error = message(error)
      this.kill()
      throw error
    })
    return this.starting
  }

  private async connect(): Promise<void> {
    this.status = 'connecting'
    this.error = undefined
    const windows = process.platform === 'win32'
    const child = spawn(windows ? [this.server.command, ...this.server.args].map(quoteArg).join(' ') : this.server.command, windows ? [] : this.server.args, {
      shell: windows,
      windowsHide: true,
      env: { ...process.env, ...this.server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2000) })
    child.on('error', (error) => this.onExit(`启动失败：${error.message}`))
    child.on('close', (code) => this.onExit(`进程已退出（退出码 ${code ?? 'null'}）${this.stderr.trim() ? `：${this.stderr.trim().slice(-500)}` : ''}`))
    child.stdin.on('error', () => undefined)
    await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Cubex', version: '1.0.0' } }, START_TIMEOUT)
    this.notify('notifications/initialized')
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, START_TIMEOUT) as { tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[]; nextCursor?: string }
      for (const tool of result.tools ?? []) {
        if (typeof tool.name === 'string') tools.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', inputSchema: tool.inputSchema })
      }
      cursor = result.nextCursor
      if (!cursor) break
    }
    this.tools = tools
    this.status = 'ready'
  }

  async call(tool: string, args: unknown, signal: AbortSignal): Promise<string> {
    await this.start()
    if (!this.tools.some((item) => item.name === tool)) throw new Error(`MCP 服务器「${this.server.name}」没有工具「${tool}」`)
    const id = this.nextId
    const abort = () => this.notify('notifications/cancelled', { requestId: id, reason: '用户取消' })
    signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await this.request('tools/call', { name: tool, arguments: args && typeof args === 'object' ? args : {} }, CALL_TIMEOUT, signal)
      return formatToolResult(result)
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  stop(): void {
    this.kill()
    this.status = 'stopped'
    this.starting = undefined
  }

  snapshot(): McpStatus {
    return { id: this.server.id, name: this.server.name, enabled: this.server.enabled, status: this.status, error: this.error, tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description })) }
  }

  private kill(): void {
    const child = this.child
    this.child = undefined
    this.rejectAll(new Error('MCP 服务器已停止'))
    if (child && child.exitCode === null) {
      child.stdin.end()
      child.kill()
    }
  }

  private onExit(reason: string): void {
    if (!this.child) return
    this.child = undefined
    this.rejectAll(new Error(reason))
    this.status = 'error'
    this.error = reason
    this.starting = undefined
  }

  private rejectAll(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
  }

  private send(payload: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error('MCP 服务器未运行')
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`)
  }

  private notify(method: string, params?: unknown): void {
    try { this.send(params === undefined ? { method } : { method, params }) } catch { return }
  }

  private request(method: string, params: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('已取消'))
      const cleanup = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => { cleanup(); reject(new Error('已取消')) }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${method} 超时（${timeout / 1000} 秒）`)) }, timeout)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve: (value) => { cleanup(); resolve(value) }, reject: (error) => { cleanup(); reject(error) }, timer })
      try { this.send({ id, method, params }) } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private onData(text: string): void {
    this.buffer += text
    if (this.buffer.length > 20_000_000) this.buffer = ''
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line.startsWith('{')) continue
      let payload: RpcMessage
      try { payload = JSON.parse(line) as RpcMessage } catch { continue }
      this.onMessage(payload)
    }
  }

  private onMessage(payload: RpcMessage): void {
    if (payload.method) {
      if (payload.id === undefined || payload.id === null) return
      try {
        if (payload.method === 'ping') this.send({ id: payload.id, result: {} })
        else if (payload.method === 'roots/list') this.send({ id: payload.id, result: { roots: [] } })
        else this.send({ id: payload.id, error: { code: -32601, message: `Cubex 不支持 ${payload.method}` } })
      } catch { return }
      return
    }
    if (typeof payload.id !== 'number') return
    const pending = this.pending.get(payload.id)
    if (!pending) return
    if (payload.error) pending.reject(new Error(payload.error.message ?? `MCP 错误 ${payload.error.code ?? ''}`))
    else pending.resolve(payload.result)
  }
}

export class McpManager {
  private clients = new Map<string, McpClient>()

  sync(servers: McpServer[]): void {
    const wanted = new Map(servers.filter((server) => server.enabled).map((server) => [server.id, server]))
    for (const [id, client] of this.clients) {
      const next = wanted.get(id)
      if (!next || configKey(next) !== client.key) {
        client.stop()
        this.clients.delete(id)
      }
    }
    for (const [id, server] of wanted) {
      if (this.clients.has(id)) continue
      const client = new McpClient(server)
      this.clients.set(id, client)
      void client.start().catch((error: unknown) => console.error(`[cubex] MCP 服务器 ${server.name} 启动失败`, message(error)))
    }
  }

  list(servers: McpServer[]): McpStatus[] {
    return servers.map((server) => {
      const client = this.clients.get(server.id)
      return client && server.enabled ? client.snapshot() : { id: server.id, name: server.name, enabled: server.enabled, status: 'stopped', tools: [] }
    })
  }

  async test(server: McpServer): Promise<McpStatus> {
    const client = new McpClient(server)
    try {
      await client.start()
    } catch {
      return client.snapshot()
    } finally {
      client.stop()
    }
    return { ...client.snapshot(), status: 'ready' }
  }

  catalog(): { server: string; tools: McpTool[] }[] {
    return [...this.clients.values()].filter((client) => client.status === 'ready' && client.tools.length).map((client) => ({ server: client.server.name, tools: client.tools }))
  }

  async call(serverName: string, tool: string, args: unknown, signal: AbortSignal): Promise<string> {
    const client = [...this.clients.values()].find((item) => item.server.name === serverName)
    if (!client) throw new Error(`MCP 服务器「${serverName}」不存在或已停用`)
    return client.call(tool, args, signal)
  }

  stopAll(): void {
    for (const client of this.clients.values()) client.stop()
    this.clients.clear()
  }
}
