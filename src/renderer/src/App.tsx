import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, CloudUpload, CodeXml, Copy, Cpu, Ellipsis, FileCode2, FileDown, Folder, FolderOpen, FolderTree, Globe, Hand, Image, ListChecks, ListOrdered, LoaderCircle, Maximize2, MessageCircleQuestion, MessageSquare, Mic, MicOff, Minus, Monitor, Moon, OctagonX, PanelLeft, PanelRight, Paperclip, Pencil, Pin, PinOff, PlugZap, Plus, Puzzle, Search, Settings2, ShieldCheck, Square, SquarePen, Sun, Terminal, Trash2, Workflow, X } from 'lucide-react'
import { approvalLabels, approvalModes, createInitialState, uiLanguages, type AgentActivity, type AppState, type ControlState, type Message, type MessageImage, type PendingQuestion, type Project, type Settings, type SkillMeta, type Thread, type ToolCall, type ToolResult } from '../../shared/schema'
import { api, isDesktop } from './bridge'
import { Logo } from './Logo'
import { Markdown, OpenTargetContext, type OpenTarget } from './Markdown'
import type { OpenRequest } from './RightPanel'
import { SkillMenu } from './SkillMenu'
import { Select, useUi, type MenuEntry } from './ui'
import { LanguageContext, translate, useI18n, eulaText, tr as trBase } from './i18n'
import { useSpeech } from './useSpeech'
import type { SectionId as SettingsSection } from './SettingsPanel'

const importRightPanel = () => import('./RightPanel')
const importSettingsPanel = () => import('./SettingsPanel')
const importWorkflowCanvas = () => import('./WorkflowCanvas')
const SettingsPanel = lazy(() => importSettingsPanel().then((module) => ({ default: module.SettingsPanel })))
const RightPanel = lazy(() => importRightPanel().then((module) => ({ default: module.RightPanel })))
const WorkflowCanvas = lazy(() => importWorkflowCanvas().then((module) => ({ default: module.WorkflowCanvas })))

function prefetchPanels() {
  const run = () => { void importRightPanel(); void importSettingsPanel(); void importWorkflowCanvas() }
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
  if (idle) idle(run)
  else setTimeout(run, 800)
}
const panelThreadId = (): string | null => {
  const match = /^#panel=([^&]+)/.exec(window.location.hash)
  return match ? decodeURIComponent(match[1]) : null
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })

const toolIcon = {
  read_file: FileCode2,
  list_directory: FolderTree,
  search_files: Search,
  write_file: FileCode2,
  edit_file: Pencil,
  run_command: Terminal,
  ask_user: MessageCircleQuestion,
  manage_todos: ListChecks,
  delegate: Workflow,
  github_push: CloudUpload,
  browser_open: Globe,
  web_search: Search,
  computer_use: Monitor,
  plugin_call: Puzzle,
  mcp_call: PlugZap,
} as const

const approvalDetail: Partial<Record<ToolCall['name'], string>> = {
  run_command: '将在项目目录中执行命令',
  github_push: '将提交当前改动并推送到 GitHub 仓库',
  computer_use: '将操控你的鼠标、键盘或读取屏幕，请确认后再批准',
  plugin_call: '将调用第三方插件，插件可访问项目目录',
  mcp_call: '将调用外部 MCP 服务器提供的工具',
  browser_open: '将在隔离的浏览器会话中打开网页',
}

type Translate = (zhText: string, vars?: Record<string, string | number>) => string

const toolTitle = (call: ToolCall, tr: Translate) => {
  const args = call.args as Record<string, string | undefined>
  switch (call.name) {
    case 'read_file': return tr('读取 {path}', { path: args.path ?? '' })
    case 'list_directory': return tr('列出 {path}', { path: args.path || '.' })
    case 'search_files': return tr('搜索 {pattern}', { pattern: args.pattern ?? '' })
    case 'write_file': return tr('写入 {path}', { path: args.path ?? '' })
    case 'edit_file': return tr('编辑 {path}', { path: args.path ?? '' })
    case 'run_command': return tr('执行 {command}', { command: args.command ?? '' })
    case 'ask_user': return tr('询问 {question}', { question: args.question ?? '' })
    case 'github_push': return tr('推送到 GitHub {message}', { message: args.message ?? '' })
    case 'browser_open': return tr('打开网页 {url}', { url: args.url ?? '' })
    case 'computer_use': return tr('电脑操控 {action}', { action: args.action ?? '' })
    case 'plugin_call': return tr('插件 {plugin}/{tool}', { plugin: args.plugin ?? '', tool: args.tool ?? '' })
    case 'mcp_call': return tr('MCP {server}/{tool}', { server: args.server ?? '', tool: args.tool ?? '' })
  }
}

let sharedAudioCtx: AudioContext | null = null
const soundTones: Record<'done' | 'approval' | 'question', number[]> = {
  done: [660, 880],
  approval: [520, 700, 520],
  question: [700, 560],
}
function playCue(kind: 'done' | 'approval' | 'question', volume: number) {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    if (!sharedAudioCtx) sharedAudioCtx = new Ctor()
    const ctx = sharedAudioCtx
    void ctx.resume?.()
    const gain = ctx.createGain()
    gain.gain.value = Math.max(0, Math.min(1, volume)) * 0.18
    gain.connect(ctx.destination)
    const tones = soundTones[kind]
    const step = 0.12
    tones.forEach((freq, index) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = ctx.currentTime + index * step
      const stop = start + step
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, start)
      env.gain.exponentialRampToValueAtTime(1, start + 0.01)
      env.gain.exponentialRampToValueAtTime(0.0001, stop)
      osc.connect(env)
      env.connect(gain)
      osc.start(start)
      osc.stop(stop + 0.02)
    })
  } catch { /* 忽略音效播放失败 */ }
}

