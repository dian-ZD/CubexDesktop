import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, screen, session, shell, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { join, basename, relative, isAbsolute, sep } from 'node:path'
import { realpath, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { answerInputSchema, approvalInputSchema, automationInputSchema, channels, createThreadInputSchema, dequeueInputSchema, deleteMessageInputSchema, githubPushInputSchema, githubTokenInputSchema, mcpTestInputSchema, openExternalInputSchema, panelWindowInputSchema, projectInputSchema, projectPathInputSchema, providerKeyInputSchema, regenerateMessageInputSchema, rollbackMessageInputSchema, runShellInputSchema, saveWorkflowInputSchema, sendMessageInputSchema, settingsSchema, testConnectionInputSchema, threadInputSchema, updateProjectInputSchema, updateThreadInputSchema, windowActionSchema, workflowInputSchema, type AgentActivity, type AppState, type Automation, type ControlState, type MessageCard, type Result, type StreamDelta, type Thread, type Workflow } from '../shared/schema'
import { testConnection } from './llm'
import { ensureProjectFiles } from './projectFiles'
import { browseDirectory, readProjectFile, runShellCommand } from './tools'
import { StateStore } from './store'
import { SecretStore } from './secrets'
import { AgentRunner } from './agent'
import { ExtensionHost } from './extensions'
import { McpManager } from './mcp'
import { composeWorkflowPrompt, dueAutomations } from './workflow'

const GITHUB_SECRET = 'github'
const isDev = !!process.env.ELECTRON_RENDERER_URL
if (process.env.CUBEX_SMOKE === '1') app.setPath('userData', join(app.getPath('temp'), `cubex-smoke-${process.pid}`))
const store = new StateStore(join(app.getPath('userData'), 'state.json'))
const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'))
const mcp = new McpManager()
let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null

let appIcon: Electron.NativeImage | null = null

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
const liveWindows = () => [mainWindow, panelWindow].filter((win): win is BrowserWindow => !!win && !win.isDestroyed())
const extensions = new ExtensionHost({
  pluginsDir: join(app.getPath('userData'), 'plugins'),
  getSettings: () => store.get().settings,
  getGithubToken: () => secrets.get(GITHUB_SECRET),
  mcp,
  onControl: (control) => {
    const payload: ControlState = control.active ? control : { active: false }
    for (const win of liveWindows()) win.webContents.send(channels.control, payload)
  },
})
const agent = new AgentRunner(store, secrets, (delta: StreamDelta) => {
  for (const win of liveWindows()) win.webContents.send(channels.delta, delta)
}, undefined, extensions, (activity: AgentActivity) => {
  for (const win of liveWindows()) win.webContents.send(channels.activity, activity)
})

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

function workflowCard(workflow: Workflow): MessageCard {
  const steps = workflow.nodes.filter((node) => node.kind !== 'note').length
  return { kind: 'workflow', workflowId: workflow.id, name: workflow.name, steps }
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
    await agent.send(thread.id, composeWorkflowPrompt(workflow), automation.modelId, workflowCard(workflow))
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

const restoreBounds = new WeakMap<BrowserWindow, Rectangle>()

function toggleMaximize(win: BrowserWindow) {
  if (win.isMaximized()) {
    const previous = restoreBounds.get(win)
    win.unmaximize()
    if (previous) win.setBounds(previous)
    return
  }
  restoreBounds.set(win, win.getBounds())
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea
  win.setBounds(workArea)
  win.maximize()
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
  panelWindow.on('closed', () => {
    panelWindow = null
    for (const win of liveWindows()) win.webContents.send(channels.windowState, { maximized: win.isMaximized(), focused: win.isFocused(), panelDetached: false })
  })
  void loadRenderer(panelWindow, `panel=${encodeURIComponent(threadId)}`)
  for (const win of liveWindows()) win.webContents.send(channels.windowState, { maximized: win.isMaximized(), focused: win.isFocused(), panelDetached: true })
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
  const sendWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(channels.windowState, { maximized: mainWindow.isMaximized(), focused: mainWindow.isFocused(), panelDetached: !!panelWindow && !panelWindow.isDestroyed() })
  }
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)
  mainWindow.on('focus', sendWindowState)
  mainWindow.on('blur', sendWindowState)
  mainWindow.webContents.on('did-finish-load', sendWindowState)
  guardNavigation(mainWindow)
  mainWindow.on('closed', () => {
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

  handle(channels.createThread, async (_event, payload) => {
    const input = createThreadInputSchema.parse(payload)
    return agent.createThread(input.projectId, input.modelId)
  })

  handle(channels.sendMessage, async (_event, payload) => {
    const input = sendMessageInputSchema.parse(payload)
    await agent.send(input.threadId, input.content, input.modelId, input.card, input.images)
  })

  handle(channels.regenerateMessage, async (_event, payload) => {
    const input = regenerateMessageInputSchema.parse(payload)
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
    await agent.cancel(threadInputSchema.parse(payload).threadId)
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
    await store.update((state) => {
      const previous = new Map(state.settings.automations.map((item) => [item.id, item.lastRun]))
      settings.automations = settings.automations.map((item) => ({ ...item, lastRun: previous.get(item.id) ?? item.lastRun }))
      state.settings = settings
    })
    await secrets.prune(new Set([...settings.providers.map((provider) => provider.id), GITHUB_SECRET]))
    mcp.sync(settings.mcp.servers)
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
    await store.update((state) => { state.workflows = (state.workflows ?? []).filter((item) => item.id !== workflowId) })
  })

  handle(channels.runWorkflow, async (_event, payload) => {
    const { workflowId } = workflowInputSchema.parse(payload)
    const state = store.get()
    const workflow = state.workflows?.find((item) => item.id === workflowId)
    if (!workflow) throw new Error('工作流不存在')
    const prompt = composeWorkflowPrompt(workflow)
    const thread = await agent.createThread(workflow.projectId, state.settings.defaultModelId)
    await agent.send(thread.id, prompt, state.settings.defaultModelId, workflowCard(workflow))
    return store.get().threads.find((item) => item.id === thread.id) ?? thread
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
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(async () => {
  hardenSession()
  await Promise.all([store.load(), secrets.load()])
  store.subscribe(publish)
  registerIpc()
  createWindow()
  void buildAppIcon().then(() => {
    if (appIcon && !appIcon.isEmpty()) for (const win of liveWindows()) win.setIcon(appIcon)
  }).catch(() => { /* 图标构建失败不阻塞启动 */ })
  void extensions.load().catch((error: unknown) => console.error('[cubex] 插件加载失败', error))
  if (process.env.CUBEX_SMOKE !== '1') {
    setTimeout(() => {
      mcp.sync(store.get().settings.mcp.servers)
      startAutomationScheduler()
    }, 1200)
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
  store.flushSync()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
