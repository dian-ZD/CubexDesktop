import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellCommand } from '../src/main/platform/shell'
import { killTree, spawnDetached } from '../src/main/platform/proc'
import { desktopCaptureSupported } from '../src/main/platform/capture'

const isWindows = process.platform === 'win32'

describe('shell 解析', () => {
  it('auto 在 Windows 用 powershell.exe，其余用 /bin/sh', () => {
    const [file, args] = shellCommand('auto', 'echo hi')
    if (isWindows) {
      expect(file).toBe('powershell.exe')
      expect(args).toContain('echo hi')
    } else {
      expect(file).toBe('/bin/sh')
      expect(args).toEqual(['-c', 'echo hi'])
    }
  })

  it('显式 shell 保持各自包装约定', () => {
    expect(shellCommand('bash', 'ls')).toEqual(['bash', ['-c', 'ls']])
    expect(shellCommand('pwsh', 'ls')).toEqual(['pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'ls']])
    const cmd = shellCommand('cmd', 'dir')
    expect(cmd[0]).toBe('cmd.exe')
    expect(cmd[1]).toEqual(['/d', '/s', '/c', '"dir"'])
  })
})

async function countRunning(pattern: string): Promise<number> {
  return new Promise((resolve) => {
    const probe = spawn('pgrep', ['-f', pattern])
    let out = ''
    probe.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    probe.on('close', () => resolve(out.trim() ? out.trim().split('\n').length : 0))
  })
}

describe.skipIf(isWindows)('killTree（POSIX 进程组）', () => {
  it('杀死 shell 及其全部子孙进程', async () => {
    const dur = `3${String(process.pid).slice(-4)}.7`
    const child = spawn('sh', ['-c', `sleep ${dur} & sleep ${dur} & wait`], { detached: spawnDetached, stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 500))
    expect(await countRunning(`sleep ${dur}`)).toBeGreaterThanOrEqual(2)
    killTree(child)
    await new Promise((r) => setTimeout(r, 500))
    expect(await countRunning(`sleep ${dur}`)).toBe(0)
  }, 20_000)
})

describe('截屏能力探测', () => {
  it('Linux 下 Wayland 会话判不可用、x11 判可用', () => {
    if (process.platform === 'linux') {
      const saved = process.env.XDG_SESSION_TYPE
      process.env.XDG_SESSION_TYPE = 'wayland'
      expect(desktopCaptureSupported()).toBe(false)
      process.env.XDG_SESSION_TYPE = 'x11'
      expect(desktopCaptureSupported()).toBe(true)
      if (saved === undefined) delete process.env.XDG_SESSION_TYPE
      else process.env.XDG_SESSION_TYPE = saved
    } else {
      expect(desktopCaptureSupported()).toBe(true)
    }
  })
})