export function App() {
  const [state, setState] = useState<AppState>(() => createInitialState())
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<'chat' | 'settings' | 'work'>('chat')
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>()
  const [projectId, setProjectId] = useState<string | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [modelOverride, setModelOverride] = useState<string>('')
  const [input, setInput] = useState('')
  const [images, setImages] = useState<MessageImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [streams, setStreams] = useState<Record<string, string>>({})
  const [activities, setActivities] = useState<Record<string, AgentActivity>>({})
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return localStorage.getItem('cubex.onboarded') !== '1' } catch { return false }
  })
  const [control, setControl] = useState<ControlState>({ active: false })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const actionLock = useRef(false)

  useEffect(() => {
    let cancelled = false
    void api.getState().then((result) => {
      if (cancelled) return
      if (result.ok) setState(result.data)
      else setError(result.error)
      setLoaded(true)
      prefetchPanels()
    }).catch(() => {
      if (!cancelled) {
        setError(tr('无法读取工作区，请重新打开应用。'))
        setLoaded(true)
      }
    })
    const offState = api.onState((next) => {
      setState(next)
      setStreams((current) => {
        const alive = new Set(next.threads.filter((item) => item.status !== 'idle').flatMap((item) => item.messages.map((message) => message.id)))
        const kept = Object.fromEntries(Object.entries(current).filter(([id]) => alive.has(id)))
        return Object.keys(kept).length === Object.keys(current).length ? current : kept
      })
      setActivities((current) => {
        const running = new Set(next.threads.filter((item) => item.status === 'running').map((item) => item.id))
        const kept = Object.fromEntries(Object.entries(current).filter(([id]) => running.has(id)))
        return Object.keys(kept).length === Object.keys(current).length ? current : kept
      })
    })
    const offActivity = api.onActivity((activity) => {
      setActivities((current) => ({ ...current, [activity.threadId]: activity }))
    })
    let buffer: Record<string, string> = {}
    let frame = 0
    const flushDeltas = () => {
      frame = 0
      const chunk = buffer
      buffer = {}
      setStreams((current) => {
        const next = { ...current }
        for (const [id, text] of Object.entries(chunk)) next[id] = (next[id] ?? '') + text
        return next
      })
    }
    const offDelta = api.onDelta(({ messageId, delta }) => {
      buffer[messageId] = (buffer[messageId] ?? '') + delta
      if (!frame) frame = requestAnimationFrame(flushDeltas)
    })
    return () => { cancelled = true; if (frame) cancelAnimationFrame(frame); offState(); offDelta(); offActivity() }
  }, [])

  const ui = useUi()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [maximized, setMaximized] = useState(false)
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>('dark')
  const [focused, setFocused] = useState(true)
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [panelDetached, setPanelDetached] = useState(false)
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null)
  const requestOpen = useCallback((target: OpenTarget) => {
    if (target.kind === 'url' && !isDesktop) { void api.openExternal({ url: target.value }); return }
    setRightPanelOpen(true)
    setOpenRequest({ target, nonce: Date.now() })
  }, [])
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [skillQuery, setSkillQuery] = useState<string | null>(null)
  const reloadSkills = useCallback(() => { void api.listSkills().then((result) => { if (result.ok) setSkills(result.data) }) }, [])
  useEffect(() => { reloadSkills() }, [reloadSkills])
  const onInputChange = useCallback((value: string) => {
    setInput(value)
    const match = /^\/([^\s/]*)$/.exec(value)
    setSkillQuery(match ? match[1] : null)
  }, [])
  const pickSkill = useCallback((skill: SkillMeta) => {
    setSkillQuery(null)
    void api.readSkill({ id: skill.id }).then((result) => {
      if (!result.ok) { setError(result.error); return }
      setInput((current) => (/^\/[^\s/]*$/.test(current) ? '' : current) + result.data.content)
      requestAnimationFrame(() => { const node = inputRef.current; if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length) } })
    })
  }, [])
  const detachedThreadId = useMemo(panelThreadId, [])
  useEffect(() => api.onWindowState((next) => {
    setMaximized(next.maximized)
    setFocused(next.focused)
    document.documentElement.dataset.maximized = String(next.maximized)
    if (typeof next.panelDetached === 'boolean') setPanelDetached(next.panelDetached)
  }), [])
  useEffect(() => api.onControl((next) => setControl(next)), [])
  const visibleProjects = useMemo(() => state.projects.filter((item) => !item.archived), [state.projects])
  const project = visibleProjects.find((item) => item.id === projectId) ?? visibleProjects[visibleProjects.length - 1] ?? null
  const threadsByProject = useMemo(() => {
    const map = new Map<string, Thread[]>()
    for (const item of state.threads.slice().reverse()) {
      const list = map.get(item.projectId) ?? []
      list.push(item)
      map.set(item.projectId, list)
    }
    for (const list of map.values()) list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
    return map
  }, [state.threads])
  const thread = state.threads.find((item) => item.id === threadId) ?? null
  const running = state.threads.filter((item) => item.status !== 'idle').length
  const models = state.settings.models
  const modelId = modelOverride || thread?.modelId || state.settings.defaultModelId || models[0]?.id || ''
  const model = models.find((item) => item.id === modelId) ?? null
  const isActive = thread?.status !== undefined && thread.status !== 'idle'
  const { appearance, chat, general, sound, work } = state.settings
  const uiLang = general.uiLanguage
  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(uiLang, key, vars), [uiLang])
  const tr = useCallback((zhText: string, vars?: Record<string, string | number>) => trBase(uiLang, zhText, vars), [uiLang])
  const panelFallback = <div className="loading-state" role="status"><LoaderCircle size={22} className="spin" />{tr('正在加载…')}</div>
  const lastStatus = useRef<Record<string, string>>({})

  const currentStreamLen = useMemo(() => {
    if (!thread) return 0
    let total = 0
    for (const message of thread.messages) { const value = streams[message.id]; if (value) total += value.length }
    return total
  }, [thread, streams])

  useEffect(() => {
    if (!chat.autoScroll) return
    const node = scrollRef.current
    if (!node) return
    const handle = requestAnimationFrame(() => { node.scrollTop = node.scrollHeight })
    return () => cancelAnimationFrame(handle)
  }, [thread?.id, thread?.messages.length, currentStreamLen, thread?.status, chat.autoScroll])

  useEffect(() => {
    if (!thread?.id) return
    const node = scrollRef.current
    if (!node) return
    const scroll = () => { node.scrollTop = node.scrollHeight }
    const first = requestAnimationFrame(scroll)
    const second = requestAnimationFrame(() => requestAnimationFrame(scroll))
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [thread?.id])

  useEffect(() => {
    const node = inputRef.current
    if (!node) return
    const base = 48
    const max = Math.round(base * 2.5)
    node.style.height = 'auto'
    node.style.height = `${Math.min(Math.max(node.scrollHeight, base), max)}px`
    node.style.overflowY = node.scrollHeight > max ? 'auto' : 'hidden'
  }, [input])

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const resolved = appearance.theme === 'system' ? (media.matches ? 'light' : 'dark') : appearance.theme
      root.dataset.theme = resolved
      setResolvedTheme(resolved)
    }
    apply()
    root.dataset.density = appearance.density
    root.dataset.reduceMotion = String(appearance.reduceMotion)
    root.dataset.accent = appearance.accent
    root.dataset.fontFamily = appearance.fontFamily
    root.style.setProperty('--font-size', `${appearance.fontSize}px`)
    root.style.setProperty('--code-font-size', `${appearance.codeFontSize}px`)
    const background = appearance.background
    if (background.image) {
      root.style.setProperty('--bg-image', `url(${JSON.stringify(background.image)})`)
      root.style.setProperty('--bg-image-opacity', String(background.opacity))
      root.dataset.background = 'true'
    } else {
      root.style.removeProperty('--bg-image')
      root.style.removeProperty('--bg-image-opacity')
      root.dataset.background = 'false'
    }
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [appearance])

  const toggleTheme = async () => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark'
    await call(() => api.saveSettings({ ...state.settings, appearance: { ...state.settings.appearance, theme: next } }), tr('切换主题失败，请重试。'))
  }

  const setUiLanguage = useCallback((uiLanguage: (typeof uiLanguages)[number]) => {
    setState((current) => ({ ...current, settings: { ...current.settings, general: { ...current.settings.general, uiLanguage } } }))
    void api.saveSettings({ ...state.settings, general: { ...state.settings.general, uiLanguage } }).catch(() => { /* 忽略保存失败 */ })
  }, [state.settings])

  useEffect(() => {
    const previous = lastStatus.current
    const next: Record<string, string> = {}
    for (const item of state.threads) {
      next[item.id] = item.status
      const before = previous[item.id]
      if (before !== 'running' || item.status === 'running') continue
      if (sound.enabled) {
        const cue = item.status === 'awaiting-approval' ? (sound.onApproval ? 'approval' : null)
          : item.status === 'awaiting-input' ? (sound.onQuestion ? 'question' : null)
            : (sound.onDone ? 'done' : null)
        if (cue) playCue(cue, sound.volume)
      }
      if (!chat.notifyOnDone) continue
      if (!document.hidden && document.hasFocus()) continue
      if (typeof Notification === 'undefined') continue
      const body = item.status === 'awaiting-approval' ? tr('「{title}」等待你的审批', { title: item.title }) : item.status === 'awaiting-input' ? tr('「{title}」需要你补充信息', { title: item.title }) : tr('「{title}」已完成回复', { title: item.title })
      try { new Notification('Cubex', { body }) } catch { setError(tr('系统通知发送失败，可在设置中关闭完成通知。')) }
    }
    lastStatus.current = next
  }, [state.threads, chat.notifyOnDone, sound.enabled, sound.onApproval, sound.onQuestion, sound.onDone, sound.volume])

  const newThread = useCallback(() => {
    setThreadId(null)
    setInput('')
    setView('chat')
    setError(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const selectProject = useCallback(async () => {
    if (!isDesktop || actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await api.selectProject()
      if (!result.ok) setError(result.error)
      else if (result.data) {
        setProjectId(result.data.id)
        setThreadId(null)
        setView('chat')
      }
    } catch {
      setError(tr('无法打开项目选择窗口，请重试。'))
    } finally {
      actionLock.current = false
      setBusy(false)
    }
  }, [])

  const send = useCallback(async () => {
    const content = input.trim()
    const attached = images
    if (!project || !isDesktop || !loaded || (!content && attached.length === 0) || actionLock.current) return
    if (!modelId) {
      setError(tr('请先在设置中添加提供商与模型。'))
      return
    }
    actionLock.current = true
    setBusy(true)
    setError(null)
    try {
      let target = thread
      if (!target) {
        const created = await api.createThread({ projectId: project.id, modelId })
        if (!created.ok) { setError(created.error); return }
        target = created.data
        setThreadId(target.id)
      }
      if (target.status === 'idle') {
        const window = model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : 128_000
        let used = 0
        for (let i = target.messages.length - 1; i >= 0; i--) {
          const message = target.messages[i]
          if (message.role === 'assistant' && message.usage) { used = message.usage.input + message.usage.output; break }
        }
        if (used / window >= 0.92) await api.compactThread({ threadId: target.id }).catch(() => undefined)
      }
      const result = await api.sendMessage({ threadId: target.id, content, modelId, ...(attached.length ? { images: attached } : {}) })
      if (!result.ok) setError(result.error)
      else {
        setInput('')
        setImages([])
        if (isActive) ui.toast(tr('已加入队列，当前回复结束后自动发送'), 'success')
      }
    } catch {
      setError(tr('消息未能发送，请重试。'))
    } finally {
      actionLock.current = false
      setBusy(false)
    }
  }, [project, input, images, loaded, thread, modelId, isActive, ui])

  const answer = useCallback(async (question: PendingQuestion, value: string) => {
    if (!thread) return
    try {
      const result = await api.answerQuestion({ threadId: thread.id, callId: question.callId, answer: value })
      if (!result.ok) setError(result.error)
    } catch { setError(tr('回答未能提交，请重试。')) }
  }, [thread])

  const dequeue = async (queuedId: string) => {
    if (!thread) return
    try {
      const result = await api.dequeueMessage({ threadId: thread.id, queuedId })
      if (!result.ok) setError(result.error)
    } catch { setError(tr('移除排队消息失败，请重试。')) }
  }

  const attachFiles = async () => {
    if (!project || !isDesktop) return
    try {
      const result = await api.pickFiles({ projectId: project.id })
      if (!result.ok) { setError(result.error); return }
      if (result.data.length === 0) return
      const mention = result.data.map((path) => `@${path}`).join(' ')
      setInput((current) => current ? `${current.replace(/\s*$/, '')} ${mention} ` : `${mention} `)
      requestAnimationFrame(() => inputRef.current?.focus())
    } catch { setError(tr('无法打开文件选择窗口，请重试。')) }
  }

  const addImageFiles = useCallback(async (files: File[]) => {
    const pics = files.filter((file) => /^image\/(png|jpe?g|gif|webp)$/.test(file.type))
    if (pics.length === 0) return
    const loaded = await Promise.all(pics.map((file) => new Promise<MessageImage | null>((resolve) => {
      if (file.size > 10 * 1024 * 1024) { resolve(null); return }
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? { dataUrl: reader.result, name: file.name } : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })))
    const valid = loaded.filter((item): item is MessageImage => item !== null)
    if (valid.length < pics.length) setError(tr('部分图片过大（超过 10MB）或读取失败，已忽略。'))
    if (valid.length === 0) return
    setImages((current) => [...current, ...valid].slice(0, 8))
  }, [])

  const pickImages = useCallback(() => {
    const picker = document.createElement('input')
    picker.type = 'file'
    picker.accept = 'image/png,image/jpeg,image/gif,image/webp'
    picker.multiple = true
    picker.onchange = () => { void addImageFiles(Array.from(picker.files ?? [])) }
    picker.click()
  }, [addImageFiles])

  const removeImage = useCallback((index: number) => setImages((current) => current.filter((_, i) => i !== index)), [])

  const addToChat = useCallback((text: string) => {
    const snippet = text.trim()
    if (!snippet) return
    setView('chat')
    setInput((current) => current ? `${current.replace(/\s*$/, '')}\n\n${snippet}` : snippet)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length) })
    ui.toast(tr('已添加到对话输入框'), 'success')
  }, [ui])

  const onSpeechText = useCallback((text: string) => {
    setInput((current) => (current ? `${current}${current.endsWith(' ') || current.endsWith('\n') ? '' : ' '}${text}` : text))
  }, [])
  const onSpeechError = useCallback((message: string) => ui.toast(message, 'error'), [ui])
  const speech = useSpeech(general.uiLanguage, onSpeechText, onSpeechError)
  const toggleListening = speech.toggle

  const changeApprovalMode = async (mode: Settings['approvalMode']) => {
    if (mode === state.settings.approvalMode) return
    await call(() => api.saveSettings({ ...state.settings, approvalMode: mode }), tr('切换审批模式失败，请重试。'))
  }

  const cancel = async () => {
    if (!thread) return
    try {
      const result = await api.cancelThread({ threadId: thread.id })
      if (!result.ok) setError(result.error)
    } catch { setError(tr('停止失败，请重试。')) }
  }

  const call = useCallback(async (run: () => Promise<{ ok: true } | { ok: false; error: string }>, fallback: string, success?: string) => {
    try {
      const result = await run()
      if (!result.ok) { ui.toast(result.error, 'error'); return false }
      if (success) ui.toast(success, 'success')
      return true
    } catch {
      ui.toast(fallback, 'error')
      return false
    }
  }, [ui])

  const removeThread = async (item: Thread) => {
    if (general.confirmDelete && !(await ui.confirm({ title: tr('删除任务'), message: tr('确定删除任务「{title}」？对话记录将无法恢复，项目文件不受影响。', { title: item.title }), confirmLabel: tr('删除'), danger: true }))) return
    if (await call(() => api.deleteThread({ threadId: item.id }), tr('删除失败，请重试。'), tr('任务已删除')) && threadId === item.id) setThreadId(null)
  }

  const messageActions = useMemo<MessageAction>(() => ({
    regenerate: (messageId: string) => {
      if (!threadId) return
      void call(() => api.regenerateMessage({ threadId, messageId, ...(modelOverride ? { modelId: modelOverride } : {}) }), tr('重新生成失败，请重试。'))
    },
    rollback: (messageId: string) => {
      if (!threadId) return
      void (async () => {
        if (general.confirmDelete && !(await ui.confirm({ title: tr('回退对话'), message: tr('将删除这条消息及其之后的所有内容，回到发送前的状态，无法恢复。'), confirmLabel: tr('回退'), danger: true }))) return
        await call(() => api.rollbackMessage({ threadId, messageId }), tr('回退失败，请重试。'), tr('已回退'))
      })()
    },
    remove: (messageId: string) => {
      if (!threadId) return
      void (async () => {
        if (general.confirmDelete && !(await ui.confirm({ title: tr('删除消息'), message: tr('确定删除这条消息？无法恢复。'), confirmLabel: tr('删除'), danger: true }))) return
        await call(() => api.deleteMessage({ threadId, messageId }), tr('删除失败，请重试。'), tr('消息已删除'))
      })()
    },
  }), [threadId, modelOverride, general.confirmDelete, call, ui, tr])

  const renameThread = async (item: Thread) => {
    const title = await ui.prompt({ title: tr('重命名任务'), value: item.title, placeholder: tr('任务名称'), confirmLabel: tr('保存'), maxLength: 120 })
    if (title && title !== item.title) await call(() => api.updateThread({ threadId: item.id, title }), tr('重命名失败，请重试。'))
  }

  const removeProject = async (item: Project) => {
    const count = threadsByProject.get(item.id)?.length ?? 0
    if (!(await ui.confirm({ title: tr('移除项目'), message: count ? tr('确定从 Cubex 中移除「{name}」及其 {count} 个任务？本地文件夹不会被删除。', { name: item.name, count }) : tr('确定从 Cubex 中移除「{name}」？本地文件夹不会被删除。', { name: item.name }), confirmLabel: tr('移除'), danger: true }))) return
    if (await call(() => api.deleteProject({ projectId: item.id }), tr('移除项目失败，请重试。'), tr('项目已移除')) && project?.id === item.id) { setProjectId(null); setThreadId(null) }
  }

  const renameProject = async (item: Project) => {
    const name = await ui.prompt({ title: tr('重命名项目'), message: tr('仅修改在 Cubex 中显示的名称，不会改动文件夹。'), value: item.name, confirmLabel: tr('保存'), maxLength: 120 })
    if (name && name !== item.name) await call(() => api.updateProject({ projectId: item.id, name }), tr('重命名失败，请重试。'))
  }

  const archiveProject = async (item: Project) => {
    if (await call(() => api.updateProject({ projectId: item.id, archived: true }), tr('归档失败，请重试。'), tr('已归档「{name}」，可在设置中恢复', { name: item.name })) && project?.id === item.id) { setProjectId(null); setThreadId(null) }
  }

  const newThreadIn = (item: Project) => {
    setProjectId(item.id)
    setCollapsed((current) => ({ ...current, [item.id]: false }))
    newThread()
  }

  const projectMenu = (item: Project): MenuEntry[] => [
    { label: tr('新建任务'), icon: SquarePen, onSelect: () => newThreadIn(item) },
    { label: tr('在资源管理器中打开'), icon: FolderOpen, disabled: !isDesktop, onSelect: () => void call(() => api.revealProject({ projectId: item.id }), tr('无法打开文件夹。')) },
    { label: tr('复制路径'), icon: Copy, onSelect: () => void navigator.clipboard.writeText(item.path).then(() => ui.toast(tr('路径已复制'), 'success'), () => ui.toast(tr('复制失败'), 'error')) },
    'separator',
    { label: tr('重命名'), icon: Pencil, disabled: !isDesktop, onSelect: () => void renameProject(item) },
    { label: tr('归档'), icon: Archive, disabled: !isDesktop, onSelect: () => void archiveProject(item) },
    { label: tr('移除项目'), icon: Trash2, danger: true, disabled: !isDesktop, onSelect: () => void removeProject(item) },
  ]

  const threadMenu = (item: Thread): MenuEntry[] => [
    { label: item.pinned ? tr('取消置顶') : tr('置顶任务'), icon: item.pinned ? PinOff : Pin, disabled: !isDesktop, onSelect: () => void call(() => api.updateThread({ threadId: item.id, pinned: !item.pinned }), tr('操作失败，请重试。')) },
    { label: tr('重命名'), icon: Pencil, disabled: !isDesktop, onSelect: () => void renameThread(item) },
    'separator',
    { label: tr('在资源管理器中打开'), icon: FolderOpen, disabled: !isDesktop, onSelect: () => void call(() => api.revealProject({ projectId: item.projectId }), tr('无法打开文件夹。')) },
    { label: tr('文件管理'), icon: FolderTree, disabled: !isDesktop, onSelect: () => void call(() => api.revealProject({ projectId: item.projectId }), tr('无法打开文件夹。')) },
    { label: tr('分享为图片'), icon: Image, disabled: !isDesktop, onSelect: () => void (async () => {
      try {
        const result = await api.shareThreadImage({ threadId: item.id })
        if (!result.ok) ui.toast(result.error, 'error')
        else if (result.data) ui.toast(tr('长图已保存并复制到剪贴板'), 'success')
      } catch { ui.toast(tr('生成分享图片失败，请重试。'), 'error') }
    })() },
    { label: tr('导出 Markdown'), icon: FileDown, disabled: !isDesktop, onSelect: () => void (async () => {
      try {
        const result = await api.exportThread({ threadId: item.id })
        if (!result.ok) ui.toast(result.error, 'error')
        else if (result.data) ui.toast(tr('已导出任务记录'), 'success')
      } catch { ui.toast(tr('导出失败，请重试。'), 'error') }
    })() },
    'separator',
    { label: tr('删除任务'), icon: Trash2, danger: true, disabled: !isDesktop, onSelect: () => void removeThread(item) },
  ]

  const windowAction = (action: 'minimize' | 'maximize' | 'close') => {
    if (action === 'maximize' && !isDesktop) setMaximized((value) => !value)
    void api.windowControl(action).catch(() => undefined)
  }

  useEffect(() => {
    if (!error) return
    ui.toast(error, 'error')
    setError(null)
  }, [error, ui])

  const shownNoticeRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isDesktop || !state.notice) return
    if (shownNoticeRef.current === state.notice) return
    shownNoticeRef.current = state.notice
    ui.toast(state.notice, 'info')
  }, [state.notice, ui])

  const resolve = async (approved: boolean) => {
    if (!thread?.pending) return
    try {
      const result = await api.resolveApproval({ threadId: thread.id, callId: thread.pending.callId, approved })
      if (!result.ok) setError(result.error)
    } catch { setError(tr('审批失败，请重试。')) }
  }

  const stopControl = useCallback(async () => {
    if (!control.active) return
    try {
      const result = await api.cancelThread({ threadId: control.threadId })
      if (!result.ok) setError(result.error)
    } catch { setError(tr('结束操控失败，请重试。')) }
  }, [control, tr])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && work.escToStopControl && control.active && !event.defaultPrevented) {
        event.preventDefault()
        void stopControl()
        return
      }
      if (event.key === 'Escape' && view === 'settings' && !event.defaultPrevented) {
        event.preventDefault()
        setView('chat')
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void selectProject()
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        newThread()
      } else if (event.key === ',') {
        event.preventDefault()
        setView((current) => current === 'settings' ? 'chat' : 'settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectProject, newThread, view, control, work.escToStopControl, stopControl])

  const composerDisabled = !project || busy || !isDesktop
  const canSend = !composerDisabled && (input.trim().length > 0 || images.length > 0) && !!modelId && (thread?.queue?.length ?? 0) < 20
  const awaitingInput = thread?.status === 'awaiting-input' && !!thread.question
  const ctrlSend = chat.sendKey === 'ctrl-enter'
  const sendLabel = ctrlSend ? 'Ctrl Enter' : 'Enter'
  const showSidebar = sidebarOpen && view !== 'settings'
  const panelMode = view === 'chat' || view === 'work'
  const showRightPanel = rightPanelOpen && view === 'chat' && !panelDetached

  if (detachedThreadId) {
    const panelThread = state.threads.find((item) => item.id === detachedThreadId) ?? null
    const panelProject = panelThread ? state.projects.find((item) => item.id === panelThread.projectId) ?? null : null
    return (
      <LanguageContext.Provider value={uiLang}>
      <OpenTargetContext.Provider value={requestOpen}>
      <div className={`shell panel-shell${focused ? '' : ' blurred'}`}>
        <div className="main-shell">
          <header className="titlebar panel-titlebar">
            <div className="titlebar-context"><Logo size={18} rounded /><span className="view-label truncate">{panelThread ? panelThread.title : tr('任务面板')}</span></div>
            <div className="titlebar-actions">
              <div className="window-controls" role="group" aria-label={tr('窗口控制')}>
                <button className="window-button" aria-label={tr('最小化')} title={tr('最小化')} onClick={() => windowAction('minimize')}><Minus size={15} /></button>
                <button className="window-button close" aria-label={tr('关闭')} title={tr('关闭')} onClick={() => windowAction('close')}><X size={15} /></button>
              </div>
            </div>
          </header>
          {!loaded ? <div className="loading-state" role="status"><LoaderCircle size={22} className="spin" />{tr('正在加载…')}</div>
            : panelThread ? <Suspense fallback={panelFallback}><RightPanel thread={panelThread} project={panelProject} detached onError={setError} openRequest={openRequest} contextWindow={models.find((item) => item.id === panelThread.modelId)?.contextWindow} /></Suspense>
            : <div className="right-panel-empty panel-shell-empty"><Logo size={30} /><span>{tr('该任务已被删除，可以关闭此窗口。')}</span></div>}
        </div>
      </div>
      </OpenTargetContext.Provider>
      </LanguageContext.Provider>
    )
  }

  return (
    <LanguageContext.Provider value={uiLang}>
    <OpenTargetContext.Provider value={requestOpen}>
    <div className={`shell${showSidebar ? '' : ' sidebar-collapsed'}${maximized ? ' maximized' : ''}${focused ? '' : ' blurred'}`}>
      {showSidebar && (
        <aside className="sidebar" aria-label={tr('工作区导航')}>
          <div className="sidebar-brand">
            <Logo className="brand-icon" size={24} />
            <span>Cubex<span className="brand-suffix">Desktop</span></span>
            <button className="icon-button sidebar-toggle" aria-label={tr('收起侧栏')} title={tr('收起侧栏')} onClick={() => setSidebarOpen(false)}><PanelLeft size={17} /></button>
          </div>
          <button className="nav-action new-task" onClick={newThread} aria-current={view === 'chat' && !thread ? 'page' : undefined}>
            <SquarePen size={17} /><span>{t('nav.newTask')}</span><kbd>Ctrl N</kbd>
          </button>
          <nav className="sidebar-scroll" aria-label={tr('项目与任务')}>
            <div className="section-head"><span>{t('nav.projects')}</span><button className="icon-button" aria-label={t('nav.addProject')} title={isDesktop ? `${t('nav.addProject')} · Ctrl O` : tr('请在桌面应用中添加项目')} disabled={busy || !isDesktop} onClick={() => void selectProject()}><Plus size={15} /></button></div>
            <ul className="project-list">
              {visibleProjects.map((item) => {
                const list = threadsByProject.get(item.id) ?? []
                const open = !collapsed[item.id]
                return (
                  <li key={item.id} className="project-group">
                    <div className="project-row" onContextMenu={(event) => { event.preventDefault(); ui.openMenu({ x: event.clientX, y: event.clientY }, projectMenu(item)) }}>
                      <button className="nav-row" aria-current={project?.id === item.id && !thread ? 'true' : undefined} aria-expanded={open} title={item.path} onClick={() => { if (project?.id === item.id && !thread) setCollapsed((current) => ({ ...current, [item.id]: open })); else { setProjectId(item.id); setCollapsed((current) => ({ ...current, [item.id]: false })) } setThreadId(null); setView((current) => current === 'work' ? 'work' : 'chat') }}>
                        <span className={`chevron${open ? ' open' : ''}`}><ChevronRight size={12} /></span>
                        {open ? <FolderOpen size={15} /> : <Folder size={15} />}<span className="truncate">{item.name}</span>
                        {list.length > 0 && <span className="subtle-count">{list.length}</span>}
                      </button>
                      <button className="icon-button row-action" aria-label={tr('在 {name} 中新建任务', { name: item.name })} title={tr('新建任务')} onClick={() => newThreadIn(item)}><SquarePen size={13} /></button>
                      <button className="icon-button row-action" aria-label={tr('{name} 更多操作', { name: item.name })} title={tr('更多操作')} onClick={(event) => ui.openMenu(event.currentTarget, projectMenu(item))}><Ellipsis size={14} /></button>
                    </div>
                    {open && (
                      <ul className="task-list">
                        {list.map((task) => (
                          <li key={task.id} className="thread-item" onContextMenu={(event) => { event.preventDefault(); ui.openMenu({ x: event.clientX, y: event.clientY }, threadMenu(task)) }}>
                            <button className="nav-row task-row" aria-current={view === 'chat' && thread?.id === task.id ? 'page' : undefined} title={task.title} onClick={() => { setProjectId(task.projectId); setThreadId(task.id); setModelOverride(''); setView('chat') }}>
                              {task.status !== 'idle' ? <LoaderCircle size={14} className="spin" /> : task.pinned ? <Pin size={13} className="pin-mark" /> : <MessageSquare size={14} />}
                              <span className="truncate">{task.title}</span>
                              {task.status === 'awaiting-approval' && <span className="status-pip" title={tr('等待审批')} />}
                              {task.status === 'awaiting-input' && <span className="status-pip input" title={tr('等待补充信息')} />}
                            </button>
                            <button className="icon-button row-action" aria-label={tr('{title} 更多操作', { title: task.title })} title={tr('更多操作')} onClick={(event) => ui.openMenu(event.currentTarget, threadMenu(task))}><Ellipsis size={14} /></button>
                          </li>
                        ))}
                        {list.length === 0 && <li className="sidebar-empty nested">{tr('暂无任务')}</li>}
                      </ul>
                    )}
                  </li>
                )
              })}
              {visibleProjects.length === 0 && <li className="sidebar-empty">{tr('打开本地文件夹，')}<br />{tr('在这里管理你的项目。')}</li>}
            </ul>
          </nav>
          <div className="sidebar-bottom">
            <button className="nav-action" onClick={() => setView('settings')}><Settings2 size={17} /><span>{tr('设置')}</span><kbd>Ctrl ,</kbd></button>
            <div className="workspace-identity"><span className="identity-mark">C</span><div><strong>{tr('本地工作区')}</strong><span>{tr(approvalLabels[state.settings.approvalMode].name)}</span></div><ShieldCheck size={16} /></div>
          </div>
        </aside>
      )}

      <div className="main-shell">
        <header className="titlebar" onDoubleClick={(event) => { if (event.target === event.currentTarget) windowAction('maximize') }}>
          <div className="titlebar-context">
            {!sidebarOpen && view !== 'settings' && <button className="icon-button" aria-label={tr('展开侧栏')} title={tr('展开侧栏')} onClick={() => setSidebarOpen(true)}><PanelLeft size={18} /></button>}
            <span className="view-label truncate">{view === 'settings' ? tr('设置') : view === 'work' ? tr('工作流') : thread ? thread.title : tr('新建任务')}</span>
            {project && view !== 'settings' && <><ChevronRight size={13} /><span className="context-project truncate" title={project.path}>{project.name}</span></>}
          </div>
          <div className="titlebar-actions">
            {view !== 'settings' && (
              <div className="mode-switch" role="radiogroup" aria-label={tr('工作模式')}>
                <button role="radio" aria-checked={view === 'chat'} className={view === 'chat' ? 'active' : ''} title={tr('Code：对话式编码')} onClick={() => setView('chat')}><CodeXml size={14} />Code</button>
                <button role="radio" aria-checked={view === 'work'} className={view === 'work' ? 'active' : ''} title={tr('Work：画布工作流')} onClick={() => setView('work')}><Workflow size={14} />Work</button>
              </div>
            )}
            {!isDesktop && <span className="preview-badge" title={state.notice}>{tr('浏览器预览')}</span>}
            <button className="icon-button" aria-label={resolvedTheme === 'dark' ? tr('切换到浅色') : tr('切换到深色')} title={resolvedTheme === 'dark' ? tr('切换到浅色') : tr('切换到深色')} onClick={() => void toggleTheme()}>{resolvedTheme === 'dark' ? <Sun size={17} /> : <Moon size={16} />}</button>
            {thread && panelMode && <button className="icon-button" aria-label={tr('任务操作')} title={tr('任务操作')} onClick={(event) => ui.openMenu(event.currentTarget, threadMenu(thread))}><Ellipsis size={16} /></button>}
            {panelMode && (panelDetached
              ? <button className="icon-button" aria-label={tr('收回任务面板')} title={tr('收回任务面板')} onClick={() => { void api.closePanelWindow().catch(() => undefined); setRightPanelOpen(true) }}><PanelRight size={17} /></button>
              : <button className="icon-button" aria-label={rightPanelOpen ? tr('收起右栏') : tr('展开右栏')} aria-pressed={rightPanelOpen} title={rightPanelOpen ? tr('收起右栏') : tr('展开右栏')} onClick={() => setRightPanelOpen((value) => !value)}><PanelRight size={17} /></button>)}
            <div className="window-controls" role="group" aria-label={tr('窗口控制')}>
              <button className="window-button" aria-label={tr('最小化')} title={tr('最小化')} onClick={() => windowAction('minimize')}><Minus size={15} /></button>
              <button className="window-button" aria-label={maximized ? tr('还原') : tr('最大化')} title={maximized ? tr('还原') : tr('最大化')} onClick={() => windowAction('maximize')}>{maximized ? <Copy size={12} /> : <Maximize2 size={13} />}</button>
              <button className="window-button close" aria-label={tr('关闭')} title={tr('关闭')} onClick={() => windowAction('close')}><X size={15} /></button>
            </div>
          </div>
        </header>

        {work.showControlBanner && control.active && (
          <div className={`control-banner ${control.kind}`} role="alert">
            <div className="control-banner-body">
              {control.kind === 'computer' ? <Hand size={16} /> : <Globe size={16} />}
              <div><strong>{control.kind === 'computer' ? tr('正在操控电脑') : tr('正在操控浏览器')}</strong><span>{control.label}</span></div>
            </div>
            {work.escToStopControl && (
              <button className="control-banner-stop" onClick={() => void stopControl()}><OctagonX size={14} />{tr('结束操控')} <kbd>Esc</kbd></button>
            )}
          </div>
        )}

        <div className="workspace">
          {view === 'settings' ? <Suspense fallback={panelFallback}><SettingsPanel settings={state.settings} projects={state.projects} workflows={state.workflows ?? []} onError={setError} initialSection={settingsSection} onClose={() => { setSettingsSection(undefined); setView('chat'); reloadSkills() }} /></Suspense>
            : view === 'work' ? <main className="center is-work">{loaded ? <Suspense fallback={panelFallback}><WorkflowCanvas project={project} workflows={state.workflows ?? []} settings={state.settings} panelOpen={rightPanelOpen && !panelDetached} onError={setError} onOpenThread={(id) => { setThreadId(id); setModelOverride(''); setView('chat') }} onToggleAutoSwitch={(value) => void call(() => api.saveSettings({ ...state.settings, work: { ...state.settings.work, autoSwitchToChat: value } }), tr('保存设置失败，请重试。'))} /></Suspense> : <div className="loading-state" role="status"><LoaderCircle size={22} className="spin" />{tr('正在打开工作区…')}</div>}</main> : (
            <main className={`center${thread ? ' has-task' : ' is-home'}`}>
              {!loaded ? <div className="loading-state" role="status"><LoaderCircle size={22} className="spin" />{tr('正在打开工作区…')}</div> : (
                <>
                  {thread ? (
                    <div className="center-scroll" ref={scrollRef}>
                      <div className="content-column conversation">
                        {thread.messages.map((message) => <MessageView key={message.id} message={message} stream={streams[message.id]} modelName={models.find((item) => item.id === (message.role === 'assistant' ? message.modelId : ''))?.name} showUsage={chat.showUsage} expandTools={chat.expandTools} canEdit={thread.status === 'idle'} actions={messageActions} />)}
                        {thread.status === 'running' && !thread.messages.some((message) => message.role === 'assistant' && message.content === '' && streams[message.id]) && thread.messages[thread.messages.length - 1]?.role !== 'assistant' && (
                          <ActivityIndicator activity={activities[thread.id]} fallback={tr('正在思考…')} />
                        )}
                        {thread.status === 'awaiting-approval' && thread.pending && (
                          <div className="approval-bar" role="alertdialog" aria-label={tr('等待审批')}>
                            <div className="approval-body">
                              <ShieldCheck size={16} />
                              <div><strong>{tr('助手请求：{summary}', { summary: thread.pending.summary })}</strong><span>{approvalDetail[thread.pending.name] ? tr(approvalDetail[thread.pending.name]!) : tr('将修改项目中的文件')}</span></div>
                            </div>
                            <div className="approval-actions">
                              <button className="btn-secondary" onClick={() => void resolve(false)}><X size={14} />{tr('拒绝')}</button>
                              <button className="btn-primary" onClick={() => void resolve(true)}><Check size={14} />{tr('批准')}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="welcome content-column">
                      <div className="welcome-mark" aria-hidden="true"><Logo size={48} /></div>
                      <h1>{project ? tr('准备好，开始新的会话。') : tr('从一个项目开始。')}</h1>
                      <p>{project ? tr('在 {name} 中与 Cubex 协作：读代码、改文件、跑命令。', { name: project.name }) : tr('打开你的项目，让思路在这里继续。')}</p>
                    </div>
                  )}
                  <div className="composer-area content-column">
                    {thread && (thread.queue?.length ?? 0) > 0 && (
                      <ul className="queue-list" aria-label={tr('排队消息')}>
                        {thread.queue!.map((item, index) => (
                          <li key={item.id} className="queue-item">
                            <ListOrdered size={13} /><span className="queue-index">{index + 1}</span><span className="truncate" title={item.content}>{item.content}</span>
                            <button className="icon-button" aria-label={tr('移除排队消息')} title={tr('移除')} onClick={() => void dequeue(item.id)}><X size={13} /></button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="composer-stack">
                      {thread && (thread.todos?.length ?? 0) > 0 && (() => {
                        const todos = thread.todos!
                        const done = todos.filter((item) => item.status === 'done').length
                        return (
                          <div className="todo-track" role="group" aria-label={tr('任务待办进度 {done}/{total}', { done, total: todos.length })}>
                            <span className="todo-track-count">{done}/{todos.length}</span>
                            <div className="todo-track-dots">
                              {todos.map((item, index) => (
                                <span key={item.id} className={`todo-dot ${item.status}`} tabIndex={0} title={tr('{index}. {content}（{status}）', { index: index + 1, content: item.content, status: item.status === 'done' ? tr('已完成') : item.status === 'active' ? tr('进行中') : tr('待办') })} aria-label={tr('第 {index} 项：{content}', { index: index + 1, content: item.content })} />
                              ))}
                            </div>
                          </div>
                        )
                      })()}
                      <form className={`composer${awaitingInput ? ' covered' : ''}`} aria-hidden={awaitingInput || undefined} onSubmit={(event) => { event.preventDefault(); void send() }}
                        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
                        onDrop={(event) => { const files = Array.from(event.dataTransfer.files); if (files.some((file) => file.type.startsWith('image/'))) { event.preventDefault(); void addImageFiles(files) } }}>
                        {images.length > 0 && (
                          <div className="composer-images" role="list" aria-label={tr('待发送图片')}>
                            {images.map((image, index) => (
                              <div className="composer-image" role="listitem" key={`${image.name ?? 'image'}-${index}`}>
                                <img src={image.dataUrl} alt={image.name ?? tr('图片 {index}', { index: index + 1 })} />
                                <button type="button" className="composer-image-remove" aria-label={tr('移除图片')} title={tr('移除图片')} onClick={() => removeImage(index)}><X size={12} /></button>
                              </div>
                            ))}
                          </div>
                        )}
                        {skillQuery !== null && <SkillMenu skills={skills} query={skillQuery} onPick={pickSkill} onClose={() => setSkillQuery(null)} />}
                        <textarea ref={inputRef} aria-label={tr('消息')} aria-describedby="execution-hint" placeholder={project ? (isActive ? tr('继续输入，发送后将排队等待当前回复结束…') : ctrlSend ? tr('描述你想做的事，Ctrl Enter 发送，Enter 换行…') : tr('描述你想做的事，Enter 发送，Shift Enter 换行…') + tr('（输入 / 调用技能）')) : tr('选择项目后开始会话…')} value={input} onChange={(event) => onInputChange(event.target.value)} maxLength={60_000} rows={2} disabled={composerDisabled || awaitingInput}
                          onPaste={(event) => { const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void addImageFiles(files) } }}
                          onKeyDown={(event) => {
                            if (skillQuery !== null && ['Enter', 'ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(event.key)) return
                            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                            const modifier = event.ctrlKey || event.metaKey
                            if (ctrlSend ? modifier : !event.shiftKey && !modifier) { event.preventDefault(); void send() }
                          }} />
                        <div className="composer-toolbar">
                          <button className="composer-project" type="button" onClick={() => void selectProject()} disabled={busy || !isDesktop} title={project?.path ?? (isDesktop ? tr('选择项目 · Ctrl O') : tr('本机目录仅在桌面应用中可用'))}><FolderOpen size={15} /><span className="truncate">{project?.name ?? tr('选择项目')}</span><ChevronDown size={12} /></button>
                          <Select className="composer-model" label={tr('模型')} icon={Cpu} value={modelId} disabled={models.length === 0} onChange={setModelOverride}
                            options={models.map((item) => ({ value: item.id, label: item.name, hint: item.modelId }))} />
                          <Select className="composer-approval" label={tr('审批模式')} icon={ShieldCheck} value={state.settings.approvalMode} disabled={!isDesktop} onChange={(value) => void changeApprovalMode(value as Settings['approvalMode'])}
                            options={approvalModes.map((mode) => ({ value: mode, label: tr(approvalLabels[mode].name), hint: tr(approvalLabels[mode].hint) }))} />
                          <div className="composer-tools" role="group" aria-label={tr('输入工具')}>
                            <button className="icon-button" type="button" aria-label={tr('添加文件')} title={tr('添加项目文件到消息')} disabled={!project || !isDesktop} onClick={() => void attachFiles()}><Paperclip size={16} /></button>
                            <button className="icon-button" type="button" aria-label={tr('添加图片')} title={tr('添加图片（可粘贴或拖拽）')} disabled={!project || !isDesktop || images.length >= 8} onClick={pickImages}><Image size={16} /></button>
                            {(() => {
                              const busySpeech = speech.status === 'loading' || speech.status === 'transcribing'
                              const label = speech.status === 'recording' ? tr('停止语音输入') : speech.status === 'loading' ? tr('正在下载语音模型 {progress}%', { progress: speech.progress }) : speech.status === 'transcribing' ? tr('正在识别语音…') : tr('语音输入')
                              return (
                                <button className={`icon-button${speech.status === 'recording' ? ' listening' : ''}`} type="button" aria-label={label} aria-pressed={speech.status === 'recording'} title={label} disabled={!project || !isDesktop || busySpeech} onClick={toggleListening}>
                                  {busySpeech ? <LoaderCircle size={16} className="spin" /> : speech.status === 'recording' ? <MicOff size={16} /> : <Mic size={16} />}
                                </button>
                              )
                            })()}
                            <button className="icon-button" type="button" aria-label={tr('技能与 MCP')} title={tr('技能与 MCP（在设置中管理）')} onClick={() => { setSettingsSection('skills'); setView('settings') }}><Puzzle size={16} /></button>
                          </div>
                          {isActive ? (
                            <div className="send-group">
                              {input.trim() && <button className="send-button queue" type="submit" aria-label={tr('加入队列')} title={tr('加入队列，当前回复结束后发送')} disabled={!canSend}><ListOrdered size={16} /></button>}
                              <button className="send-button stop" type="button" aria-label={tr('停止回复')} title={tr('停止回复')} onClick={() => void cancel()}><Square size={15} /></button>
                            </div>
                          ) : (
                            <button className="send-button" type="submit" aria-label={tr('发送')} title={tr('发送 · {key}', { key: sendLabel })} disabled={!canSend}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}</button>
                          )}
                        </div>
                      </form>
                      {awaitingInput && thread?.question && <QuestionOverlay key={thread.question.callId} question={thread.question} onAnswer={(value) => void answer(thread.question!, value)} onCancel={() => void cancel()} />}
                    </div>
                    <p className="composer-hint" id="execution-hint">{!isDesktop ? tr('预览模式 · 会话与模型调用需在桌面应用中使用') : models.length === 0 ? tr('尚未配置模型，先到设置中添加提供商与模型。') : isActive ? tr('回复进行中 · 可继续输入补充说明，发送后自动排队') : `${tr(approvalLabels[state.settings.approvalMode].name)} · ${tr(approvalLabels[state.settings.approvalMode].hint)}`}</p>
                    {!thread && <div className="quick-actions">
                      <button onClick={() => setView('settings')}><Cpu size={15} />{models.length === 0 ? t('action.configureModel') : t('action.manageModels')}<ArrowUpRight size={13} /></button>
                    </div>}
                  </div>
                </>
              )}
            </main>
          )}
          {showRightPanel && (
            <Suspense fallback={null}>
            <RightPanel
              thread={thread}
              project={project}
              onDetach={isDesktop && thread ? () => { void api.openPanelWindow({ threadId: thread.id }).then((result) => { if (!result.ok) setError(result.error) }) } : undefined}
              onError={setError}
              onAddToChat={addToChat}
              openRequest={openRequest}
              contextWindow={model?.contextWindow}
            />
            </Suspense>
          )}
        </div>
        <footer className="statusbar"><span><span className={`dot${running ? ' running' : ''}`} />{running ? t('status.running', { n: running }) : t('status.localWorkspace')}</span><span>{model ? model.name : t('status.noModel')}<span className="status-separator">·</span>{isDesktop ? tr(approvalLabels[state.settings.approvalMode].name) : t('status.preview')}</span></footer>
      </div>
      {loaded && showOnboarding && (
        <Onboarding
          uiLanguage={uiLang}
          onLanguage={setUiLanguage}
          onClose={() => { try { localStorage.setItem('cubex.onboarded', '1') } catch { /* 忽略存储失败 */ } setShowOnboarding(false) }}
          onConfigure={() => { try { localStorage.setItem('cubex.onboarded', '1') } catch { /* 忽略存储失败 */ } setShowOnboarding(false); setView('settings'); setSettingsSection('providers') }}
        />
      )}
    </div>
    </OpenTargetContext.Provider>
    </LanguageContext.Provider>
  )
}

const onboardingLangOptions: { value: (typeof uiLanguages)[number]; label: string; sub: string }[] = [
  { value: 'zh-CN', label: '简体中文', sub: 'Simplified Chinese' },
  { value: 'en', label: 'English', sub: '英语' },
]

function Onboarding({ uiLanguage, onLanguage, onClose, onConfigure }: { uiLanguage: (typeof uiLanguages)[number]; onLanguage: (lang: (typeof uiLanguages)[number]) => void; onClose: () => void; onConfigure: () => void }) {
  const { lang, t, tr } = useI18n()
  const [step, setStep] = useState(0)
  const [agreeEula, setAgreeEula] = useState(false)
  const [agreeRegion, setAgreeRegion] = useState(false)
  const [showEula, setShowEula] = useState(false)
  const steps = [
    { icon: <Globe size={34} />, title: t('onboarding.lang.title'), desc: t('onboarding.lang.desc'), kind: 'lang' as const },
    { icon: <Logo size={40} />, title: t('onboarding.s1.title'), desc: t('onboarding.s1.desc'), kind: 'info' as const },
    { icon: <Folder size={34} />, title: t('onboarding.s2.title'), desc: t('onboarding.s2.desc'), kind: 'info' as const },
    { icon: <Workflow size={34} />, title: t('onboarding.s3.title'), desc: t('onboarding.s3.desc'), kind: 'info' as const },
    { icon: <Cpu size={34} />, title: t('onboarding.s4.title'), desc: t('onboarding.s4.desc'), kind: 'agree' as const },
  ]
  const total = steps.length
  const current = steps[step]
  const first = step === 0
  const last = step === total - 1
  const agreed = agreeEula && agreeRegion
  const canNext = !last && (current.kind !== 'agree')
  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label={t('onboarding.lang.title')}>
      <div className="onboarding-card">
        <div className="onboarding-head">
          <span className="onboarding-step">{t('onboarding.step', { n: step + 1, total })}</span>
          {!last && <button className="icon-button onboarding-skip" type="button" aria-label={t('onboarding.skip')} title={t('onboarding.skip')} onClick={onClose}><X size={16} /></button>}
        </div>
        <div className="onboarding-body">
          <div className="onboarding-icon">{current.icon}</div>
          <h2 className="onboarding-title">{current.title}</h2>
          <p className="onboarding-desc">{current.desc}</p>
          {current.kind === 'lang' && (
            <div className="onboarding-lang">
              {onboardingLangOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`onboarding-lang-item${uiLanguage === option.value ? ' active' : ''}`}
                  onClick={() => onLanguage(option.value)}
                >
                  <span className="onboarding-lang-main">{tr(option.label)}</span>
                  <span className="onboarding-lang-sub">{tr(option.sub)}</span>
                  {uiLanguage === option.value && <Check size={16} className="onboarding-lang-check" />}
                </button>
              ))}
            </div>
          )}
          {current.kind === 'agree' && (
            <div className="onboarding-agree">
              <label className="onboarding-check">
                <input type="checkbox" checked={agreeEula} onChange={(event) => setAgreeEula(event.target.checked)} />
                <span>{t('onboarding.agree.eula')}</span>
              </label>
              <label className="onboarding-check">
                <input type="checkbox" checked={agreeRegion} onChange={(event) => setAgreeRegion(event.target.checked)} />
                <span>{t('onboarding.agree.region')}</span>
              </label>
              <button type="button" className="onboarding-eula-link" onClick={() => setShowEula(true)}>{t('onboarding.viewEula')}</button>
            </div>
          )}
        </div>
        <div className="onboarding-dots" aria-hidden="true">
          {steps.map((_, index) => <span key={index} className={`onboarding-dot${index === step ? ' active' : ''}`} />)}
        </div>
        <div className="onboarding-actions">
          <button type="button" className="onboarding-btn ghost" disabled={first} onClick={() => setStep((value) => Math.max(0, value - 1))}>{t('onboarding.prev')}</button>
          <div className="onboarding-actions-right">
            {last
              ? <>
                  <button type="button" className="onboarding-btn ghost" disabled={!agreed} title={agreed ? undefined : t('onboarding.mustAgree')} onClick={onClose}>{t('onboarding.start')}</button>
                  <button type="button" className="onboarding-btn primary" disabled={!agreed} title={agreed ? undefined : t('onboarding.mustAgree')} onClick={onConfigure}>{t('onboarding.configure')}</button>
                </>
              : <button type="button" className="onboarding-btn primary" disabled={!canNext} onClick={() => setStep((value) => value + 1)}>{t('onboarding.next')}</button>}
          </div>
        </div>
      </div>
      {showEula && (
        <div className="eula-overlay" role="dialog" aria-modal="true" aria-label={t('eula.title')} onClick={() => setShowEula(false)}>
          <div className="eula-card" onClick={(event) => event.stopPropagation()}>
            <div className="eula-head"><h3>{t('eula.title')}</h3><button className="icon-button" type="button" aria-label={t('eula.close')} onClick={() => setShowEula(false)}><X size={16} /></button></div>
            <pre className="eula-body">{eulaText(lang)}</pre>
            <div className="eula-foot"><button type="button" className="onboarding-btn primary" onClick={() => setShowEula(false)}>{t('eula.close')}</button></div>
          </div>
        </div>
      )}
    </div>
  )
}

function QuestionOverlay({ question, onAnswer, onCancel }: { question: PendingQuestion; onAnswer: (value: string) => void; onCancel: () => void }) {
  const { tr } = useI18n()
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const options = question.options ?? []
  const hasOptions = options.length > 0

  useEffect(() => { if (!hasOptions) requestAnimationFrame(() => inputRef.current?.focus()) }, [hasOptions])

  const submit = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || submitted) return
    setSubmitted(true)
    onAnswer(trimmed)
  }

  const compose = () => {
    const extra = text.trim()
    if (selected.length === 0) return extra
    const picked = selected.join('、')
    return extra ? `${picked}；补充：${extra}` : picked
  }

  const pick = (option: string) => {
    if (question.multiple) {
      setSelected((current) => current.includes(option) ? current.filter((item) => item !== option) : [...current, option])
    } else {
      submit(option)
    }
  }

  return (
    <div className="question-overlay" role="dialog" aria-modal="true" aria-label={tr('助手需要更多信息')}>
      <div className="question-head">
        <MessageCircleQuestion size={17} />
        <div className="question-text"><strong>{tr('助手需要你补充信息')}</strong><Markdown source={question.question} /></div>
        <button className="icon-button" type="button" aria-label={tr('停止本次任务')} title={tr('停止本次任务')} onClick={onCancel}><X size={15} /></button>
      </div>
      {hasOptions && (
        <div className="question-options" role={question.multiple ? 'group' : 'radiogroup'}>
          {options.map((option) => (
            <button key={option} type="button" className={`question-option${selected.includes(option) ? ' selected' : ''}`} aria-pressed={question.multiple ? selected.includes(option) : undefined} disabled={submitted} onClick={() => pick(option)}>
              {question.multiple && <span className="option-check">{selected.includes(option) && <Check size={12} />}</span>}
              <span>{option}</span>
            </button>
          ))}
        </div>
      )}
      <form className="question-form" onSubmit={(event) => { event.preventDefault(); submit(compose()) }}>
        <textarea ref={inputRef} aria-label={tr('回答')} rows={2} maxLength={4000} value={text} disabled={submitted} placeholder={hasOptions ? (question.multiple ? tr('可多选上方选项，也可在此补充说明…') : tr('或在此直接输入其他回答…')) : tr('输入你的回答，Enter 提交，Shift Enter 换行…')} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(compose()) } }} />
        <button className="btn-primary" type="submit" disabled={submitted || !compose()}>{submitted ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{tr('提交回答')}</button>
      </form>
    </div>
  )
}

