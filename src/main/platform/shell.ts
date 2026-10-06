import { shells } from '../../shared/schema'

export type ShellKind = (typeof shells)[number]

export function shellCommand(shell: ShellKind, command: string): [string, string[]] {
  const resolved = shell === 'auto' ? (process.platform === 'win32' ? 'powershell' : 'sh') : shell
  switch (resolved) {
    case 'powershell': return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
    case 'pwsh': return ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]]
    case 'cmd': return ['cmd.exe', ['/d', '/s', '/c', `"${command}"`]]
    case 'bash': return ['bash', ['-c', command]]
    default: return ['/bin/sh', ['-c', command]]
  }
}
