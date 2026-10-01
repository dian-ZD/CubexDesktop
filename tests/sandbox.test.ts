import { describe, expect, it } from 'vitest'
import { buildSandboxEnv } from '../src/main/sandbox/env'
import { findEscape } from '../src/main/sandbox/guard'

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