type MessageAction = { regenerate: (id: string) => void; rollback: (id: string) => void; remove: (id: string) => void }
type MessageViewProps = { message: Message; stream?: string; modelName?: string; showUsage: boolean; expandTools: boolean; canEdit: boolean; actions: MessageAction }

// 状态经 IPC 推送后对象引用每次都会变化。用关键字段浅比较代替昂贵的 JSON.stringify 深比较，
// 避免任意后台任务的一次状态广播就让当前会话所有消息重新序列化。
function sameMessage(a: Message, b: Message): boolean {
  if (a === b) return true
  if (a.role !== b.role || a.id !== b.id || a.time !== b.time) return false
  if (a.role === 'assistant' && b.role === 'assistant') {
    if (a.content !== b.content) return false
    if (a.toolCalls.length !== b.toolCalls.length) return false
    for (let i = 0; i < a.toolCalls.length; i += 1) {
      if (a.toolCalls[i].id !== b.toolCalls[i].id || a.toolCalls[i].name !== b.toolCalls[i].name) return false
    }
    const au = a.usage, bu = b.usage
    if ((au?.input ?? -1) !== (bu?.input ?? -1) || (au?.output ?? -1) !== (bu?.output ?? -1)) return false
    return true
  }
  if (a.role === 'tool' && b.role === 'tool') {
    if (a.results.length !== b.results.length) return false
    for (let i = 0; i < a.results.length; i += 1) {
      if (a.results[i].callId !== b.results[i].callId || a.results[i].ok !== b.results[i].ok || a.results[i].output !== b.results[i].output || a.results[i].diff !== b.results[i].diff || a.results[i].image !== b.results[i].image) return false
    }
    return true
  }
  if ((a.role === 'user' && b.role === 'user') || (a.role === 'system' && b.role === 'system')) {
    return a.content === b.content
  }
  return false
}

