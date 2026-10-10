import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron'
import { join, basename, relative, isAbsolute, sep } from 'node:path'
import { realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { answerInputSchema, approvalInputSchema, automationInputSchema, browserBoundsInputSchema, browserNavigateInputSchema, browserTabInputSchema, channels, createThreadInputSchema, dequeueInputSchema, deleteMessageInputSchema, exportTextInputSchema, generateWorkflowInputSchema, githubPushInputSchema, githubTokenInputSchema, mcpTestInputSchema, openExternalInputSchema, panelWindowInputSchema, projectInputSchema, projectPathInputSchema, listProviderModelsInputSchema, probeContextWindowInputSchema, providerKeyInputSchema, regenerateMessageInputSchema, rollbackMessageInputSchema, runShellInputSchema, saveWorkflowInputSchema, sendMessageInputSchema, settingsSchema, steerInputSchema, testConnectionInputSchema, threadInputSchema, threadInputSchema as browserThreadInputSchema, updateProjectInputSchema, updateThreadInputSchema, windowActionSchema, workflowControlInputSchema, workflowInputSchema, type AgentActivity, type AppState, type Automation, type BrowserState, type ControlState, type McpServer, type Result, type StreamDelta, type Thread } from '../shared/schema'
import { browserEngine } from './browser'
import { aociBinaryDirs, planAociServers, resolveAociBinary, type AociPlan } from './aoci'
import { captureIsolatedDesktop, closeIsolatedDesktop, ISOLATED_DESKTOP_NAME } from './computer'
import { listModels, probeContextWindow, testConnection } from './llm'
import { ensureProjectFiles } from './projectFiles'
import { browseDirectory, readProjectFile, saveProjectFile, runShellCommand } from './tools'
import { saveProjectFileInputSchema, copyTextInputSchema } from '../shared/schema'
import { StateStore } from './store'
import { SecretStore } from './secrets'
import { AgentRunner } from './agent'
import { ExtensionHost } from './extensions'
import { McpManager } from './mcp'
import { SkillStore } from './skills'
import { WorkflowRunner } from './workflowRunner'
import { generateWorkflowWithModel } from './workflowGenerate'
import { dueAutomations } from './workflow'

const GITHUB_SECRET = 'github'
const isDev = !!process.env.ELECTRON_RENDERER_URL
if (process.env.CUBEX_SMOKE === '1') app.setPath('userData', join(app.getPath('temp'), `cubex-smoke-${process.pid}`))
const store = new StateStore(join(app.getPath('userData'), 'state.json'))
const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'))
const mcp = new McpManager()
const skills = new SkillStore(join(app.getPath('userData'), 'skills'))
let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let floatingWindow: BrowserWindow | null = null
let controlThreadId: string | null = null
let floatingSuppressedThreadId: string | null = null

let appIcon: Electron.NativeImage | null = null

function aociProjectPath(threadId?: string): string | undefined {
  const state = store.get()
  const thread = threadId
    ? state.threads.find((item) => item.id === threadId)
    : [...state.threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  const project = thread ? state.projects.find((item) => item.id === thread.projectId) : state.projects[0]
  return project?.path
}

/**
 * 维护 beta.tokenSaving 对应的 aoci MCP 服务器条目，返回应同步的服务器列表。
 * 开关关闭、二进制缺失或尚无项目时该条目会被移除。
 */
async function syncAoci(threadId?: string): Promise<McpServer[]> {
  const settings = store.get().settings
  const plan: AociPlan = planAociServers(settings.mcp.servers, {
    enabled: settings.beta.tokenSaving,
    binary: resolveAociBinary(aociBinaryDirs(process.resourcesPath, app.getAppPath())),
    projectPath: aociProjectPath(threadId),
  })
  if (!plan.changed) return plan.servers
  await store.update((state) => {
    state.settings.mcp.servers = plan.servers
  })
  return plan.servers
}

async function buildAppIcon(): Promise<Electron.NativeImage | undefined> {
  if (appIcon && !appIcon.isEmpty()) return appIcon
  for (const iconPath of [
    join(process.resourcesPath ?? '', 'icon.ico'),
    join(process.resourcesPath ?? '', 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.png'),
    join(app.getAppPath(), '..', 'build', 'icon.ico'),
    join(app.getAppPath(), '..', 'build', 'icon.png'),
  ]) {
    const file = nativeImage.createFromPath(iconPath)
    if (!file.isEmpty()) { appIcon = file; return file }
  }
  return undefined
}
const liveWindows = () => [mainWindow, panelWindow, floatingWindow].filter((win): win is BrowserWindow => !!win && !win.isDestroyed())
const extensions = new ExtensionHost({
  pluginsDir: join(app.getPath('userData'), 'plugins'),
  getSettings: () => store.get().settings,
  getGithubToken: () => secrets.get(GITHUB_SECRET),
  getProviderKey: (providerId: string) => secrets.get(providerId),
  mcp,
  onControl: (control) => {
    const payload: ControlState = control.active ? control : { active: false }
    controlActive = control.active
    for (const win of liveWindows()) win.webContents.send(channels.control, payload)
    // 任务第一次操控浏览器/电脑时弹出右下角悬浮窗；同一任务后续工具调用不再闪退。
    if (control.active) {
      const settings = store.get().settings
      const isInteractiveControl = control.kind === 'browser' || (control.kind === 'computer' && !control.label.startsWith('正在生成图片：'))
      if (settings.floating.autoShow && floatingSuppressedThreadId !== control.threadId && isInteractiveControl) {
        openFloatingWindow({ threadId: control.threadId })
      }
      if (isInteractiveControl) {
        controlThreadId = control.threadId
        if (settings.computer.mode === 'isolated' && settings.computer.mirror && !mirrorTimer) startDesktopMirror(ISOLATED_DESKTOP_NAME)
      }
    }
  },
})
const agent = new AgentRunner(store, secrets, (delta: StreamDelta) => {
  for (const win of liveWindows()) win.webContents.send(channels.delta, delta)
}, undefined, extensions, (activity: AgentActivity) => {
  for (const win of liveWindows()) win.webContents.send(channels.activity, activity)
})
browserEngine.setStateListener((state: BrowserState) => {
  for (const win of liveWindows()) win.webContents.send(channels.browserState, state)
})

const workflowRunner = new WorkflowRunner(store, agent)

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const fail = (error: unknown): Result<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

function trusted(event: IpcMainInvokeEvent): boolean {
  return liveWindows().some((win) => event.sender === win.webContents) && !event.senderFrame?.parent
}

function handle<T>(channel: string, fn: (event: IpcMainInvokeEvent, payload: unknown) => Promise<T>) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (!trusted(event)) return fail('拒绝来自未授权来源的请求')
    try {
      return ok(await fn(event, payload))
    } catch (error) {
      return fail(error)
    }
  })
}

