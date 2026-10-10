import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { AppWindow, CircleHelp, Copy, Crosshair, Eye, FileText, GitBranch, Globe, Hourglass, Image, LayoutGrid, LoaderCircle, Maximize, Minus, Monitor, Play, Plus, Puzzle, Redo2, Save, Search, Server, ShieldCheck, Sparkles, StickyNote, Terminal, Trash2, Undo2, Video, Workflow as WorkflowIcon, X, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Project, Settings, Workflow, WorkflowNode, WorkflowNodeKind } from '../../shared/schema'
import { nodeConfigFields } from '../../shared/schema'
import { api, isDesktop } from './bridge'
import { Select, useUi } from './ui'
import { useI18n } from './i18n'

const NODE_W = 220
const NODE_H = 92
const CANVAS_W = 2400
const CANVAS_H = 1600
const ZOOM_MIN = 0.4
const ZOOM_MAX = 1.6

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

const kindMeta: Record<WorkflowNodeKind, { label: string; icon: LucideIcon; hint: string }> = {
  task: { label: '执行', icon: Zap, hint: '让 Cubex 完成一项具体工作' },
  response: { label: '模型回复', icon: WorkflowIcon, hint: '让模型生成最终给用户看的文字回复' },
  image: { label: '图片生成', icon: Image, hint: '使用已配置的图片模型生成图片' },
  video: { label: '视频生成', icon: Video, hint: '使用已配置的视频模型生成视频' },
  check: { label: '检查', icon: ShieldCheck, hint: '运行测试或构建，验证前面步骤的结果' },
  review: { label: '审阅', icon: Eye, hint: '总结并自查前面步骤的产出' },
  note: { label: '备注', icon: StickyNote, hint: '仅作为背景信息，不会被执行' },
  computer: { label: '电脑操控', icon: Monitor, hint: '截屏、输入文字、按键或点击屏幕坐标' },
  browser: { label: '浏览器操控', icon: Globe, hint: '打开网页并提取标题、正文与链接' },
  launch: { label: '打开应用', icon: AppWindow, hint: '启动指定的应用、文件或网址' },
  command: { label: '命令执行', icon: Terminal, hint: '在项目根目录运行 shell 命令' },
  search: { label: '搜索定位', icon: Search, hint: '在项目文件中搜索或列出目录' },
  file: { label: '文件读写', icon: FileText, hint: '读取、创建或编辑项目文件' },
  git: { label: 'Git 提交', icon: GitBranch, hint: '提交并推送改动到 GitHub 仓库' },
  plugin: { label: '插件调用', icon: Puzzle, hint: '调用已安装的插件完成特定任务' },
  mcp: { label: 'MCP 调用', icon: Server, hint: '调用已连接的 MCP 服务器工具' },
  wait: { label: '等待确认', icon: Hourglass, hint: '确认外部条件就绪后再继续' },
  ask: { label: '询问用户', icon: CircleHelp, hint: '向用户提问以确认关键信息' },
}
const kindOf = (node: WorkflowNode): WorkflowNodeKind => node.kind ?? 'task'

type TemplateStep = { title: string; prompt: string; kind?: WorkflowNodeKind }
const templates: { name: string; steps: TemplateStep[] }[] = [
  {
    name: '功能开发',
    steps: [
      { title: '理解需求', prompt: '阅读项目结构和相关代码，明确要实现的功能与边界条件。' },
      { title: '制定方案', prompt: '列出实现步骤与涉及的文件，说明关键取舍。' },
      { title: '编码实现', prompt: '按方案完成修改，保持与现有代码风格一致。' },
      { title: '验证', prompt: '运行测试与构建，修复出现的问题。', kind: 'check' },
      { title: '自查总结', prompt: '回顾所有修改，确认满足需求并总结变更点。', kind: 'review' },
    ],
  },
  {
    name: '问题排查',
    steps: [
      { title: '复现问题', prompt: '根据描述复现问题，记录触发条件与现象。' },
      { title: '定位根因', prompt: '沿调用链排查，找到问题的根本原因并说明依据。' },
      { title: '修复问题', prompt: '实施最小且安全的修复，避免引入新问题。' },
      { title: '回归验证', prompt: '重新执行复现步骤并运行相关测试，确认问题已解决。', kind: 'check' },
    ],
  },
  {
    name: '代码审查',
    steps: [
      { title: '梳理改动', prompt: '列出最近改动的文件与主要内容。' },
      { title: '逐项审查', prompt: '检查正确性、安全性、性能与代码风格问题。', kind: 'review' },
      { title: '输出报告', prompt: '汇总发现的问题，按严重程度排序并给出修复建议。' },
    ],
  },
]

