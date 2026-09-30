import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StateStore } from '../src/main/store'
import { createInitialState } from '../src/shared/schema'

const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'cubex-store-')), 'state.json')

describe('StateStore', () => {
  it('文件不存在时使用初始状态', async () => {
    const store = new StateStore(await tempFile())
    await store.load()
    expect(store.get().threads).toEqual([])
    expect(store.get().notice).toBeUndefined()
  })

  it('损坏文件被备份并重置', async () => {
    const file = await tempFile()
    await writeFile(file, '{not json', 'utf8')
    const store = new StateStore(file)
    await store.load()
    expect(store.get().notice).toContain('重置')
    expect((await stat(`${file}.corrupt`)).isFile()).toBe(true)
  })

  it('运行中的会话在启动时恢复为空闲并记录中断', async () => {
    const file = await tempFile()
    const state = createInitialState()
    const now = new Date().toISOString()
    state.projects.push({ id: 'p', name: 'p', path: 'C:/p' })
    state.threads.push({
      id: 't', projectId: 'p', title: 'x', modelId: 'm', status: 'awaiting-approval', createdAt: now, updatedAt: now,
      messages: [{ id: 'u1', role: 'user', time: now, content: 'hi' }],
      pending: { callId: 'c1', name: 'run_command', args: { command: 'ls' }, summary: 'ls' },
    })
    await writeFile(file, JSON.stringify(state), 'utf8')
    const store = new StateStore(file)
    await store.load()
    const thread = store.get().threads[0]
    expect(thread.status).toBe('idle')
    expect(thread.pending).toBeUndefined()
    const last = thread.messages.at(-1)
    expect(last?.role).toBe('system')
    expect(store.get().notice).toContain('中断')
  })

  it('更新会通知订阅者并原子写入', async () => {
    const file = await tempFile()
    const store = new StateStore(file)
    await store.load()
    let calls = 0
    const off = store.subscribe(() => calls++)
    await store.update((s) => { s.settings.approvalMode = 'auto-edit' })
    off()
    await store.update((s) => { s.settings.approvalMode = 'full-auto' })
    expect(calls).toBe(1)
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).settings.approvalMode).toBe('full-auto')
  })
})