function withKeys(state: AppState): AppState {
  return { ...state, settings: { ...state.settings, providers: state.settings.providers.map((provider) => ({ ...provider, hasKey: secrets.has(provider.id) })), github: { ...state.settings.github, hasToken: secrets.has(GITHUB_SECRET) } } }
}

async function runAutomation(automation: Automation): Promise<Thread> {
  const state = store.get()
  const workflow = automation.workflowId ? state.workflows?.find((item) => item.id === automation.workflowId) : undefined
  if (automation.workflowId && !workflow) throw new Error('定时任务绑定的工作流不存在，请重新选择')
  const projectId = workflow ? workflow.projectId : automation.projectId
  const thread = await agent.createThread(projectId, automation.modelId)
  await store.update((state) => {
    const target = state.threads.find((item) => item.id === thread.id)
    if (target) target.title = `⏱ ${automation.name}`.slice(0, 60)
    const item = state.settings.automations.find((entry) => entry.id === automation.id)
    if (item) item.lastRun = new Date().toISOString()
  })
  if (workflow) {
    await workflowRunner.start(thread.id, workflow)
  } else {
    await agent.send(thread.id, automation.prompt, automation.modelId)
  }
  return thread
}

function startAutomationScheduler() {
  const tick = async () => {
    const state = store.get()
    for (const automation of dueAutomations(state.settings.automations, Date.now())) {
      if (!state.projects.some((project) => project.id === automation.projectId)) continue
      await runAutomation(automation).catch(async (error: unknown) => {
        await store.update((draft) => {
          const item = draft.settings.automations.find((entry) => entry.id === automation.id)
          if (item) item.lastRun = new Date().toISOString()
        })
        console.error('[cubex] 自动化运行失败', automation.name, error instanceof Error ? error.message : error)
      })
    }
  }
  setInterval(() => { void tick() }, 60_000)
}

function threadToMarkdown(thread: Thread): string {
  const lines = [`# ${thread.title}`, '', `> 导出自 CubexDesktop · ${new Date().toLocaleString('zh-CN')}`, '']
  for (const message of thread.messages) {
    if (message.role === 'user') lines.push('## 用户', '', message.content, '')
    else if (message.role === 'assistant') {
      if (message.content) lines.push('## Cubex', '', message.content, '')
      for (const call of message.toolCalls) lines.push(`- 调用 \`${call.name}\` ${JSON.stringify(call.args).slice(0, 300)}`)
      if (message.toolCalls.length) lines.push('')
    } else if (message.role === 'tool') {
      for (const result of message.results) lines.push(`<details><summary>${result.name} · ${result.ok ? '完成' : '失败'}</summary>`, '', '```', result.output.slice(0, 4000), '```', '</details>', '')
    } else lines.push(`> ${message.content}`, '')
  }
  return lines.join('\n')
}

let publishPending = false