const sameMessageProps = (prev: MessageViewProps, next: MessageViewProps) =>
  prev.stream === next.stream && prev.modelName === next.modelName && prev.showUsage === next.showUsage && prev.expandTools === next.expandTools && prev.canEdit === next.canEdit
  && sameMessage(prev.message, next.message)

function CopyButton({ text }: { text: string }) {
  const { tr } = useI18n()
  const [done, setDone] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1400) }).catch(() => undefined) }
  return <button type="button" className="msg-action" title={tr('复制')} aria-label={tr('复制')} onClick={copy}>{done ? <Check size={13} /> : <Copy size={13} />}</button>
}

const activityPhaseText: Record<AgentActivity['phase'], string> = {
  thinking: '思考中',
  planning: '规划下一步',
  writing: '撰写回复',
  tool: '执行工具',
  delegating: '协调子智能体',
  waiting: '等待中',
}

function ActivityIndicator({ activity, fallback }: { activity?: AgentActivity; fallback: string }) {
  const { tr } = useI18n()
  const label = activity?.label || fallback
  const phase = activity?.phase ?? 'thinking'
  return (
    <div className={`thinking activity phase-${phase}`} role="status" aria-live="polite">
      <span className="activity-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="activity-text">
        <span className="activity-label">{label}</span>
        {activity?.detail && <span className="activity-detail">{activity.detail}</span>}
      </span>
      <span className="activity-phase">{tr(activityPhaseText[phase])}{typeof activity?.step === 'number' ? tr(' · 第 {step} 步', { step: activity.step }) : ''}</span>
    </div>
  )
}

