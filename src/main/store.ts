import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInitialState, migrateState, stateSchema, type AppState } from '../shared/schema'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const PERSIST_DELAY_MS = 250

export class StateStore {
  private state: AppState
  private queue: Promise<void> = Promise.resolve()
  private listeners = new Set<(state: AppState) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(private readonly filePath: string) {
    this.state = createInitialState()
  }

  async load(): Promise<void> {
    let notice: string | undefined
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const migrated = migrateState(JSON.parse(raw)) as Record<string, unknown> | null
      // 快速路径：state.json 只由本应用写入，磁盘上的数据上次已通过全量校验。
      // 重跑完整 zod 校验在大会话（数千条消息）上要数百毫秒。结构检查必须足够厚：
      // 漏检的坏字段会因每次启动都命中快速路径而永远不触发回落校验。
      const looksValid = typeof migrated?.version === 'number'
        && Array.isArray(migrated.threads)
        && Array.isArray(migrated.projects)
        && typeof migrated.settings === 'object' && migrated.settings !== null
        && migrated.threads.every((thread: unknown) => {
          const item = thread as { id?: unknown; title?: unknown; status?: unknown; createdAt?: unknown; updatedAt?: unknown; messages?: unknown }
          if (typeof item?.id !== 'string' || !Array.isArray(item?.messages)) return false
          // updatedAt 会被 aociProjectPath 的 localeCompare 直接用，缺了会抛错
          return typeof item.title === 'string' && typeof item.status === 'string' && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string'
            && item.messages.every((message: unknown) => typeof (message as { role?: unknown })?.role === 'string')
        })
        && Array.isArray((migrated.settings as { providers?: unknown }).providers)
        && Array.isArray((migrated.settings as { models?: unknown }).models)
        && typeof (migrated.settings as { general?: unknown }).general === 'object' && (migrated.settings as { general?: unknown }).general !== null
      if (looksValid) {
        this.state = migrated as AppState
      } else {
        const parsed = stateSchema.safeParse(migrated)
        if (parsed.success) {
          this.state = parsed.data
        } else {
          notice = '状态文件校验失败，已重置为初始状态；原文件保留为 .corrupt 备份'
          await rename(this.filePath, `${this.filePath}.corrupt`).catch(() => undefined)
          this.state = createInitialState()
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        notice = '状态文件无法读取，已重置为初始状态'
        await rename(this.filePath, `${this.filePath}.corrupt`).catch(() => undefined)
      }
      this.state = createInitialState()
    }
    let interrupted = 0
    for (const thread of this.state.threads) {
      for (const agent of thread.subagentRuns ?? []) {
        if (agent.status === 'queued' || agent.status === 'running' || agent.status === 'awaiting-approval') {
          agent.status = 'cancelled'
          agent.detail = '应用退出导致子任务中断'
          agent.finishedAt = new Date().toISOString()
          this.dirty = true
        }
      }
      if (thread.status !== 'idle') {
        const now = new Date().toISOString()
        thread.status = 'idle'
        thread.pending = undefined
        thread.updatedAt = now
        const run = thread.workflowRun
        const workflowPaused = !!run && run.status === 'running'
        if (run && workflowPaused) {
          run.status = 'paused'
          for (const step of run.steps) if (step.status === 'running') step.status = 'pending'
        }
        thread.messages = [...thread.messages.slice(-399), {
          id: `${thread.id}-interrupted-${Date.now().toString(36)}`,
          role: 'system',
          time: now,
          level: 'info',
          content: workflowPaused ? '应用在工作流执行期间退出，工作流已暂停，可从当前步骤继续。' : '应用在回复期间退出，本轮已中断。',
        }]
        interrupted += 1
      }
    }
    if (interrupted > 0) notice = [notice, `${interrupted} 个会话因上次退出被中断`].filter(Boolean).join('；')
    this.state.notice = notice
    if (interrupted > 0 || notice || this.dirty) {
      this.dirty = true
      await this.flush()
    }
  }

  get(): AppState {
    return this.state
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async update(mutate: (state: AppState) => void): Promise<void> {
    mutate(this.state)
    if (this.state.threads.length > 200) this.state.threads = this.state.threads.slice(-200)
    if (this.state.projects.length > 50) this.state.projects = this.state.projects.slice(-50)
    for (const listener of this.listeners) listener(this.state)
    this.schedulePersist()
  }

  // 合并短时间内的多次写入，避免流式回复期间频繁序列化整个状态
  private schedulePersist() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, PERSIST_DELAY_MS)
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return this.queue
    this.dirty = false
    const snapshot = JSON.stringify(this.state)
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        const tmp = `${this.filePath}.${process.pid}.tmp`
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, this.filePath)
      })
      .catch((error: unknown) => {
        // 写盘失败必须恢复 dirty，否则期间崩溃 = 静默丢数据（磁盘满/杀软锁文件等）
        this.dirty = true
        console.error('[cubex] 状态保存失败：', message(error))
      })
    return this.queue
  }

  // 退出时同步落盘，保证最后一次修改不丢失
  flushSync() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.sync.tmp`
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      renameSync(tmp, this.filePath)
    } catch {
      this.dirty = true
    }
  }
}