// 同一轮事件循环内的多次状态变更只推送一次，减少大状态反复跨进程序列化
function publish() {
  if (publishPending) return
  publishPending = true
  setImmediate(() => {
    publishPending = false
    // 透明度/主题改动要立刻作用到悬浮窗，否则设置里拖了滑条窗口没反应。
    applyFloatingOpacity()
    if (controlThreadId) {
      const thread = store.get().threads.find((item) => item.id === controlThreadId)
      if (!thread || (thread.status === 'idle' && !thread.pending && !thread.question && !(thread.queue?.length))) {
        controlThreadId = null
        floatingSuppressedThreadId = null
        if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close()
        stopDesktopMirror()
        void closeIsolatedDesktop(ISOLATED_DESKTOP_NAME)
      }
    }
    const payload = withKeys(store.get())
    for (const win of liveWindows()) win.webContents.send(channels.state, payload)
  })
}

const webPreferences = () => ({
  preload: join(__dirname, '../preload/index.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: true,
})

function guardNavigation(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isDev || !url.startsWith(process.env.ELECTRON_RENDERER_URL!)) event.preventDefault()
  })
}

function loadRenderer(win: BrowserWindow, hash?: string) {
  if (isDev) return win.loadURL(`${process.env.ELECTRON_RENDERER_URL!}${hash ? `#${hash}` : ''}`)
  return win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

function toggleMaximize(win: BrowserWindow) {
  // 透明无边框窗口此前用 setBounds(workArea) 模拟最大化，在高 DPI / 任务栏场景下只贴了边、
  // 却没真正铺满（看起来“边角变方但没全屏”）。改用原生 maximize/unmaximize，由系统保证铺满与还原。
  if (win.isFullScreen()) {
    win.setFullScreen(false)
    return
  }
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  broadcastWindowState()
}

function isEdgeToEdge(win: BrowserWindow) {
  return win.isMaximized() || win.isFullScreen()
}

const lastWindowState = new WeakMap<BrowserWindow, string>()

function broadcastWindowState() {
  const wins = liveWindows()
  const panelDetached = !!panelWindow && !panelWindow.isDestroyed()
  for (const win of wins) {
    const next = { maximized: isEdgeToEdge(win), focused: win.isFocused(), panelDetached }
    const key = `${next.maximized}|${next.focused}|${next.panelDetached}`
    if (lastWindowState.get(win) === key) continue
    lastWindowState.set(win, key)
    win.webContents.send(channels.windowState, next)
  }
}

function bindWindowStateEvents(win: BrowserWindow) {
  win.on('maximize', broadcastWindowState)
  win.on('unmaximize', broadcastWindowState)
  win.on('minimize', broadcastWindowState)
  win.on('restore', broadcastWindowState)
  win.on('resize', broadcastWindowState)
  win.on('resized', broadcastWindowState)
  win.on('move', broadcastWindowState)
  win.on('moved', broadcastWindowState)
  win.on('enter-full-screen', broadcastWindowState)
  win.on('leave-full-screen', broadcastWindowState)
  win.on('focus', broadcastWindowState)
  win.on('blur', broadcastWindowState)
  win.on('show', broadcastWindowState)
}

function openPanelWindow(threadId: string) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    void panelWindow.loadURL(panelWindow.webContents.getURL().split('#')[0] + `#panel=${encodeURIComponent(threadId)}`)
    panelWindow.focus()
    return
  }
  const bounds = mainWindow?.getBounds()
  panelWindow = new BrowserWindow({
    width: 420,
    height: 720,
    minWidth: 333,
    minHeight: 420,
    x: bounds ? bounds.x + bounds.width - 440 : undefined,
    y: bounds ? bounds.y + 40 : undefined,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    title: 'Cubex 任务面板',
    ...(appIcon && !appIcon.isEmpty() ? { icon: appIcon } : {}),
    webPreferences: webPreferences(),
  })
  panelWindow.setAlwaysOnTop(true, 'floating')
  panelWindow.once('ready-to-show', () => panelWindow?.show())
  guardNavigation(panelWindow)
  bindWindowStateEvents(panelWindow)
  panelWindow.webContents.on('did-finish-load', broadcastWindowState)
  panelWindow.on('closed', () => {
    panelWindow = null
    broadcastWindowState()
  })
  void loadRenderer(panelWindow, `panel=${encodeURIComponent(threadId)}`)
  broadcastWindowState()
}

const FLOATING_WIDTH = 380
const FLOATING_HEIGHT = 520

function floatingSlot(): { x: number; y: number } | undefined {
  const source = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : undefined
  const base = source ?? { x: 0, y: 0, width: 1920, height: 1080 }
  const margin = 24
  return { x: Math.round(base.x + base.width - FLOATING_WIDTH - margin), y: Math.round(base.y + base.height - FLOATING_HEIGHT - margin - 48) }
}

function floatingDark(): boolean {
  const theme = store.get().settings.appearance.theme
  if (theme === 'system') return nativeTheme.shouldUseDarkColors
  return theme === 'dark'
}

// 与 styles.css 中 --bg-panel 的深浅两色保持一致，避免窗口背景与面板出现色差。
function floatingBackgroundColor(): string {
  return floatingDark() ? '#23252a' : '#ffffff'
}

function applyFloatingOpacity(): void {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  const opacity = store.get().settings.floating.opacity
  floatingWindow.setOpacity(opacity)
  floatingWindow.setBackgroundColor(floatingBackgroundColor())
}

