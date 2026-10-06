import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AOCI_SERVER_ID, AOCI_SERVER_NAME, aociBinaryDirs, aociServer, planAociServers, resolveAociBinary } from '../src/main/aoci'
import type { McpServer } from '../src/shared/schema'

const binaryName = process.platform === 'win32' ? 'aoci.exe' : 'aoci'
const dirs = [mkdtempSync(join(tmpdir(), 'aoci-test-'))]
const missing = [mkdtempSync(join(tmpdir(), 'aoci-none-'))]

afterAll(() => {
  for (const dir of [...dirs, ...missing]) rmSync(dir, { recursive: true, force: true })
})

const other: McpServer = { id: 'user-1', name: 'filesystem', command: 'npx', args: ['-y', 'server'], env: {}, enabled: true }

describe('aoci 二进制定位', () => {
  it('按平台二进制名在候选目录里找到文件', () => {
    const file = join(dirs[0], binaryName)
    writeFileSync(file, '')
    expect(resolveAociBinary(dirs)).toBe(file)
    expect(resolveAociBinary(missing)).toBeNull()
  })

  it('打包后在 resources/aoci，开发期在仓库 vendor/aoci', () => {
    expect(aociBinaryDirs('/app/resources', '/app')).toEqual([join('/app/resources', 'aoci'), join('/app', 'vendor', 'aoci')])
  })
})

describe('planAociServers', () => {
  it('开关关闭时移除 aoci 条目，其余服务器原样保留', () => {
    const servers = [other, aociServer('C:/bin/aoci.exe', '/repo/a')]
    const plan = planAociServers(servers, { enabled: false, binary: 'C:/bin/aoci.exe', projectPath: '/repo/a' })
    expect(plan.changed).toBe(true)
    expect(plan.servers).toEqual([other])
  })

  it('开关关闭且本来就没有 aoci 条目时什么都不改', () => {
    const plan = planAociServers([other], { enabled: false, binary: null })
    expect(plan).toEqual({ servers: [other], changed: false })
  })

  it('开关打开但二进制缺失时不新建条目', () => {
    const plan = planAociServers([], { enabled: true, binary: null, projectPath: '/repo/a' })
    expect(plan.changed).toBe(false)
    expect(plan.servers).toEqual([])
  })

  it('开关打开但还没有项目时不新建条目', () => {
    const plan = planAociServers([], { enabled: true, binary: 'C:/bin/aoci.exe' })
    expect(plan.changed).toBe(false)
  })

  it('开关打开时新建指向当前项目的条目', () => {
    const plan = planAociServers([other], { enabled: true, binary: 'C:/bin/aoci.exe', projectPath: '/repo/a' })
    expect(plan.changed).toBe(true)
    expect(plan.servers).toHaveLength(2)
    expect(plan.servers[0]).toEqual(other)
    expect(plan.servers[1]).toEqual({
      id: AOCI_SERVER_ID,
      name: AOCI_SERVER_NAME,
      command: 'C:/bin/aoci.exe',
      args: ['--repo', '/repo/a', 'mcp'],
      env: {},
      enabled: true,
    })
  })

  it('换项目时就地替换，不新增第二条也不打乱其它条目', () => {
    const first = planAociServers([other], { enabled: true, binary: 'C:/bin/aoci.exe', projectPath: '/repo/a' })
    const second = planAociServers(first.servers, { enabled: true, binary: 'C:/bin/aoci.exe', projectPath: '/repo/b' })
    expect(second.changed).toBe(true)
    expect(second.servers).toHaveLength(2)
    expect(second.servers[0]).toEqual(other)
    expect(second.servers[1].args).toEqual(['--repo', '/repo/b', 'mcp'])
  })

  it('项目与二进制都没变时不产生改动', () => {
    const plan = planAociServers([other], { enabled: true, binary: 'C:/bin/aoci.exe', projectPath: '/repo/a' })
    const again = planAociServers(plan.servers, { enabled: true, binary: 'C:/bin/aoci.exe', projectPath: '/repo/a' })
    expect(again.changed).toBe(false)
    expect(again.servers).toBe(plan.servers)
  })
})
