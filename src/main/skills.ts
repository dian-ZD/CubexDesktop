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

/** 内置技能（随应用分发，只读）。 */
const builtinSkills: SkillDetail[] = [
  {
    id: 'builtin:work-builder',
    name: '工作流搭建',
    description: '把多步骤任务落成 Work 画布工作流：设计节点、写好每步指令并调用 create_workflow 保存',
    builtin: true,
    content: [
      '你的任务是把用户描述的流程落成一个可运行的工作流，并调用 create_workflow 工具保存。严格按下面的方法执行。',
      '',
      '## 工作流是什么',
      '- 工作流由 1–20 个节点线性串联组成，保存在 Work 画布中，用户可随时手动运行、编辑。',
      '- **关键限制：节点之间不共享上下文**。每个节点执行时只能看到自己的 prompt，看不到其他节点的执行过程与结果。所以每个 prompt 必须是一份完整自包含的任务书。',
      '',
      '## 每个节点的 prompt 必须写全（这是质量的关键）',
      '一份合格的 prompt 包含四要素：',
      '1. **目标**：这一步要产出什么（文件、结论、命令结果…）。',
      '2. **背景**：项目路径、相关文件路径、上一步的产出放在哪里（如「读取上一步生成的 report.md」）——用文件在磁盘上传递状态，而不是指望模型记得上一步。',
      '3. **怎么做**：具体指令与约束（用哪些工具、遵循什么规范、不要做什么）。',
      '4. **验收标准**：怎样算完成（如「tests 全部通过」「输出包含 3 个部分的 markdown」）。',
      '',
      '## 设计节点的方法',
      '- 先把用户流程拆成有序步骤，每步只做一件事；超过 10 步时考虑合并同类操作。',
      '- 为每步选择合适的 kind：task（默认，通用 agent 任务）/ command（运行命令）/ search（检索资料）/ file（文件操作）/ git（版本操作）/ review（审查）。',
      '- 中间产物一律落到项目内的文件（如 .cubex/artifacts/xx.md），后续节点从文件读——这是节点间传递信息的唯一可靠方式。',
      '- 步骤命名用动宾短语（「整理需求清单」「运行测试并修复」），用户一眼看懂。',
      '',
      '## 与用户确认',
      '- 流程意图清楚就直接生成，生成后用一段话概述每个节点做什么、信息如何流转。',
      '- 用户目标模糊或有多种拆法时，先 ask_user 确认步骤划分，再生成。',
      '',
      '## 保存',
      '调用 create_workflow，参数：name（工作流名称，动宾短语）+ nodes 数组（每项 { title, prompt, kind? }）。保存成功后告诉用户去 Work 画布查看与运行。',
    ].join('\n'),
  },
  {
    id: 'builtin:review',
    name: '代码审查',
    description: '对指定文件或改动做结构、缺陷与风格审查',
    builtin: true,
    content: [
      '请对目标代码做一次系统审查，按下面的框架输出，不要泛泛而谈。',
      '',
      '## 审查框架',
      '1. **正确性**：逻辑错误、边界条件（空值/空集合/极大值/并发）、错误处理是否吞异常。',
      '2. **安全性**：注入（命令/SQL/路径穿越）、密钥泄漏、不安全的反序列化、权限校验缺失。',
      '3. **性能**：明显的 N+1、重复计算、大对象拷贝、阻塞主线程的操作。',
      '4. **可读性**：命名是否达意、函数是否过长、重复代码是否该抽取。',
      '5. **一致性**：是否遵循项目既有约定（命名风格、目录组织、错误处理模式）——先看周边同类代码再下结论。',
      '',
      '## 输出格式',
      '按严重程度分组：🔴 必须修 / 🟡 建议修 / 🟢 可选优化。每条给出：文件路径:行号、问题描述、为什么是问题、修复建议（能给出修改后的代码片段最好）。最后一段总结整体质量与最优先要修的 1–2 件事。',
      '',
      '目标：',
    ].join('\n'),
  },
  {
    id: 'builtin:explain',
    name: '解释代码',
    description: '逐段解释一段代码的作用与关键逻辑',
    builtin: true,
    content: [
      '请解释下面这段代码。要求：',
      '',
      '1. **一句话总览**：这段代码整体在做什么。',
      '2. **逐段拆解**：按逻辑块分段，每段说明输入→处理→输出；关键算法/数据结构点出名字（如「滑动窗口」「KMP 失配」）。',
      '3. **关键细节**：为什么这样写——隐含约定、边界处理、容易误读的行。',
      '4. **踩坑提示**：调用方需要注意什么（副作用、异常、性能陷阱、线程安全）。',
      '5. 引用代码时给出 `文件:行号`，长代码块只贴关键行。',
      '',
      '代码：',
    ].join('\n'),
  },
  {
    id: 'builtin:test',
    name: '补充测试',
    description: '为指定函数或模块补充单元测试',
    builtin: true,
    content: [
      '请为下面的函数/模块补充单元测试，要求：',
      '',
      '1. **先侦察再动笔**：找到项目现有测试文件与测试框架（vitest/jest/pytest…），完全沿用其风格、目录与命名约定；没有现成测试时选择与项目技术栈匹配的主流框架。',
      '2. **覆盖分层**：正常路径（典型输入）→ 边界（空值、空集合、极值、unicode）→ 异常（抛错、网络失败、非法输入）→ 关键交互（mock 外部依赖，只 mock 边界，不 mock 被测内部）。',
      '3. **测试质量**：每个测试只测一个行为，命名自解释（「拒绝过期的 token」而非「test2」），断言具体值而非 not-throw；避免实现细节耦合（重构不应破坏测试）。',
      '4. **跑通为凭**：写完运行测试命令，全部通过才算完成；失败的测试要么修代码要么修测试，如实报告结果。',
      '',
      '目标：',
    ].join('\n'),
  },
  {
    id: 'builtin:refactor',
    name: '重构',
    description: '在不改变外部行为的前提下改善代码结构',
    builtin: true,
    content: [
      '请重构目标代码，要求：',
      '',
      '1. **先锁定行为**：重构前确认现有测试通过；没有测试就先为要改动的行为补关键测试（防护网），再动手。',
      '2. **小步前进**：每做一次结构改动（提取函数/移动文件/改名/消除重复）就跑一次验证，出问题立刻能定位到哪一步。',
      '3. **经典手法按需选用**：提取函数、提取变量、内联临时变量、移动函数、以多态取代条件、拆分过长函数/参数对象。不要为了模式而模式。',
      '4. **守住边界**：不改公开 API（除非用户明确要求）、不顺手修 bug、不混入格式化整文件之类的噪音 diff。',
      '5. **完成后报告**：改了什么结构、为什么、验证结果（测试/类型检查输出摘要）。',
      '',
      '目标：',
    ].join('\n'),
  },
  {
    id: 'builtin:docs',
    name: '写文档',
    description: '为代码或项目编写 README、API 说明、注释等文档',
    builtin: true,
    content: [
      '请为目标编写文档。先读代码与现有文档，再动笔：',
      '',
      '1. **定体裁**：README（面向第一次接触项目的人：是什么、能干什么、5 分钟跑起来）、API 参考（面向使用者：签名、参数、返回、错误、示例）、内联注释（面向维护者：只解释「为什么」，不复述代码）。',
      '2. **结构清晰**：开头一段话讲清价值；用小节与列表；命令与代码全部放代码块并标注语言；示例可直接复制运行。',
      '3. **准确第一**：所有命令、路径、参数名从代码里核实，不凭记忆写；不确定的标注「待确认」。',
      '4. **语言**：与用户交流语言一致；技术名词与代码标识符保持原文。',
      '',
      '目标：',
    ].join('\n'),
  },
  {
    id: 'builtin:write-plugin',
    name: '写插件',
    description: '按 CubexDesktop 插件协议脚手架一个本地插件（plugin.json + 脚本），含 slash 命令配置',
    builtin: true,
    content: [
      '请帮我编写一个 CubexDesktop 本地插件。CubexDesktop 插件是插件目录下的一个文件夹，内含一个 `plugin.json` 清单和可执行脚本；AI 在对话中通过统一的 `plugin_call` 工具调用插件声明的工具。请严格遵循下面的协议来创建插件，不要臆造字段或调用方式。完整协议见 `docs/plugins.md`（应用仓库内），本模板是可执行摘要。',
      '',
      '## 我要的插件',
      '- 用途：（在这里描述插件要做什么，例如“查询某 API、格式化本地文件、调用某命令行工具”）',
      '- 期望的工具与参数：（可留空，让你根据用途设计）',
      '- 是否需要 / 命令：（插件可被输入框 / 菜单直接调用，见下文 slash 字段）',
      '',
      '## plugin.json 清单格式（必须遵守）',
      '- `name`(必填,string)：字母/数字/`_`/`-`，长度 1–40，目录内唯一。',
      '- `description`(可选,string)：最长 1000。',
      '- `version`(可选,string)：最长 40。升级插件时递增版本号。',
      '- `slash`(可选,boolean)：**true 时该插件才有资格出现在输入框 / 菜单**；默认 false。',
      '- `tools`(必填,array,1–20 项)：每项含：',
      '  - `name`(必填)：字母/数字/`_`/`-`，1–40。',
      '  - `description`(必填)：写清能做什么/何时用，模型靠它决定何时调用。',
      '  - `command`(必填)：以 shell 在插件目录下执行，如 `node index.js`、`python main.py`。',
      '  - `parameters`(可选)：JSON Schema，推荐 `{"type":"object","properties":{...},"required":[...]}`。',
      '  - `slashCommand`(可选)：该工具的 / 别名（中英文/数字/`_`/`-`，1–40）。插件 slash=true 且工具声明了 slashCommand 才会出现在 / 菜单。',
      '  - `slashTemplate`(可选)：选中 / 命令后给模型的提示模板，`{args}` 代表用户补充的文字，如「把 {args} 翻译成英文」。',
      '',
      '## 运行时调用协议（脚本必须据此读写）',
      '- 调用时在插件目录下以 shell 执行工具的 `command`，并注入环境变量：`CUBEX_ARGS`(模型入参的 JSON 字符串，需 JSON.parse)、`CUBEX_TOOL`(被调用工具名)、`CUBEX_PLUGIN`(插件名)、`CUBEX_PROJECT_ROOT`(当前项目根目录绝对路径)。',
      '- 标准输出 stdout 即返回给模型的结果；stderr 仅作调试。退出码非 0 视为失败。',
      '- 单次调用超时 120 秒；输出超过约 40000 字符会被截断；用户可随时中止，请处理终止信号。',
      '',
      '## 交付要求',
      '1. 先确认插件用途与工具设计，不明确处用 ask_user 询问，不要臆测。',
      '2. 生成完整可运行的文件：`plugin.json` 与脚本（默认 Node.js `index.js`，也可用 Python 等，只要 `command` 能在插件目录运行）。脚本必须从 `CUBEX_ARGS` 解析参数、把结果打印到 stdout、失败时非 0 退出；解析失败、上游报错都要输出人类可读的错误信息到 stdout 再退出非 0。',
      '3. 说明安装步骤：把该文件夹放到「设置 → 插件 → 打开插件目录」对应目录下，回设置面板点「刷新」并启用。若配置了 slashCommand，提醒用户重启一次应用使 / 菜单生效。',
      '4. 给出一次示例调用与预期 stdout；提示插件以用户权限运行本机命令、破坏性操作要走审批。',
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
    // frontmatter 是「key: value」平文本：name/description 若含换行或行首 --- 会破坏结构，甚至注入任意字段
    const safeName = name.replace(/[\r\n]+/g, ' ').replace(/^\s*-{3,}\s*$/gm, '—').trim()
    const safeDescription = description.replace(/[\r\n]+/g, ' ').replace(/^\s*-{3,}\s*$/gm, '—').trim()
    const doc = `---\nname: ${safeName}\ndescription: ${safeDescription}\n---\n\n${parsed.content}\n`
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