// 操控态按整个 agent 任务跟踪，工具调用之间不收起悬浮窗。
let controlActive = false

function openFloatingWindow(options: { force?: boolean; threadId?: string } = {}): void {
  const settings = store.get().settings
  if (!options.force && !settings.floating.autoShow) return
  if (options.force) floatingSuppressedThreadId = null
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.showInactive()
    return
  }
  const slot = floatingSlot()
  floatingWindow = new BrowserWindow({
    width: FLOATING_WIDTH,
    height: FLOATING_HEIGHT,
    minWidth: 320,
    minHeight: 360,
    ...(slot ?? {}),
    show: false,
    frame: false,
    // 不用 transparent：透明无边框窗口在 Windows 上会让圆角外露出灰色残留（DWM 阴影），
    // 改为不透明窗口 + 圆角由 CSS 承担，背景色随主题切换避免闪烁。
    backgroundColor: floatingBackgroundColor(),
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    title: 'Cubex 悬浮助手',
    ...(appIcon && !appIcon.isEmpty() ? { icon: appIcon } : {}),
    webPreferences: webPreferences(),
  })
  floatingWindow.setAlwaysOnTop(true, 'floating')
  applyFloatingOpacity()
  floatingWindow.once('ready-to-show', () => floatingWindow?.showInactive())
  guardNavigation(floatingWindow)
  floatingWindow.on('closed', () => { floatingWindow = null })
  void loadRenderer(floatingWindow, 'floating')
}

function closeFloatingWindow(): void {
  if (controlThreadId) floatingSuppressedThreadId = controlThreadId
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close()
  floatingWindow = null
  stopDesktopMirror()
}

let mirrorTimer: NodeJS.Timeout | null = null
let mirrorBusy = false

function stopDesktopMirror(): void {
  if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null }
  for (const win of liveWindows()) win.webContents.send(channels.desktopMirror, null)
}

function broadcastMirror(frame: { image: string; width: number; height: number }): void {
  for (const win of liveWindows()) win.webContents.send(channels.desktopMirror, frame)
}

export function startDesktopMirror(name: string, intervalMs = 1200): void {
  if (process.platform !== 'win32') return
  if (mirrorTimer) clearInterval(mirrorTimer)
  const tick = async () => {
    if (mirrorBusy) return
    mirrorBusy = true
    try {
      const shot = await captureIsolatedDesktop(name)
      const png = await readFile(shot.png)
      await rm(shot.png, { force: true }).catch(() => undefined)
      broadcastMirror({ image: `data:image/png;base64,${png.toString('base64')}`, width: shot.width, height: shot.height })
    } catch (error) {
      // 镜像失败不影响主流程：桌面可能还没创建或已被关闭。
      console.error('[cubex] 独立桌面镜像失败', error instanceof Error ? error.message : error)
    } finally {
      mirrorBusy = false
    }
  }
  void tick()
  mirrorTimer = setInterval(() => void tick(), intervalMs)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'CubexDesktop',
    ...(appIcon && !appIcon.isEmpty() ? { icon: appIcon } : {}),
    webPreferences: webPreferences(),
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  bindWindowStateEvents(mainWindow)
  mainWindow.webContents.on('did-finish-load', broadcastWindowState)
  guardNavigation(mainWindow)
  browserEngine.setWindow(mainWindow)
  {
    const browser = store.get().settings.browser
    browserEngine.setOptions({ allowDownloads: browser.allowDownloads, allowNewWindows: browser.allowNewWindows, userAgent: browser.userAgent, homepage: browser.homepage })
  }
  mainWindow.on('closed', () => {
    browserEngine.setWindow(null)
    mainWindow = null
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.close()
  })
  void loadRenderer(mainWindow)
}

