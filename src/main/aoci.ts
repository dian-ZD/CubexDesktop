import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '../shared/schema'

export const AOCI_SERVER_ID = 'cubex-aoci'
export const AOCI_SERVER_NAME = 'aoci'
export const AOCI_VERSION = 'v0.1.0-rc18'

const binaryName = () => (process.platform === 'win32' ? 'aoci.exe' : 'aoci')

/** 打包后随安装包放在 resources/aoci，dev 下放在仓库的 vendor/aoci */
export function aociBinaryDirs(resourcesPath: string, appPath: string): string[] {
  return [join(resourcesPath, 'aoci'), join(appPath, 'vendor', 'aoci')]
}

export function resolveAociBinary(dirs: string[]): string | null {
  const name = binaryName()
  for (const dir of dirs) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return null
}

export function aociServer(binary: string, projectPath: string): McpServer {
  return {
    id: AOCI_SERVER_ID,
    name: AOCI_SERVER_NAME,
    command: binary,
    args: ['--repo', projectPath, 'mcp'],
    env: {},
    enabled: true,
  }
}

export interface AociPlanOptions {
  enabled: boolean
  binary: string | null
  projectPath?: string
}

export interface AociPlan {
  servers: McpServer[]
  changed: boolean
}

/**
 * 计算出「应该存在的 MCP 服务器列表」。
 *
 * 开关打开且二进制与项目路径都齐备时，自动维护一个 id 为 cubex-aoci 的条目，
 * 其 --repo 指向当前项目；开关关闭、二进制缺失或还没有项目时移除该条目。
 * 用户自己添加的其它 MCP 服务器一律不动。
 */
export function planAociServers(servers: McpServer[], options: AociPlanOptions): AociPlan {
  const index = servers.findIndex((item) => item.id === AOCI_SERVER_ID || item.name === AOCI_SERVER_NAME)
  const existing = index >= 0 ? servers[index] : undefined

  if (!options.enabled || !options.binary || !options.projectPath) {
    if (!existing) return { servers, changed: false }
    return { servers: servers.filter((_, position) => position !== index), changed: true }
  }

  const next = aociServer(options.binary, options.projectPath)
  if (existing && existing.command === next.command && existing.args.join(' ') === next.args.join(' ') && existing.enabled) {
    return { servers, changed: false }
  }
  if (!existing) return { servers: [...servers, next], changed: true }
  const replaced = [...servers]
  replaced[index] = next
  return { servers: replaced, changed: true }
}
