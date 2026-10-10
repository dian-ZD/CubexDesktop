import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolCall, ToolName, ToolResult } from '../shared/schema'
import type { ToolSpec } from './llm'
import { shellCommand } from './platform/shell'
import { killTree, spawnDetached } from './platform/proc'
import { buildSandboxEnv, findEscape } from './sandbox'

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target', '.next', '.turbo', '.cache'])
const SENSITIVE = /^(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|.*\.p12|.*\.pfx|credentials(\..*)?)$/i
const MAX_OUTPUT = 40_000
const MAX_READ_BYTES = 400_000
const MAX_COMMAND_MS = 180_000

export const toolSpecs: ToolSpec[] = [
  { name: 'read_file', description: '读取项目内文本文件，返回带行号的内容。可用 start/limit 读取片段。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根目录的路径' }, start: { type: 'integer', description: '起始行（1 起）' }, limit: { type: 'integer', description: '最多返回行数，默认 400' } }, required: ['path'] } },
  { name: 'list_directory', description: '列出目录内容（跳过 node_modules、.git 等）。depth 控制递归层数，默认 2。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，默认根目录' }, depth: { type: 'integer' } }, required: [] } },
  { name: 'search_files', description: '在项目文件中按正则搜索文本，返回 文件:行号:内容。', parameters: { type: 'object', properties: { pattern: { type: 'string', description: '正则表达式' }, path: { type: 'string', description: '限定的相对目录' }, glob: { type: 'string', description: '文件名后缀过滤，如 .ts' } }, required: ['pattern'] } },
  { name: 'write_file', description: '创建或整体覆盖一个文件。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: '把文件中 old_text 的首次出现替换为 new_text。old_text 必须在文件中唯一出现。', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'run_command', description: '在项目根目录执行 shell 命令，返回 stdout/stderr 与退出码。超时由设置决定，可用 timeout_ms 缩短。', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['command'] } },
  { name: 'ask_user', description: '当缺少必要信息或存在需要用户决定的关键分歧时，提出一个明确问题，给出 2–6 个候选选项。能够根据任务判断最佳方案时，用 recommended 指定一个推荐项，并在问题中简述理由。用户也可以自由输入；开启自动选择推荐项时，系统会直接采用有效推荐项。不要为未知事实、凭据或必须由用户完成的操作编造推荐答案。', parameters: { type: 'object', properties: { question: { type: 'string', description: '问题及推荐理由，一句话说清' }, options: { type: 'array', items: { type: 'string' }, description: '候选选项，2–6 个；标题不添加推荐后缀，界面会显示推荐标记' }, recommended: { type: 'string', description: '推荐选项的完整标题，必须与 options 中一项完全相同；无法合理推荐时省略' }, multiple: { type: 'boolean', description: '是否允许多选；自动推荐选择只采用 recommended 指定的那一项' } }, required: ['question'] } },
  { name: 'manage_todos', description: '维护当前任务的待办清单，用于把复杂任务拆成有序步骤并逐项推进，防止在长任务中丢失进度。action=set：用 items 数组整体设置清单（每项 content 为一句话步骤）；action=start：把某项标记为进行中（同一时刻只应有一项进行中）；action=complete：把某项标记为已完成；action=clear：清空清单。除“只是回答一个简单问题/查询”外，动手前都应先用 set 建立待办，之后每完成一步就用 complete 更新。返回最新的清单与进度。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['set', 'start', 'complete', 'clear'], description: 'set/start/complete/clear' }, items: { type: 'array', items: { type: 'string' }, description: 'action=set 时的步骤文本数组，按顺序排列' }, index: { type: 'integer', description: 'action=start/complete 时要操作的待办序号（从 1 开始）' } }, required: ['action'] } },
  { name: 'delegate', description: '把复杂任务拆成界限清晰、可独立完成的子任务并行委派。应优先使用：多个互不相干文件/模块的同类操作、可并行的调研+编码、改动后的独立复查（reviewer）、大范围搜索分区并行。每批支持 1–32 个子任务，按设置的并发上限排队执行，返回各任务结果。可选择已配置的子智能体 profileId，或指定角色和模型。研究与审查角色仅能读取和检索；编码与通用角色仍受项目权限及审批约束。同一文件的修改必须串行安排。', parameters: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', properties: { name: { type: 'string', description: '子智能体名称，如「前端」「接口」' }, instruction: { type: 'string', description: '完整独立的任务说明，包含目标、负责文件、约束和验收标准；子智能体看不到当前对话，必须写全所需背景' }, profileId: { type: 'string', description: '已配置的子智能体 ID，取自系统提示中的配置列表；配置的角色和非空模型优先' }, role: { type: 'string', enum: ['general', 'researcher', 'coder', 'reviewer'], description: '未选择配置时的角色，默认 general；researcher 和 reviewer 为只读' }, modelId: { type: 'string', description: '模型配置 ID，取自系统提示中的可用模型列表；省略时沿用主智能体模型' } }, required: ['instruction'] }, description: '子任务数组，超出并发上限的任务自动排队' } }, required: ['tasks'] } },
  { name: 'load_skill', description: '加载一个已安装技能的完整指令（SKILL.md 全文），按其中的步骤、规范与流程执行任务。技能清单（名称、适用场景）见系统提示的「可用技能」一节；当任务与某个技能描述的场景匹配、或用户提到该技能时，先调用此工具加载，再严格按技能内容执行。不要加载与当前任务无关的技能。', parameters: { type: 'object', properties: { id: { type: 'string', description: '技能 ID，取自系统提示中的可用技能列表' } }, required: ['id'] } },
  { name: 'create_workflow', description: '把一个多步骤任务保存为 Work 画布工作流（线性顺序执行）。用户要求「做一个工作流 / 把这个流程保存为工作流 / 自动化这套步骤」时使用。节点按给出顺序依次串联执行，每个节点是一步（title 一句话，prompt 是该步的完整执行指令）。保存后用户可在 Work 画布中查看、编辑与运行。', parameters: { type: 'object', properties: { name: { type: 'string', description: '工作流名称，一句话' }, nodes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { title: { type: 'string', description: '步骤名，一句话' }, prompt: { type: 'string', description: '该步骤的完整执行指令，包含所需背景与验收标准；执行节点之间不共享上下文，必须各自写全' }, kind: { type: 'string', enum: ['task', 'command', 'search', 'file', 'git', 'review'], description: '节点类型，默认 task（通用 agent 执行）；command 为运行命令，search 为检索，file 为文件操作，git 为版本操作，review 为审查' } }, required: ['title', 'prompt'] } } }, required: ['name', 'nodes'] } },
]

