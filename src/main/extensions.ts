import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, desktopCapturer, shell } from 'electron'
import { pluginManifestSchema, type PluginInfo, type PluginManifest, type Settings, type ToolCall } from '../shared/schema'
import type { ToolSpec } from './llm'
import type { McpManager } from './mcp'
import { killTree, spawnDetached } from './platform/proc'

const MAX_OUTPUT = 40_000
const clip = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（已截断，共 ${text.length} 字符）` : text)
const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

export { extensionToolNames } from './tools'

interface LoadedPlugin {
  dir: string
  manifest?: PluginManifest
  error?: string
}

export interface ExtensionContext {
  root: string
  signal: AbortSignal
  threadId?: string
}

export interface ExtensionDeps {
  pluginsDir: string
  getSettings: () => Settings
  getGithubToken: () => string | undefined
  mcp?: McpManager
  onControl?: (control: { active: true; kind: 'computer' | 'browser'; label: string; threadId: string } | { active: false }) => void
}

export const EXAMPLE_PLUGIN = {
  'plugin.json': JSON.stringify({
    name: 'hello',
    description: '示例插件：回显参数并返回当前时间。复制此目录即可编写自己的插件。',
    version: '1.0.0',
    tools: [{ name: 'echo', description: '回显传入的 text 参数', command: 'node index.js', parameters: { type: 'object', properties: { text: { type: 'string', description: '要回显的文本' } }, required: ['text'] } }],
  }, null, 2),
  'index.js': [
    "// Cubex 插件协议：参数以 JSON 形式通过标准输入与环境变量 CUBEX_ARGS 传入；",
    "// CUBEX_TOOL 为被调用的工具名，CUBEX_PROJECT_ROOT 为当前项目根目录；标准输出即返回给模型的结果。",
    "const args = JSON.parse(process.env.CUBEX_ARGS || '{}')",
    "console.log(`[${process.env.CUBEX_TOOL}] ${args.text ?? ''} @ ${new Date().toLocaleString('zh-CN')}`)",
    '',
  ].join('\n'),
}

export const BUILTIN_PLUGINS: Record<string, Record<string, string>> = {
  hello: EXAMPLE_PLUGIN,
}

export class ExtensionHost {
  private plugins: LoadedPlugin[] = []

  constructor(private readonly deps: ExtensionDeps) {}

  async load(): Promise<void> {
    await mkdir(this.deps.pluginsDir, { recursive: true })
    await this.seedBuiltins()
    const loaded: LoadedPlugin[] = []
    for (const entry of await readdir(this.deps.pluginsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const dir = join(this.deps.pluginsDir, entry.name)
      try {
        const raw = JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8')) as unknown
        const parsed = pluginManifestSchema.safeParse(raw)
        loaded.push(parsed.success ? { dir, manifest: parsed.data } : { dir, error: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；') })
      } catch (error) {
        loaded.push({ dir, error: `无法读取 plugin.json：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    const seen = new Set<string>()
    this.plugins = loaded.map((item) => {
      if (!item.manifest) return item
      if (seen.has(item.manifest.name)) return { dir: item.dir, error: `插件名「${item.manifest.name}」重复` }
      seen.add(item.manifest.name)
      return item
    })
  }

  private async seedBuiltins(): Promise<void> {
    const existing = new Set((await readdir(this.deps.pluginsDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    for (const [name, files] of Object.entries(BUILTIN_PLUGINS)) {
      if (existing.has(name)) continue
      const dir = join(this.deps.pluginsDir, name)
      await mkdir(dir, { recursive: true })
      for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content, 'utf8')
    }
  }

  private enabledPlugins(): PluginManifest[] {
    const disabled = new Set(this.deps.getSettings().plugins.disabled)
    return this.plugins.flatMap((item) => (item.manifest && !disabled.has(item.manifest.name) ? [item.manifest] : []))
  }

  list(): PluginInfo[] {
    const settings = this.deps.getSettings()
    const disabled = new Set(settings.plugins.disabled)
    const builtin: PluginInfo[] = [
      { name: 'browser', description: '内置浏览器：打开网页并读取标题、正文与链接，供智能体查资料、验证页面。', builtin: true, enabled: settings.plugins.browser, tools: [{ name: 'browser_open', description: '打开 http/https 页面并提取文本' }] },
      { name: 'search', description: '联网搜索：输入关键词，返回相关网页的标题、地址与摘要，搜索到的网页会显示在任务摘要中。', builtin: true, enabled: settings.plugins.search, tools: [{ name: 'web_search', description: '按关键词联网搜索并返回结果列表' }] },
      { name: 'computer', description: '电脑操控：截屏、打开应用或文件、输入文字、按键、点击坐标。每次操作都需要你批准。', builtin: true, enabled: settings.plugins.computer, tools: [{ name: 'computer_use', description: 'screenshot / open / type / key / click' }] },
    ]
    const user = this.plugins.map<PluginInfo>((item) => item.manifest
      ? { name: item.manifest.name, description: item.manifest.description, version: item.manifest.version, builtin: false, enabled: !disabled.has(item.manifest.name), tools: item.manifest.tools.map((tool) => ({ name: tool.name, description: tool.description })), path: item.dir }
      : { name: item.dir.split(/[\\/]/).pop() ?? item.dir, description: '', builtin: false, enabled: false, tools: [], path: item.dir, error: item.error })
    return [...builtin, ...user]
  }

  specs(settings: Settings): ToolSpec[] {
    const specs: ToolSpec[] = []
    if (settings.github.hasToken) specs.push({ name: 'github_push', description: '把当前项目提交并推送到用户配置的 GitHub 仓库（仓库不存在时自动创建）。仅在用户要求或设置允许自动推送时使用。', parameters: { type: 'object', properties: { message: { type: 'string', description: '提交说明，简要概括本次改动' } }, required: [] } })
    if (settings.plugins.browser) specs.push({ name: 'browser_open', description: '在内置浏览器中打开网页，返回标题、可见正文和主要链接。用于查阅文档、验证网页或本地开发服务。', parameters: { type: 'object', properties: { url: { type: 'string', description: 'http 或 https 地址' }, selector: { type: 'string', description: '可选，只提取匹配该 CSS 选择器的元素文本' } }, required: ['url'] } })
    if (settings.plugins.search) specs.push({ name: 'web_search', description: '联网搜索：输入关键词，返回若干条相关网页的标题、地址与摘要。需要获取最新资料、查证事实或寻找网页时使用；拿到结果后可再用 browser_open 打开某个地址查看详情。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, limit: { type: 'integer', description: '返回结果条数，默认 6，最多 10' } }, required: ['query'] } })
    if (settings.plugins.computer) specs.push({ name: 'computer_use', description: '操控用户电脑。action：screenshot（截屏并把图片直接返回给你查看，同时保存到项目 .cubex/screenshots，你可以据此判断屏幕内容）、open（打开应用/文件/网址，target 为路径或 URL）、type（输入 text）、key（发送按键 keys，SendKeys 语法，如 ^s、{ENTER}）、click（在 x,y 屏幕坐标单击）。每次调用都需要用户批准。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['screenshot', 'open', 'type', 'key', 'click'] }, target: { type: 'string' }, text: { type: 'string' }, keys: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['action'] } })
    const plugins = this.enabledPlugins()
    if (plugins.length) {
      const catalog = plugins.map((plugin) => plugin.tools.map((tool) => `- ${plugin.name}/${tool.name}：${tool.description}${tool.parameters ? `；参数 ${JSON.stringify(tool.parameters).slice(0, 400)}` : ''}`).join('\n')).join('\n')
      specs.push({ name: 'plugin_call', description: `调用用户安装的插件工具。可用工具：\n${catalog}`, parameters: { type: 'object', properties: { plugin: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object', description: '传给插件工具的参数' } }, required: ['plugin', 'tool'] } })
    }
    const mcp = this.deps.mcp?.catalog() ?? []
    if (mcp.length) {
      const catalog = mcp.map((entry) => entry.tools.slice(0, 80).map((tool) => `- ${entry.server}/${tool.name}：${tool.description.replace(/\s+/g, ' ').slice(0, 300)}${tool.inputSchema ? `；参数 ${JSON.stringify(tool.inputSchema).slice(0, 600)}` : ''}`).join('\n')).join('\n')
      specs.push({ name: 'mcp_call', description: `调用已连接的 MCP（Model Context Protocol）服务器工具。server 为服务器名，tool 为工具名，args 须符合该工具的参数结构。可用工具：\n${catalog}`, parameters: { type: 'object', properties: { server: { type: 'string', description: 'MCP 服务器名' }, tool: { type: 'string', description: '工具名' }, args: { type: 'object', description: '传给工具的参数' } }, required: ['server', 'tool'] } })
    }
    return specs
  }

  async run(call: ToolCall, context: ExtensionContext): Promise<{ output: string; image?: string }> {
    const settings = this.deps.getSettings()
    switch (call.name) {
      case 'github_push': {
        const token = this.deps.getGithubToken()
        if (!token) throw new Error('尚未配置 GitHub 令牌，请在设置 → GitHub 中填写')
        const { pushToGithub } = await import('./github')
        const result = await pushToGithub({ token, projectPath: context.root, github: settings.github, message: str(call.args.message), signal: context.signal })
        return { output: `${result.log}\n仓库地址：${result.url}` }
      }
      case 'browser_open':
        if (!settings.plugins.browser) throw new Error('内置浏览器插件已关闭')
        this.deps.onControl?.({ active: true, kind: 'browser', label: `正在打开网页：${str(call.args.url) || '（空地址）'}`, threadId: context.threadId ?? '' })
        try {
          return { output: await browsePage(str(call.args.url), str(call.args.selector), context.signal) }
        } finally {
          this.deps.onControl?.({ active: false })
        }
      case 'web_search': {
        if (!settings.plugins.search) throw new Error('联网搜索已关闭，请在设置 → 插件中开启')
        const query = str(call.args.query).trim()
        if (!query) throw new Error('请提供搜索关键词')
        const limit = Math.max(1, Math.min(10, Number(call.args.limit) || 6))
        this.deps.onControl?.({ active: true, kind: 'browser', label: `正在联网搜索：${query}`, threadId: context.threadId ?? '' })
        try {
          const results = await webSearch(query, limit, context.signal)
          if (!results.length) return { output: `未找到与「${query}」相关的结果。` }
          const body = results.map((item, i) => `${i + 1}. ${item.title}\n   ${item.url}${item.snippet ? `\n   ${item.snippet}` : ''}`).join('\n\n')
          const marker = `\n\n[CUBEX_SEARCH]${JSON.stringify({ query, results })}`
          return { output: clip(`「${query}」的搜索结果（共 ${results.length} 条）：\n\n${body}${marker}`) }
        } finally {
          this.deps.onControl?.({ active: false })
        }
      }
      case 'computer_use': {
        if (!settings.plugins.computer) throw new Error('电脑操控插件已关闭，请在设置 → 插件中开启')
        const actionLabels: Record<string, string> = { screenshot: '截屏', open: '打开应用/文件', type: '输入文字', key: '发送按键', click: '点击屏幕' }
        const action = str(call.args.action)
        this.deps.onControl?.({ active: true, kind: 'computer', label: `正在操控电脑：${actionLabels[action] ?? action}`, threadId: context.threadId ?? '' })
        try {
          return await computerAction(call.args, context.root)
        } finally {
          this.deps.onControl?.({ active: false })
        }
      }
      case 'plugin_call':
        return { output: await this.callPlugin(str(call.args.plugin), str(call.args.tool), call.args.args, context) }
      case 'mcp_call':
        if (!this.deps.mcp) throw new Error('MCP 未初始化')
        return { output: await this.deps.mcp.call(str(call.args.server), str(call.args.tool), call.args.args, context.signal) }
      default:
        throw new Error(`扩展层不支持的工具：${call.name}`)
    }
  }

  private callPlugin(pluginName: string, toolName: string, args: unknown, context: ExtensionContext): Promise<string> {
    const plugin = this.enabledPlugins().find((item) => item.name === pluginName)
    const loaded = this.plugins.find((item) => item.manifest?.name === pluginName)
    if (!plugin || !loaded) throw new Error(`插件「${pluginName}」不存在或已停用`)
    const tool = plugin.tools.find((item) => item.name === toolName)
    if (!tool) throw new Error(`插件「${pluginName}」没有工具「${toolName}」`)
    const payload = JSON.stringify(args && typeof args === 'object' ? args : {})
    return new Promise((resolvePromise) => {
      const child = spawn(tool.command, { cwd: loaded.dir, shell: true, windowsHide: true, detached: spawnDetached, env: { ...process.env, CUBEX_ARGS: payload, CUBEX_TOOL: tool.name, CUBEX_PLUGIN: plugin.name, CUBEX_PROJECT_ROOT: context.root } })
      let output = ''
      const push = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString('utf8') }
      child.stdout.on('data', push)
      child.stderr.on('data', push)
      const kill = () => killTree(child)
      const timer = setTimeout(() => { kill(); output += '\n[插件超时 120 秒，已终止]' }, 120_000)
      context.signal.addEventListener('abort', kill, { once: true })
      const finish = (text: string) => {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', kill)
        resolvePromise(clip(text))
      }
      child.on('error', (error) => finish(`插件启动失败：${error.message}`))
      child.on('close', (code) => finish(`${output.trim() || '（无输出）'}\n\n[退出码 ${code ?? 'null'}]`))
      child.stdin.end(payload)
    })
  }
}

const hardenedSessions = new WeakSet<Electron.Session>()

export async function browsePage(url: string, selector: string, signal: AbortSignal): Promise<string> {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`无效网址：${url}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http/https 网址')
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'cubex-browser', offscreen: true } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const browserSession = win.webContents.session
  if (!hardenedSessions.has(browserSession)) {
    hardenedSessions.add(browserSession)
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    browserSession.on('will-download', (event) => event.preventDefault())
  }
  const abort = () => { if (!win.isDestroyed()) win.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([
      win.loadURL(parsed.toString()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面加载超时（30 秒）')), 30_000)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 600))
    const script = `(() => {
      const sel = ${JSON.stringify(selector)};
      const nodes = sel ? Array.from(document.querySelectorAll(sel)) : [document.body];
      const text = nodes.map((node) => node ? node.innerText : '').join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map((a) => (a.innerText.trim().slice(0, 60) || '(无文字)') + ' → ' + a.href);
      return { title: document.title, url: location.href, text, links };
    })()`
    const data = await win.webContents.executeJavaScript(script, true) as { title: string; url: string; text: string; links: string[] }
    return clip(`标题：${data.title}\n地址：${data.url}\n\n${data.text.slice(0, 30_000) || '（页面没有可见文本）'}${data.links.length ? `\n\n主要链接：\n${data.links.join('\n')}` : ''}`)
  } finally {
    signal.removeEventListener('abort', abort)
    if (!win.isDestroyed()) win.destroy()
  }
}

export interface SearchResult { title: string; url: string; snippet: string }

export async function webSearch(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`
  const win = new BrowserWindow({ width: 1024, height: 768, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'cubex-browser', offscreen: true } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const browserSession = win.webContents.session
  if (!hardenedSessions.has(browserSession)) {
    hardenedSessions.add(browserSession)
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    browserSession.on('will-download', (event) => event.preventDefault())
  }
  const abort = () => { if (!win.isDestroyed()) win.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([
      win.loadURL(target),
      new Promise((_, reject) => setTimeout(() => reject(new Error('搜索超时（20 秒）')), 20_000)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 400))
    const script = `(() => {
      const out = [];
      const nodes = Array.from(document.querySelectorAll('.result__body, .web-result'));
      for (const node of nodes) {
        const link = node.querySelector('a.result__a, a.result__url');
        if (!link) continue;
        let href = link.getAttribute('href') || '';
        const m = href.match(/[?&]uddg=([^&]+)/);
        if (m) { try { href = decodeURIComponent(m[1]); } catch (e) {} }
        const snippetEl = node.querySelector('.result__snippet');
        out.push({ title: (link.innerText || '').trim(), url: href, snippet: snippetEl ? (snippetEl.innerText || '').trim() : '' });
      }
      return out;
    })()`
    const raw = await win.webContents.executeJavaScript(script, true) as SearchResult[]
    const seen = new Set<string>()
    const results: SearchResult[] = []
    for (const item of raw) {
      if (!item.url || !/^https?:\/\//.test(item.url) || !item.title) continue
      if (seen.has(item.url)) continue
      seen.add(item.url)
      results.push({ title: item.title.slice(0, 200), url: item.url.slice(0, 2048), snippet: (item.snippet || '').replace(/\s+/g, ' ').slice(0, 400) })
      if (results.length >= limit) break
    }
    return results
  } finally {
    signal.removeEventListener('abort', abort)
    if (!win.isDestroyed()) win.destroy()
  }
}

function powershell(script: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('该操作目前仅支持 Windows'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolvePromise(output.trim()) : reject(new Error(output.trim() || `PowerShell 退出码 ${code}`))))
  })
}

const psQuote = (text: string) => `'${text.replace(/'/g, "''")}'`

export async function computerAction(args: Record<string, unknown>, root: string): Promise<{ output: string; image?: string }> {
  const action = str(args.action)
  switch (action) {
    case 'screenshot': {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
      const image = sources[0]?.thumbnail
      if (!image || image.isEmpty()) throw new Error('截屏失败：未获取到屏幕画面')
      const dir = join(root, '.cubex', 'screenshots')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `screen-${Date.now()}.png`)
      const png = image.toPNG()
      await writeFile(file, png)
      const size = image.getSize()
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`
      return { output: `已截屏（${size.width}×${size.height}），保存到 ${file}。截图已附在下方供你查看。`, image: dataUrl }
    }
    case 'open': {
      const target = str(args.target).trim()
      if (!target) throw new Error('open 需要 target')
      if (/^https?:\/\//i.test(target)) { await shell.openExternal(target); return { output: `已在默认浏览器打开 ${target}` } }
      const error = await shell.openPath(target)
      if (error) throw new Error(`无法打开：${error}`)
      return { output: `已打开 ${target}` }
    }
    case 'type': {
      const text = str(args.text)
      if (!text) throw new Error('type 需要 text')
      const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}')
      await powershell(`$w = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 300; $w.SendKeys(${psQuote(escaped)})`)
      return { output: `已输入 ${text.length} 个字符` }
    }
    case 'key': {
      const keys = str(args.keys)
      if (!keys) throw new Error('key 需要 keys')
      await powershell(`$w = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 300; $w.SendKeys(${psQuote(keys)})`)
      return { output: `已发送按键 ${keys}` }
    }
    case 'click': {
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000) throw new Error('click 需要合法的整数坐标 x、y')
      await powershell(`Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);' -Name U -Namespace Cubex; [Cubex.U]::SetCursorPos(${x}, ${y}) | Out-Null; [Cubex.U]::mouse_event(2,0,0,0,0); [Cubex.U]::mouse_event(4,0,0,0,0)`)
      return { output: `已在 (${x}, ${y}) 单击` }
    }
    default:
      throw new Error(`未知操作：${action}（可选 screenshot / open / type / key / click）`)
  }
}
