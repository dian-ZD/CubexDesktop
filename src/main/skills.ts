import { join, basename, extname } from 'node:path'
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import type { SkillMeta, SkillDetail } from '../shared/schema'
import { unzip } from './unzip'

const allowExt = new Set(['.md', '.markdown', '.txt', '.mdx', '.zip'])
const maxBytes = 5 * 1024 * 1024
const skillDocNames = ['skill.md', 'skill.markdown', 'readme.md']

const builtinSkills: SkillDetail[] = [
  {
    id: 'builtin:review',
    name: '代码审查',
    description: '对指定文件或改动做结构、缺陷与风格审查',
    builtin: true,
    content: '请对以下代码进行审查，关注：\n1. 潜在缺陷与边界条件\n2. 可读性与命名\n3. 性能与安全\n4. 是否符合项目既有约定\n\n目标：',
  },
  {
    id: 'builtin:explain',
    name: '解释代码',
    description: '逐段解释一段代码的作用与关键逻辑',
    builtin: true,
    content: '请逐段解释下面这段代码的作用、关键逻辑与设计意图，并指出容易踩坑的地方：\n\n',
  },
  {
    id: 'builtin:test',
    name: '补充测试',
    description: '为指定函数或模块补充单元测试',
    builtin: true,
    content: '请为下面的函数/模块补充单元测试，覆盖正常路径、边界与异常场景，并沿用项目已有的测试框架与风格：\n\n',
  },
]

function slugify(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'skill'
}

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw)
  if (!fm) return { body: raw }
  const meta: { name?: string; description?: string } = {}
  for (const line of fm[1].split('\n')) {
    const match = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    if (match[1].toLowerCase() === 'name' && value) meta.name = value
    if (match[1].toLowerCase() === 'description' && value) meta.description = value
  }
  return { ...meta, body: raw.slice(fm[0].length) }
}

function deriveDescription(body: string): string {
  const firstLine = body.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find((line) => line.length > 0)
  return firstLine ? firstLine.slice(0, 120) : ''
}

function parseSkillFile(fileName: string, raw: string): { name: string; description: string; content: string } {
  const parsed = parseFrontmatter(raw)
  const name = parsed.name || basename(fileName, extname(fileName))
  const description = parsed.description || deriveDescription(parsed.body)
  return { name, description, content: parsed.body.trim() }
}

function parseSkillPackage(fallbackName: string, entries: { name: string; data: Buffer }[]): { name: string; description: string; content: string } {
  const files = entries.map((entry) => ({ path: entry.name.replace(/\\/g, '/'), base: basename(entry.name).toLowerCase(), text: () => entry.data.toString('utf8') }))
  const manifest = files.find((file) => file.base === 'manifest.json' || file.base === 'skill.json')
  if (manifest) {
    try {
      const meta = JSON.parse(manifest.text()) as { name?: string; description?: string; content?: string; entry?: string; instructions?: string }
      let content = typeof meta.content === 'string' ? meta.content : typeof meta.instructions === 'string' ? meta.instructions : ''
      if (!content && meta.entry) {
        const target = files.find((file) => file.path.endsWith(meta.entry as string) || file.base === basename(meta.entry as string).toLowerCase())
        if (target) content = parseFrontmatter(target.text()).body
      }
      if (!content) {
        const doc = files.find((file) => skillDocNames.includes(file.base))
        if (doc) content = parseFrontmatter(doc.text()).body
      }
      const name = meta.name || fallbackName
      const description = meta.description || deriveDescription(content)
      return { name, description, content: content.trim() }
    } catch {
      /* fall through to SKILL.md */
    }
  }
  const doc = files.find((file) => skillDocNames.includes(file.base)) ?? files.find((file) => file.base.endsWith('.md'))
  if (doc) return parseSkillFile(doc.base, doc.text())
  throw new Error('zip 包内未找到 SKILL.md 或 manifest.json')
}

export class SkillStore {
  constructor(private readonly dir: string) {}

  private async ensureDir() {
    await mkdir(this.dir, { recursive: true })
  }

  private idFor(fileName: string): string {
    return `file:${fileName}`
  }

  private safeName(id: string): string {
    if (!id.startsWith('file:')) throw new Error('技能不存在')
    const fileName = id.slice('file:'.length)
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) throw new Error('非法技能路径')
    return fileName
  }

  async list(): Promise<SkillMeta[]> {
    await this.ensureDir()
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const files: SkillMeta[] = []
    for (const fileName of entries) {
      if (!['.md', '.markdown', '.txt', '.mdx'].includes(extname(fileName).toLowerCase())) continue
      const raw = await readFile(join(this.dir, fileName), 'utf8').catch(() => '')
      const parsed = parseSkillFile(fileName, raw)
      files.push({ id: this.idFor(fileName), name: parsed.name, description: parsed.description, builtin: false, fileName })
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const builtin: SkillMeta[] = builtinSkills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, builtin: skill.builtin }))
    return [...builtin, ...files]
  }

  async read(id: string): Promise<SkillDetail> {
    const builtin = builtinSkills.find((skill) => skill.id === id)
    if (builtin) return builtin
    const fileName = this.safeName(id)
    const raw = await readFile(join(this.dir, fileName), 'utf8')
    const parsed = parseSkillFile(fileName, raw)
    return { id, name: parsed.name, description: parsed.description, builtin: false, fileName, content: parsed.content }
  }

  private async writeSkill(name: string, content: string): Promise<{ fileName: string }> {
    const existing = new Set(await readdir(this.dir).catch(() => [] as string[]))
    let fileName = `${slugify(name)}.md`
    let counter = 1
    while (existing.has(fileName)) fileName = `${slugify(name)}-${counter++}.md`
    const doc = `---\nname: ${name}\ndescription: ${deriveDescription(content).replace(/\n/g, ' ')}\n---\n\n${content}\n`
    await writeFile(join(this.dir, fileName), doc, 'utf8')
    return { fileName }
  }

  async import(paths: string[]): Promise<SkillMeta[]> {
    await this.ensureDir()
    const imported: SkillMeta[] = []
    for (const source of paths) {
      const ext = extname(source).toLowerCase()
      if (!allowExt.has(ext)) throw new Error(`支持 ${[...allowExt].join(' / ')} 格式的技能`)
      const info = await stat(source)
      if (info.size > maxBytes) throw new Error(`技能文件过大（上限 ${Math.round(maxBytes / 1024)} KB）`)
      let parsed: { name: string; description: string; content: string }
      if (ext === '.zip') {
        const entries = unzip(await readFile(source))
        parsed = parseSkillPackage(basename(source, ext), entries)
      } else {
        parsed = parseSkillFile(basename(source), await readFile(source, 'utf8'))
      }
      if (!parsed.content) throw new Error('技能内容为空')
      const { fileName } = await this.writeSkill(parsed.name, parsed.content)
      imported.push({ id: this.idFor(fileName), name: parsed.name, description: parsed.description, builtin: false, fileName })
    }
    return imported
  }

  async remove(id: string): Promise<void> {
    if (!id.startsWith('file:')) throw new Error('内置技能不可删除')
    const fileName = this.safeName(id)
    await rm(join(this.dir, fileName), { force: true })
  }
}