export const interactiveTools: ReadonlySet<ToolName> = new Set(['ask_user'])
export const todoTools: ReadonlySet<ToolName> = new Set(['manage_todos'])
export const delegateTools: ReadonlySet<ToolName> = new Set(['delegate'])

export const mutatingTools: ReadonlySet<ToolName> = new Set(['write_file', 'edit_file'])
export const commandTools: ReadonlySet<ToolName> = new Set(['run_command'])
export const browserTools: ReadonlySet<ToolName> = new Set(['browser_navigate', 'browser_click', 'browser_type', 'browser_extract', 'browser_screenshot', 'browser_wait', 'browser_search', 'browser_tab', 'browser_crawl', 'browser_extract_links'])
export const extensionToolNames: ReadonlySet<ToolName> = new Set(['github_push', 'browser_open', 'web_search', 'computer_use', 'generate_image', 'plugin_call', 'mcp_call', 'browser_navigate', 'browser_click', 'browser_type', 'browser_extract', 'browser_screenshot', 'browser_wait', 'browser_search', 'browser_tab', 'browser_crawl', 'browser_extract_links'])
export const sensitiveExtensionTools: ReadonlySet<ToolName> = new Set(['github_push', 'computer_use', 'plugin_call', 'mcp_call', 'browser_navigate', 'browser_click', 'browser_type', 'browser_tab', 'browser_crawl'])

const normalizeCommand = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()

export function matchesCommandRule(command: string, rules: readonly string[]): string | undefined {
  const target = normalizeCommand(command)
  const segments = target.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
  return rules.find((rule) => {
    const pattern = normalizeCommand(rule)
    if (!pattern) return false
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      return segments.some((segment) => regex.test(segment))
    }
    return segments.some((segment) => segment === pattern || segment.startsWith(`${pattern} `))
  })
}

