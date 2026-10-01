import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSandboxEnv } from '../src/main/sandbox/env'
import { findEscape } from '../src/main/sandbox/guard'

const hasCurl = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0

function curl(env: NodeJS.ProcessEnv, url: string): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sS', '--max-time', '5', '-o', '/dev/null', url], { env })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', () => resolve({ ok: false, code: null, stderr: 'spawn failed' }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr }))
  })
}

describe('沙箱环境', () => {
  it('只保留白名单变量并锁定 HOME', () => {
    process.env.CUBEX_TEST_SECRET = 'leak-me'
    const env = buildSandboxEnv('/tmp/proj', true)
    delete process.env.CUBEX_TEST_SECRET
    expect(env.CUBEX_SANDBOX).toBe('1')
    expect(env.HOME).toBe('/tmp/proj')
    expect(env.USERPROFILE).toBe('/tmp/proj')
    expect(env.CUBEX_TEST_SECRET).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('禁网时代理指向黑洞端口并关闭包管理器索引', () => {
    const env = buildSandboxEnv('/tmp/proj', false)
    expect(env.http_proxy).toBe('http://127.0.0.1:9')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9')
    expect(env.npm_config_offline).toBe('true')
    expect(env.PIP_NO_INDEX).toBe('1')
    const open = buildSandboxEnv('/tmp/proj', true)
    expect(open.http_proxy).toBeUndefined()
  })

  // 回归：no_proxy='*' 的语义是"所有主机直连、绕过代理"，会整体抵消禁网（2026-10-01 实测确认）
  it('禁网时不得写入 no_proxy', () => {
    const env = buildSandboxEnv('/tmp/proj', false)
    expect(env.no_proxy).toBeUndefined()
    expect(env.NO_PROXY).toBeUndefined()
  })

  it('父进程的 no_proxy 不会泄漏进沙箱', () => {
    process.env.no_proxy = '*'
    process.env.NO_PROXY = '*'
    const env = buildSandboxEnv('/tmp/proj', false)
    delete process.env.no_proxy
    delete process.env.NO_PROXY
    expect(env.no_proxy).toBeUndefined()
    expect(env.NO_PROXY).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32' || !hasCurl)('禁网实测（环回目标，真实进程）', () => {
  it('禁网时连本机 HTTP 服务也不可达，允许联网时可达', async () => {
    const server = createServer((_request, response) => response.end('ok'))
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    const root = await mkdtemp(join(tmpdir(), 'cubex-sandbox-'))
    const url = `http://127.0.0.1:${port}/`
    const allowed = await curl(buildSandboxEnv(root, true), url)
    const blocked = await curl(buildSandboxEnv(root, false), url)
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    expect(allowed.ok).toBe(true)
    expect(blocked.ok).toBe(false)
    expect(blocked.stderr).toContain('port 9')
  }, 20_000)
})

describe('越权命令拦截', () => {
  it('拦截提权与系统改动作', () => {
    expect(findEscape('sudo ls')).toBeDefined()
    expect(findEscape('echo x | su')).toBeDefined()
    expect(findEscape('chmod 777 /tmp/x')).toBeDefined()
    expect(findEscape('cat /etc/passwd')).toBeDefined()
    expect(findEscape('reg add HKLM\\Software')).toBeDefined()
    expect(findEscape('setx FOO 1')).toBeDefined()
  })

  it('普通命令不误伤', () => {
    expect(findEscape('ls -la')).toBeUndefined()
    expect(findEscape('npm run build')).toBeUndefined()
    expect(findEscape('dissemble data')).toBeUndefined()
    expect(findEscape('sudoedit note.txt')).toBeUndefined()
  })
})
