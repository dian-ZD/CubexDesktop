import { join, basename, extname } from 'node:path'
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import type { SkillMeta, SkillDetail } from '../shared/schema'
import { unzip } from './unzip'

// Agent Skills 标准（兼容 Anthropic skills）：每个技能是 skills/ 下一个目录，
// 内含 SKILL.md（YAML frontmatter：name / description）与可选附加上下文文件。
// 单文件与 zip 导入时自动转换为该标准结构。
const allowExt = new Set(['.md', '.markdown', '.txt', '.mdx', '.zip'])
const maxBytes = 5 * 1024 * 1024
const skillDocNames = ['skill.md', 'skill.markdown', 'readme.md']
const maxContextBytes = 200_000

/** 内置技能（随应用分发，只读；work-builder 之类生成型入口不在这里，见 Work 画布）。 */
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
  {
    id: 'builtin:write-plugin',
    name: '写插件',
    description: '按 CubexDesktop 插件协议脚手架一个本地插件（plugin.json + 脚本）',
    builtin: true,
    content: [
      '请帮我编写一个 CubexDesktop 本地插件。CubexDesktop 插件是插件目录下的一个文件夹，内含一个 `plugin.json` 清单和可执行脚本；AI 在对话中通过统一的 `plugin_call` 工具调用插件声明的工具。请严格遵循下面的协议来创建插件，不要臆造字段或调用方式。',
      '',
      '## 我要的插件',
      '- 用途：（在这里描述插件要做什么，例如“查询某 API、格式化本地文件、调用某命令行工具”）',
      '- 期望的工具与参数：（可留空，让你根据用途设计）',
      '',
      '## plugin.json 清单格式（必须遵守）',
      '- `name`(必填,string)：字母/数字/`_`/`-`，长度 1–40，目录内唯一。',
      '- `description`(可选,string)：最长 1000。',
      '- `version`(可选,string)：最长 40。',
      '- `tools`(必填,array,1–20 项)：每项含 `name`(1–40)、`description`(必填,写清能做什么/何时用)、`command`(必填,以 shell 在插件目录下执行)、`parameters`(可选,JSON Schema，推荐 `{"type":"object","properties":{...},"required":[...]}`)。',
      '',
      '## 运行时调用协议（脚本必须据此读写）',
      '- 调用时在插件目录下以 shell 执行工具的 `command`，并注入环境变量：`CUBEX_ARGS`(模型入参的 JSON 字符串，需 JSON.parse)、`CUBEX_TOOL`(被调用工具名)、`CUBEX_PROJECT_ROOT`(当前项目根目录绝对路径)。',
      '- 标准输出 stdout 即返回给模型的结果，请把有用信息打印到 stdout；stderr 仅作调试。',
      '- 退出码非 0 视为失败；单次超时 120 秒；输出超过约 40000 字符会被截断；用户可随时中止，请处理终止信号。',
      '',
      '## 交付要求',
      '1. 先确认插件用途与工具设计，不明确处用 ask_user 询问，不要臆测。',
      '2. 生成完整可运行的文件：`plugin.json` 与脚本（默认 Node.js `index.js`，也可用 Python 等，只要 `command` 能在插件目录运行）。脚本必须从 `CUBEX_ARGS` 解析参数、把结果打印到 stdout、失败时非 0 退出。',
      '3. 说明安装步骤：把该文件夹放到「设置 → 插件 → 打开插件目录」对应目录下，回设置面板点「刷新」并启用。',
      '4. 给出一次示例调用与预期 stdout，并提示插件以用户权限运行本机命令、破坏性操作要走审批或自行确认。',
    ].join('\n'),
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

function parseSkillPackage(fallbackName: string, entries: { name: string; data: Buffer }[]): { name: string; description: string; content: string; extra: Array<{ name: string; data: Buffer }> } {
  const files = entries.map((entry) => ({ path: entry.name.replace(/\\/g, '/'), base: basename(entry.name).toLowerCase(), text: () => entry.data.toString('utf8'), data: entry.data }))
  const manifest = files.find((file) => file.base === 'manifest.json' || file.base === 'skill.json')
  if (manifest) {
    try {
      const meta = JSON.parse(manifest.text()) as { name?: string; description?: string; content?: string; entry?: string; instructions?: string }
      let content = typeof meta.content === 'string' ? meta.content : typeof meta.instructions === 'string' ? meta.instructions : ''
      if (!content && meta.entry) {
        const target = files.find((file) => file.path.endsWith(meta.entry as string) || file.base === (meta.entry as string).split('/').pop()!.toLowerCase())
        if (target) content = parseFrontmatter(target.text()).body
      }
      if (!content) {
        const doc = files.find((file) => skillDocNames.includes(file.base))
        if (doc) content = parseFrontmatter(doc.text()).body
      }
      const name = meta.name || fallbackName
      const description = meta.description || deriveDescription(content)
      const extra = files.filter((file) => file.data.length <= maxContextBytes && !skillDocNames.includes(file.base) && file.base !== 'manifest.json' && file.base !== 'skill.json' && /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(file.base)).map((file) => ({ name: file.base, data: file.data }))
      return { name, description, content: content.trim(), extra }
    } catch {
      /* fall through to SKILL.md */
    }
  }
  const doc = files.find((file) => skillDocNames.includes(file.base)) ?? files.find((file) => file.base.endsWith('.md'))
  if (!doc) throw new Error('zip 包内未找到 SKILL.md 或 manifest.json')
  const parsed = parseSkillFile(doc.base, doc.text())
  const extra = files.filter((file) => file !== doc && file.data.length <= maxContextBytes && /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(file.base)).map((file) => ({ name: file.base, data: file.data }))
  return { ...parsed, extra }
}

export class SkillStore {
  constructor(private readonly dir: string) {}

  private async ensureDir() {
    await mkdir(this.dir, { recursive: true })
  }

  private idFor(dirName: string): string {
    return `skill:${dirName}`
  }

  private safeName(id: string): string {
    if (!id.startsWith('skill:')) throw new Error('技能不存在')
    const dirName = id.slice('skill:'.length)
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(dirName) || dirName.includes('..')) throw new Error('非法技能路径')
    return dirName
  }

  /** 列出技能目录下的标准 skill 目录（每个含 SKILL.md）。 */
  async list(): Promise<SkillMeta[]> {
    await this.ensureDir()
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => [] as Array<{ isDirectory: () => boolean; name: string }>)
    const files: SkillMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillDir = join(this.dir, entry.name)
      const docPath = join(skillDir, 'SKILL.md')
      const raw = await readFile(docPath, 'utf8').catch(() => '')
      if (!raw) continue // 不含 SKILL.md 的目录不是技能，跳过
      const parsed = parseFrontmatter(raw)
      const name = parsed.name || entry.name
      files.push({ id: this.idFor(entry.name), name, description: parsed.description || deriveDescription(parsed.body), builtin: false, fileName: entry.name })
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const builtin: SkillMeta[] = builtinSkills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, builtin: skill.builtin }))
    return [...builtin, ...files]
  }

  /** 读取技能正文（SKILL.md body）+ 附加上下文文件（Agent Skills 渐进式披露：正文先给，需要时模型可再要参考文件）。 */
  async read(id: string): Promise<SkillDetail> {
    const builtin = builtinSkills.find((skill) => skill.id === id)
    if (builtin) return builtin
    const dirName = this.safeName(id)
    const skillDir = join(this.dir, dirName)
    const raw = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    const parsed = parseFrontmatter(raw)
    let content = parsed.body.trim()
    // 附加上下文文件追加为参考附录；保持上限避免撑爆上下文。
    const extras: string[] = []
    const entries = await readdir(skillDir).catch(() => [] as string[])
    for (const name of entries) {
      if (name === 'SKILL.md' || !/\.(md|markdown|txt|json|csv|ya?ml)$/i.test(name)) continue
      const info = await stat(join(skillDir, name)).catch(() => null)
      if (!info || info.size > maxContextBytes) continue
      const text = await readFile(join(skillDir, name), 'utf8').catch(() => '')
      if (text) extras.push(`## 参考文件：${name}\n${text}`)
    }
    if (extras.length) content = `${content}\n\n---\n\n${extras.join('\n\n---\n\n')}`
    return { id, name: parsed.name || dirName, description: parsed.description || deriveDescription(parsed.body), builtin: false, fileName: dirName, content }
  }

  /** 按标准结构落盘：skills/<slug>/SKILL.md（frontmatter）+ 附加上下文文件。 */
  private async writeSkill(name: string, parsed: { name: string; description?: string; content: string; extra?: Array<{ name: string; data: Buffer }> }): Promise<{ dirName: string }> {
    await this.ensureDir()
    const existing = new Set(await readdir(this.dir).catch(() => [] as string[]))
    let dirName = slugify(name)
    let counter = 1
    while (existing.has(dirName)) dirName = `${slugify(name)}-${counter++}`
    const skillDir = join(this.dir, dirName)
    await mkdir(skillDir, { recursive: true })
    const description = (parsed.description || deriveDescription(parsed.content)).replace(/\n/g, ' ')
    const doc = `---\nname: ${name}\ndescription: ${description}\n---\n\n${parsed.content}\n`
    await writeFile(join(skillDir, 'SKILL.md'), doc, 'utf8')
    for (const file of parsed.extra ?? []) {
      const safe = file.name.replace(/[/\\]/g, '-').replace(/[\u0000-\u001f]/g, '') // eslint-disable-line no-control-regex -- 清洗 zip 条目名中的控制字符
      if (!safe || safe === 'SKILL.md') continue
      await writeFile(join(skillDir, safe), file.data)
    }
    return { dirName }
  }

  async import(paths: string[]): Promise<SkillMeta[]> {
    await this.ensureDir()
    const imported: SkillMeta[] = []
    for (const source of paths) {
      const ext = extname(source).toLowerCase()
      if (!allowExt.has(ext)) throw new Error(`支持 ${[...allowExt].join(' / ')} 格式的技能`)
      const info = await stat(source)
      if (info.size > maxBytes) throw new Error(`技能文件过大（上限 ${Math.round(maxBytes / 1024)} KB）`)
      let parsed: { name: string; description?: string; content: string; extra?: Array<{ name: string; data: Buffer }> }
      if (ext === '.zip') {
        const entries = unzip(await readFile(source))
        parsed = parseSkillPackage(basename(source, ext), entries)
      } else {
        const single = parseSkillFile(basename(source, ext), await readFile(source, 'utf8'))
        parsed = single
      }
      if (!parsed.content) throw new Error('技能内容为空')
      const { dirName } = await this.writeSkill(parsed.name, parsed)
      imported.push({ id: this.idFor(dirName), name: parsed.name, description: parsed.description || deriveDescription(parsed.content), builtin: false, fileName: dirName })
    }
    return imported
  }

  async remove(id: string): Promise<void> {
    if (!id.startsWith('skill:')) throw new Error('内置技能不可删除')
    const dirName = this.safeName(id)
    await rm(join(this.dir, dirName), { recursive: true, force: true })
  }
}