export function summarizeCall(call: ToolCall): string {
  const a = call.args
  switch (call.name) {
    case 'read_file': return `读取 ${String(a.path ?? '')}`
    case 'list_directory': return `列出 ${String(a.path ?? '.') || '.'}`
    case 'search_files': return `搜索 /${String(a.pattern ?? '')}/${a.path ? ` 于 ${String(a.path)}` : ''}`
    case 'write_file': return `写入 ${String(a.path ?? '')}`
    case 'edit_file': return `编辑 ${String(a.path ?? '')}`
    case 'run_command': return `执行 ${String(a.command ?? '')}`
    case 'ask_user': return `询问 ${String(a.question ?? '')}`
    case 'manage_todos': return `更新待办（${String(a.action ?? '')}）`
    case 'delegate': {
      const tasks = Array.isArray(a.tasks) ? a.tasks : []
      const names = tasks.map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name?: unknown }).name ?? '') : '')).filter(Boolean)
      return `委派 ${tasks.length} 个子任务${names.length ? `：${names.join('、')}` : ''}`
    }
    case 'github_push': return `推送到 GitHub${a.message ? `：${String(a.message)}` : ''}`
    case 'browser_open': return `打开网页 ${String(a.url ?? '')}`
    case 'web_search': return `联网搜索 ${String(a.query ?? '')}`
    case 'computer_use': {
      const detail = a.action === 'type' ? `输入「${String(a.text ?? '').slice(0, 200)}」` : a.action === 'key' ? `按键 ${String(a.keys ?? '')}` : a.action === 'click' ? `单击 (${String(a.x)}, ${String(a.y)})` : a.action === 'open' ? `打开 ${String(a.target ?? '')}` : '截屏'
      return `电脑操控：${detail}`
    }
    case 'browser_navigate': return `浏览器打开 ${String(a.url ?? '')}`
    case 'browser_click': return `浏览器点击 ${String(a.selector ?? '')}`
    case 'browser_type': return `浏览器输入到 ${String(a.selector ?? '')}：「${String(a.text ?? '').slice(0, 120)}」`
    case 'browser_extract': return `浏览器提取内容${a.selector ? `（${String(a.selector)}）` : ''}`
    case 'browser_screenshot': return '浏览器截屏'
    case 'browser_wait': return `浏览器等待${a.selector ? ` ${String(a.selector)}` : `${String(a.ms ?? 1000)}ms`}`
    case 'browser_search': return `浏览器搜索 ${String(a.query ?? '')}`
    case 'browser_crawl': return `全网爬取 ${String(a.query ?? '')}${Array.isArray(a.urls) && a.urls.length ? `（${a.urls.length} 个种子链接）` : ''}`
    case 'browser_extract_links': return `浏览器提取链接${a.selector ? `（${String(a.selector)}）` : ''}`
    case 'browser_tab': return `浏览器标签页 ${String(a.action ?? '')}${a.tabId ? ` ${String(a.tabId)}` : ''}`
    case 'generate_image': return `生成图片：「${String(a.prompt ?? '').slice(0, 80)}」`
    case 'plugin_call': return `插件 ${String(a.plugin ?? '')}/${String(a.tool ?? '')}${a.args ? ` ${JSON.stringify(a.args).slice(0, 300)}` : ''}`
    case 'mcp_call': return `MCP ${String(a.server ?? '')}/${String(a.tool ?? '')}${a.args ? ` ${JSON.stringify(a.args).slice(0, 300)}` : ''}`
    default: return `调用 ${String(call.name)}`
  }
}

export interface SandboxOptions {
  enabled: boolean
  allowNetwork: boolean
}

export interface ToolContext {
  root: string
  signal: AbortSignal
  commandTimeoutMs?: number
  shell?: 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh'
  sandbox?: SandboxOptions
}

export async function runTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const started = Date.now()
  try {
    const result = await dispatch(call, context)
    return { callId: call.id, name: call.name, ok: true, durationMs: Date.now() - started, ...result }
  } catch (error) {
    return { callId: call.id, name: call.name, ok: false, output: clip(error instanceof Error ? error.message : String(error)), durationMs: Date.now() - started }
  }
}