function hardenSession() {
  const ses = session.defaultSession
  const mediaAllowed = (wc: Electron.WebContents | null, permission: string) => permission === 'media' && liveWindows().some((win) => wc === win.webContents)
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(mediaAllowed(wc, permission)))
  ses.setPermissionCheckHandler((wc, permission) => mediaAllowed(wc, permission))
  ses.webRequest.onHeadersReceived((details, callback) => {
    const modelHosts = 'https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net'
    const csp = isDev
      ? `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws://localhost:* http://localhost:* ${modelHosts}; font-src 'self' data:`
      : `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ${modelHosts}`
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  hardenPreviewSession()
}

const PREVIEW_PARTITION = 'persist:cubex-preview'

function hardenPreviewSession() {
  const preview = session.fromPartition(PREVIEW_PARTITION)
  preview.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
  preview.setPermissionCheckHandler((_wc, permission) => permission === 'media')
}

function registerIpc() {
  handle(channels.getState, async () => withKeys(store.get()))

  handle(channels.selectProject, async () => {
    if (!mainWindow) throw new Error('窗口不可用')
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择项目目录' })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = await realpath(result.filePaths[0])
    const existing = store.get().projects.find((project) => project.path === path)
    if (existing) return existing
    const project = { id: randomUUID(), name: basename(path) || path, path }
    await store.update((state) => {
      state.projects.push(project)
    })
    await ensureProjectFiles(project.path, project.name).catch(() => [])
    return project
  })

  handle(channels.pickFiles, async (_event, payload) => {
    const { projectId } = projectInputSchema.parse(payload)
    const project = store.get().projects.find((item) => item.id === projectId)
    if (!project || !mainWindow) throw new Error('项目不存在')
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], defaultPath: project.path, title: '添加文件到对话' })
    if (result.canceled) return []
    return result.filePaths.map((file) => {
      const rel = relative(project.path, file)
      return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : file
    })
  })

  handle(channels.answerQuestion, async (_event, payload) => {
    const input = answerInputSchema.parse(payload)
    await agent.answerQuestion(input.threadId, input.callId, input.answer)
  })

  handle(channels.dequeueMessage, async (_event, payload) => {
    const input = dequeueInputSchema.parse(payload)
    await agent.dequeue(input.threadId, input.queuedId)
  })

  handle(channels.steerMessage, async (_event, payload) => {
    const input = steerInputSchema.parse(payload)
    await agent.steer(input.threadId, input.content)
  })

  handle(channels.createThread, async (_event, payload) => {
    const input = createThreadInputSchema.parse(payload)
    return agent.createThread(input.projectId, input.modelId, input.mode)
  })

  handle(channels.browserBounds, async (_event, payload) => {
    const input = browserBoundsInputSchema.parse(payload)
    browserEngine.setBounds(input.threadId, { x: input.x, y: input.y, width: input.width, height: input.height })
    return browserEngine.state(input.threadId)
  })

  handle(channels.browserHide, async (_event, payload) => {
    const input = browserThreadInputSchema.parse(payload)
    browserEngine.hide(input.threadId)
    return null
  })

  handle(channels.browserNavigate, async (_event, payload) => {
    const input = browserNavigateInputSchema.parse(payload)
    await browserEngine.manualNavigate(input.threadId, input.url)
    return browserEngine.state(input.threadId)
  })

  handle(channels.browserCapture, async (_event, payload) => {
    const input = browserThreadInputSchema.parse(payload)
    return browserEngine.captureReference(input.threadId)
  })

  handle(channels.browserTab, async (_event, payload) => {
    const input = browserTabInputSchema.parse(payload)
    return browserEngine.tab(input)
  })

  handle(channels.sendMessage, async (_event, payload) => {
    const input = sendMessageInputSchema.parse(payload)
    mcp.sync(await syncAoci(input.threadId))
    await agent.send(input.threadId, input.content, input.modelId, input.card, input.images)
  })

  handle(channels.regenerateMessage, async (_event, payload) => {
    const input = regenerateMessageInputSchema.parse(payload)
    mcp.sync(await syncAoci(input.threadId))
    await agent.regenerateMessage(input.threadId, input.messageId, input.modelId)
  })

  handle(channels.rollbackMessage, async (_event, payload) => {
    const input = rollbackMessageInputSchema.parse(payload)
    await agent.rollbackMessage(input.threadId, input.messageId)
  })

  handle(channels.deleteMessage, async (_event, payload) => {
    const input = deleteMessageInputSchema.parse(payload)
    await agent.deleteMessage(input.threadId, input.messageId)
  })

  handle(channels.cancelThread, async (_event, payload) => {
    const { threadId } = threadInputSchema.parse(payload)
    if (store.get().threads.find((item) => item.id === threadId)?.workflowRun?.status === 'running') {
      await workflowRunner.pause(threadId)
      return
    }
    await agent.cancel(threadId)
  })

  handle(channels.deleteThread, async (_event, payload) => {
    await agent.deleteThread(threadInputSchema.parse(payload).threadId)
  })

  handle(channels.updateThread, async (_event, payload) => {
    const input = updateThreadInputSchema.parse(payload)
    await store.update((state) => {
      const target = state.threads.find((item) => item.id === input.threadId)
      if (!target) throw new Error('任务不存在')
      if (input.title !== undefined) target.title = input.title
      if (input.pinned !== undefined) target.pinned = input.pinned || undefined
    })
  })

  handle(channels.compactThread, async (_event, payload) => {
    return agent.compactThread(threadInputSchema.parse(payload).threadId)
  })

  handle(channels.exportThread, async (_event, payload) => {
    const { threadId } = threadInputSchema.parse(payload)
    const thread = store.get().threads.find((item) => item.id === threadId)
    if (!thread || !mainWindow) throw new Error('任务不存在')
    const safe = thread.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'task'
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出任务', defaultPath: `${safe}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, threadToMarkdown(thread), 'utf8')
    shell.showItemInFolder(result.filePath)
    return result.filePath
  })

  handle(channels.exportText, async (_event, payload) => {
    const input = exportTextInputSchema.parse(payload)
    if (!mainWindow) throw new Error('窗口不存在')
    const safe = input.defaultName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'report'
    const result = await dialog.showSaveDialog(mainWindow, { title: input.title, defaultPath: `${safe}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, input.content, 'utf8')
    shell.showItemInFolder(result.filePath)
    return result.filePath
  })

  handle(channels.deleteProject, async (_event, payload) => {
    await agent.deleteProject(projectInputSchema.parse(payload).projectId)
  })

  handle(channels.updateProject, async (_event, payload) => {
    const input = updateProjectInputSchema.parse(payload)
    await store.update((state) => {
      const target = state.projects.find((item) => item.id === input.projectId)
      if (!target) throw new Error('项目不存在')
      if (input.name !== undefined) target.name = input.name
      if (input.archived !== undefined) target.archived = input.archived || undefined
    })
  })

  handle(channels.revealProject, async (_event, payload) => {
    const { projectId } = projectInputSchema.parse(payload)
    const project = store.get().projects.find((item) => item.id === projectId)
    if (!project) throw new Error('项目不存在')
    const error = await shell.openPath(project.path)
    if (error) throw new Error(`无法打开目录：${error}`)
  })

  handle(channels.windowControl, async (event, payload) => {
    const action = windowActionSchema.parse(payload)
    const target = liveWindows().find((win) => win.webContents === event.sender) ?? mainWindow
    if (!target) return
    if (action === 'minimize') target.minimize()
    else if (action === 'maximize') toggleMaximize(target)
    else if (action === 'fullscreen') {
      // 真全屏（独立于最大化）：让系统与其他应用能检测到全屏状态，
      // 例如 Windows 下触发任务栏/Dock 类装饰应用的自动隐藏。
      target.setFullScreen(!target.isFullScreen())
      broadcastWindowState()
    }
    else target.close()
  })

  const findProject = (projectId: string) => {
    const project = store.get().projects.find((item) => item.id === projectId)
    if (!project) throw new Error('项目不存在')
    return project
  }

  handle(channels.listFiles, async (_event, payload) => {
    const input = projectPathInputSchema.parse(payload)
    return browseDirectory(findProject(input.projectId).path, input.path)
  })

  handle(channels.readProjectFile, async (_event, payload) => {
    const input = projectPathInputSchema.parse(payload)
    return readProjectFile(findProject(input.projectId).path, input.path)
  })

  handle(channels.saveProjectFile, async (_event, payload) => {
    const input = saveProjectFileInputSchema.parse(payload)
    return saveProjectFile(findProject(input.projectId).path, input.path, input.content, input.expectedContent)
  })

  handle(channels.runShell, async (_event, payload) => {
    const input = runShellInputSchema.parse(payload)
    const project = findProject(input.projectId)
    const started = Date.now()
    const settings = store.get().settings
    const { commandTimeoutSec, shell: shellKind } = settings.agent
    const output = await runShellCommand(project.path, input.command, { timeoutMs: commandTimeoutSec * 1000, shell: shellKind, sandbox: { enabled: settings.permissions.sandbox, allowNetwork: settings.permissions.sandboxNetwork } })
    return { output, durationMs: Date.now() - started }
  })

  handle(channels.openPanelWindow, async (_event, payload) => {
    const input = panelWindowInputSchema.parse(payload)
    if (!store.get().threads.some((item) => item.id === input.threadId)) throw new Error('任务不存在')
    openPanelWindow(input.threadId)
  })

  handle(channels.openFloatingWindow, async () => { openFloatingWindow({ force: true }) })
  handle(channels.closeFloatingWindow, async () => { closeFloatingWindow() })
  handle(channels.focusMainWindow, async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // 复制统一走主进程：渲染进程的 navigator.clipboard 在窗口未聚焦时会直接失败
  // （实测 NotAllowedError: Document is not focused），用户点「复制」往往正好伴随焦点切换。
  handle(channels.copyText, async (_event, payload) => {
    const input = copyTextInputSchema.parse(payload)
    clipboard.writeText(input.text)
  })

  handle(channels.closePanelWindow, async () => {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.close()
  })

  handle(channels.openExternal, async (_event, payload) => {
    const { url } = openExternalInputSchema.parse(payload)
    if (!/^https?:\/\//i.test(url)) throw new Error('仅允许打开 http/https 链接')
    await shell.openExternal(url)
  })

  handle(channels.resolveApproval, async (_event, payload) => {
    const input = approvalInputSchema.parse(payload)
    await agent.resolveApproval(input.threadId, input.callId, input.approved)
  })

  handle(channels.saveSettings, async (_event, payload) => {
    const settings = settingsSchema.parse(payload)
    settings.github.hasToken = secrets.has(GITHUB_SECRET)
    const previousMode = store.get().settings.computer.mode
    await store.update((state) => {
      const previous = new Map(state.settings.automations.map((item) => [item.id, item.lastRun]))
      settings.automations = settings.automations.map((item) => ({ ...item, lastRun: previous.get(item.id) ?? item.lastRun }))
      state.settings = settings
    })
    if (previousMode === 'isolated' && settings.computer.mode !== 'isolated') {
      await closeIsolatedDesktop(ISOLATED_DESKTOP_NAME)
      stopDesktopMirror()
    }
    await secrets.prune(new Set([...settings.providers.map((provider) => provider.id), GITHUB_SECRET]))
    mcp.sync(await syncAoci())
    browserEngine.setOptions({ allowDownloads: settings.browser.allowDownloads, allowNewWindows: settings.browser.allowNewWindows, userAgent: settings.browser.userAgent, homepage: settings.browser.homepage })
    publish()
  })

  handle(channels.shareThreadImage, async (_event, payload) => {
    const { threadId } = threadInputSchema.parse(payload)
    const state = store.get()
    const thread = state.threads.find((item) => item.id === threadId)
    if (!thread || !mainWindow) throw new Error('任务不存在')
    const project = state.projects.find((item) => item.id === thread.projectId)
    const { renderShareImage, threadToShareHtml } = await import('./share')
    const image = await renderShareImage(threadToShareHtml(thread, project?.name ?? ''))
    const png = image.toPNG()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]).catch(() => undefined)
    const safe = thread.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'task'
    const result = await dialog.showSaveDialog(mainWindow, { title: '保存分享图片（已复制到剪贴板）', defaultPath: `${safe}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, png)
    shell.showItemInFolder(result.filePath)
    return result.filePath
  })

  handle(channels.setGithubToken, async (_event, payload) => {
    const { token } = githubTokenInputSchema.parse(payload)
    if (!token) {
      await secrets.set(GITHUB_SECRET, '')
      publish()
      return null
    }
    const { verifyGithubToken } = await import('./github')
    const login = await verifyGithubToken(token)
    await secrets.set(GITHUB_SECRET, token)
    publish()
    return login
  })

  handle(channels.githubPush, async (_event, payload) => {
    const input = githubPushInputSchema.parse(payload)
    const token = secrets.get(GITHUB_SECRET)
    if (!token) throw new Error('尚未配置 GitHub 令牌')
    const { pushToGithub } = await import('./github')
    return pushToGithub({ token, projectPath: findProject(input.projectId).path, github: store.get().settings.github, message: input.message })
  })

  handle(channels.listPlugins, async () => {
    await extensions.load()
    return extensions.list()
  })

  handle(channels.openPluginsDir, async () => {
    await extensions.load()
    const error = await shell.openPath(join(app.getPath('userData'), 'plugins'))
    if (error) throw new Error(`无法打开插件目录：${error}`)
  })

  handle(channels.listSkills, async () => skills.list())

  handle(channels.importSkills, async () => {
    if (!mainWindow) throw new Error('窗口未就绪')
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: '导入技能（标准 skill 包 .zip 或单文件）',
      filters: [{ name: '技能', extensions: ['zip', 'md', 'markdown', 'mdx', 'txt'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return skills.import(result.filePaths)
  })

  handle(channels.deleteSkill, async (_event, payload) => {
    const id = payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string' ? (payload as { id: string }).id : ''
    if (!id) throw new Error('缺少技能标识')
    await skills.remove(id)
  })

  handle(channels.readSkill, async (_event, payload) => {
    const id = payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string' ? (payload as { id: string }).id : ''
    if (!id) throw new Error('缺少技能标识')
    return skills.read(id)
  })

  handle(channels.openSkillsDir, async () => {
    const dir = join(app.getPath('userData'), 'skills')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dir, { recursive: true }))
    const error = await shell.openPath(dir)
    if (error) throw new Error(`无法打开技能目录：${error}`)
  })

  handle(channels.listMcp, async () => mcp.list(store.get().settings.mcp.servers))

  handle(channels.testMcp, async (_event, payload) => {
    const { server } = mcpTestInputSchema.parse(payload)
    return mcp.test(server)
  })

  handle(channels.saveWorkflow, async (_event, payload) => {
    const workflow = saveWorkflowInputSchema.parse(payload)
    findProject(workflow.projectId)
    await store.update((state) => {
      const list = state.workflows ?? []
      const index = list.findIndex((item) => item.id === workflow.id)
      if (index < 0 && list.length >= 50) throw new Error('工作流数量已达上限（50 个）')
      state.workflows = index < 0 ? [...list, workflow] : list.map((item) => (item.id === workflow.id ? workflow : item))
    })
  })

  handle(channels.deleteWorkflow, async (_event, payload) => {
    const { workflowId } = workflowInputSchema.parse(payload)
    const inUse = store.get().threads.some((item) => item.workflowRun && item.workflowRun.workflowId === workflowId && item.workflowRun.status !== 'done')
    if (inUse) throw new Error('该工作流正在被任务使用，请先结束对应任务的工作流')
    await store.update((state) => { state.workflows = (state.workflows ?? []).filter((item) => item.id !== workflowId) })
  })

  handle(channels.runWorkflow, async (_event, payload) => {
    const { workflowId } = workflowInputSchema.parse(payload)
    const state = store.get()
    const workflow = state.workflows?.find((item) => item.id === workflowId)
    if (!workflow) throw new Error('工作流不存在')
    const thread = await agent.createThread(workflow.projectId, state.settings.defaultModelId)
    await workflowRunner.start(thread.id, workflow)
    return store.get().threads.find((item) => item.id === thread.id) ?? thread
  })

  // Work 画布「AI 生成工作流」：调 LLM 把自然语言需求转成画布上的节点（生成后由用户检查/保存）。
  handle(channels.generateWorkflow, async (_event, payload) => {
    const input = generateWorkflowInputSchema.parse(payload)
    findProject(input.projectId)
    return generateWorkflowWithModel({ settings: store.get().settings, secrets: { get: (id) => secrets.get(id) }, projectId: input.projectId, request: input.request, ...(input.modelId ? { modelId: input.modelId } : {}) })
  })

  handle(channels.workflowControl, async (_event, payload) => {
    const input = workflowControlInputSchema.parse(payload)
    if (!store.get().threads.some((item) => item.id === input.threadId)) throw new Error('任务不存在')
    if (input.action === 'pause') await workflowRunner.pause(input.threadId)
    else if (input.action === 'resume') await workflowRunner.resume(input.threadId)
    else if (input.action === 'retry-node') {
      if (!input.nodeId) throw new Error('缺少步骤标识')
      await workflowRunner.retryNode(input.threadId, input.nodeId)
    } else {
      if (!input.nodeId) throw new Error('缺少步骤标识')
      await workflowRunner.skipNode(input.threadId, input.nodeId)
    }
  })

  handle(channels.runAutomation, async (_event, payload) => {
    const { automationId } = automationInputSchema.parse(payload)
    const automation = store.get().settings.automations.find((item) => item.id === automationId)
    if (!automation) throw new Error('自动化不存在，请先保存设置')
    await runAutomation(automation)
  })

  handle(channels.setProviderKey, async (_event, payload) => {
    const input = providerKeyInputSchema.parse(payload)
    if (!store.get().settings.providers.some((provider) => provider.id === input.providerId)) throw new Error('提供商不存在，请先保存设置')
    await secrets.set(input.providerId, input.apiKey.trim())
    publish()
  })

  handle(channels.testConnection, async (_event, payload) => {
    const input = testConnectionInputSchema.parse(payload)
    const apiKey = input.apiKey?.trim() || secrets.get(input.provider.id)
    if (input.provider.kind !== 'ollama' && !apiKey) throw new Error(`提供商「${input.provider.name}」尚未填写 API Key`)
    return testConnection(input.provider, apiKey, input.model)
  })

  handle(channels.listProviderModels, async (_event, payload) => {
    const input = listProviderModelsInputSchema.parse(payload)
    const apiKey = input.apiKey?.trim() || secrets.get(input.provider.id)
    if (input.provider.kind !== 'ollama' && !apiKey) throw new Error(`提供商「${input.provider.name}」尚未填写 API Key`)
    return listModels(input.provider, apiKey)
  })

  handle(channels.probeContextWindow, async (_event, payload) => {
    const input = probeContextWindowInputSchema.parse(payload)
    const apiKey = input.apiKey?.trim() || secrets.get(input.provider.id)
    if (input.provider.kind !== 'ollama' && !apiKey) throw new Error(`提供商「${input.provider.name}」尚未填写 API Key`)
    return probeContextWindow({ provider: input.provider, apiKey, model: input.model })
  })
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== PREVIEW_PARTITION) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
  })
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    return
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(async () => {
  hardenSession()
  await Promise.all([store.load(), secrets.load()])
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    await store.update((state) => { state.notice = [state.notice, '当前系统无可用密钥环（gnome-keyring/kwallet），API Key 仅弱加密存储，建议启用系统密钥环'].filter(Boolean).join('；') })
  }
  store.subscribe(publish)
  registerIpc()
  createWindow()
  void buildAppIcon().then(() => {
    if (appIcon && !appIcon.isEmpty()) for (const win of liveWindows()) win.setIcon(appIcon)
  }).catch(() => { /* 图标构建失败不阻塞启动 */ })
  void extensions.load().catch((error: unknown) => console.error('[cubex] 插件加载失败', error))
  if (process.env.CUBEX_SMOKE !== '1') {
    setTimeout(() => {
      void syncAoci().then((servers) => mcp.sync(servers))
      startAutomationScheduler()
    }, 1200)
    // 兜底：操控期间若镜像被意外停掉（例如 suspended 后回来），按设置在操控恢复时重新拉起。
    setInterval(() => {
      if (!controlActive) { stopDesktopMirror(); return }
      const settings = store.get().settings
      if (settings.computer.mode !== 'isolated' || !settings.computer.mirror) { stopDesktopMirror(); return }
      if (!mirrorTimer) startDesktopMirror(ISOLATED_DESKTOP_NAME)
    }, 2000)
  }
  if (process.env.CUBEX_SMOKE === '1' && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const mounted = await mainWindow?.webContents.executeJavaScript('Boolean(document.querySelector(".shell")) && Boolean(window.cubex)')
      console.log(mounted ? '[cubex] smoke-ready' : '[cubex] smoke-failed: 界面未挂载或桥接缺失')
      app.exit(mounted ? 0 : 2)
    })
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      console.log(`[cubex] smoke-failed: ${code} ${description}`)
      app.exit(2)
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void agent.terminateAll()
  mcp.stopAll()
  browserEngine.closeAll()
  store.flushSync()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
