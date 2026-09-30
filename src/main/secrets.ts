import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export class SecretStore {
  private entries: Record<string, string> = {}
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object') {
        this.entries = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>
      }
    } catch {
      this.entries = {}
    }
  }

  has(providerId: string): boolean {
    return providerId in this.entries
  }

  get(providerId: string): string | undefined {
    const stored = this.entries[providerId]
    if (!stored) return undefined
    try {
      const buffer = Buffer.from(stored, 'base64')
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buffer) : buffer.toString('utf8')
    } catch {
      return undefined
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    if (!apiKey) delete this.entries[providerId]
    else {
      const buffer = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(apiKey) : Buffer.from(apiKey, 'utf8')
      this.entries[providerId] = buffer.toString('base64')
    }
    await this.persist()
  }

  async prune(keep: Set<string>): Promise<void> {
    let changed = false
    for (const key of Object.keys(this.entries)) {
      if (!keep.has(key)) {
        delete this.entries[key]
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.entries)
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.tmp`
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.filePath)
    }).catch(() => undefined)
    return this.queue
  }
}