async function dispatch(call: ToolCall, context: ToolContext): Promise<{ output: string; diff?: string }> {
  const a = call.args
  if (typeof a.__raw === 'string') throw new Error('工具参数不是合法 JSON（可能被截断），未执行。请检查输出是否过长并重新调用该工具。')
  switch (call.name) {
    case 'read_file': return { output: await readFileTool(context.root, str(a.path), num(a.start), num(a.limit)) }
    case 'list_directory': return { output: await listTool(context.root, str(a.path) || '.', num(a.depth) ?? 2) }
    case 'search_files': return { output: await searchTool(context.root, str(a.pattern), str(a.path) || '.', str(a.glob), context.signal) }
    case 'write_file': {
      if (a.content === undefined || a.content === null) throw new Error('缺少 content 参数（可能因输出过长被截断），未写入。请重新调用 write_file 并提供完整内容。')
      return writeTool(context.root, str(a.path), str(a.content))
    }
    case 'edit_file': {
      if (a.new_text === undefined || a.new_text === null) throw new Error('缺少 new_text 参数（可能因输出过长被截断），未编辑。请重新调用 edit_file 并提供完整内容。')
      return editTool(context.root, str(a.path), str(a.old_text), str(a.new_text))
    }
    case 'run_command': return { output: await commandTool(context.root, str(a.command), num(a.timeout_ms), context.signal, context.commandTimeoutMs ?? MAX_COMMAND_MS, context.shell ?? 'auto', context.sandbox) }
    case 'ask_user': throw new Error('ask_user 需要由会话层处理')
    case 'manage_todos': throw new Error('manage_todos 需要由会话层处理')
    case 'delegate': throw new Error('delegate 需要由会话层处理')
    case 'load_skill': throw new Error('load_skill 需要由会话层处理')
    case 'create_workflow': throw new Error('create_workflow 需要由会话层处理')
    default: throw new Error(`未知工具：${String(call.name)}`)
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined)
const clip = (text: string, max = MAX_OUTPUT) => (text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）` : text)

const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)

export async function resolveInside(root: string, target: string): Promise<string> {
  if (!target.trim()) throw new Error('路径不能为空')
  const absolute = resolve(root, target)
  if (escapes(relative(root, absolute))) throw new Error(`路径越出项目目录：${target}`)
  let probe = absolute
  while (true) {
    try {
      const real = await realpath(probe)
      const realRoot = await realpath(root)
      if (escapes(relative(realRoot, real))) throw new Error(`路径通过链接越出项目目录：${target}`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  const name = absolute.slice(absolute.lastIndexOf(sep) + 1)
  if (SENSITIVE.test(name)) throw new Error(`拒绝访问疑似凭据文件：${target}`)
  return absolute
}

async function readFileTool(root: string, path: string, start?: number, limit?: number): Promise<string> {
  const file = await resolveInside(root, path)
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`不是文件：${path}`)
  if (info.size > MAX_READ_BYTES) throw new Error(`文件过大（${info.size} 字节），请用 start/limit 读取片段或改用 search_files`)
  const lines = (await readFile(file, 'utf8')).split('\n')
  const from = Math.max(1, start ?? 1)
  const count = Math.min(Math.max(1, limit ?? 400), 2000)
  const slice = lines.slice(from - 1, from - 1 + count)
  const numbered = slice.map((line, index) => `${String(from + index).padStart(5)}| ${line}`).join('\n')
  const tail = from - 1 + count < lines.length ? `\n…（共 ${lines.length} 行，已显示到第 ${from - 1 + slice.length} 行）` : ''
  return clip(numbered + tail)
}

async function listTool(root: string, path: string, depth: number): Promise<string> {
  const dir = await resolveInside(root, path)
  const lines: string[] = []
  let count = 0
  const walk = async (current: string, level: number) => {
    if (level > Math.min(depth, 4) || count > 800) return
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (count++ > 800) { lines.push('…（条目过多，已截断）'); return }
      const rel = relative(root, join(current, entry.name)).split(sep).join('/')
      if (entry.isDirectory()) {
        lines.push(`${rel}/${SKIP_DIRS.has(entry.name) ? '  (已跳过)' : ''}`)
        if (!SKIP_DIRS.has(entry.name) && !entry.isSymbolicLink()) await walk(join(current, entry.name), level + 1)
      } else lines.push(rel)
    }
  }
  await walk(dir, 1)
  return clip(lines.join('\n') || '（空目录）')
}

async function searchTool(root: string, pattern: string, path: string, glob: string, signal: AbortSignal): Promise<string> {
  if (!pattern) throw new Error('缺少搜索模式')
  let regex: RegExp
  try { regex = new RegExp(pattern, 'i') } catch { throw new Error(`无效正则：${pattern}`) }
  const dir = await resolveInside(root, path)
  const hits: string[] = []
  let scanned = 0
  let scanCapped = false
  const walk = async (current: string, level: number) => {
    if (level > 10 || hits.length >= 300 || signal.aborted) return
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (hits.length >= 300 || signal.aborted) return
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, level + 1)
        continue
      }
      if (!entry.isFile() || SENSITIVE.test(entry.name) || (glob && !entry.name.endsWith(glob))) continue
      if (++scanned > 5000) { scanCapped = true; return }
      const info = await lstat(full)
      if (info.size > MAX_READ_BYTES) continue
      const text = await readFile(full, 'utf8').catch(() => '')
      if (text.includes('\u0000')) continue
      const rel = relative(root, full).split(sep).join('/')
      text.split('\n').forEach((line, index) => {
        if (hits.length < 300 && regex.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim().slice(0, 300)}`)
      })
    }
  }
  await walk(dir, 0)
  const tail = hits.length >= 300 ? '\n…（结果过多，已截断）' : scanCapped ? '\n…（扫描文件数达到上限，结果可能不完整；请缩小搜索范围重试）' : ''
  return clip(hits.length ? hits.join('\n') + tail : '没有匹配结果' + (scanCapped ? '（注意：扫描文件数已达上限，结果可能不完整）' : ''))
}

