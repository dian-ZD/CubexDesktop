import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow, desktopCapturer, shell } from 'electron'
import { buildSearchUrl, pluginManifestSchema, type PluginInfo, type PluginManifest, type Settings, type ToolCall } from '../shared/schema'
import type { ToolSpec } from './llm'
import type { McpManager } from './mcp'
import { captureIsolatedDesktop, clickIsolatedDesktop, ISOLATED_DESKTOP_NAME, keyIsolatedDesktop, launchOnIsolatedDesktop, typeIsolatedDesktop, waitForUserIdle } from './computer'
import { browserEngine, type BrowserAction } from './browser'
import { killTree, spawnDetached } from './platform/proc'
import { desktopCaptureSupported } from './platform/capture'

const MAX_OUTPUT = 40_000
const clip = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（已截断，共 ${text.length} 字符）` : text)
const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

/** 用系统 start 启动未注册文件关联的应用名（如 notepad / msedge）；名字含特殊字符时不执行，避免命令注入。 */
function startShellApplication(name: string): Promise<boolean> {
  if (!/^[\w .\-()@+#']{1,80}$/.test(name)) return Promise.resolve(false)
  return new Promise((resolvePromise) => {
    execFile('cmd.exe', ['/c', 'start', '', name], { windowsHide: true }, (error) => resolvePromise(!error))
  })
}

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
  getProviderKey: (providerId: string) => string | undefined
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
      { name: 'computer', description: '电脑操控：截屏、打开应用或文件、输入文字、按键、点击、拖拽、滚动。每次操作都需要你批准。', builtin: true, enabled: settings.plugins.computer && desktopCaptureSupported(), tools: [{ name: 'computer_use', description: 'screenshot / open / type / key / click / double_click / right_click / move / drag / scroll' }] },
      { name: 'image', description: '图片生成：调用用户配置的生图模型（OpenAI 兼容 /images/generations 接口），按提示词生成图片并保存到项目 .cubex/images，同时在对话中展示。', builtin: true, enabled: settings.plugins.image, tools: [{ name: 'generate_image', description: '按提示词生成一张图片' }] },
    ]
    const user = this.plugins.map<PluginInfo>((item) => item.manifest
      ? { name: item.manifest.name, description: item.manifest.description, version: item.manifest.version, builtin: false, enabled: !disabled.has(item.manifest.name), tools: item.manifest.tools.map((tool) => ({ name: tool.name, description: tool.description })), path: item.dir }
      : { name: item.dir.split(/[\\/]/).pop() ?? item.dir, description: '', builtin: false, enabled: false, tools: [], path: item.dir, error: item.error })
    return [...builtin, ...user]
  }

  specs(settings: Settings, mode?: 'code' | 'work' | 'browser'): ToolSpec[] {
    const specs: ToolSpec[] = []
    if (mode === 'browser') {
      const tabIdParam = { type: 'string', description: '可选，目标标签页 id；默认作用于当前活动标签' }
      specs.push({ name: 'browser_navigate', description: '在内置浏览器工作台中打开一个 http/https 网址（用户能实时看到页面）。返回页面标题、地址、可见文本片段与截图。', parameters: { type: 'object', properties: { url: { type: 'string', description: 'http 或 https 地址' }, tabId: tabIdParam }, required: ['url'] } })
      specs.push({ name: 'browser_click', description: '点击当前页面中匹配 CSS 选择器的第一个元素（会先滚动到该元素）。返回点击后的页面状态与截图，据此判断是否成功。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' }, tabId: tabIdParam }, required: ['selector'] } })
      specs.push({ name: 'browser_type', description: '向匹配选择器的输入框/文本域填入文本；submit=true 时提交所在表单。返回页面状态与截图。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' }, text: { type: 'string', description: '要输入的文本' }, submit: { type: 'boolean', description: '是否提交表单' }, tabId: tabIdParam }, required: ['selector', 'text'] } })
      specs.push({ name: 'browser_extract', description: '提取当前页面的可见文本用于阅读理解。可选 selector 只提取匹配元素的文本。返回标题、地址与文本。', parameters: { type: 'object', properties: { selector: { type: 'string', description: '可选，CSS 选择器' }, tabId: tabIdParam }, required: [] } })
      specs.push({ name: 'browser_screenshot', description: '对当前页面截图，返回图片供你查看当前画面。', parameters: { type: 'object', properties: { tabId: tabIdParam }, required: [] } })
      specs.push({ name: 'browser_wait', description: '等待：给 selector 则等待该元素出现（最多 ms 毫秒，默认 15000）；只给 ms 则单纯等待若干毫秒。用于等待页面加载或异步内容渲染。', parameters: { type: 'object', properties: { selector: { type: 'string', description: '可选，等待出现的 CSS 选择器' }, ms: { type: 'integer', description: '毫秒数' }, tabId: tabIdParam }, required: [] } })
      specs.push({ name: 'browser_search', description: '用用户设置的搜索引擎，在用户可见的浏览器视图中直接打开关键词的搜索结果页（用户能实时看到搜索过程）。返回结果页标题、地址、可见文本片段与结构化结果列表（标题/地址/摘要），随后可 browser_click 进入某条结果。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, tabId: tabIdParam }, required: ['query'] } })
      specs.push({ name: 'browser_tab', description: '管理浏览器标签页：action=list 列出全部标签与当前活动标签；new 新建一个标签（可选 url 直接打开网页）；activate 切换到 tabId 指定的标签；close 关闭 tabId 指定的标签。除 list 外都返回最新标签清单。其余 browser_* 工具默认作用于当前活动标签，需要操作别的标签时把它的 id 作为 tabId 传入。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'activate', 'close'], description: 'list / new / activate / close' }, tabId: { type: 'string', description: '目标标签页 id（activate / close 时必填）' }, url: { type: 'string', description: 'action=new 时可选，直接打开的 http/https 网址' } }, required: ['action'] } })
      specs.push({ name: 'browser_crawl', description: '全网批量爬取：给关键词或一组种子网址，自动收集搜索结果/站点链接，按相关性去重后批量抓取多页正文（默认最多 8 页，可到 20），一次返回聚合后的多页内容与来源列表。适合查资料、对比多个来源、市场/产品/技术调研等「要看很多网页」的任务；单页逐步点读用 browser_search/browser_navigate。depth=1 时会跟进已抓页面中的相关链接再抓一层。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词（与 urls 至少给一个）' }, urls: { type: 'array', items: { type: 'string' }, description: '种子网址列表，直接抓这些页面' }, maxPages: { type: 'integer', description: '最多抓取页数，默认取设置（3–20）' }, depth: { type: 'integer', description: '0=只抓种子/搜索结果（默认）；1=跟进相关链接再抓一层' } }, required: [] } })
      specs.push({ name: 'browser_extract_links', description: '提取当前页面（或匹配 selector 的容器内）的结构化链接列表（标题/地址/锚文本），用于先看清页面上有哪些可去的入口，再决定点哪个或批量交给 browser_crawl。', parameters: { type: 'object', properties: { selector: { type: 'string', description: '可选，限定在匹配该 CSS 选择器的容器内提取' }, tabId: tabIdParam }, required: [] } })
    }
    if (settings.github.hasToken) specs.push({ name: 'github_push', description: '把当前项目提交并推送到用户配置的 GitHub 仓库（仓库不存在时自动创建）。仅在用户要求或设置允许自动推送时使用。', parameters: { type: 'object', properties: { message: { type: 'string', description: '提交说明，简要概括本次改动' } }, required: [] } })
    if (settings.plugins.browser && mode !== 'browser') specs.push({ name: 'browser_open', description: '在内置浏览器中打开网页，返回标题、可见正文和主要链接。用于查阅文档、验证网页或本地开发服务。', parameters: { type: 'object', properties: { url: { type: 'string', description: 'http 或 https 地址' }, selector: { type: 'string', description: '可选，只提取匹配该 CSS 选择器的元素文本' } }, required: ['url'] } })
    // Browser 模式下不提供后台抓取式 web_search：搜索应直接在用户可见的浏览器视图里打开结果页，
    // 由 AI 用 browser_navigate 完成（既能实时展现搜索过程，也避免离屏抓取导致的超时）。
    if (settings.plugins.search && mode !== 'browser') specs.push({ name: 'web_search', description: '联网搜索：输入关键词，返回若干条相关网页的标题、地址与摘要。需要获取最新资料、查证事实或寻找网页时使用；拿到结果后可再用 browser_open 打开某个地址查看详情。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, limit: { type: 'integer', description: '返回结果条数，默认 6，最多 10' } }, required: ['query'] } })
    if (settings.plugins.computer && desktopCaptureSupported()) specs.push({ name: 'computer_use', description: '操控用户电脑。action：screenshot（截屏并把图片直接返回给你查看，你可以据此判断屏幕内容）、open（打开应用/文件/网址）、type（输入 text）、key（发送按键 keys，SendKeys 语法，如 ^s、{ENTER}）、click（在 x,y 单击）、double_click（双击）、right_click（右键单击）、move（只移动鼠标）、drag（从 fromX,fromY 拖到 toX,toY，可设 hold 毫秒）、scroll（滚轮，amount 正数向下）。除截图外每次调用都需要用户批准；模式为「独立桌面」时，click/drag/type/key 需要额外提供 window（目标窗口标题），AI 的鼠标和键鼠操作都发生在独立桌面上，不会抢占你当前的桌面。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['screenshot', 'open', 'type', 'key', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll'] }, target: { type: 'string' }, text: { type: 'string' }, keys: { type: 'string' }, window: { type: 'string', description: '独立桌面模式下的目标窗口标题' }, x: { type: 'integer' }, y: { type: 'integer' }, fromX: { type: 'integer' }, fromY: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' }, hold: { type: 'integer', description: '拖拽按下后的停留毫秒' }, amount: { type: 'integer', description: '滚动单位，正数向下' } }, required: ['action'] } })
    if (settings.plugins.image) {
      const configured = settings.image.providerId && settings.image.modelId
      const sizeHint = settings.image.size === 'auto' ? '由服务自动决定' : settings.image.size
      specs.push({ name: 'generate_image', description: `调用用户配置的生图模型，按提示词生成一张图片。${configured ? '图片会保存到项目 .cubex/images 并直接显示在对话里。' : '（尚未配置图片模型时调用会失败，请提示用户到 设置 → 图片生成 中配置。）'}默认尺寸 ${sizeHint}，可用 size 覆盖（1024x1024 / 1024x1536 / 1536x1024 等，以服务支持为准）。写提示词时用一句具体、完整的描述，包含主体、风格、构图与光影。`, parameters: { type: 'object', properties: { prompt: { type: 'string', description: '对要生成图片的完整描述' }, size: { type: 'string', description: '可选，图片尺寸，如 1024x1024；默认用设置中的尺寸' } }, required: ['prompt'] } })
    }
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
        if (!desktopCaptureSupported()) throw new Error('当前系统桌面会话不支持电脑操控（Linux 需要 X11 会话；Wayland 下截屏不可用）')
        const actionLabels: Record<string, string> = { screenshot: '截屏', open: '打开应用/文件', type: '输入文字', key: '发送按键', click: '点击屏幕' }
        const action = str(call.args.action)
        this.deps.onControl?.({ active: true, kind: 'computer', label: `正在操控电脑：${actionLabels[action] ?? action}`, threadId: context.threadId ?? '' })
        try {
          return await computerAction(call.args, context.root, settings)
        } finally {
          this.deps.onControl?.({ active: false })
        }
      }
      case 'browser_navigate':
      case 'browser_click':
      case 'browser_type':
      case 'browser_extract':
      case 'browser_screenshot':
      case 'browser_wait':
      case 'browser_search':
      case 'browser_extract_links':
        return this.runBrowser(call, context)
      case 'browser_crawl':
        return this.runBrowserCrawl(call, context)
      case 'browser_tab':
        return this.runBrowserTab(call, context)
      case 'generate_image':
        return this.runGenerateImage(call, context)
      case 'plugin_call':
        return { output: await this.callPlugin(str(call.args.plugin), str(call.args.tool), call.args.args, context) }
      case 'mcp_call':
        if (!this.deps.mcp) throw new Error('MCP 未初始化')
        return { output: await this.deps.mcp.call(str(call.args.server), str(call.args.tool), call.args.args, context.signal) }
      default:
        throw new Error(`扩展层不支持的工具：${call.name}`)
    }
  }

  private async runBrowser(call: ToolCall, context: ExtensionContext): Promise<{ output: string; image?: string }> {
    const a = call.args
    let action: BrowserAction
    let label: string
    switch (call.name) {
      case 'browser_navigate': {
        const url = str(a.url).trim()
        if (!url) throw new Error('请提供要打开的网址')
        action = { kind: 'navigate', url }
        label = `打开网页：${url}`
        break
      }
      case 'browser_search': {
        const query = str(a.query).trim()
        if (!query) throw new Error('请提供搜索关键词')
        const browser = this.deps.getSettings().browser
        const url = buildSearchUrl(query, browser.searchEngine, browser.searchTemplate)
        action = { kind: 'navigate', url }
        label = `搜索：${query}`
        break
      }
      case 'browser_click':
        if (!str(a.selector).trim()) throw new Error('请提供要点击的元素选择器')
        action = { kind: 'click', selector: str(a.selector) }
        label = `点击 ${str(a.selector)}`
        break
      case 'browser_type':
        if (!str(a.selector).trim()) throw new Error('请提供输入框选择器')
        action = { kind: 'type', selector: str(a.selector), text: str(a.text), submit: a.submit === true }
        label = `输入到 ${str(a.selector)}`
        break
      case 'browser_extract':
        action = { kind: 'extract', ...(str(a.selector).trim() ? { selector: str(a.selector) } : {}) }
        label = '提取页面内容'
        break
      case 'browser_extract_links':
        action = { kind: 'links', ...(str(a.selector).trim() ? { selector: str(a.selector) } : {}) }
        label = '提取页面链接'
        break
      case 'browser_screenshot':
        action = { kind: 'screenshot' }
        label = '页面截屏'
        break
      case 'browser_wait':
        action = { kind: 'wait', ...(str(a.selector).trim() ? { selector: str(a.selector) } : {}), ...(Number(a.ms) ? { ms: Number(a.ms) } : {}) }
        label = '等待页面'
        break
      default:
        throw new Error(`不支持的浏览器动作：${call.name}`)
    }
    const threadId = context.threadId ?? ''
    const tabId = str(a.tabId).trim() || undefined
    this.deps.onControl?.({ active: true, kind: 'browser', label: `浏览器：${label}`, threadId })
    try {
      const result = await browserEngine.run(threadId, action, context.signal, tabId)
      const status = result.verified ? '已完成' : '未按预期完成'
      if (call.name === 'browser_extract_links') {
        const links = result.links ?? []
        const body = links.map((link, index) => `${index + 1}. ${link.title || link.text || '(无标题)'}\n   ${link.url}${link.text && link.text !== link.title ? `\n   ${link.text}` : ''}`).join('\n')
        const lines = [
          `动作：${label} —— ${status}`,
          `标题：${result.title || '（无）'}`,
          `地址：${result.url || '（无）'}`,
          `共提取 ${links.length} 条链接：`,
          body || '（页面没有可提取的链接）',
        ].filter(Boolean)
        return { output: clip(lines.join('\n')) }
      }
      const lines = [
        `动作：${label} —— ${status}`,
        result.detail ? `说明：${result.detail}` : '',
        `标题：${result.title || '（无）'}`,
        `地址：${result.url || '（无）'}`,
        `页面内容：\n${result.snippet}`,
      ].filter(Boolean)
      // 搜索结果页额外返回结构化结果列表，供模型直接挑选目标，也供右栏「搜索结果」展示。
      if (call.name === 'browser_search') {
        const query = str(a.query).trim()
        const searchHost = safeHost(result.url)
        const hits = (result.links ?? [])
          .map((link) => ({ title: (link.title || link.text || '').slice(0, 200), url: resolveResultUrl(link.url), snippet: (link.snippet || link.text || '').slice(0, 300) }))
          .filter((hit) => hit.url && keepLink(hit.url, searchHost) && hit.title)
        const seen = new Set<string>()
        const unique = hits.filter((hit) => (seen.has(hit.url) ? false : (seen.add(hit.url), true))).slice(0, 12)
        if (unique.length) {
          lines.push('', `结构化结果（${unique.length} 条，可直接 browser_navigate 打开）：`, unique.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`).join('\n'))
          lines.push(`\n[CUBEX_SEARCH]${JSON.stringify({ query, results: unique })}`)
        }
      }
      return { output: clip(lines.join('\n')), ...(result.screenshot ? { image: result.screenshot } : {}) }
    } finally {
      this.deps.onControl?.({ active: false })
    }
  }

  private async runBrowserCrawl(call: ToolCall, context: ExtensionContext): Promise<{ output: string }> {
    const a = call.args
    const settings = this.deps.getSettings()
    const query = str(a.query).trim()
    const urls = Array.isArray(a.urls) ? a.urls.filter((item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item.trim())).map((item) => item.trim()) : []
    if (!query && urls.length === 0) throw new Error('browser_crawl 需要 query 或 urls 至少其一')
    const maxPages = Math.max(3, Math.min(20, Number(a.maxPages) || settings.browser.crawlPages || 8))
    const depth = Number(a.depth) >= 1 ? 1 : 0
    const mode = settings.browser.crawlMode === 'visible' ? 'visible' : 'background'
    const threadId = context.threadId ?? ''
    this.deps.onControl?.({ active: true, kind: 'browser', label: mode === 'visible' ? `浏览器：前台逐页爬取 ${query || `${urls.length} 个网址`}` : `浏览器：后台并行爬取 ${query || `${urls.length} 个网址`}`, threadId })
    try {
      const outcome = await crawlWeb({
        query,
        urls,
        maxPages,
        depth,
        mode,
        threadId,
        signal: context.signal,
        searchEngine: settings.browser.searchEngine,
        searchTemplate: settings.browser.searchTemplate,
        onProgress: (progress) => {
          const detail = progress.total > 0 ? `${progress.done}/${progress.total}` : `${progress.done}`
          this.deps.onControl?.({ active: true, kind: 'browser', label: mode === 'visible' ? `浏览器：前台爬取 ${detail}` : `浏览器：后台爬取 ${detail} · ${progress.url.slice(0, 60)}`, threadId })
        },
      })
      if (outcome.pages.length === 0) {
        const failText = outcome.failed.length ? `\n失败：\n${outcome.failed.map((item) => `- ${item.url}（${item.error}）`).join('\n')}` : ''
        return { output: clip(`未能抓取到任何页面${query ? `（关键词「${query}」）` : ''}。可尝试更换关键词、直接给 urls，或用 browser_search 逐步查看。${failText}`) }
      }
      // 按与查询词的相关性排序后输出，越相关的页面排越前。
      const terms = queryTerms(query)
      const ranked = outcome.pages
        .map((page, index) => ({ page, index, score: relevanceScore(page, terms) }))
        .sort((x, y) => y.score - x.score || x.index - y.index)
      const sections = ranked.map((entry, position) => {
        const excerpt = entry.page.text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000)
        return `【${position + 1}】${entry.page.title || '(无标题)'}\n地址：${entry.page.url}\n相关度：${entry.score}\n正文：\n${excerpt || '（页面没有可见文本）'}`
      })
      const sources = ranked.map((entry, position) => `${position + 1}. ${entry.page.title || entry.page.url} — ${entry.page.url}`)
      const failText = outcome.failed.length ? `\n\n抓取失败 ${outcome.failed.length} 页：\n${outcome.failed.map((item) => `- ${item.url}（${item.error}）`).join('\n')}` : ''
      const header = [
        `全网爬取完成：成功抓取 ${outcome.pages.length} 页${outcome.truncated ? `（已达页数/时间上限，共尝试 ${outcome.tried} 个候选）` : ''}${depth >= 1 ? '，含相关链接扩展（depth=1）' : ''}。`,
        query ? `关键词：${query}` : '',
      ].filter(Boolean).join('\n')
      const marker = `[CUBEX_SEARCH]${JSON.stringify({ query, results: ranked.map((entry) => ({ title: entry.page.title.slice(0, 200), url: entry.page.url.slice(0, 2048), snippet: entry.page.text.replace(/\s+/g, ' ').slice(0, 300) })) })}`
      return {
        output: clip([
          header,
          marker,
          sections.join('\n\n———\n\n'),
          '',
          `来源列表：\n${sources.join('\n')}`,
          failText,
        ].filter((part) => part !== '').join('\n')),
      }
    } finally {
      this.deps.onControl?.({ active: false })
    }
  }

  private async runGenerateImage(call: ToolCall, context: ExtensionContext): Promise<{ output: string; image?: string }> {
    const settings = this.deps.getSettings()
    if (!settings.plugins.image) throw new Error('图片生成插件已关闭，请在设置 → 插件中开启')
    const prompt = str(call.args.prompt).trim()
    if (!prompt) throw new Error('请提供要生成图片的提示词')
    const providerId = settings.image.providerId
    const provider = settings.providers.find((item) => item.id === providerId)
    if (!provider) throw new Error('尚未配置图片生成模型，请在设置 → 图片生成中选择提供商与模型')
    const apiKey = provider.hasKey ? this.deps.getProviderKey(provider.id) : undefined
    if (provider.hasKey && !apiKey) throw new Error('提供商的 API Key 读取失败，请在设置 → 模型服务中重新保存')
    const size = str(call.args.size).trim() || settings.image.size
    this.deps.onControl?.({ active: true, kind: 'computer', label: `正在生成图片：${prompt.slice(0, 60)}`, threadId: context.threadId ?? '' })
    try {
      const { generateImage } = await import('./images')
      const started = Date.now()
      const result = await generateImage({ provider, apiKey, modelId: settings.image.modelId, prompt, size, root: context.root, signal: context.signal })
      const lines = [
        `已生成图片（${Math.round((Date.now() - started) / 1000)} 秒）。`,
        `保存位置：${result.file}`,
        result.revisedPrompt ? `模型修订后的提示词：${result.revisedPrompt}` : '',
      ].filter(Boolean)
      return { output: clip(lines.join('\n')), image: result.dataUrl }
    } finally {
      this.deps.onControl?.({ active: false })
    }
  }

  private async runBrowserTab(call: ToolCall, context: ExtensionContext): Promise<{ output: string }> {
    const a = call.args
    const action = str(a.action).trim()
    const threadId = context.threadId ?? ''
    const tabId = str(a.tabId).trim()
    const url = str(a.url).trim()
    const labels: Record<string, string> = { list: '查看标签页', new: '新建标签页', activate: '切换标签页', close: '关闭标签页' }
    if (!(action in labels)) throw new Error('action 需为 list / new / activate / close')
    this.deps.onControl?.({ active: true, kind: 'browser', label: `浏览器：${labels[action]}`, threadId })
    try {
      const before = browserEngine.state(threadId)
      if ((action === 'activate' || action === 'close') && !before.tabs.some((tab) => tab.id === tabId)) {
        throw new Error(`未找到标签 ${tabId || '（未提供 tabId）'}，请先用 action=list 查看可用标签`)
      }
      if (action === 'new') browserEngine.tab({ threadId, action: 'new', ...(url ? { url } : {}) })
      else if (action === 'activate') browserEngine.tab({ threadId, action: 'activate', tabId })
      else if (action === 'close') browserEngine.tab({ threadId, action: 'close', tabId })
      const state = browserEngine.state(threadId)
      const lines = state.tabs.map((tab) => `${tab.id === state.activeTabId ? '●' : '○'} ${tab.title || tab.url || '（空白页）'}${tab.loading ? ' [加载中]' : ''}\n   id: ${tab.id}\n   地址: ${tab.url || '（无）'}`)
      return { output: clip(`浏览器标签页（共 ${state.tabs.length} 个，● 为当前活动标签）：\n\n${lines.join('\n') || '（暂无标签，可用 action=new 新建）'}`) }
    } finally {
      this.deps.onControl?.({ active: false })
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

export interface CrawlLink { title: string; url: string; text: string; snippet?: string }
export interface RawPage { title: string; url: string; text: string; links: CrawlLink[] }
export interface CrawlProgress { done: number; total: number; url: string }

const CRAWL_LOAD_TIMEOUT = 20_000
const CRAWL_READ_TIMEOUT = 10_000
const CRAWL_CONCURRENCY = 3
const CRAWL_DEADLINE_MS = 180_000

const CRAWL_PAGE_SCRIPT = `(() => {
  const text = (document.body && (document.body.innerText || '')) || '';
  const links = [];
  const seen = new Set();
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 400)) {
    const href = a.href;
    if (!href || !/^https?:/i.test(href)) continue;
    const t = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140);
    if (!t) continue;
    const key = href + '|' + t;
    if (seen.has(key)) continue;
    seen.add(key);
    let snippet = '';
    const box = a.parentElement && a.parentElement.parentElement;
    if (box && box.innerText) snippet = box.innerText.replace(/\\s+/g, ' ').trim().slice(0, 260);
    links.push({ title: (a.title || t).slice(0, 160), url: href.slice(0, 2048), text: t, snippet });
    if (links.length >= 60) break;
  }
  return { title: document.title || '', url: location.href, text: text.slice(0, 80000), links };
})()`

// 后台离屏抓取单个页面：返回标题、可见文本与结构化链接（供 depth 扩展用）。
async function fetchPageOffscreen(url: string, signal: AbortSignal): Promise<RawPage> {
  if (signal.aborted) throw new Error('已取消')
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
      win.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面加载超时')), CRAWL_LOAD_TIMEOUT)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 400))
    const data = await Promise.race([
      win.webContents.executeJavaScript(CRAWL_PAGE_SCRIPT, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面读取超时')), CRAWL_READ_TIMEOUT)),
    ]) as RawPage
    return { title: String(data?.title ?? ''), url: String(data?.url ?? url), text: String(data?.text ?? ''), links: Array.isArray(data?.links) ? data.links : [] }
  } finally {
    signal.removeEventListener('abort', abort)
    if (!win.isDestroyed()) win.destroy()
  }
}

// 把搜索引擎的跳转链接解析成真实地址（bing /ck/a、duckduckgo /l/?uddg=、百度 /link?url= 除外保留）。
function resolveResultUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    if (host.endsWith('bing.com') && parsed.pathname === '/ck/a') {
      const encoded = parsed.searchParams.get('u')
      if (encoded && encoded.startsWith('a1')) {
        const b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/')
        const decoded = Buffer.from(b64, 'base64').toString('utf8')
        if (/^https?:/i.test(decoded)) return decoded
      }
    }
    if (host.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      const uddg = parsed.searchParams.get('uddg')
      if (uddg) return decodeURIComponent(uddg)
    }
    if (host.endsWith('baidu.com') && parsed.pathname === '/link' && parsed.searchParams.has('url')) return raw
    return raw
  } catch {
    return raw
  }
}