type Translate = (zhText: string, vars?: Record<string, string | number>) => string
const identity: Translate = (zhText) => zhText

const chainWorkflow = (projectId: string, name: string, steps: TemplateStep[], translate: Translate = identity): Workflow => {
  const nodes = steps.map((step, index) => ({ id: uid('node'), title: translate(step.title), prompt: translate(step.prompt), x: 60 + index * 300, y: 120, ...(step.kind ? { kind: step.kind } : {}) }))
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }))
  return { id: uid('wf'), projectId, name, nodes, edges, updatedAt: new Date().toISOString() }
}

const blankWorkflow = (projectId: string, index: number, translate: Translate = identity): Workflow => chainWorkflow(projectId, translate('工作流 {n}', { n: index }), [
  { title: '理解需求', prompt: '阅读项目结构和相关文件，总结需要完成的工作。' },
  { title: '实现并验证', prompt: '根据上一步的结论完成修改，并运行测试或构建验证。' },
], translate)

const reaches = (edges: Workflow['edges'], from: string, target: string): boolean => {
  const stack = [from]
  const seen = new Set<string>()
  while (stack.length) {
    const current = stack.pop()!
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of edges) if (edge.from === current) stack.push(edge.to)
  }
  return false
}

const orderNodes = (workflow: Workflow): WorkflowNode[] => {
  const ids = new Set(workflow.nodes.map((node) => node.id))
  const incoming = new Map<string, number>(workflow.nodes.map((node) => [node.id, 0]))
  const next = new Map<string, string[]>()
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  }
  const byPosition = (a: WorkflowNode, b: WorkflowNode) => a.x - b.x || a.y - b.y
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const ready = workflow.nodes.filter((node) => incoming.get(node.id) === 0).sort(byPosition)
  const ordered: WorkflowNode[] = []
  while (ready.length) {
    const node = ready.shift()!
    ordered.push(node)
    for (const id of next.get(node.id) ?? []) {
      const count = (incoming.get(id) ?? 1) - 1
      incoming.set(id, count)
      if (count === 0) {
        ready.push(nodes.get(id)!)
        ready.sort(byPosition)
      }
    }
  }
  return ordered.length === workflow.nodes.length ? ordered : workflow.nodes
}