async function writeTool(root: string, path: string, content: string): Promise<{ output: string; diff: string }> {
  const file = await resolveInside(root, path)
  const before = await readFile(file, 'utf8').catch(() => null)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  const diff = makeDiff(path, before ?? '', content)
  return { output: `${before === null ? '已创建' : '已覆盖'} ${path}（${content.split('\n').length} 行）`, diff }
}

async function editTool(root: string, path: string, oldText: string, newText: string): Promise<{ output: string; diff: string }> {
  if (!oldText) throw new Error('old_text 不能为空')
  const file = await resolveInside(root, path)
  const before = await readFile(file, 'utf8')
  const first = before.indexOf(oldText)
  if (first === -1) throw new Error(`在 ${path} 中找不到 old_text，请先 read_file 确认内容`)
  if (before.indexOf(oldText, first + oldText.length) !== -1) throw new Error('old_text 在文件中出现多次，请提供更长的唯一片段')
  const after = before.slice(0, first) + newText + before.slice(first + oldText.length)
  await writeFile(file, after, 'utf8')
  return { output: `已编辑 ${path}`, diff: makeDiff(path, before, after) }
}

export interface BrowseEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  skipped?: boolean
}

export async function browseDirectory(root: string, path = '.'): Promise<BrowseEntry[]> {
  const dir = await resolveInside(root, path || '.')
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: relative(root, join(dir, entry.name)).split(sep).join('/'),
      kind: entry.isDirectory() ? 'directory' : 'file',
      skipped: entry.isDirectory() && SKIP_DIRS.has(entry.name) ? true : undefined,
    }))
}

export async function readProjectFile(root: string, path: string): Promise<{ path: string; content: string; size: number; truncated: boolean }> {
  const file = await resolveInside(root, path)
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`不是文件：${path}`)
  const text = await readFile(file, 'utf8')
  if (text.includes('\u0000')) throw new Error(`二进制文件无法预览：${path}`)
  const truncated = text.length > MAX_READ_BYTES
  return { path, content: truncated ? text.slice(0, MAX_READ_BYTES) : text, size: info.size, truncated }
}

const pendingFileSaves = new Map<string, Promise<void>>()

export async function saveProjectFile(root: string, path: string, content: string, expectedContent: string): Promise<{ path: string; content: string; size: number; truncated: boolean }> {
  if (content.length > MAX_READ_BYTES || expectedContent.length > MAX_READ_BYTES) throw new Error('文件过大，无法在预览中编辑')
  if (content.includes('\u0000')) throw new Error('不能保存包含二进制内容的文件')
  const file = await resolveInside(root, path)
  const key = process.platform === 'win32' ? file.toLowerCase() : file
  const previous = pendingFileSaves.get(key) ?? Promise.resolve()
  let release = (): void => undefined
  const pending = new Promise<void>((resolve) => { release = resolve })
  pendingFileSaves.set(key, pending)
  try {
    await previous
    const checked = await resolveInside(root, path)
    if (checked !== file) throw new Error('文件路径已变化，请重新打开文件')
    const info = await stat(file)
    if (!info.isFile()) throw new Error(`不是文件：${path}`)
    const bytes = await readFile(file)
    const before = bytes.toString('utf8')
    if (before.includes('\u0000') || !Buffer.from(before, 'utf8').equals(bytes)) throw new Error('此文件不是可编辑的 UTF-8 文本')
    if (before.length > MAX_READ_BYTES) throw new Error('文件过大，截断预览不能用于保存')
    if (before !== expectedContent) throw new Error('文件已被其他操作修改，请重新加载后再编辑；当前草稿未保存')
    if (content !== before) await writeFile(file, content, 'utf8')
    return { path, content, size: Buffer.byteLength(content, 'utf8'), truncated: false }
  } finally {
    release()
    if (pendingFileSaves.get(key) === pending) pendingFileSaves.delete(key)
  }
}

