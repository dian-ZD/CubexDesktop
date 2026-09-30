import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { formatToolResult, McpManager } from '../src/main/mcp'
import { buildSystemPrompt } from '../src/main/prompt'
import { defaultSettings, migrateState, settingsSchema, type McpServer } from '../src/shared/schema'

const dir = mkdtempSync(join(tmpdir(), 'cubex-mcp-'))
const script = join(dir, 'server.cjs')
writeFileSync(script, `
const rl = require('readline').createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n')
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  else if (msg.method === 'tools/list') {
    if (!msg.params.cursor) send({ id: msg.id, result: { tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }], nextCursor: 'p2' } })
    else send({ id: msg.id, result: { tools: [{ name: 'fail', description: '总是失败' }] } })
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') send({ id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + msg.params.arguments.text + ':' + (process.env.FAKE_TOKEN || '') }] } })
    else send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } })
  }
})
`)

const server = (patch: Partial<McpServer> = {}): McpServer => ({ id: 'mcp-1', name: 'fake', command: process.execPath, args: [script], env: { FAKE_TOKEN: 't1' }, enabled: true, ...patch })

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('formatToolResult', () => {
  it('拼接文本与资源并标记错误', () => {
    expect(formatToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'resource', resource: { uri: 'file:///x' } }] })).toBe('a\n[资源] file:///x')
    expect(formatToolResult({ isError: true, content: [{ type: 'text', text: 'bad' }] })).toBe('[工具返回错误]\nbad')
    expect(formatToolResult({ structuredContent: { ok: 1 } })).toContain('"ok": 1')
    expect(formatToolResult({})).toBe('（无输出）')
  })
})

describe('McpManager', () => {
  it('test() 完成握手、分页列出工具后停止进程', async () => {
    const status = await new McpManager().test(server())
    expect(status.status).toBe('ready')
    expect(status.tools.map((tool) => tool.name)).toEqual(['echo', 'fail'])
  }, 20_000)

  it('test() 启动失败时返回错误状态', async () => {
    const status = await new McpManager().test(server({ command: process.execPath, args: ['-e', 'process.exit(3)'] }))
    expect(status.status).toBe('error')
    expect(status.error).toMatch(/退出/)
  }, 20_000)

  it('sync() 后可通过 call() 调用工具，并注入环境变量', async () => {
    const manager = new McpManager()
    manager.sync([server()])
    try {
      const signal = new AbortController().signal
      expect(await manager.call('fake', 'echo', { text: 'hi' }, signal)).toBe('echo:hi:t1')
      expect(await manager.call('fake', 'fail', {}, signal)).toBe('[工具返回错误]\nboom')
      await expect(manager.call('fake', 'nope', {}, signal)).rejects.toThrow(/没有工具/)
      await expect(manager.call('other', 'echo', {}, signal)).rejects.toThrow(/不存在/)
      expect(manager.catalog()[0]?.tools.length).toBe(2)
      expect(manager.list([server()])[0]?.status).toBe('ready')
      manager.sync([server({ enabled: false })])
      expect(manager.catalog()).toEqual([])
    } finally {
      manager.stopAll()
    }
  }, 20_000)
})

describe('MCP 设置', () => {
  it('旧状态迁移后补齐空的 mcp 配置', () => {
    const migrated = migrateState({ version: 2, projects: [], threads: [], settings: { providers: [], models: [], defaultModelId: '', approvalMode: 'auto-edit' } }) as { settings: { mcp: unknown } }
    expect(migrated.settings.mcp).toEqual({ servers: [] })
  })

  it('服务器名称必须唯一且合法', () => {
    const base = defaultSettings()
    expect(settingsSchema.safeParse({ ...base, mcp: { servers: [server(), server({ id: 'mcp-2' })] } }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...base, mcp: { servers: [server({ name: 'a b' })] } }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...base, mcp: { servers: [server()] } }).success).toBe(true)
  })

  it('系统提示词包含 ask_user 规则，启用 MCP 时提示 mcp_call', () => {
    const project = { id: 'p1', name: 'demo', path: 'C:\\demo' }
    const plain = buildSystemPrompt(defaultSettings(), project)
    expect(plain).toContain('ask_user')
    expect(plain).not.toContain('mcp_call')
    expect(buildSystemPrompt({ ...defaultSettings(), mcp: { servers: [server()] } }, project)).toContain('mcp_call')
  })
})