const MessageView = memo(function MessageView({ message, stream, modelName, showUsage, expandTools, canEdit, actions }: MessageViewProps) {
  const { tr } = useI18n()
  if (message.role === 'user') {
    return (
      <div className="msg user">
        {message.card ? (
          <div className="msg-card"><Workflow size={14} /><div className="msg-card-body"><strong>{message.card.name}</strong><span className="muted">{tr('工作流 · 共 {steps} 步', { steps: message.card.steps })}</span></div></div>
        ) : (
          <>
            {message.images && message.images.length > 0 && (
              <div className="msg-images">
                {message.images.map((image, index) => (
                  <a key={`${image.name ?? 'image'}-${index}`} href={image.dataUrl} target="_blank" rel="noreferrer" title={image.name ?? tr('图片 {index}', { index: index + 1 })}>
                    <img src={image.dataUrl} alt={image.name ?? tr('图片 {index}', { index: index + 1 })} />
                  </a>
                ))}
              </div>
            )}
            {message.content && <div className="bubble">{message.content}</div>}
          </>
        )}
        <div className="msg-toolbar">
          <time>{time(message.time)}</time>
          <CopyButton text={message.content} />
          {canEdit && <button type="button" className="msg-action" title={tr('回退到此消息之前')} aria-label={tr('回退')} onClick={() => actions.rollback(message.id)}><ArrowUp size={13} /></button>}
          {canEdit && <button type="button" className="msg-action danger" title={tr('删除此消息')} aria-label={tr('删除')} onClick={() => actions.remove(message.id)}><Trash2 size={13} /></button>}
        </div>
      </div>
    )
  }
  if (message.role === 'system') {
    return <div className={`msg system ${message.level}`}><CircleHelp size={14} /><span>{message.content}</span></div>
  }
  if (message.role === 'tool') {
    return <div className="msg tool">{message.results.map((result) => <ToolResultCard key={result.callId} result={result} defaultOpen={expandTools} />)}</div>
  }
  const streaming = !message.content && !!stream
  const content = message.content || stream || ''
  return (
    <div className="msg assistant">
      <div className="assistant-head"><span className="result-mark"><Logo size={26} rounded /></span><strong>Cubex</strong>{modelName && <span className="muted">{modelName}</span>}{showUsage && message.usage && <span className="muted">{message.usage.input + message.usage.output} tokens</span>}</div>
      {content && (streaming ? <div className="stream-text">{content}</div> : <Markdown source={content} />)}
      {!content && message.toolCalls.length === 0 && <div className="thinking"><LoaderCircle size={14} className="spin" />{tr('正在生成…')}</div>}
      {message.toolCalls.length > 0 && <div className="tool-calls">{message.toolCalls.map((call) => { const Icon = toolIcon[call.name]; return <ToolCallChip key={call.id} call={call} Icon={Icon} /> })}</div>}
      {content && (
        <div className="msg-toolbar">
          <CopyButton text={content} />
          {canEdit && <button type="button" className="msg-action" title={tr('重新生成')} aria-label={tr('重新生成')} onClick={() => actions.regenerate(message.id)}><LoaderCircle size={13} /></button>}
          {canEdit && <button type="button" className="msg-action danger" title={tr('删除此消息')} aria-label={tr('删除')} onClick={() => actions.remove(message.id)}><Trash2 size={13} /></button>}
        </div>
      )}
    </div>
  )
}, sameMessageProps)