export function runShellCommand(root: string, command: string, options: { signal?: AbortSignal; timeoutMs?: number; shell?: ToolContext['shell']; sandbox?: SandboxOptions } = {}): Promise<string> {
  const signal = options.signal ?? new AbortController().signal
  const maxMs = options.timeoutMs ?? MAX_COMMAND_MS
  return commandTool(root, command, undefined, signal, maxMs, options.shell ?? 'auto', options.sandbox)
}

export function makeDiff(path: string, before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const removed = a.slice(prefix, a.length - suffix)
  const added = b.slice(prefix, b.length - suffix)
  const context = 3
  const ctxBefore = a.slice(Math.max(0, prefix - context), prefix)
  const ctxAfter = a.slice(a.length - suffix, a.length - suffix + context)
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${Math.max(1, prefix - ctxBefore.length + 1)},${ctxBefore.length + removed.length + ctxAfter.length} +${Math.max(1, prefix - ctxBefore.length + 1)},${ctxBefore.length + added.length + ctxAfter.length} @@`,
    ...ctxBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...ctxAfter.map((line) => ` ${line}`),
  ]
  return clip(lines.join('\n'), 50_000)
}

function commandTool(root: string, command: string, timeoutMs: number | undefined, signal: AbortSignal, maxMs: number, shell: NonNullable<ToolContext['shell']>, sandbox?: SandboxOptions): Promise<string> {
  if (!command.trim()) throw new Error('命令不能为空')
  if (sandbox?.enabled && findEscape(command)) throw new Error('沙箱已拦截可能越权的命令。如确需执行，请在设置中关闭沙箱或将其加入允许列表。')
  const limit = Math.min(Math.max(timeoutMs ?? maxMs, 1000), maxMs)
  return new Promise((resolvePromise) => {
    const [file, args] = shellCommand(shell, command)
    const env = sandbox?.enabled ? buildSandboxEnv(root, sandbox.allowNetwork) : process.env
    const child = spawn(file, args, { cwd: root, windowsHide: true, env, detached: spawnDetached, windowsVerbatimArguments: file === 'cmd.exe' })
    let output = ''
    let truncated = false
    // 多字节 UTF-8 字符可能被切在 chunk 边界上，用 StringDecoder 缓冲不完整的字节序列（中文 Windows 下 PowerShell 输出必现）
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const push = (chunk: Buffer, decoder: StringDecoder) => {
      if (output.length >= MAX_OUTPUT) { truncated = true; return }
      output += decoder.write(chunk)
    }
    child.stdout?.on('data', (chunk: Buffer) => push(chunk, stdoutDecoder))
    child.stderr?.on('data', (chunk: Buffer) => push(chunk, stderrDecoder))
    let finished = false
    let fallback: NodeJS.Timeout | undefined
    const kill = () => {
      if (finished || child.pid === undefined) return
      killTree(child)
      fallback ??= setTimeout(() => done(null), 3000)
    }
    const timer = setTimeout(() => { kill(); output += `\n[超时 ${limit}ms，已终止]` }, limit)
    const onAbort = () => { kill(); output += '\n[用户取消，已终止]' }
    signal.addEventListener('abort', onAbort, { once: true })
    const done = (code: number | null, error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(fallback)
      signal.removeEventListener('abort', onAbort)
      // 把 decoder 中残留的不完整字节也冲出来
      output += stdoutDecoder.end() + stderrDecoder.end()
      child.stdout?.destroy()
      child.stderr?.destroy()
      const body = clip(output.slice(0, MAX_OUTPUT)) + (truncated ? '\n…（输出已截断）' : '')
      resolvePromise(error ? `启动失败：${error.message}` : `${body.trim() || '（无输出）'}\n\n[退出码 ${code ?? 'null'}]`)
    }
    child.on('error', (error) => done(null, error))
    child.on('exit', (code) => setTimeout(() => done(code), 150))
    child.on('close', (code) => done(code))
    if (signal.aborted) onAbort()
  })
}