const autoLayout = (workflow: Workflow): Workflow => {
  const ordered = orderNodes(workflow)
  const depth = new Map<string, number>()
  for (const node of ordered) {
    let max = 0
    for (const edge of workflow.edges) if (edge.to === node.id && depth.has(edge.from)) max = Math.max(max, (depth.get(edge.from) ?? 0) + 1)
    depth.set(node.id, max)
  }
  const rows = new Map<number, number>()
  const nodes = ordered.map((node) => {
    const column = depth.get(node.id) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return { ...node, x: 60 + column * (NODE_W + 90), y: 80 + row * (NODE_H + 48) }
  })
  return { ...workflow, nodes }
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const bend = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

export function WorkflowCanvas({ project, workflows, settings, panelOpen = true, onOpenThread, onToggleAutoSwitch, onError }: { project: Project | null; workflows: Workflow[]; settings: Settings; panelOpen?: boolean; onOpenThread: (threadId: string) => void; onToggleAutoSwitch: (value: boolean) => void; onError: (message: string) => void }) {
  const ui = useUi()
  const { tr } = useI18n()
  const own = useMemo(() => workflows.filter((item) => item.projectId === project?.id), [workflows, project?.id])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Workflow | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [linking, setLinking] = useState<string | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const [busy, setBusy] = useState<'save' | 'run' | null>(null)
  const [zoom, setZoom] = useState(1)
  const [past, setPast] = useState<Workflow[]>([])
  const [future, setFuture] = useState<Workflow[]>([])
  const canvasRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [nodesVisible, setNodesVisible] = useState(true)

  const saved = own.find((item) => item.id === activeId) ?? null
  const dirty = !!draft && (!saved || JSON.stringify({ ...draft, updatedAt: '' }) !== JSON.stringify({ ...saved, updatedAt: '' }))

  const shownProject = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (shownProject.current === project?.id) return
    shownProject.current = project?.id
    const first = own[0] ?? null
    setActiveId(first?.id ?? null)
    setDraft(first)
    setSelected(null)
    setLinking(null)
    setPast([])
    setFuture([])
  }, [project?.id, own])

  // 记录「改动前的 draft」到撤销栈。用 ref 读当前值而不是在 setState updater 里嵌套 setState（StrictMode 下 updater 会被双调用导致重复入栈）
  const draftRef = useRef<Workflow | null>(null)
  draftRef.current = draft
  const snapshot = () => {
    const current = draftRef.current
    if (!current) return
    setPast((stack) => [...stack.slice(-49), current])
    setFuture([])
  }

  const undo = () => {
    setPast((stack) => {
      if (!stack.length) return stack
      const previous = stack[stack.length - 1]
      setDraft((current) => {
        if (current) setFuture((redo) => [...redo, current])
        return previous
      })
      return stack.slice(0, -1)
    })
  }

  const redo = () => {
    setFuture((stack) => {
      if (!stack.length) return stack
      const next = stack[stack.length - 1]
      setDraft((current) => {
        if (current) setPast((back) => [...back, current])
        return next
      })
      return stack.slice(0, -1)
    })
  }

  const update = (updater: (current: Workflow) => Workflow) => setDraft((current) => current ? updater(current) : current)
  const updateNode = (id: string, value: Partial<WorkflowNode>) => update((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...value } : node) }))

  const removeNode = (id: string) => {
    snapshot()
    update((current) => ({ ...current, nodes: current.nodes.filter((node) => node.id !== id), edges: current.edges.filter((edge) => edge.from !== id && edge.to !== id) }))
    setSelected((current) => current === id ? null : current)
  }

  const state = useRef({ draft, selected, past, future })
  state.current = { draft, selected, past, future }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setLinking(null); return }
      const target = event.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if ((event.ctrlKey || event.metaKey) && !typing) {
        const key = event.key.toLowerCase()
        if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); return }
        if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); return }
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && state.current.selected) {
        event.preventDefault()
        removeNode(state.current.selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirmDiscard = async () => !dirty || await ui.confirm({ title: tr('放弃未保存的修改'), message: tr('当前工作流有未保存的修改，切换后将丢失。'), confirmLabel: tr('放弃修改'), danger: true })

  const activate = (next: Workflow | null, selectFirst = false) => {
    setActiveId(next?.id ?? null)
    setDraft(next)
    setSelected(selectFirst ? next?.nodes[0]?.id ?? null : null)
    setLinking(null)
    setPast([])
    setFuture([])
  }

  const open = async (id: string) => {
    if (id === activeId || !(await confirmDiscard())) return
    activate(own.find((item) => item.id === id) ?? null)
  }

  const create = async (template?: { name: string; steps: TemplateStep[] }) => {
    if (!project || !(await confirmDiscard())) return
    const next = template ? chainWorkflow(project.id, tr(template.name), template.steps, tr) : blankWorkflow(project.id, own.length + 1, tr)
    activate(next, true)
  }

  const addNode = (kind: WorkflowNodeKind) => {
    if (!draft) return
    if (draft.nodes.length >= 20) { onError(tr('单个工作流最多 20 个节点')); return }
    snapshot()
    const last = draft.nodes[draft.nodes.length - 1]
    const meta = kindMeta[kind]
    const node: WorkflowNode = { id: uid('node'), title: tr('{label}节点', { label: tr(meta.label) }), prompt: '', x: last ? Math.min(CANVAS_W - NODE_W, last.x + 300) : 80, y: last ? last.y : 120, ...(kind !== 'task' ? { kind } : {}) }
    update((current) => ({ ...current, nodes: [...current.nodes, node], edges: last && kind !== 'note' ? [...current.edges, { from: last.id, to: node.id }] : current.edges }))
    setSelected(node.id)
  }

  const duplicateNode = (id: string) => {
    if (!draft) return
    if (draft.nodes.length >= 20) { onError(tr('单个工作流最多 20 个节点')); return }
    const source = draft.nodes.find((node) => node.id === id)
    if (!source) return
    snapshot()
    const copy: WorkflowNode = { ...source, id: uid('node'), x: Math.min(CANVAS_W - NODE_W, source.x + 40), y: Math.min(CANVAS_H - NODE_H, source.y + 40) }
    update((current) => ({ ...current, nodes: [...current.nodes, copy] }))
    setSelected(copy.id)
  }

  const connect = (to: string) => {
    if (!draft || !linking) return
    const from = linking
    setLinking(null)
    if (from === to || draft.edges.some((edge) => edge.from === from && edge.to === to)) return
    if (reaches(draft.edges, to, from)) { onError(tr('这条连线会形成循环，工作流需要是单向的')); return }
    if (draft.edges.length >= 60) { onError(tr('单个工作流最多 60 条连线')); return }
    snapshot()
    update((current) => ({ ...current, edges: [...current.edges, { from, to }] }))
  }

  const layout = () => {
    if (!draft) return
    snapshot()
    update(autoLayout)
    ui.toast(tr('已按执行顺序自动排版'), 'success')
  }

  const fit = () => {
    const container = canvasRef.current
    if (!container || !draft || draft.nodes.length === 0) return
    const minX = Math.min(...draft.nodes.map((node) => node.x))
    const minY = Math.min(...draft.nodes.map((node) => node.y))
    const maxX = Math.max(...draft.nodes.map((node) => node.x + NODE_W))
    const maxY = Math.max(...draft.nodes.map((node) => node.y + NODE_H))
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((container.clientWidth - 48) / (maxX - minX), (container.clientHeight - 48) / (maxY - minY), 1)))
    setZoom(next)
    requestAnimationFrame(() => container.scrollTo({ left: Math.max(0, minX * next - 24), top: Math.max(0, minY * next - 24) }))
  }

  const toCanvas = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: (event.clientX - rect.left + canvasRef.current!.scrollLeft) / zoom, y: (event.clientY - rect.top + canvasRef.current!.scrollTop) / zoom }
  }

  const checkVisibility = () => {
    const container = canvasRef.current
    if (!container || !draft || draft.nodes.length === 0) { setNodesVisible(true); return }
    const left = container.scrollLeft / zoom
    const top = container.scrollTop / zoom
    const right = left + container.clientWidth / zoom
    const bottom = top + container.clientHeight / zoom
    const any = draft.nodes.some((n) => n.x + NODE_W > left && n.x < right && n.y + NODE_H > top && n.y < bottom)
    setNodesVisible(any)
  }

  const recenter = () => {
    const container = canvasRef.current
    if (!container || !draft || draft.nodes.length === 0) return
    const minX = Math.min(...draft.nodes.map((n) => n.x))
    const minY = Math.min(...draft.nodes.map((n) => n.y))
    const maxX = Math.max(...draft.nodes.map((n) => n.x + NODE_W))
    const maxY = Math.max(...draft.nodes.map((n) => n.y + NODE_H))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    container.scrollTo({ left: Math.max(0, cx * zoom - container.clientWidth / 2), top: Math.max(0, cy * zoom - container.clientHeight / 2), behavior: 'smooth' })
    requestAnimationFrame(() => requestAnimationFrame(checkVisibility))
  }

  const onWheel = (event: ReactWheelEvent) => {
    if (!event.ctrlKey && !event.metaKey && event.shiftKey) return
    event.preventDefault()
    const container = canvasRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const worldX = (container.scrollLeft + px) / zoom
    const worldY = (container.scrollTop + py) / zoom
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * factor * 100) / 100))
    if (next === zoom) return
    setZoom(next)
    requestAnimationFrame(() => {
      container.scrollLeft = worldX * next - px
      container.scrollTop = worldY * next - py
      checkVisibility()
    })
  }

  const startPan = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    const container = canvasRef.current
    if (!container) return
    pan.current = { x: event.clientX, y: event.clientY, left: container.scrollLeft, top: container.scrollTop }
    // 捕获指针：拖动中划出画布边界不会丢平移，直到 pointerup（onPointerLeave 只对未捕获的 pan 兜底）
    container.setPointerCapture(event.pointerId)
    setSelected(null)
    setLinking(null)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { checkVisibility() }, [zoom, draft?.id, draft?.nodes.length])

  const startDrag = (event: ReactPointerEvent, node: WorkflowNode) => {
    if (event.button !== 0) return
    snapshot()
    const point = toCanvas(event)
    drag.current = { id: node.id, dx: point.x - node.x, dy: point.y - node.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelected(node.id)
  }

  const moveDrag = (event: ReactPointerEvent) => {
    const panning = pan.current
    if (panning) {
      const container = canvasRef.current
      if (container) {
        container.scrollLeft = panning.left - (event.clientX - panning.x)
        container.scrollTop = panning.top - (event.clientY - panning.y)
      }
      return
    }
    const point = toCanvas(event)
    if (linking) setPointer(point)
    const current = drag.current
    if (!current) return
    updateNode(current.id, {
      x: Math.round(Math.min(CANVAS_W - NODE_W, Math.max(0, point.x - current.dx))),
      y: Math.round(Math.min(CANVAS_H - NODE_H, Math.max(0, point.y - current.dy))),
    })
  }

  const endDrag = () => { drag.current = null; pan.current = null; checkVisibility() }

  const persist = async (): Promise<boolean> => {
    if (!draft) return false
    const name = draft.name.trim()
    if (!name) { onError(tr('请填写工作流名称')); return false }
    const payload = { ...draft, name, updatedAt: new Date().toISOString() }
    const result = await api.saveWorkflow(payload)
    if (!result.ok) { onError(result.error); return false }
    setDraft(payload)
    return true
  }

  const save = async () => {
    setBusy('save')
    try { if (await persist()) ui.toast(tr('工作流已保存'), 'success') } catch { onError(tr('保存工作流失败，请重试。')) } finally { setBusy(null) }
  }

  // AI 生成工作流：描述需求 → 主进程调模型生成节点/连线 → 直接铺到画布（未保存，用户可检查编辑后保存）。
  const generateFromPrompt = async () => {
    if (!project) return
    if (!(await confirmDiscard())) return
    const request = await ui.prompt({ title: tr('AI 生成工作流'), message: tr('用一句话描述你想让工作流完成什么，Cubex 会自动拆解成画布节点。'), placeholder: tr('例如：搜索某主题的资料并整理成报告配一张插图'), confirmLabel: tr('生成'), maxLength: 2000 })
    if (!request || !request.trim()) return
    setBusy('run')
    try {
      const result = await api.generateWorkflow({ projectId: project.id, request, ...(settings.defaultModelId ? { modelId: settings.defaultModelId } : {}) })
      if (!result.ok) { onError(result.error); return }
      activate(result.data, true)
      ui.toast(tr('工作流已生成到画布，检查后可保存'), 'success')
    } catch { onError(tr('生成工作流失败，请重试。')) } finally { setBusy(null) }
  }

  const run = async () => {
    if (!draft) return
    const runnable = draft.nodes.filter((node) => kindOf(node) !== 'note')
    if (runnable.length === 0) { onError(tr('至少需要一个可执行节点（备注节点不会被执行）')); return }
    if (draft.nodes.some((node) => !node.prompt.trim())) { onError(tr('还有节点没有填写内容')); return }
    if (settings.work.confirmBeforeRun && !(await ui.confirm({ title: tr('运行工作流'), message: tr('将依次执行「{name}」的 {n} 个节点，确定开始？', { name: draft.name, n: runnable.length }), confirmLabel: tr('运行') }))) return
    setBusy('run')
    try {
      if (dirty && !(await persist())) return
      const result = await api.runWorkflow({ workflowId: draft.id })
      if (!result.ok) onError(result.error)
      else if (settings.work.autoSwitchToChat) onOpenThread(result.data.id)
      else ui.toast(tr('已在后台开始运行，可在「AI 对话」中查看进度'), 'success')
    } catch { onError(tr('运行工作流失败，请重试。')) } finally { setBusy(null) }
  }

  const remove = async () => {
    if (!draft) return
    if (!(await ui.confirm({ title: tr('删除工作流'), message: tr('确定删除「{name}」？此操作无法撤销。', { name: draft.name }), confirmLabel: tr('删除'), danger: true }))) return
    if (saved) {
      try {
        const result = await api.deleteWorkflow({ workflowId: draft.id })
        if (!result.ok) { onError(result.error); return }
      } catch { onError(tr('删除工作流失败，请重试。')); return }
    }
    activate(own.find((item) => item.id !== draft.id) ?? null)
  }

  const openCreateMenu = (anchor: HTMLElement) => {
    void ui.openMenu(anchor, [
      { label: tr('空白工作流'), icon: Plus, onSelect: () => void create() },
      { label: tr('AI 生成工作流…'), icon: Sparkles, onSelect: () => void generateFromPrompt() },
      'separator',
      ...templates.map((template) => ({ label: tr('模板：{name}', { name: tr(template.name) }), icon: WorkflowIcon, onSelect: () => void create(template) })),
    ])
  }

  const openAddMenu = (anchor: HTMLElement) => {
    void ui.openMenu(anchor, (Object.keys(kindMeta) as WorkflowNodeKind[]).map((kind) => ({ label: tr('{label}节点 · {hint}', { label: tr(kindMeta[kind].label), hint: tr(kindMeta[kind].hint) }), icon: kindMeta[kind].icon, onSelect: () => addNode(kind) })))
  }

  if (!project) {
    return <div className="work-empty"><WorkflowIcon size={30} strokeWidth={1.3} /><h2>{tr('先选择一个项目')}</h2><p>{tr('工作流属于项目，打开项目后即可在画布上编排多步任务。')}</p></div>
  }

  const node = draft?.nodes.find((item) => item.id === selected) ?? null
  const byId = new Map(draft?.nodes.map((item) => [item.id, item]) ?? [])
  const linkFrom = linking ? byId.get(linking) : undefined
  const orderIndex = new Map(draft ? orderNodes(draft).filter((item) => kindOf(item) !== 'note').map((item, index) => [item.id, index + 1]) : [])

  return (
    <div className="work-view">
      <div className="work-toolbar">
        <div className="work-tabs" role="tablist" aria-label={tr('工作流')}>
          {own.map((item) => (
            <button key={item.id} role="tab" aria-selected={item.id === activeId} className={`work-tab${item.id === activeId ? ' active' : ''}`} onClick={() => void open(item.id)}>{item.name}</button>
          ))}
          {draft && !saved && <button role="tab" aria-selected className="work-tab active">{draft.name}<span className="work-unsaved">{tr('未保存')}</span></button>}
          <button className="icon-button" aria-label={tr('新建工作流')} title={tr('新建工作流（可选模板）')} disabled={own.length >= 50} onClick={(event) => openCreateMenu(event.currentTarget)}><Plus size={15} /></button>
        </div>
        {draft && (
          <div className="work-actions">
            <input className="work-name" aria-label={tr('工作流名称')} value={draft.name} maxLength={120} onChange={(event) => update((current) => ({ ...current, name: event.target.value }))} />
            <div className="work-tools" role="group" aria-label={tr('画布工具')}>
              <button className="icon-button" aria-label={tr('撤销')} title={tr('撤销（Ctrl+Z）')} disabled={past.length === 0} onClick={undo}><Undo2 size={15} /></button>
              <button className="icon-button" aria-label={tr('重做')} title={tr('重做（Ctrl+Y）')} disabled={future.length === 0} onClick={redo}><Redo2 size={15} /></button>
              <span className="work-tools-sep" aria-hidden />
              <button className="icon-button" aria-label={tr('自动排版')} title={tr('按执行顺序自动排版')} onClick={layout}><LayoutGrid size={15} /></button>
              <button className="icon-button" aria-label={tr('适配视图')} title={tr('缩放至完整显示')} onClick={fit}><Maximize size={15} /></button>
              <span className="work-tools-sep" aria-hidden />
              <button className="icon-button" aria-label={tr('缩小')} title={tr('缩小')} disabled={zoom <= ZOOM_MIN} onClick={() => setZoom((current) => Math.max(ZOOM_MIN, Math.round((current - 0.1) * 10) / 10))}><Minus size={15} /></button>
              <button className="work-zoom" title={tr('重置缩放')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button className="icon-button" aria-label={tr('放大')} title={tr('放大')} disabled={zoom >= ZOOM_MAX} onClick={() => setZoom((current) => Math.min(ZOOM_MAX, Math.round((current + 0.1) * 10) / 10))}><Plus size={15} /></button>
            </div>
            <button className="btn-secondary" onClick={(event) => openAddMenu(event.currentTarget)} disabled={draft.nodes.length >= 20}><Plus size={14} />{tr('节点')}</button>
            <button className="btn-secondary" onClick={() => void save()} disabled={!dirty || !!busy || !isDesktop}>{busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{tr('保存')}</button>
            <label className="work-switch" title={tr('运行后自动切换到 AI 对话页查看进度')}>
              <input type="checkbox" checked={settings.work.autoSwitchToChat} onChange={(event) => onToggleAutoSwitch(event.target.checked)} />
              <span className="work-switch-track" aria-hidden><span className="work-switch-thumb" /></span>
              <span className="work-switch-label">{tr('切到对话')}</span>
            </label>
            <button className="btn-primary" onClick={() => void run()} disabled={!!busy || !isDesktop}>{busy === 'run' ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{tr('运行')}</button>
            <button className="icon-button danger" aria-label={tr('删除工作流')} title={tr('删除工作流')} onClick={() => void remove()}><Trash2 size={15} /></button>
          </div>
        )}
      </div>
      {!draft ? (
        <div className="work-empty">
          <WorkflowIcon size={30} strokeWidth={1.3} />
          <h2>{tr('用画布编排多步任务')}</h2>
          <p>{tr('把复杂工作拆成节点，用连线决定先后顺序，一键交给 Cubex 依次执行。')}</p>
          <div className="work-empty-actions">
            <button className="btn-primary" onClick={() => void create()}><Plus size={14} />{tr('空白工作流')}</button>
            {templates.map((template) => (
              <button key={template.name} className="btn-secondary" onClick={() => void create(template)}>{tr(template.name)}</button>
            ))}
          </div>
        </div>
      ) : (
        <div className="work-body">
          <div ref={canvasRef} className={`work-canvas${linking ? ' linking' : ''}${pan.current ? ' panning' : ''}`} onWheel={onWheel} onScroll={checkVisibility} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerLeave={endDrag} onPointerCancel={endDrag} onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('work-surface') || (event.target as HTMLElement).classList.contains('work-scale')) startPan(event) }}>
            <div className="work-scale" style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom }}>
              <div className="work-surface" style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom})`, transformOrigin: '0 0' }}>
                <svg className="work-edges" width={CANVAS_W} height={CANVAS_H} aria-hidden="true">
                  {draft.edges.map((edge) => {
                    const from = byId.get(edge.from)
                    const to = byId.get(edge.to)
                    if (!from || !to) return null
                    const d = curve(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2)
                    return (
                      <g key={`${edge.from}-${edge.to}`} className="work-edge" onClick={() => { snapshot(); update((current) => ({ ...current, edges: current.edges.filter((item) => item !== edge) })) }}>
                        <path className="work-edge-hit" d={d} />
                        <path className="work-edge-line" d={d} />
                      </g>
                    )
                  })}
                  {linkFrom && pointer && <path className="work-edge-line pending" d={curve(linkFrom.x + NODE_W, linkFrom.y + NODE_H / 2, pointer.x, pointer.y)} />}
                </svg>
                {draft.nodes.map((item) => {
                  const kind = kindOf(item)
                  const Icon = kindMeta[kind].icon
                  const order = orderIndex.get(item.id)
                  return (
                    <div key={item.id} className={`work-node k-${kind}${item.id === selected ? ' selected' : ''}${item.prompt.trim() ? '' : ' incomplete'}`} style={{ left: item.x, top: item.y, width: NODE_W, height: NODE_H }}>
                      <button type="button" className="work-port in" aria-label={tr('连接到 {title}', { title: item.title })} title={linking ? tr('连接到此节点') : tr('输入')} onClick={() => connect(item.id)} />
                      <div className="work-node-head" onPointerDown={(event) => startDrag(event, item)}>
                        <span className="work-node-index" title={tr(kindMeta[kind].label)}>{kind === 'note' ? <Icon size={11} /> : order ?? <Icon size={11} />}</span>
                        <span className="truncate">{item.title}</span>
                        <Icon size={12} className="work-node-kind" aria-label={tr(kindMeta[kind].label)} />
                      </div>
                      <p className="work-node-body" onClick={() => setSelected(item.id)}>{(() => {
                        const filled = nodeConfigFields[kind].filter((field) => (item.config?.[field.key] ?? '').trim())
                        const summary = filled.length ? filled.map((field) => `${tr(field.label)}：${item.config![field.key]!.trim()}`).join('；') : ''
                        return summary || item.prompt.trim() || tr('点击填写内容…')
                      })()}</p>
                      <button type="button" className={`work-port out${linking === item.id ? ' active' : ''}`} aria-label={tr('从 {title} 连线', { title: item.title })} title={tr('拖出连线：点击后再点击目标节点左侧圆点')} onClick={() => setLinking((current) => current === item.id ? null : item.id)} />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {panelOpen && (
          <aside className="work-inspector" aria-label={tr('节点属性')}>
            {node ? (
              <>
                <div className="work-inspector-head"><strong>{tr('节点设置')}</strong><button className="icon-button" aria-label={tr('关闭')} onClick={() => setSelected(null)}><X size={14} /></button></div>
                <div className="field"><span>{tr('类型')}</span>
                  <Select className="field-select" value={kindOf(node)} label={tr('节点类型')} options={(Object.keys(kindMeta) as WorkflowNodeKind[]).map((kind) => ({ value: kind, label: tr(kindMeta[kind].label), hint: tr(kindMeta[kind].hint), icon: kindMeta[kind].icon }))} onChange={(kind) => { snapshot(); updateNode(node.id, { kind: kind === 'task' ? undefined : kind }) }} />
                </div>
                <p className="hint">{tr(kindMeta[kindOf(node)].hint)}</p>
                <label className="field"><span>{tr('标题')}</span><input value={node.title} maxLength={120} onChange={(event) => updateNode(node.id, { title: event.target.value })} /></label>
                {nodeConfigFields[kindOf(node)].length > 0 && (
                  <div className="work-node-config">
                    <strong>{tr('专属配置')}</strong>
                    {nodeConfigFields[kindOf(node)].map((field) => {
                      const value = node.config?.[field.key] ?? ''
                      const setConfig = (next: string) => updateNode(node.id, { config: { ...(node.config ?? {}), [field.key]: next } })
                      if (field.type === 'select') {
                        return (
                          <label className="field" key={field.key}><span>{tr(field.label)}</span>
                            {/* 空串 = 未指定（默认），注入哨兵选项让 Select 能正确回显，而不是显示「未选择」 */}
                            <Select className="field-select" label={tr(field.label)} value={value}
                              options={[{ value: '', label: tr('默认') }, ...field.options!.filter((option) => option !== '默认').map((option) => ({ value: option, label: tr(option) }))]}
                              onChange={(option) => { snapshot(); setConfig(option) }} />
                          </label>
                        )
                      }
                      if (field.type === 'textarea') {
                        return (
                          <label className="field" key={field.key}><span>{tr(field.label)}</span>
                            <textarea value={value} maxLength={4000} placeholder={field.placeholder ? tr(field.placeholder) : undefined} onChange={(event) => setConfig(event.target.value)} />
                          </label>
                        )
                      }
                      return (
                        <label className="field" key={field.key}><span>{tr(field.label)}</span>
                          <input value={value} maxLength={4000} placeholder={field.placeholder ? tr(field.placeholder) : undefined} onChange={(event) => setConfig(event.target.value)} />
                        </label>
                      )
                    })}
                  </div>
                )}
                <label className="field grow"><span>{kindOf(node) === 'note' ? tr('备注内容') : tr('指令')}</span><textarea value={node.prompt} maxLength={8000} placeholder={kindOf(node) === 'note' ? tr('写下要让 Cubex 参考的背景信息…') : tr('描述这一步要让 Cubex 完成什么…')} onChange={(event) => updateNode(node.id, { prompt: event.target.value })} /></label>
                <div className="work-node-actions">
                  <button className="btn-secondary" onClick={() => duplicateNode(node.id)} disabled={draft.nodes.length >= 20}><Copy size={14} />{tr('复制')}</button>
                  <button className="btn-secondary danger" onClick={() => removeNode(node.id)}><Trash2 size={14} />{tr('删除')}</button>
                </div>
              </>
            ) : (
              <div className="work-help">
                <strong>{tr('工作流概览')}</strong>
                <p className="work-stats">{tr('{n} 个节点', { n: draft.nodes.length })} · {tr('{n} 条连线', { n: draft.edges.length })}{draft.nodes.some((item) => kindOf(item) === 'note') ? ` · ${tr('{n} 条备注', { n: draft.nodes.filter((item) => kindOf(item) === 'note').length })}` : ''}</p>
                {orderIndex.size > 0 && (
                  <ol className="work-order">
                    {orderNodes(draft).filter((item) => kindOf(item) !== 'note').map((item) => (
                      <li key={item.id}><button type="button" onClick={() => setSelected(item.id)}><span>{item.title}</span></button></li>
                    ))}
                  </ol>
                )}
                <strong>{tr('使用说明')}</strong>
                <ul>
                  <li>{tr('拖动节点标题栏调整位置，Delete 删除选中节点')}</li>
                  <li>{tr('点击节点右侧圆点，再点击目标节点左侧圆点即可连线')}</li>
                  <li>{tr('点击连线可删除，Esc 取消连线，Ctrl+Z 撤销')}</li>
                  <li>{tr('备注节点不执行，仅作为背景信息提供给 Cubex')}</li>
                  <li>{tr('运行时按连线顺序（无依赖时从左到右）依次执行')}</li>
                </ul>
              </div>
            )}
            {!nodesVisible && draft.nodes.length > 0 && (
              <div className="work-inspector-foot">
                <button type="button" className="work-recenter" onClick={recenter} title={tr('回到画布中心（第一个模块处）')}>
                  <Crosshair size={15} />{tr('回到中心')}
                </button>
              </div>
            )}
          </aside>
          )}
        </div>
      )}
    </div>
  )
}
