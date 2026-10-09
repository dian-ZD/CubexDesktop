import type { AppState, CubexAPI } from '../../shared/schema'
import { createInitialState } from '../../shared/schema'

declare global {
  interface Window {
    cubex?: CubexAPI
  }
}

export const isDesktop = typeof window !== 'undefined' && !!window.cubex

const unavailable = (feature: string) => Promise.resolve({ ok: false as const, error: `${feature}仅在桌面应用中可用；当前为浏览器预览，不访问本机文件与模型服务` })

let previewState: AppState = {
  ...createInitialState(),
  notice: '浏览器预览模式：界面可交互，但项目、会话与模型调用等桌面能力被禁用',
}
const previewListeners = new Set<(state: AppState) => void>()
const broadcast = () => { for (const listener of previewListeners) listener(previewState) }

const previewApi: CubexAPI = {
  getState: () => Promise.resolve({ ok: true, data: previewState }),
  selectProject: () => unavailable('选择项目'),
  createThread: () => unavailable('新建会话'),
  sendMessage: () => unavailable('发送消息'),
  regenerateMessage: () => unavailable('重新生成'),
  rollbackMessage: () => unavailable('回退消息'),
  deleteMessage: () => unavailable('删除消息'),
  cancelThread: () => unavailable('停止回复'),
  deleteThread: () => unavailable('删除任务'),
  updateThread: () => unavailable('修改任务'),
  compactThread: () => unavailable('压缩上下文'),
  exportThread: () => unavailable('分享任务'),
  exportText: () => unavailable('导出文件'),
  deleteProject: () => unavailable('删除项目'),
  updateProject: () => unavailable('修改项目'),
  revealProject: () => unavailable('在资源管理器中打开'),
  windowControl: () => Promise.resolve({ ok: true, data: undefined }),
  resolveApproval: () => unavailable('审批'),
  answerQuestion: () => unavailable('回答追问'),
  dequeueMessage: () => unavailable('取消排队'),
  steerMessage: () => unavailable('引导'),
  pickFiles: () => unavailable('添加文件'),
  listFiles: () => unavailable('浏览文件'),
  readProjectFile: () => unavailable('读取文件'),
  saveProjectFile: () => unavailable('保存文件'),
  runShell: () => unavailable('终端'),
  openPanelWindow: () => unavailable('独立窗口'),
  closePanelWindow: () => Promise.resolve({ ok: true, data: undefined }),
  openExternal: ({ url }) => { window.open(url, '_blank', 'noopener'); return Promise.resolve({ ok: true, data: undefined }) },
  saveSettings: (settings) => {
    previewState = { ...previewState, settings }
    broadcast()
    return Promise.resolve({ ok: true, data: undefined })
  },
  setProviderKey: ({ providerId, apiKey }) => {
    previewState = {
      ...previewState,
      settings: {
        ...previewState.settings,
        providers: previewState.settings.providers.map((item) => item.id === providerId ? { ...item, hasKey: apiKey.length > 0 } : item),
      },
    }
    broadcast()
    return Promise.resolve({ ok: true, data: undefined })
  },
  testConnection: () => unavailable('测试连接'),
  listProviderModels: () => unavailable('自动检测模型'),
  probeContextWindow: () => unavailable('实测上下文长度'),
  shareThreadImage: () => unavailable('分享为图片'),
  setGithubToken: () => unavailable('GitHub 令牌'),
  githubPush: () => unavailable('推送到 GitHub'),
  listPlugins: () => Promise.resolve({ ok: true, data: [] }),
  openPluginsDir: () => unavailable('打开插件目录'),
  listSkills: () => Promise.resolve({ ok: true, data: [] }),
  importSkills: () => unavailable('导入技能'),
  deleteSkill: () => unavailable('删除技能'),
  readSkill: () => unavailable('读取技能'),
  openSkillsDir: () => unavailable('打开技能目录'),
  listMcp: () => Promise.resolve({ ok: true, data: [] }),
  testMcp: () => unavailable('测试 MCP 服务器'),
  saveWorkflow: (workflow) => {
    const others = (previewState.workflows ?? []).filter((item) => item.id !== workflow.id)
    previewState = { ...previewState, workflows: [...others, workflow] }
    broadcast()
    return Promise.resolve({ ok: true, data: undefined })
  },
  deleteWorkflow: ({ workflowId }) => {
    previewState = { ...previewState, workflows: (previewState.workflows ?? []).filter((item) => item.id !== workflowId) }
    broadcast()
    return Promise.resolve({ ok: true, data: undefined })
  },
  runWorkflow: () => unavailable('运行工作流'),
  runAutomation: () => unavailable('运行自动化'),
  browserBounds: () => unavailable('浏览器画面'),
  browserHide: () => unavailable('浏览器画面'),
  browserNavigate: () => unavailable('浏览器导航'),
  browserCapture: () => unavailable('浏览器引用'),
  browserTab: () => unavailable('浏览器标签'),
  onBrowserState: () => () => undefined,
  workflowControl: () => unavailable('工作流控制'),
  openFloatingWindow: () => unavailable('悬浮窗'),
  closeFloatingWindow: () => unavailable('悬浮窗'),
  focusMainWindow: () => unavailable('主窗口'),
  copyText: ({ text }) => {
    if (!navigator.clipboard) return Promise.resolve({ ok: false as const, error: '当前环境不支持剪贴板' })
    return navigator.clipboard.writeText(text).then(() => ({ ok: true as const, data: undefined }), () => ({ ok: false as const, error: '复制失败，请手动选择文本复制' }))
  },
  onDesktopMirror: () => () => undefined,
  onState: (listener) => {
    previewListeners.add(listener)
    return () => previewListeners.delete(listener)
  },
  onDelta: () => () => undefined,
  onActivity: () => () => undefined,
  onWindowState: () => () => undefined,
  onControl: () => () => undefined,
}

export const api: CubexAPI = isDesktop ? window.cubex! : previewApi