function keepLink(resolved: string, searchHost: string): boolean {
  try {
    const parsed = new URL(resolved)
    if (!/^https?:$/.test(parsed.protocol)) return false
    if (IGNORED_CRAWL_EXT.test(parsed.pathname)) return false
    if (!searchHost) return true
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const root = searchHost.toLowerCase().replace(/^www\./, '')
    // 搜索引擎自身页面（导航、账号、图片视频入口）不算结果；百度 /link 跳转保留。
    if (host === root || host.endsWith(`.${root}`)) return parsed.pathname === '/link' && parsed.searchParams.has('url')
    return true
  } catch {
    return false
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

const IGNORED_CRAWL_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|woff2?|ttf|eot|otf|mp3|mp4|webm|avi|mov|mkv|zip|rar|gz|7z|exe|dmg|apk)(\?|$)/i

// 把查询词切成匹配单元：英文按词，中文补充双字片段，避免整句匹配不上。
function queryTerms(query: string): string[] {
  const base = query.toLowerCase().split(/[\s,，、;；:：·"“”'‘’()（）]+/).map((item) => item.trim()).filter(Boolean)
  const terms = new Set<string>()
  for (const token of base) {
    terms.add(token)
    if (/[一-鿿]/.test(token) && token.length >= 3) {
      for (let i = 0; i + 2 <= token.length && i < 8; i++) terms.add(token.slice(i, i + 2))
    }
  }
  return [...terms]
}

function relevanceScore(page: { title: string; url: string; text: string }, terms: string[]): number {
  if (!terms.length) return 1
  const haystack = `${page.title} ${page.url} ${page.text.slice(0, 4000)}`.toLowerCase()
  let score = 0
  for (const term of terms) if (haystack.includes(term)) score++
  return score
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

export interface CrawlOptions {
  query: string
  urls: string[]
  maxPages: number
  depth: number
  mode: 'background' | 'visible'
  threadId: string
  signal: AbortSignal
  searchEngine: Settings['browser']['searchEngine']
  searchTemplate: string
  onProgress: (progress: CrawlProgress) => void
}

export interface CrawlOutcome {
  pages: RawPage[]
  tried: number
  failed: Array<{ url: string; error: string }>
  truncated: boolean
}

// 全网爬取主流程：种子收集 → 去重 → 抓取（后台并行 / 前台逐页）→ depth=1 按相关性扩展 → 聚合。
export async function crawlWeb(options: CrawlOptions): Promise<CrawlOutcome> {
  const { query, urls, maxPages, depth, mode, threadId, signal, searchEngine, searchTemplate, onProgress } = options
  const deadline = Date.now() + CRAWL_DEADLINE_MS
  const terms = queryTerms(query)
  const seeds: Array<{ url: string }> = urls.filter((item) => /^https?:\/\//i.test(item)).map((item) => ({ url: item }))

  if (query) {
    onProgress({ done: 0, total: 0, url: `正在搜索种子：${query}` })
    try {
      const hits = await webSearch(query, Math.min(20, Math.max(maxPages * 2, 10)), signal)
      seeds.push(...hits.map((hit) => ({ url: hit.url })))
    } catch {
      // 主用引擎失败时退化为配置的搜索引擎结果页
    }
    if (seeds.length === 0) {
      try {
        const searchUrl = buildSearchUrl(query, searchEngine, searchTemplate)
        const searchHost = new URL(searchUrl).hostname
        const page = await fetchPageOffscreen(searchUrl, signal)
        seeds.push(...page.links.map((link) => ({ url: resolveResultUrl(link.url) })).filter((item) => keepLink(item.url, searchHost)))
      } catch {
        // 搜索失败时由上层按“无种子”返回
      }
    }
  }

  const queue: string[] = []
  const visited = new Set<string>()
  const normalize = (url: string) => url.split('#')[0]
  for (const seed of seeds) {
    const key = normalize(resolveResultUrl(seed.url))
    if (visited.has(key) || queue.length >= maxPages) continue
    if (!/^https?:\/\//i.test(key)) continue
    visited.add(key)
    queue.push(key)
  }

  const failed: CrawlOutcome['failed'] = []
  const pages: RawPage[] = []
  let truncated = false

  const crawlBatch = async (batch: string[], offset: number): Promise<void> => {
    if (mode === 'visible') {
      // 前台模式：在用户可见的标签里逐页打开，实时看到爬取过程。
      for (let i = 0; i < batch.length; i++) {
        if (signal.aborted) throw new Error('已取消')
        if (Date.now() > deadline) { truncated = true; break }
        const url = batch[i]
        onProgress({ done: offset + i + 1, total: queue.length, url })
        try {
          await browserEngine.run(threadId, { kind: 'navigate', url }, signal)
          const read = await browserEngine.run(threadId, { kind: 'links' }, signal)
          pages.push({ title: read.title, url: read.url || url, text: read.snippet, links: read.links ?? [] })
        } catch (error) {
          failed.push({ url, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return
    }
    await runPool(batch, CRAWL_CONCURRENCY, async (url, index) => {
      if (signal.aborted || Date.now() > deadline) return
      onProgress({ done: offset + index + 1, total: queue.length, url })
      try {
        pages.push(await fetchPageOffscreen(url, signal))
      } catch (error) {
        if (signal.aborted) return
        failed.push({ url, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  if (queue.length === 0) return { pages, tried: 0, failed, truncated }
  await crawlBatch(queue, 0)

  // depth=1：从已抓页面的相关链接里补充候选，直到抓满 maxPages 或到达期限。
  if (depth >= 1 && pages.length < maxPages && !signal.aborted && Date.now() < deadline) {
    const candidates: Array<{ url: string; score: number }> = []
    for (const page of pages) {
      for (const link of page.links) {
        const resolved = resolveResultUrl(link.url)
        const key = normalize(resolved)
        if (visited.has(key)) continue
        if (!keepLink(resolved, '')) continue
        const score = relevanceScore({ title: link.title, url: resolved, text: `${link.text} ${link.snippet ?? ''}` }, terms)
        if (score <= 0) continue
        visited.add(key)
        candidates.push({ url: resolved, score })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const extra = candidates.slice(0, maxPages - pages.length - failed.length).map((item) => item.url)
    if (extra.length) {
      queue.push(...extra)
      await crawlBatch(extra, pages.length + failed.length)
    }
  }

  if (Date.now() >= deadline) truncated = true
  return { pages, tried: queue.length, failed, truncated }
}

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

const MOUSE_DLL = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);' -Name U -Namespace Cubex; `

const mouseScript = (points: Array<{ x: number; y: number; hold?: number; buttons?: Array<'down' | 'up'>; wheel?: number }>): string => {
  const steps = points.map((point) => {
    const lines = [`[Cubex.U]::SetCursorPos(${point.x}, ${point.y}) | Out-Null`]
    if (point.hold) lines.push(`Start-Sleep -Milliseconds ${point.hold}`)
    for (const button of point.buttons ?? []) {
      if (button === 'down') lines.push('[Cubex.U]::mouse_event(2,0,0,0,0)')
      else lines.push('[Cubex.U]::mouse_event(4,0,0,0,0)')
    }
    if (point.wheel) lines.push(`[Cubex.U]::mouse_event(0x0800,0,0,${point.wheel},0)`)
    return lines.join('; ')
  })
  return MOUSE_DLL + steps.join('; ')
}

const mouseClickScript = (x: number, y: number, options: { clicks: number; right?: boolean }): string => {
  const down = options.right ? 8 : 2
  const up = options.right ? 16 : 4
  const steps = [`[Cubex.U]::SetCursorPos(${x}, ${y}) | Out-Null`]
  for (let index = 0; index < options.clicks; index++) {
    steps.push(`[Cubex.U]::mouse_event(${down},0,0,0,0)`, `[Cubex.U]::mouse_event(${up},0,0,0,0)`)
    if (options.clicks > 1) steps.push('Start-Sleep -Milliseconds 80')
  }
  return MOUSE_DLL + steps.join('; ')
}

const coordinate = (value: unknown, label: string): number => {
  const num = Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0 || num > 20_000) throw new Error(`${label} 需要合法的整数坐标（0–20000）`)
  return num
}

export async function computerAction(args: Record<string, unknown>, root: string, settings: Settings): Promise<{ output: string; image?: string }> {
  const action = str(args.action)
  const control = settings.computer
  const isolated = control.mode === 'isolated'
  switch (action) {
    case 'screenshot': {
      if (isolated) {
        const shot = await captureIsolatedDesktop()
        const png = await readFile(shot.png)
        await rm(shot.png, { force: true }).catch(() => undefined)
        const dir = join(root, '.cubex', 'screenshots')
        await mkdir(dir, { recursive: true })
        const file = join(dir, `desktop-${Date.now()}.png`)
        await writeFile(file, png)
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`
        return { output: `已截取独立桌面「${ISOLATED_DESKTOP_NAME}」（${shot.width}×${shot.height}，${shot.windows.length} 个窗口），保存到 ${file}。坐标以这张截图为准。`, image: dataUrl }
      }
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
      const raw = str(args.target).trim()
      if (!raw) throw new Error('open 需要 target')
      if (isolated) {
        const command = /^https?:\/\//i.test(raw) ? 'msedge' : raw
        const argument = /^https?:\/\//i.test(raw) ? raw : ''
        const pid = await launchOnIsolatedDesktop(command, argument)
        return { output: `已在独立桌面「${ISOLATED_DESKTOP_NAME}」启动 ${raw}（进程 ${pid}）。该桌面与你的当前桌面互不干扰，可在设置里关闭实时镜像。` }
      }
      if (/^https?:\/\//i.test(raw)) { await shell.openExternal(raw); return { output: `已在默认浏览器打开 ${raw}` } }
      // 相对路径按项目根目录解析，避免在应用自身的工作目录下找不到文件。
      const target = isAbsolute(raw) ? raw : resolve(root, raw)
      const error = await shell.openPath(target)
      if (!error) return { output: `已打开 ${target}` }
      // shell.openPath 打不开未注册文件关联的应用名（如 notepad），退回到系统 start。
      if (!/[/\\]/.test(raw) && await startShellApplication(raw)) return { output: `已启动应用「${raw}」` }
      if (!existsSync(target)) throw new Error(`无法打开「${raw}」：路径不存在（已按项目目录解析为 ${target}）。请确认路径是否正确，或改用绝对路径。`)
      throw new Error(`无法打开「${raw}」：${error}（已解析为 ${target}）`)
    }
    case 'type': {
      const text = str(args.text)
      if (!text) throw new Error('type 需要 text')
      const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}')
      if (isolated) {
        const title = str(args.window).trim()
        if (!title) throw new Error('独立桌面模式下 type 需要 window（目标窗口标题）')
        await typeIsolatedDesktop(title, text)
        return { output: `已在独立桌面窗口「${title}」输入 ${text.length} 个字符` }
      }
      const waited = await waitForUserIdle(control.idleWaitSec)
      if (waited >= control.idleWaitSec && control.idleWaitSec > 0) return { output: `检测到你正在使用键鼠，已等待 ${Math.round(waited)} 秒仍未空闲，本次输入未执行，请稍后重试或调小「等待空闲」时间` }
      await powershell(`$w = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 300; $w.SendKeys(${psQuote(escaped)})`)
      return { output: `已输入 ${text.length} 个字符${waited > 0 ? `（已等你空闲 ${Math.round(waited)} 秒）` : ''}` }
    }
    case 'key': {
      const keys = str(args.keys)
      if (!keys) throw new Error('key 需要 keys')
      if (isolated) {
        const title = str(args.window).trim()
        if (!title) throw new Error('独立桌面模式下 key 需要 window（目标窗口标题）')
        await keyIsolatedDesktop(title, keys)
        return { output: `已向独立桌面窗口「${title}」发送按键 ${keys}` }
      }
      const waited = await waitForUserIdle(control.idleWaitSec)
      if (waited >= control.idleWaitSec && control.idleWaitSec > 0) return { output: `检测到你正在使用键鼠，已等待 ${Math.round(waited)} 秒仍未空闲，本次按键未执行` }
      await powershell(`$w = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 300; $w.SendKeys(${psQuote(keys)})`)
      return { output: `已发送按键 ${keys}${waited > 0 ? `（已等你空闲 ${Math.round(waited)} 秒）` : ''}` }
    }
    case 'click':
    case 'double_click':
    case 'right_click': {
      const x = coordinate(args.x, 'click')
      const y = coordinate(args.y, 'click')
      const clicks = action === 'double_click' ? 2 : 1
      const right = action === 'right_click'
      if (isolated) {
        const title = str(args.window).trim()
        if (!title) throw new Error('独立桌面模式下 click 需要 window（目标窗口标题）')
        await clickIsolatedDesktop(title, x, y, { right, double: clicks > 1 })
        return { output: `已在独立桌面窗口「${title}」的 (${x}, ${y}) ${right ? '右键' : action === 'double_click' ? '双击' : '单击'}` }
      }
      const waited = await waitForUserIdle(control.idleWaitSec)
      if (waited >= control.idleWaitSec && control.idleWaitSec > 0) return { output: `检测到你正在使用鼠标，已等待 ${Math.round(waited)} 秒仍未空闲，本次点击未执行，请稍后重试或调小「等待空闲」时间` }
      await powershell(mouseClickScript(x, y, { clicks, right }))
      return { output: `已在 (${x}, ${y}) ${right ? '右键单击' : action === 'double_click' ? '双击' : '单击'}${waited > 0 ? `（已等你空闲 ${Math.round(waited)} 秒）` : ''}` }
    }
    case 'move': {
      const x = coordinate(args.x, 'move')
      const y = coordinate(args.y, 'move')
      if (isolated) return { output: `独立桌面模式下不移动你的鼠标指针；如需在独立桌面内定位，请使用 click 的 window + 坐标` }
      const waited = await waitForUserIdle(control.idleWaitSec)
      await powershell(mouseScript([{ x, y }]))
      return { output: `鼠标已移动到 (${x}, ${y})${waited > 0 ? `（已等你空闲 ${Math.round(waited)} 秒）` : ''}` }
    }
    case 'drag': {
      const fromX = coordinate(args.fromX ?? args.x1, 'drag 的 fromX')
      const fromY = coordinate(args.fromY ?? args.y1, 'drag 的 fromY')
      const toX = coordinate(args.toX ?? args.x2, 'drag 的 toX')
      const toY = coordinate(args.toY ?? args.y2, 'drag 的 toY')
      const hold = Math.max(0, Math.min(10_000, Number(args.hold ?? 200)))
      if (isolated) {
        const title = str(args.window).trim()
        if (!title) throw new Error('独立桌面模式下 drag 需要 window（目标窗口标题）')
        // 独立桌面没有真实指针：用「按下—移动—抬起」的语义由三次点击近似，并等待目标窗口响应。
        await clickIsolatedDesktop(title, fromX, fromY, { holdMs: hold })
        await clickIsolatedDesktop(title, Math.round((fromX + toX) / 2), Math.round((fromY + toY) / 2), { holdMs: hold })
        await clickIsolatedDesktop(title, toX, toY)
        return { output: `已在独立桌面窗口「${title}」从 (${fromX}, ${fromY}) 拖到 (${toX}, ${toY})（独立桌面以分步点击近似拖拽轨迹）` }
      }
      const waited = await waitForUserIdle(control.idleWaitSec)
      if (waited >= control.idleWaitSec && control.idleWaitSec > 0) return { output: `检测到你正在使用鼠标，已等待 ${Math.round(waited)} 秒仍未空闲，本次拖拽未执行` }
      const steps = 12
      const path: Array<{ x: number; y: number; hold?: number; buttons?: Array<'down' | 'up'> }> = [{ x: fromX, y: fromY, buttons: ['down'] }]
      for (let index = 1; index <= steps; index++) {
        path.push({ x: Math.round(fromX + ((toX - fromX) * index) / steps), y: Math.round(fromY + ((toY - fromY) * index) / steps) })
      }
      path.push({ x: toX, y: toY, hold, buttons: ['up'] })
      await powershell(mouseScript(path))
      return { output: `已从 (${fromX}, ${fromY}) 拖拽到 (${toX}, ${toY})${waited > 0 ? `（已等你空闲 ${Math.round(waited)} 秒）` : ''}` }
    }
    case 'scroll': {
      const amount = Math.max(-2400, Math.min(2400, Number(args.amount ?? 600)))
      if (isolated) return { output: '独立桌面模式下请用 key 的 window 参数发送 PgDn/PgUp 或方向键滚动' }
      const waited = await waitForUserIdle(control.idleWaitSec)
      await powershell(mouseScript([{ x: Number(args.x ?? 0), y: Number(args.y ?? 0), wheel: amount }]))
      return { output: `已滚动 ${amount > 0 ? '向下' : '向上'} ${Math.abs(amount)} 单位${waited > 0 ? `（已等你空闲 ${Math.round(waited)} 秒）` : ''}` }
    }
    default:
      throw new Error(`未知操作：${action}（可选 screenshot / open / type / key / click / double_click / right_click / move / drag / scroll）`)
  }
}