function formatArgs(call: ToolCall): string {
  const args = call.args as Record<string, unknown>
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  return keys.map((key) => {
    const value = args[key]
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return `${key}: ${text}`
  }).join('\n')
}

function ToolCallChip({ call, Icon }: { call: ToolCall; Icon: (typeof toolIcon)[keyof typeof toolIcon] }) {
  const { tr } = useI18n()
  const [open, setOpen] = useState(false)
  const detail = formatArgs(call)
  return (
    <div className={`tool-call${open ? ' open' : ''}`}>
      <button type="button" className="tool-call-head" aria-expanded={detail ? open : undefined} onClick={() => detail && setOpen((value) => !value)} title={detail || undefined}>
        {detail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        <Icon size={13} />
        <span className="truncate">{toolTitle(call, tr)}</span>
      </button>
      {open && detail && <pre className="tool-call-args">{detail}</pre>}
    </div>
  )
}

function ToolResultCard({ result, defaultOpen }: { result: ToolResult; defaultOpen: boolean }) {
  const { tr } = useI18n()
  const [open, setOpen] = useState(defaultOpen)
  const Icon = toolIcon[result.name]
  const status = result.denied ? tr('已拒绝') : result.ok ? tr('完成') : tr('失败')
  return (
    <div className={`tool-card${result.ok ? '' : ' failed'}${result.denied ? ' denied' : ''}`}>
      <button type="button" className="tool-card-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Icon size={13} />
        <span className="truncate">{result.output.split('\n')[0]?.slice(0, 120) || result.name}</span>
        <span className={`tag${result.ok && !result.denied ? ' ok' : ''}`}>{status}</span>
        {result.durationMs !== undefined && <span className="muted">{result.durationMs} ms</span>}
      </button>
      {open && (
        <div className="tool-card-body">
          {result.diff ? <pre className="diff">{result.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>)}</pre> : null}
          <pre className="tool-output">{result.output}</pre>
          {result.image && <a className="tool-image" href={result.image} target="_blank" rel="noreferrer"><img src={result.image} alt={tr('截图')} /></a>}
        </div>
      )}
    </div>
  )
}
