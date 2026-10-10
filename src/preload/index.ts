import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type { AgentActivity, AppState, BrowserState, ControlState, CubexAPI, Settings, StreamDelta, WindowState, Workflow } from '../shared/schema'

const api: CubexAPI = {
  getState: () => ipcRenderer.invoke(channels.getState),
  selectProject: () => ipcRenderer.invoke(channels.selectProject),
  createThread: (input) => ipcRenderer.invoke(channels.createThread, { projectId: input.projectId, modelId: input.modelId, ...(input.mode ? { mode: input.mode } : {}) }),
  sendMessage: (input) => ipcRenderer.invoke(channels.sendMessage, { threadId: input.threadId, content: input.content, ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.card ? { card: input.card } : {}), ...(input.images?.length ? { images: input.images } : {}), ...(input.instruction ? { instruction: input.instruction } : {}) }),
  regenerateMessage: (input) => ipcRenderer.invoke(channels.regenerateMessage, { threadId: input.threadId, messageId: input.messageId, ...(input.modelId ? { modelId: input.modelId } : {}) }),
  rollbackMessage: (input) => ipcRenderer.invoke(channels.rollbackMessage, { threadId: input.threadId, messageId: input.messageId }),
  deleteMessage: (input) => ipcRenderer.invoke(channels.deleteMessage, { threadId: input.threadId, messageId: input.messageId }),
  cancelThread: (input) => ipcRenderer.invoke(channels.cancelThread, { threadId: input.threadId }),
  deleteThread: (input) => ipcRenderer.invoke(channels.deleteThread, { threadId: input.threadId }),
  updateThread: (input) => ipcRenderer.invoke(channels.updateThread, { threadId: input.threadId, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.pinned !== undefined ? { pinned: input.pinned } : {}) }),
  compactThread: (input) => ipcRenderer.invoke(channels.compactThread, { threadId: input.threadId }),
  exportThread: (input) => ipcRenderer.invoke(channels.exportThread, { threadId: input.threadId }),
  exportText: (input) => ipcRenderer.invoke(channels.exportText, { title: input.title, defaultName: input.defaultName, content: input.content }),
  deleteProject: (input) => ipcRenderer.invoke(channels.deleteProject, { projectId: input.projectId }),
  updateProject: (input) => ipcRenderer.invoke(channels.updateProject, { projectId: input.projectId, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.archived !== undefined ? { archived: input.archived } : {}) }),
  revealProject: (input) => ipcRenderer.invoke(channels.revealProject, { projectId: input.projectId }),
  windowControl: (action) => ipcRenderer.invoke(channels.windowControl, action),
  resolveApproval: (input) => ipcRenderer.invoke(channels.resolveApproval, { threadId: input.threadId, callId: input.callId, approved: input.approved }),
  answerQuestion: (input) => ipcRenderer.invoke(channels.answerQuestion, { threadId: input.threadId, callId: input.callId, answer: input.answer }),
  dequeueMessage: (input) => ipcRenderer.invoke(channels.dequeueMessage, { threadId: input.threadId, queuedId: input.queuedId }),
  steerMessage: (input) => ipcRenderer.invoke(channels.steerMessage, { threadId: input.threadId, content: input.content }),
  pickFiles: (input) => ipcRenderer.invoke(channels.pickFiles, { projectId: input.projectId }),
  listFiles: (input) => ipcRenderer.invoke(channels.listFiles, { projectId: input.projectId, path: input.path }),
  readProjectFile: (input) => ipcRenderer.invoke(channels.readProjectFile, { projectId: input.projectId, path: input.path }),
  saveProjectFile: (input) => ipcRenderer.invoke(channels.saveProjectFile, { projectId: input.projectId, path: input.path, content: input.content, expectedContent: input.expectedContent }),
  runShell: (input) => ipcRenderer.invoke(channels.runShell, { projectId: input.projectId, command: input.command }),
  openPanelWindow: (input) => ipcRenderer.invoke(channels.openPanelWindow, { threadId: input.threadId }),
  closePanelWindow: () => ipcRenderer.invoke(channels.closePanelWindow),
  openExternal: (input) => ipcRenderer.invoke(channels.openExternal, { url: input.url }),
  saveSettings: (settings: Settings) => ipcRenderer.invoke(channels.saveSettings, settings),
  setProviderKey: (input) => ipcRenderer.invoke(channels.setProviderKey, { providerId: input.providerId, apiKey: input.apiKey }),
  testConnection: (input) => ipcRenderer.invoke(channels.testConnection, { provider: input.provider, model: input.model, ...(input.apiKey ? { apiKey: input.apiKey } : {}) }),
  listProviderModels: (input) => ipcRenderer.invoke(channels.listProviderModels, { provider: input.provider, ...(input.apiKey ? { apiKey: input.apiKey } : {}) }),
  probeContextWindow: (input) => ipcRenderer.invoke(channels.probeContextWindow, { provider: input.provider, model: input.model, ...(input.apiKey ? { apiKey: input.apiKey } : {}) }),
  shareThreadImage: (input) => ipcRenderer.invoke(channels.shareThreadImage, { threadId: input.threadId }),
  setGithubToken: (input) => ipcRenderer.invoke(channels.setGithubToken, { token: input.token }),
  githubPush: (input) => ipcRenderer.invoke(channels.githubPush, { projectId: input.projectId, ...(input.message ? { message: input.message } : {}) }),
  listPlugins: () => ipcRenderer.invoke(channels.listPlugins),
  openPluginsDir: () => ipcRenderer.invoke(channels.openPluginsDir),
  listSkills: () => ipcRenderer.invoke(channels.listSkills),
  importSkills: () => ipcRenderer.invoke(channels.importSkills),
  deleteSkill: (input) => ipcRenderer.invoke(channels.deleteSkill, { id: input.id }),
  readSkill: (input) => ipcRenderer.invoke(channels.readSkill, { id: input.id }),
  openSkillsDir: () => ipcRenderer.invoke(channels.openSkillsDir),
  listMcp: () => ipcRenderer.invoke(channels.listMcp),
  testMcp: (input) => ipcRenderer.invoke(channels.testMcp, { server: input.server }),
  saveWorkflow: (workflow: Workflow) => ipcRenderer.invoke(channels.saveWorkflow, {
    id: workflow.id,
    projectId: workflow.projectId,
    name: workflow.name,
    nodes: workflow.nodes.map((node) => ({ id: node.id, title: node.title, prompt: node.prompt, x: node.x, y: node.y, ...(node.kind ? { kind: node.kind } : {}), ...(node.config && Object.values(node.config).some((value) => value.trim()) ? { config: node.config } : {}) })),
    edges: workflow.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    updatedAt: workflow.updatedAt,
  }),
  deleteWorkflow: (input) => ipcRenderer.invoke(channels.deleteWorkflow, { workflowId: input.workflowId }),
  runWorkflow: (input) => ipcRenderer.invoke(channels.runWorkflow, { workflowId: input.workflowId }),
  generateWorkflow: (input) => ipcRenderer.invoke(channels.generateWorkflow, { projectId: input.projectId, request: input.request, ...(input.modelId ? { modelId: input.modelId } : {}) }),
  runAutomation: (input) => ipcRenderer.invoke(channels.runAutomation, { automationId: input.automationId }),
  browserBounds: (input) => ipcRenderer.invoke(channels.browserBounds, { threadId: input.threadId, x: input.x, y: input.y, width: input.width, height: input.height }),
  browserHide: (input) => ipcRenderer.invoke(channels.browserHide, { threadId: input.threadId }),
  browserNavigate: (input) => ipcRenderer.invoke(channels.browserNavigate, { threadId: input.threadId, url: input.url }),
  browserCapture: (input) => ipcRenderer.invoke(channels.browserCapture, { threadId: input.threadId }),
  browserTab: (input) => ipcRenderer.invoke(channels.browserTab, { threadId: input.threadId, action: input.action, ...(input.tabId ? { tabId: input.tabId } : {}), ...(input.url ? { url: input.url } : {}) }),
  onBrowserState: (listener) => {
    const wrapped = (_event: unknown, state: BrowserState) => listener(state)
    ipcRenderer.on(channels.browserState, wrapped)
    return () => ipcRenderer.removeListener(channels.browserState, wrapped)
  },
  workflowControl: (input) => ipcRenderer.invoke(channels.workflowControl, { threadId: input.threadId, action: input.action, ...(input.nodeId ? { nodeId: input.nodeId } : {}) }),
  openFloatingWindow: () => ipcRenderer.invoke(channels.openFloatingWindow),
  closeFloatingWindow: () => ipcRenderer.invoke(channels.closeFloatingWindow),
  focusMainWindow: () => ipcRenderer.invoke(channels.focusMainWindow),
  copyText: (input) => ipcRenderer.invoke(channels.copyText, { text: input.text }),
  onDesktopMirror: (listener) => {
    const wrapped = (_event: unknown, frame: { image: string; width: number; height: number } | null) => listener(frame)
    ipcRenderer.on(channels.desktopMirror, wrapped)
    return () => ipcRenderer.removeListener(channels.desktopMirror, wrapped)
  },
  onState: (listener) => {
    const wrapped = (_event: unknown, state: AppState) => listener(state)
    ipcRenderer.on(channels.state, wrapped)
    return () => ipcRenderer.removeListener(channels.state, wrapped)
  },
  onDelta: (listener) => {
    const wrapped = (_event: unknown, delta: StreamDelta) => listener(delta)
    ipcRenderer.on(channels.delta, wrapped)
    return () => ipcRenderer.removeListener(channels.delta, wrapped)
  },
  onActivity: (listener) => {
    const wrapped = (_event: unknown, activity: AgentActivity) => listener(activity)
    ipcRenderer.on(channels.activity, wrapped)
    return () => ipcRenderer.removeListener(channels.activity, wrapped)
  },
  onWindowState: (listener) => {
    const wrapped = (_event: unknown, state: WindowState) => listener(state)
    ipcRenderer.on(channels.windowState, wrapped)
    return () => ipcRenderer.removeListener(channels.windowState, wrapped)
  },
  onControl: (listener) => {
    const wrapped = (_event: unknown, control: ControlState) => listener(control)
    ipcRenderer.on(channels.control, wrapped)
    return () => ipcRenderer.removeListener(channels.control, wrapped)
  },
}

contextBridge.exposeInMainWorld('cubex', api)
