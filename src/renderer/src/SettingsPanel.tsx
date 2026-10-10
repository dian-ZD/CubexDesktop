import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, CloudUpload, Copy, Cpu, FlaskConical, FolderOpen, GitBranch, Globe, Info, KeyRound, Keyboard, LoaderCircle, MonitorCog, PictureInPicture, Play, PlugZap, Plus, Puzzle, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Star, Timer, Trash2, Upload, X } from 'lucide-react'
import {
  accents, approvalLabels, approvalModes, computerModes, densities, fontFamilies, imageSizes, languages, providerKinds, providerLabels, responseStyles, searchEngines, sendKeys, settingsSchema, shells, speechDownloadHostLabels, speechDownloadSourceLabels, speechDownloadSources, speechModels, thinkingLevelLabels, themes, uiLanguages,
  type Automation, type ConnectionTest, type CrawlMode, type DiscoveredModelInfo, type McpServer, type McpStatus, type ModelConfig, type ModelParams, type PluginInfo, type Project, type ProviderConfig, type SearchEngine, type Settings, type SkillMeta, type Workflow as WorkflowType,
} from '../../shared/schema'
import { nextRunAt, weekdayNames } from '../../shared/schedule'
import { api } from './bridge'
import { Select } from './ui'
import { useI18n } from './i18n'

export const handoffPrompt = `请立即暂停当前任务的进一步推进，先在项目根目录创建（若已存在则更新）以下四个文件，用于保存工作上下文，确保下一个会话或另一个 Agent 读取后能够无缝衔接继续本任务，而不需要我重复说明。

要求整体遵守：

- 只写事实和已确认的信息，不要编造；不确定的内容明确标注「待确认」。

- 使用简洁的 Markdown，中文书写，路径/命令/代码保留原文。

- 每个文件顶部注明「最后更新时间」和「更新者」。

- 四个文件之间不要重复大段内容，用相互引用代替（例如 "详见 plan.md 第 3 步"）。

- 创建完成后，把四个文件的完整内容依次输出给我审阅，然后再继续任务。

---

### 1. goal.md —— 目标定义（回答"我们要做成什么"）

包含：

- 一句话总目标

- 背景与动机（为什么要做）

- 明确的验收标准 / 完成定义（Definition of Done），逐条列出，可勾选

- 明确的边界：不做什么、不能改动什么

- 关键约束：技术栈、性能、兼容性、时间、风格规范等

- 相关方与沟通偏好（例如：用户希望每步先确认、还是直接执行）

### 2. plan.md —— 执行计划（回答"怎么做、做到哪了"）

包含：

- 按阶段/步骤拆分的任务清单，用 [ ] / [x] / [~] 标记未开始 / 已完成 / 进行中

- 每一步的：目标、涉及的文件或模块、预期产出、验证方法

- 当前进行到的精确位置（"下一步要做的第一件事是……"），要具体到可直接执行

- 已知风险、阻塞项及其应对方案

- 已被否决的方案及原因（避免后续重复踩坑）

### 3. memory.md —— 工作记忆（回答"过程中发生了什么、有哪些不能忘的细节"）

包含：

- 关键决策记录：决策内容、时间、原因、替代方案

- 已修改/新增/删除的文件列表及每个改动的一句话说明

- 重要发现：代码结构、依赖关系、坑点、环境差异、隐含约定

- 用户明确提出的偏好和禁忌（措辞尽量原样保留）

- 已运行的关键命令及其结果摘要（成功/失败/报错信息）

- 未解决的问题与疑问清单

- 临时性的上下文（例如临时密钥位置、测试账号、端口号——不要写入真实敏感值，只写引用位置）

### 4. agents.md —— 协作规则（回答"接手者应如何工作"）

包含：

- 接手时的启动流程：先读哪个文件、按什么顺序、读完后要做的第一件事

- 工作时的行为准则：每完成一步如何更新上述三个文件、何时需要向用户确认、何时可自主决定

- 代码与文档规范：命名、注释、提交信息格式、测试要求

- 禁止事项：绝对不能做的操作（如删库、修改某目录、跳过测试、直接推送主分支等）

- 各角色/子 Agent 的职责分工（如有多个 Agent 协作）

- 交接时的检查清单（Handoff Checklist）

---

完成以上文件后，回复格式如下：

1. 四个文件的完整内容

2. 一段不超过 5 行的"交接摘要"：当前任务是什么、进度到哪、下一步是什么

3. 然后等待我确认，或按 agents.md 中约定的规则继续执行任务。`

const defaultBaseUrl: Record<ProviderConfig['kind'], string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434',
}

const languageLabels: Record<(typeof languages)[number], string> = { 'zh-CN': '简体中文', en: 'English', auto: '跟随提问语言' }
const uiLanguageLabels: Record<(typeof uiLanguages)[number], string> = { 'zh-CN': '简体中文', en: 'English' }
const styleLabels: Record<(typeof responseStyles)[number], string> = { concise: '简洁', balanced: '适中', detailed: '详细' }
const themeLabels: Record<(typeof themes)[number], string> = { dark: '深色', light: '浅色', system: '跟随系统' }
const accentLabels: Record<(typeof accents)[number], string> = { matcha: '抹茶绿', ocean: '海洋蓝', sunset: '日落橙', violet: '薰衣紫', rose: '胭脂粉', mono: '极简灰' }
const fontFamilyLabels: Record<(typeof fontFamilies)[number], string> = { system: '系统默认', sans: '现代黑体 (Inter)', inter: '无衬线 · Inter', roboto: '无衬线 · Roboto', 'system-ui': '无衬线 · 系统 UI', serif: '衬线宋体', georgia: '衬线 · Georgia', 'source-serif': '衬线 · Source Serif', rounded: '圆润 · Nunito', yahei: '中文 · 微软雅黑', pingfang: '中文 · 苹方', 'source-han-sans': '中文黑体 · 思源黑体', 'source-han-serif': '中文宋体 · 思源宋体', kaiti: '中文 · 楷体', mono: '等宽 · Cascadia', 'jetbrains-mono': '等宽 · JetBrains Mono' }
const densityLabels: Record<(typeof densities)[number], string> = { comfortable: '舒适', compact: '紧凑' }
const shellLabels: Record<(typeof shells)[number], string> = { auto: '自动（Windows 用 PowerShell）', powershell: 'Windows PowerShell', pwsh: 'PowerShell 7 (pwsh)', cmd: '命令提示符 (cmd)', bash: 'Bash', sh: 'sh' }
const sendKeyLabels: Record<(typeof sendKeys)[number], string> = { enter: 'Enter 发送，Shift+Enter 换行', 'ctrl-enter': 'Ctrl+Enter 发送，Enter 换行' }

export type SectionId = 'general' | 'providers' | 'permissions' | 'computer' | 'floating' | 'mcp' | 'skills' | 'plugins' | 'github' | 'automation' | 'work' | 'browser' | 'worktree' | 'rules' | 'beta' | 'shortcuts' | 'archived'

const sections: { id: SectionId; title: string; hint: string; icon: typeof Settings2; hidden?: boolean }[] = [
  { id: 'general', title: '通用', hint: '界面语言、回复语言与风格、提示音、外观与对话显示', icon: SlidersHorizontal },
  { id: 'providers', title: '模型', hint: '提供商、模型、连接测试、单模型高级参数与图片生成', icon: Cpu },
  { id: 'permissions', title: '权限审批', hint: '审批模式、只读与命令规则', icon: ShieldCheck },
  { id: 'computer', title: '电脑操控', hint: '鼠标键盘操作方式、是否使用独立桌面与实时镜像', icon: MonitorCog },
  { id: 'floating', title: '悬浮窗', hint: '任务运行时右下角悬浮窗的透明度与自动弹出', icon: PictureInPicture },
  { id: 'mcp', title: 'MCP', hint: '外部工具服务器（Model Context Protocol）', icon: PlugZap },
  { id: 'skills', title: '技能', hint: '上传技能文件，用 / 名称在对话中快速调用', icon: Sparkles },
  { id: 'plugins', title: '插件', hint: '浏览器、电脑控制与自定义插件', icon: Puzzle },
  { id: 'github', title: 'GitHub', hint: '访问令牌、目标仓库与自动推送', icon: CloudUpload },
  { id: 'automation', title: '自动化', hint: '按间隔或每天/每周定时自动执行的任务', icon: Timer, hidden: true },
  { id: 'work', title: 'Work 模式', hint: '工作流运行方式与电脑/浏览器操控', icon: MonitorCog },
  { id: 'browser', title: 'Browser 模式', hint: '起始页、逐步审批、会话时长与下载/新窗口策略', icon: Globe },
  { id: 'worktree', title: '工作树', hint: '命令执行环境与改动验证', icon: GitBranch },
  { id: 'rules', title: '规则与记忆', hint: '项目上下文文件、计划方式与跨应用交接', icon: BookOpen },
  { id: 'beta', title: 'Beta 功能', hint: '实验性功能：token 节省与大型项目优化、agent 循环优化', icon: FlaskConical },
  { id: 'shortcuts', title: '键盘快捷键', hint: '发送方式与常用快捷键', icon: Keyboard },
  { id: 'archived', title: '已归档项目', hint: '查看并恢复已归档的项目', icon: Archive },
]

const hiddenSections = new Set<SectionId>(sections.filter((item) => item.hidden).map((item) => item.id))

const sectionPrefixes: Partial<Record<SectionId, string[]>> = {
  general: ['general.uiLanguage', 'general.language', 'general.responseStyle', 'general.confirmDelete', 'appearance', 'chat.showUsage', 'chat.expandTools', 'chat.autoScroll', 'chat.notifyOnDone', 'sound', 'speech'],
  providers: ['providers', 'models', 'defaultModelId', 'modelParams', 'image'],
  permissions: ['permissions', 'approvalMode'],
  computer: ['computer'],
  floating: ['floating'],
  worktree: ['agent.commandTimeoutSec', 'agent.shell', 'agent.verifyChanges'],
  rules: ['agent.maxSteps', 'agent.planFirst', 'agent.autoTodo', 'agent.autoSelectRecommended', 'agent.maxConcurrentSubagents', 'agent.subagentProfiles'],
  beta: ['beta'],
  shortcuts: ['chat.sendKey'],
  plugins: ['plugins'],
  mcp: ['mcp'],
  skills: ['skills'],
  github: ['github'],
  automation: ['automations'],
  work: ['work'],
  browser: ['browser'],
}

const intervalPresets: { value: number; label: string }[] = [
  { value: 30, label: '每 30 分钟' },
  { value: 60, label: '每小时' },
  { value: 180, label: '每 3 小时' },
  { value: 720, label: '每 12 小时' },
  { value: 1440, label: '每天' },
  { value: 10080, label: '每周' },
]

const shortcutList: { keys: string; action: string }[] = [
  { keys: 'Ctrl + O', action: '打开项目文件夹' },
  { keys: 'Ctrl + N', action: '新建任务' },
  { keys: 'Ctrl + ,', action: '打开 / 关闭设置' },
  { keys: 'Esc', action: '返回会话' },
  { keys: 'Shift + Enter 或 Enter', action: '换行 / 发送（取决于下方发送方式）' },
]

const groupOrder: Record<string, number> = { '界面与语言': 0, '外观与显示': 1, '字体与排版': 2, '对话与通知': 3, '提示音': 4, '语音输入': 5 }

// 同一分区内按分组排序，未标注分组的项保持原顺序并排在最前。
const sortByGroup = <T extends { group?: string }>(items: T[]): T[] => items
  .map((item, index) => ({ item, index }))
  .sort((left, right) => {
    const a = left.item.group ? groupOrder[left.item.group] ?? 99 : -1
    const b = right.item.group ? groupOrder[right.item.group] ?? 99 : -1
    return a === b ? left.index - right.index : a - b
  })
  .map((entry) => entry.item)

interface Row {
  key: string
  section: SectionId
  label: string
  hint?: string
  keywords?: string
  paths?: string[]
  wide?: boolean
  group?: string
  render: () => ReactNode
}

const hasCjk = (text: string) => /[\u4e00-\u9fa5]/.test(text)

const issueMessage = (issue: { message: string; code: string }, tr: (zhText: string) => string) =>
  hasCjk(issue.message) ? tr(issue.message)
    : issue.code === 'too_small' ? tr('不能为空或过小')
    : issue.code === 'too_big' ? tr('超出允许长度或范围')
    : issue.code === 'invalid_type' ? tr('请填写有效的值')
    : tr('格式不正确')

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch-thumb" />
    </button>
  )
}

// 自绘滑条：原生 input[type=range] 的填充与滑块无法对齐，这里用一条轨道 + 填充 + 滑块实现，
// 拖到端点时滑块中心正好落在轨道两端，不会右侧空一大块。
function Slider({ value, min, max, step = 1, label, onChange }: { value: number; min: number; max: number; step?: number; label: string; onChange: (value: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const span = Math.max(1, max - min)
  const ratio = Math.max(0, Math.min(1, (value - min) / span))

  const pick = (clientX: number) => {
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const inner = rect.width - SLIDER_THUMB * 2
    if (inner <= 0) return
    const next = (clientX - rect.left - SLIDER_THUMB) / inner
    const raw = min + Math.max(0, Math.min(1, next)) * span
    onChange(Math.max(min, Math.min(max, Math.round(raw / step) * step)))
  }

  return (
    <div
      ref={trackRef}
      className={`slider${dragging ? ' dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={(event) => {
        pick(event.clientX)
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 合成事件可能没有真实指针 */ }
        setDragging(true)
      }}
      onPointerMove={(event) => { if (dragging) pick(event.clientX) }}
      onPointerUp={(event) => { setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId) }}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onChange(Math.max(min, value - step)) }
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onChange(Math.min(max, value + step)) }
      }}
    >
      <span className="slider-fill" style={{ width: ratio > 0 ? `calc(${SLIDER_THUMB}px + ${ratio} * (100% - ${SLIDER_THUMB * 2}px))` : '0px' }} />
      <span className="slider-thumb" style={{ left: `calc(${SLIDER_THUMB}px + ${ratio} * (100% - ${SLIDER_THUMB * 2}px))` }} />
    </div>
  )
}

const SLIDER_THUMB = 8

function NumberField({ value, onChange, min, max, step, unit, placeholder, nullable, label }: { value: number | null; onChange: (value: number | null) => void; min: number; max: number; step?: number; unit?: string; placeholder?: string; nullable?: boolean; label: string }) {
  const [text, setText] = useState(value === null || Number.isNaN(value) ? '' : String(value))
  useEffect(() => {
    setText((current) => (Number(current) === value && current !== '') || (value === null && current === '') ? current : value === null || Number.isNaN(value) ? '' : String(value))
  }, [value])
  return (
    <div className="number-field">
      <input type="number" aria-label={label} min={min} max={max} step={step ?? 1} value={text} placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          if (next.trim() === '') onChange(nullable ? null : Number.NaN)
          else onChange(Number(next))
        }} />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
}

function Choice<T extends string>({ value, options, labels, onChange, label }: { value: T; options: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void; label: string }) {
  const { tr } = useI18n()
  return (
    <Select className="field-select" label={label} value={value} options={options.map((option) => ({ value: option, label: tr(labels[option]) }))} onChange={onChange} />
  )
}

function RuleList({ rules, onChange, placeholder, label }: { rules: string[]; onChange: (rules: string[]) => void; placeholder: string; label: string }) {
  const { tr } = useI18n()
  const [text, setText] = useState('')
  const add = () => {
    const value = text.trim()
    if (!value || rules.includes(value)) return
    onChange([...rules, value])
    setText('')
  }
  return (
    <div className="rule-list">
      <div className="key-row">
        <input aria-label={label} value={text} placeholder={placeholder} spellCheck={false} maxLength={200}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
        <button type="button" className="btn-secondary" onClick={add} disabled={!text.trim() || rules.length >= 100}><Plus size={14} />{tr('添加')}</button>
      </div>
      {rules.length > 0 ? (
        <ul className="rule-chips">
          {rules.map((rule, index) => (
            <li key={`${rule}-${index}`}>
              <code>{rule}</code>
              <button type="button" className="icon-button" aria-label={tr('移除规则 {rule}', { rule })} onClick={() => onChange(rules.filter((_, i) => i !== index))}><X size={12} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="field-hint">{tr('暂无规则')}</p>}
    </div>
  )
}

function LinesField({ label, value, placeholder, parse, invalid }: { label: string; value: string; placeholder: string; parse: (text: string) => void; invalid?: boolean }) {
  const [text, setText] = useState(value)
  return (
    <textarea aria-label={label} rows={3} spellCheck={false} value={text} placeholder={placeholder} aria-invalid={invalid}
      onChange={(event) => { setText(event.target.value); parse(event.target.value) }} />
  )
}

const parseArgs = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const parseEnv = (text: string) => {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key) env[key] = line.slice(index + 1).trim()
  }
  return env
}
const formatEnv = (env: Record<string, string>) => Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')

function ParamsForm({ label, value, fallback, errorPrefix, errors, onChange }: { label: string; value: Partial<ModelParams>; fallback?: ModelParams; errorPrefix: string; errors: Map<string, string>; onChange: (value: Partial<ModelParams>) => void }) {
  const { tr } = useI18n()
  const overriding = !!fallback
  const set = <K extends keyof ModelParams>(key: K, next: ModelParams[K] | null | undefined) => {
    if (overriding && (next === undefined || (next === null && key !== 'temperature') || (typeof next === 'number' && Number.isNaN(next)))) {
      const rest = { ...value }
      delete rest[key]
      onChange(rest)
    } else onChange({ ...value, [key]: next })
  }
  const numeric = (key: Exclude<keyof ModelParams, 'temperature' | 'thinkingLevel'>): number | null => {
    const current = value[key]
    if (current === undefined) return overriding ? null : Number.NaN
    return current
  }
  const ph = (key: Exclude<keyof ModelParams, 'temperature' | 'thinkingLevel'>) => overriding ? tr('全局 {value}', { value: String(fallback![key]) }) : undefined
  const err = (key: keyof ModelParams) => errors.get(`${errorPrefix}.${key}`)
  return (
    <div className="grid-form params-form" aria-label={tr('{label}模型参数', { label })}>
      <label className="field">
        <span>{tr('温度')}</span>
        <NumberField label={tr('{label}温度', { label })} nullable value={value.temperature === undefined ? null : value.temperature} min={0} max={2} step={0.1}
          placeholder={overriding ? (fallback!.temperature === null ? tr('全局：模型默认') : tr('全局 {value}', { value: String(fallback!.temperature) })) : tr('模型默认')}
          onChange={(next) => overriding && next === null ? set('temperature', undefined) : set('temperature', next)} />
        <FieldError message={err('temperature')} />
      </label>
      <label className="field">
        <span>{tr('最大输出 Token')}</span>
        <NumberField label={tr('{label}最大输出 Token', { label })} nullable={overriding} value={numeric('maxTokens')} min={0} max={200000} step={256} placeholder={ph('maxTokens')} onChange={(next) => set('maxTokens', next ?? undefined)} />
        <FieldError message={err('maxTokens')} />
      </label>
      <label className="field">
        <span>{tr('请求超时（秒）')}</span>
        <NumberField label={tr('{label}请求超时', { label })} nullable={overriding} value={numeric('timeoutSec')} min={10} max={900} placeholder={ph('timeoutSec')} onChange={(next) => set('timeoutSec', next ?? undefined)} />
        <FieldError message={err('timeoutSec')} />
        <span className="field-hint">{tr('等待响应或连续无数据的时限；持续收到数据会续期，不改变服务端超时。')}</span>
      </label>
      <label className="field">
        <span>{tr('失败重试次数')}</span>
        <NumberField label={tr('{label}失败重试次数', { label })} nullable={overriding} value={numeric('retries')} min={0} max={5} placeholder={ph('retries')} onChange={(next) => set('retries', next ?? undefined)} />
        <FieldError message={err('retries')} />
        <span className="field-hint">{tr('尚未输出文本时自动重试暂时性错误；已有输出时保留内容，手动继续。')}</span>
      </label>
      <label className="field">
        <span>{tr('上下文消息条数')}</span>
        <NumberField label={tr('{label}上下文消息条数', { label })} nullable={overriding} value={numeric('historyLimit')} min={10} max={400} placeholder={ph('historyLimit')} onChange={(next) => set('historyLimit', next ?? undefined)} />
        <FieldError message={err('historyLimit')} />
      </label>
      <label className="field">
        <span>{tr('思考强度')}</span>
        <Select className="thinking-select" label={tr('{label}思考强度', { label })} value={value.thinkingLevel ?? '__unset__'} disabled={false}
          onChange={(next) => set('thinkingLevel', next === '__unset__' ? (overriding ? undefined : null) : next as ModelParams['thinkingLevel'])}
          options={[
            ...(overriding ? [{ value: '__unset__', label: tr('沿用全局'), hint: fallback?.thinkingLevel === null || fallback?.thinkingLevel === undefined ? tr('全局：跟随模型默认') : tr('全局：{value}', { value: thinkingLevelLabels[fallback!.thinkingLevel!] }) }] : []),
            { value: 'off', label: tr('关闭'), hint: tr('不启用扩展思考') },
            { value: 'low', label: tr('低'), hint: tr('更快、更省') },
            { value: 'medium', label: tr('中'), hint: tr('均衡') },
            { value: 'high', label: tr('高'), hint: tr('更深入，耗时更长') },
          ]} />
        <FieldError message={err('thinkingLevel')} />
        <span className="field-hint">{tr('部分模型或端点不支持思考强度，勾选后由服务端忽略或报错。')}</span>
      </label>
    </div>
  )
}

export function SettingsPanel({ settings, projects = [], workflows = [], onError, onClose, initialSection, page }: { settings: Settings; projects?: Project[]; workflows?: WorkflowType[]; onError: (message: string | null) => void; onClose: () => void; initialSection?: SectionId; page?: SectionId }) {
  const { tr } = useI18n()
  const [draft, setDraft] = useState<Settings>(settings)
  const [section, setSection] = useState<SectionId>(page ?? initialSection ?? 'providers')
  const activeSection: SectionId = page ?? (sections.some((item) => item.id === section && item.hidden) ? 'providers' : section)
  const [query, setQuery] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [keyBusy, setKeyBusy] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, ConnectionTest | 'pending'>>({})
  const [discovery, setDiscovery] = useState<Record<string, { status: 'loading' } | { status: 'error'; message: string } | { status: 'info'; message: string } | { status: 'done'; models: DiscoveredModelInfo[] }>>({})
  const [copied, setCopied] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [pluginsBusy, setPluginsBusy] = useState(false)
  const [skills, setSkills] = useState<SkillMeta[] | null>(null)
  const [skillsBusy, setSkillsBusy] = useState(false)
  const [skillPreview, setSkillPreview] = useState<{ id: string; content: string } | null>(null)
  const [githubToken, setGithubToken] = useState('')
  const [githubBusy, setGithubBusy] = useState<'token' | 'clear' | 'push' | null>(null)
  const [githubLogin, setGithubLogin] = useState<string | null>(null)
  const [pushProjectId, setPushProjectId] = useState('')
  const [pushResult, setPushResult] = useState<string | null>(null)
  const [autoBusy, setAutoBusy] = useState<string | null>(null)
  const [mcpStatus, setMcpStatus] = useState<McpStatus[] | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpTests, setMcpTests] = useState<Record<string, McpStatus | 'pending'>>({})

  const loadMcp = async () => {
    setMcpBusy(true)
    try {
      const result = await api.listMcp()
      if (!result.ok) onError(result.error)
      else setMcpStatus(result.data)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setMcpBusy(false)
    }
  }

  const mcpRequested = useRef(false)
  useEffect(() => {
    if (section !== 'mcp' || mcpRequested.current) return
    mcpRequested.current = true
    void loadMcp()
  })

  const testMcp = async (server: McpServer) => {
    setMcpTests((current) => ({ ...current, [server.id]: 'pending' }))
    try {
      const result = await api.testMcp({ server })
      const status: McpStatus = result.ok ? result.data : { id: server.id, name: server.name, enabled: server.enabled, status: 'error', error: result.error, tools: [] }
      setMcpTests((current) => ({ ...current, [server.id]: status }))
    } catch (error) {
      setMcpTests((current) => ({ ...current, [server.id]: { id: server.id, name: server.name, enabled: server.enabled, status: 'error', error: error instanceof Error ? error.message : String(error), tools: [] } }))
    }
  }

  const loadPlugins = async () => {
    setPluginsBusy(true)
    try {
      const result = await api.listPlugins()
      if (!result.ok) onError(result.error)
      else setPlugins(result.data)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginsBusy(false)
    }
  }

  const pluginsRequested = useRef(false)
  useEffect(() => {
    if (section !== 'plugins' || pluginsRequested.current) return
    pluginsRequested.current = true
    void loadPlugins()
  })

  const openPluginsDir = async () => {
    try {
      const result = await api.openPluginsDir()
      if (!result.ok) onError(result.error)
      else void loadPlugins()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const loadSkills = async () => {
    setSkillsBusy(true)
    try {
      const result = await api.listSkills()
      if (!result.ok) onError(result.error)
      else setSkills(result.data)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSkillsBusy(false)
    }
  }

  const skillsRequested = useRef(false)
  useEffect(() => {
    if (section !== 'skills' || skillsRequested.current) return
    skillsRequested.current = true
    void loadSkills()
  })

  const importSkills = async () => {
    setSkillsBusy(true)
    try {
      const result = await api.importSkills()
      if (!result.ok) onError(result.error)
      else await loadSkills()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSkillsBusy(false)
    }
  }

  const removeSkill = async (id: string) => {
    try {
      const result = await api.deleteSkill({ id })
      if (!result.ok) { onError(result.error); return }
      if (skillPreview?.id === id) setSkillPreview(null)
      await loadSkills()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const previewSkill = async (id: string) => {
    if (skillPreview?.id === id) { setSkillPreview(null); return }
    try {
      const result = await api.readSkill({ id })
      if (!result.ok) { onError(result.error); return }
      setSkillPreview({ id, content: result.data.content })
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const openSkillsDir = async () => {
    try {
      const result = await api.openSkillsDir()
      if (!result.ok) onError(result.error)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveGithubToken = async (clear: boolean) => {
    setGithubBusy(clear ? 'clear' : 'token')
    try {
      const result = await api.setGithubToken({ token: clear ? '' : githubToken.trim() })
      if (!result.ok) onError(result.error)
      else {
        onError(null)
        setGithubToken('')
        setGithubLogin(result.data)
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setGithubBusy(null)
    }
  }

  const pushNow = async () => {
    const projectId = pushProjectId || activeProjects[0]?.id
    if (!projectId) return
    setGithubBusy('push')
    setPushResult(null)
    try {
      const result = await api.githubPush({ projectId })
      if (!result.ok) onError(result.error)
      else {
        onError(null)
        setPushResult(tr('已推送到 {repo}（{branch}）：{url}', { repo: result.data.repo, branch: result.data.branch, url: result.data.url }))
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setGithubBusy(null)
    }
  }

  const runAutomationNow = async (automation: Automation) => {
    setAutoBusy(automation.id)
    try {
      const result = await api.runAutomation({ automationId: automation.id })
      if (!result.ok) onError(result.error)
      else onError(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setAutoBusy(null)
    }
  }

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyHandoff = async () => {
    const result = await api.copyText({ text: handoffPrompt })
    if (result.ok) {
      setCopied(true)
      onError(null)
    } else {
      onError(tr('复制失败，请手动选择下方文本复制。'))
    }
  }

  const restoreProject = async (projectId: string) => {
    setRestoring(projectId)
    try {
      const result = await api.updateProject({ projectId, archived: false })
      if (!result.ok) onError(result.error)
      else onError(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoring(null)
    }
  }

  const savedSnapshot = useRef(JSON.stringify(settings))

  useEffect(() => {
    setDraft(settings)
    savedSnapshot.current = JSON.stringify(settings)
  }, [settings])

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  const errors = useMemo(() => {
    const parsed = settingsSchema.safeParse(draft)
    const map = new Map<string, string>()
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.map(String).join('.')
        if (!map.has(key)) map.set(key, issueMessage(issue, tr))
      }
    }
    return map
  }, [draft, tr])

  const errorFor = (...paths: string[]) => {
    for (const path of paths) {
      const direct = errors.get(path)
      if (direct) return direct
      for (const [key, message] of errors) if (key.startsWith(`${path}.`)) return message
    }
    return undefined
  }

  const sectionErrors = (id: SectionId) => {
    const prefixes = sectionPrefixes[id] ?? []
    let count = 0
    for (const key of errors.keys()) if (prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))) count++
    return count
  }

  const edit = (updater: (current: Settings) => Settings) => {
    setSaved(false)
    setDraft(updater)
  }

  const patch = <K extends 'general' | 'appearance' | 'modelParams' | 'agent' | 'permissions' | 'chat' | 'github' | 'plugins' | 'work' | 'browser' | 'sound' | 'image' | 'beta'>(group: K, value: Partial<Settings[K]>) =>
    edit((current) => ({ ...current, [group]: { ...current[group], ...value } }))

  const pickBackground = () => {
    const picker = document.createElement('input')
    picker.type = 'file'
    picker.accept = 'image/png,image/jpeg,image/gif,image/webp'
    picker.onchange = () => {
      const file = picker.files?.[0]
      if (!file) return
      if (file.size > 10 * 1024 * 1024) { onError(tr('背景图片过大（超过 10MB），请更换。')); return }
      const reader = new FileReader()
      reader.onload = () => { if (typeof reader.result === 'string') patch('appearance', { background: { ...draft.appearance.background, image: reader.result } }) }
      reader.onerror = () => onError(tr('背景图片读取失败，请重试。'))
      reader.readAsDataURL(file)
    }
    picker.click()
  }

  const updateAutomation = (id: string, value: Partial<Automation>) =>
    edit((current) => ({ ...current, automations: current.automations.map((item) => (item.id === id ? { ...item, ...value } : item)) }))

  const addAutomation = () => {
    const id = `auto-${Date.now().toString(36)}`
    edit((current) => ({
      ...current,
      automations: [...current.automations, { id, name: tr('新自动化'), projectId: activeProjects[0]?.id ?? '', modelId: current.defaultModelId, prompt: '', schedule: 'daily', intervalMin: 1440, time: '09:00', weekdays: [1, 2, 3, 4, 5], enabled: false }],
    }))
    setOpen((current) => new Set(current).add(id))
  }

  const updateMcp = (id: string, value: Partial<McpServer>) =>
    edit((current) => ({ ...current, mcp: { servers: current.mcp.servers.map((item) => (item.id === id ? { ...item, ...value } : item)) } }))

  const addMcp = () => {
    const id = `mcp-${Date.now().toString(36)}`
    edit((current) => {
      const names = new Set(current.mcp.servers.map((item) => item.name))
      let n = current.mcp.servers.length + 1
      while (names.has(`server${n}`)) n++
      return { ...current, mcp: { servers: [...current.mcp.servers, { id, name: `server${n}`, command: '', args: [], env: {}, enabled: true }] } }
    })
    setOpen((current) => new Set(current).add(id))
  }

  const removeMcp = (id: string) =>
    edit((current) => ({ ...current, mcp: { servers: current.mcp.servers.filter((item) => item.id !== id) } }))

  const removeAutomation = (id: string) =>
    edit((current) => ({ ...current, automations: current.automations.filter((item) => item.id !== id) }))

  const togglePlugin = (name: string, enabled: boolean) => {
    if (name === 'browser' || name === 'search' || name === 'computer' || name === 'image') patch('plugins', { [name]: enabled })
    else edit((current) => {
      const disabled = new Set(current.plugins.disabled)
      if (enabled) disabled.delete(name)
      else disabled.add(name)
      return { ...current, plugins: { ...current.plugins, disabled: [...disabled] } }
    })
  }

  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const updateProvider = (index: number, value: Partial<ProviderConfig>) =>
    edit((current) => ({ ...current, providers: current.providers.map((item, i) => (i === index ? { ...item, ...value } : item)) }))

  const updateModel = (index: number, value: Partial<ModelConfig>) =>
    edit((current) => ({ ...current, models: current.models.map((item, i) => (i === index ? { ...item, ...value } : item)) }))

  const addProvider = () => {
    const id = `provider-${Date.now().toString(36)}`
    edit((current) => ({ ...current, providers: [...current.providers, { id, name: tr('新提供商'), kind: 'openai-compatible', baseUrl: defaultBaseUrl['openai-compatible'], hasKey: false }] }))
    setOpen((current) => new Set(current).add(id))
  }

  const removeProvider = (index: number) =>
    edit((current) => {
      const removed = current.providers[index]
      const models = current.models.filter((model) => model.providerId !== removed.id)
      return {
        ...current,
        providers: current.providers.filter((_, i) => i !== index),
        models,
        defaultModelId: models.some((model) => model.id === current.defaultModelId) ? current.defaultModelId : (models[0]?.id ?? ''),
      }
    })

  const addModel = () => {
    const id = `model-${Date.now().toString(36)}`
    edit((current) => ({
      ...current,
      models: [...current.models, { id, providerId: current.providers[0]?.id ?? '', name: tr('新模型'), modelId: '' }],
      defaultModelId: current.defaultModelId || id,
    }))
    setOpen((current) => new Set(current).add(id))
  }

  const removeModel = (index: number) =>
    edit((current) => {
      const removed = current.models[index]
      const models = current.models.filter((_, i) => i !== index)
      return { ...current, models, defaultModelId: current.defaultModelId === removed.id ? (models[0]?.id ?? '') : current.defaultModelId }
    })

  const saveKey = async (providerId: string, value: string) => {
    setKeyBusy(providerId)
    try {
      const result = await api.setProviderKey({ providerId, apiKey: value.trim() })
      if (!result.ok) onError(result.error)
      else {
        onError(null)
        setKeyDrafts((current) => ({ ...current, [providerId]: '' }))
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setKeyBusy(null)
    }
  }

  const testModel = async (model: ModelConfig) => {
    const provider = draft.providers.find((item) => item.id === model.providerId)
    if (!provider) return
    if (errorFor(`providers.${draft.providers.indexOf(provider)}`) || errorFor(`models.${draft.models.indexOf(model)}`)) {
      setTests((current) => ({ ...current, [model.id]: { ok: false, latencyMs: 0, message: tr('请先修正提供商或模型中标红的字段') } }))
      return
    }
    setTests((current) => ({ ...current, [model.id]: 'pending' }))
    try {
      const apiKey = (keyDrafts[provider.id] ?? '').trim()
      const result = await api.testConnection({ provider, model, ...(apiKey ? { apiKey } : {}) })
      setTests((current) => ({ ...current, [model.id]: result.ok ? result.data : { ok: false, latencyMs: 0, message: result.error } }))
    } catch (error) {
      setTests((current) => ({ ...current, [model.id]: { ok: false, latencyMs: 0, message: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const detectModels = async (provider: ProviderConfig) => {
    setDiscovery((current) => ({ ...current, [provider.id]: { status: 'loading' } }))
    try {
      const apiKey = (keyDrafts[provider.id] ?? '').trim()
      const result = await api.listProviderModels({ provider, ...(apiKey ? { apiKey } : {}) })
      if (result.ok) setDiscovery((current) => ({ ...current, [provider.id]: { status: 'done', models: result.data } }))
      else setDiscovery((current) => ({ ...current, [provider.id]: { status: 'error', message: result.error } }))
    } catch (error) {
      setDiscovery((current) => ({ ...current, [provider.id]: { status: 'error', message: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const addDiscoveredModel = (provider: ProviderConfig, item: DiscoveredModelInfo) => {
    const id = `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    edit((current) => ({
      ...current,
      models: [...current.models, { id, providerId: provider.id, name: item.modelId, modelId: item.modelId, ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}) }],
      defaultModelId: current.defaultModelId || id,
    }))
    setOpen((current) => new Set(current).add(id))
  }

  const detectContext = async (model: ModelConfig) => {
    const provider = draft.providers.find((item) => item.id === model.providerId)
    if (!provider) return
    const index = draft.models.indexOf(model)
    setDiscovery((current) => ({ ...current, [`ctx-${model.id}`]: { status: 'loading' } }))
    try {
      const apiKey = (keyDrafts[provider.id] ?? '').trim()
      const result = await api.probeContextWindow({ provider, model, ...(apiKey ? { apiKey } : {}) })
      if (!result.ok) { setDiscovery((current) => ({ ...current, [`ctx-${model.id}`]: { status: 'error', message: result.error } })); return }
      const measured = result.data.contextWindow
      updateModel(index, { contextWindow: measured })
      setDiscovery((current) => ({ ...current, [`ctx-${model.id}`]: { status: 'info', message: result.data.capped
        ? tr('实测上下文至少 {n} tokens（已达探测上限，按此填写）', { n: measured.toLocaleString() })
        : tr('实测上下文约 {n} tokens（{tries} 次探测）', { n: measured.toLocaleString(), tries: result.data.attempts }) } }))
    } catch (error) {
      setDiscovery((current) => ({ ...current, [`ctx-${model.id}`]: { status: 'error', message: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const autoSave = async (next: Settings) => {
    const snapshot = JSON.stringify(next)
    savedSnapshot.current = snapshot
    setSaving(true)
    try {
      const result = await api.saveSettings(next)
      if (!result.ok) {
        onError(result.error)
        savedSnapshot.current = ''
      } else {
        onError(null)
        setSaved(true)
        if (mcpRequested.current) {
          setMcpTests({})
          void loadMcp()
          window.setTimeout(() => void loadMcp(), 2500)
        }
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
      savedSnapshot.current = ''
    } finally {
      setSaving(false)
    }
  }

  const autoSaveRef = useRef(autoSave)
  autoSaveRef.current = autoSave

  useEffect(() => {
    if (!dirty) return
    const parsed = settingsSchema.safeParse(draft)
    if (!parsed.success) return
    if (JSON.stringify(parsed.data) === savedSnapshot.current) return
    const timer = window.setTimeout(() => void autoSaveRef.current(parsed.data), 600)
    return () => window.clearTimeout(timer)
  }, [draft, dirty])

  const { general, appearance, modelParams, agent, permissions, chat, github, work, browser, sound, image } = draft
  const activeProjects = projects.filter((item) => !item.archived)

  const rows: Row[] = [
    { key: 'uiLanguage', section: 'general', group: '界面与语言', label: tr('界面语言'), hint: tr('应用界面显示使用的语言'), keywords: 'language ui interface 界面 中文 英文', render: () => <Choice label={tr('界面语言')} value={general.uiLanguage} options={uiLanguages} labels={uiLanguageLabels} onChange={(uiLanguage) => patch('general', { uiLanguage })} /> },
    { key: 'language', section: 'general', group: '界面与语言', label: tr('回复语言'), hint: tr('助手回复与说明使用的语言'), keywords: 'language 中文 英文', render: () => <Choice label={tr('回复语言')} value={general.language} options={languages} labels={languageLabels} onChange={(language) => patch('general', { language })} /> },
    { key: 'responseStyle', section: 'general', group: '界面与语言', label: tr('回复风格'), hint: tr('控制解释的详细程度'), keywords: 'style 简洁 详细', render: () => <Choice label={tr('回复风格')} value={general.responseStyle} options={responseStyles} labels={styleLabels} onChange={(responseStyle) => patch('general', { responseStyle })} /> },

    { key: 'soundEnabled', section: 'general', group: '提示音', label: tr('启用提示音'), hint: tr('任务状态变化时播放轻提示音（使用系统音频，无需额外文件）'), keywords: 'sound audio 提示音 声音', render: () => <Toggle label={tr('启用提示音')} checked={sound.enabled} onChange={(enabled) => patch('sound', { enabled })} /> },
    { key: 'soundOnDone', section: 'general', group: '提示音', label: tr('完成时提示音'), hint: tr('回复完成时播放'), keywords: 'sound done 完成 提示音', render: () => <Toggle label={tr('完成时提示音')} checked={sound.onDone} onChange={(onDone) => patch('sound', { onDone })} /> },
    { key: 'soundOnApproval', section: 'general', group: '提示音', label: tr('等待审批提示音'), hint: tr('需要你确认命令或改动时播放'), keywords: 'sound approval 审批 提示音', render: () => <Toggle label={tr('等待审批提示音')} checked={sound.onApproval} onChange={(onApproval) => patch('sound', { onApproval })} /> },
    { key: 'soundOnQuestion', section: 'general', group: '提示音', label: tr('等待输入提示音'), hint: tr('模型向你提问、等待回复时播放'), keywords: 'sound question 输入 提问 提示音', render: () => <Toggle label={tr('等待输入提示音')} checked={sound.onQuestion} onChange={(onQuestion) => patch('sound', { onQuestion })} /> },
    { key: 'soundVolume', section: 'general', group: '提示音', label: tr('提示音音量'), hint: '0–100%', keywords: 'sound volume 音量', render: () => (
      <div className="volume-row">
        <Slider label={tr('提示音音量')} min={0} max={100} step={5} value={Math.round(sound.volume * 100)} onChange={(volume) => patch('sound', { volume: volume / 100 })} />
        <span className="unit">{Math.round(sound.volume * 100)}%</span>
      </div>
    ) },

    { key: 'theme', section: 'general', group: '外观与显示', label: tr('主题'), keywords: 'theme dark light 深色 浅色', render: () => <Choice label={tr('主题')} value={appearance.theme} options={themes} labels={themeLabels} onChange={(theme) => patch('appearance', { theme })} /> },
    { key: 'accent', section: 'general', group: '外观与显示', label: tr('配色方案'), hint: tr('强调色与语义色'), keywords: 'accent color 配色 强调色 主题色', wide: true, render: () => (
      <div className="accent-grid" role="radiogroup" aria-label={tr('配色方案')}>
        {accents.map((value) => (
          <button key={value} type="button" role="radio" aria-checked={appearance.accent === value} className={`accent-swatch accent-${value}${appearance.accent === value ? ' selected' : ''}`} title={tr(accentLabels[value])} onClick={() => patch('appearance', { accent: value })}>
            <span className="accent-dot" /><span className="accent-name">{tr(accentLabels[value])}</span>
          </button>
        ))}
      </div>
    ) },
    { key: 'background', section: 'general', group: '外观与显示', label: tr('自定义背景'), hint: tr('选择本地图片作为背景，并调节透明度让文字保持清晰'), keywords: 'background 背景 图片 wallpaper 壁纸 透明度', wide: true, render: () => (
      <div className="background-setting">
        <div className="background-actions">
          <button type="button" className="ghost-button" onClick={pickBackground}>{appearance.background.image ? tr('更换图片') : tr('选择图片')}</button>
          {appearance.background.image && <button type="button" className="ghost-button" onClick={() => patch('appearance', { background: { ...appearance.background, image: undefined } })}>{tr('移除背景')}</button>}
        </div>
        {appearance.background.image && (
          <>
            <div className="background-preview" style={{ backgroundImage: `url(${appearance.background.image})` }} />
            <label className="background-opacity">
              <span>{tr('背景不透明度 {percent}%', { percent: Math.round(appearance.background.opacity * 100) })}</span>
              <input type="range" min={0} max={100} value={Math.round(appearance.background.opacity * 100)} onChange={(event) => patch('appearance', { background: { ...appearance.background, opacity: Number(event.target.value) / 100 } })} />
            </label>
          </>
        )}
      </div>
    ) },

    { key: 'betaTokenSaving', section: 'beta', label: tr('token节省与大型项目优化'), hint: tr('为项目建立 AOCI 认知索引：开启后自动为当前项目注册本地 aoci MCP 服务器，模型按需读取索引条目，避免每次任务重新通读整个仓库，从而节省 token 并支撑数十万行的大型项目。关闭即移除该服务器。'), keywords: 'beta aoci index 索引 token 节省 大型项目 认知 mcp', wide: true, render: () => (
      <Toggle label={tr('token节省与大型项目优化')} checked={draft.beta.tokenSaving} onChange={(tokenSaving) => patch('beta', { tokenSaving })} />
    ) },
    { key: 'betaAgentLoop', section: 'beta', label: tr('agent循环优化'), hint: tr('模型没调用工具时不再立即结束本轮，而是自动补问若干轮（默认 3 轮），补问后仍无工具调用才判定结束；期间一旦拿到工具调用就重新计数。停机语义移植自 agent-core。'), keywords: 'beta agent loop 循环 noTool 补问 停机 步数 maxSteps', wide: true, render: () => (
      <Toggle label={tr('agent循环优化')} checked={draft.beta.agentLoop} onChange={(agentLoop) => patch('beta', { agentLoop })} />
    ) },

    { key: 'computerMode', section: 'computer', label: tr('电脑操控运行位置'), hint: tr('当前桌面：AI 直接操作你的屏幕，操作前会等你空闲。独立桌面：AI 在单独的 Windows 桌面里启动和操控应用，完全不碰你的鼠标和键鼠。'), keywords: 'computer 电脑 操控 鼠标 桌面 独立 隔离 拖拽', wide: true, render: () => (
      <div className="approval-options" role="radiogroup" aria-label={tr('电脑操控运行位置')}>
        {computerModes.map((mode) => (
          <label key={mode} className={`approval-option${draft.computer.mode === mode ? ' selected' : ''}`}>
            <input type="radio" name="computer-mode" value={mode} checked={draft.computer.mode === mode} onChange={() => edit((current) => ({ ...current, computer: { ...current.computer, mode } }))} />
            <div>
              <span className="approval-name">{mode === 'current' ? tr('当前桌面') : tr('独立桌面')}</span>
              <span className="approval-hint">{mode === 'current' ? tr('AI 操作你的屏幕；检测到你在用键鼠时等待空闲') : tr('AI 拥有独立桌面和独立鼠标指针，可拖拽、双击、右键、滚动')}</span>
            </div>
          </label>
        ))}
      </div>
    ) },
    { key: 'computerIdle', section: 'computer', label: tr('操作前等待空闲（秒）'), hint: tr('仅当前桌面模式生效。检测到你在使用键鼠时，最多等待这么久；0 表示不等待，直接操作。'), keywords: 'idle 空闲 等待 鼠标 避让 computer', wide: true, render: () => (
      <NumberField label={tr('操作前等待空闲秒数')} nullable={false} value={draft.computer.idleWaitSec} min={0} max={300} step={1} onChange={(next) => edit((current) => ({ ...current, computer: { ...current.computer, idleWaitSec: next ?? 0 } }))} />
    ) },
    { key: 'computerMirror', section: 'computer', label: tr('独立桌面实时镜像'), hint: tr('开启后，使用独立桌面时会在右下角显示一个小窗实时播放独立桌面画面，你可以随时看到 AI 在做什么。'), keywords: 'mirror 镜像 独立桌面 小窗 预览', wide: true, render: () => (
      <Toggle label={tr('显示独立桌面实时镜像')} checked={draft.computer.mirror} onChange={(mirror) => edit((current) => ({ ...current, computer: { ...current.computer, mirror } }))} />
    ) },

    { key: 'floatingAuto', section: 'floating', label: tr('自动弹出悬浮窗'), hint: tr('任务开始打开网页、应用或独立桌面时，自动在右下角弹出置顶悬浮窗；关闭后仍可在标题栏手动打开。'), keywords: 'floating 悬浮窗 置顶 弹出 任务', wide: true, render: () => (
      <Toggle label={tr('任务运行时自动弹出悬浮窗')} checked={draft.floating.autoShow} onChange={(autoShow) => edit((current) => ({ ...current, floating: { ...current.floating, autoShow } }))} />
    ) },
    { key: 'floatingOpacity', section: 'floating', label: tr('悬浮窗透明度'), hint: tr('拖动调整悬浮窗整体透明度，最小 30%。'), keywords: 'opacity 透明度 悬浮窗', wide: true, render: () => (
      <div className="volume-row">
        <Slider label={tr('悬浮窗透明度')} min={30} max={100} value={Math.round(draft.floating.opacity * 100)} onChange={(opacity) => edit((current) => ({ ...current, floating: { ...current.floating, opacity: opacity / 100 } }))} />
        <span className="unit">{Math.round(draft.floating.opacity * 100)}%</span>
      </div>
    ) },
    { key: 'speechDownloadSource', section: 'general', group: '语音输入', label: tr('模型下载源'), hint: tr('官方源需要能访问 HuggingFace；网络受限时选国内镜像。自动会先试官方、失败后自动换镜像。'), keywords: 'speech download mirror hf-mirror 下载源 镜像 网络', wide: true, render: () => (
      <div className="approval-options" role="radiogroup" aria-label={tr('模型下载源')}>
        {speechDownloadSources.map((value) => (
          <label key={value} className={`approval-option${draft.speech.downloadSource === value ? ' selected' : ''}`}>
            <input type="radio" name="speech-download-source" value={value} checked={draft.speech.downloadSource === value} onChange={() => edit((current) => ({ ...current, speech: { ...current.speech, downloadSource: value } }))} />
            <div>
              <span className="approval-name">{tr(speechDownloadSourceLabels[value])}</span>
              {value !== 'auto' && <span className="approval-hint">{speechDownloadHostLabels[value]}</span>}
            </div>
          </label>
        ))}
      </div>
    ) },

    { key: 'speechModel', section: 'general', group: '语音输入', label: tr('语音识别模型'), hint: tr('模型越大中文识别越准，但首次下载更久、识别更慢。已下载过的模型可离线切换。'), keywords: 'speech asr whisper 语音 识别 模型', wide: true, render: () => (
      <div className="approval-options" role="radiogroup" aria-label={tr('语音识别模型')}>
        {speechModels.map((item) => (
          <label key={item.id} className={`approval-option${draft.speech.model === item.id ? ' selected' : ''}`}>
            <input type="radio" name="speech-model" value={item.id} checked={draft.speech.model === item.id} onChange={() => edit((current) => ({ ...current, speech: { ...current.speech, model: item.id } }))} />
            <div>
              <span className="approval-name">{tr(item.label)}</span>
              <span className="approval-hint">{item.id} · {tr(item.size)}</span>
            </div>
          </label>
        ))}
      </div>
    ) },

    { key: 'archived', section: 'archived', label: tr('已归档项目'), hint: tr('归档的项目不会出现在左侧列表，恢复后即可继续使用'), keywords: 'archive restore 归档 恢复 项目', wide: true, render: () => renderArchived() },

    { key: 'approvalMode', section: 'permissions', label: tr('审批模式'), hint: tr('修改文件或执行命令前是否需要你确认'), keywords: 'approval 审批 自动', wide: true, render: () => (
      <div className="approval-options" role="radiogroup" aria-label={tr('审批模式')}>
        {approvalModes.map((mode) => (
          <label key={mode} className={`approval-option${draft.approvalMode === mode ? ' selected' : ''}`}>
            <input type="radio" name="approval" value={mode} checked={draft.approvalMode === mode} onChange={() => edit((current) => ({ ...current, approvalMode: mode }))} />
            <div><span className="approval-name">{tr(approvalLabels[mode].name)}</span><span className="approval-hint">{tr(approvalLabels[mode].hint)}</span></div>
          </label>
        ))}
      </div>
    ) },
    { key: 'readOnly', section: 'permissions', label: tr('只读模式'), hint: tr('禁止写入文件与执行命令，只允许阅读和搜索'), keywords: 'read only 只读', render: () => <Toggle label={tr('只读模式')} checked={permissions.readOnly} onChange={(readOnly) => patch('permissions', { readOnly })} /> },
    { key: 'sandbox', section: 'permissions', label: tr('沙箱执行'), hint: tr('默认开启：命令在受限环境中运行，工作目录锁定在项目内、清理环境变量并拦截可能越权的命令'), keywords: 'sandbox 沙箱 隔离 安全', render: () => <Toggle label={tr('沙箱执行')} checked={permissions.sandbox} onChange={(sandbox) => patch('permissions', { sandbox })} /> },
    { key: 'sandboxNetwork', section: 'permissions', label: tr('沙箱内允许联网'), hint: tr('关闭时沙箱内禁止网络访问，npm install / git clone 等联网命令会失败；仅在开启沙箱时生效'), keywords: 'sandbox network 沙箱 网络 联网', render: () => <Toggle label={tr('沙箱内允许联网')} checked={permissions.sandboxNetwork} disabled={!permissions.sandbox} onChange={(sandboxNetwork) => patch('permissions', { sandboxNetwork })} /> },
    { key: 'allowCommands', section: 'permissions', label: tr('自动允许的命令'), hint: tr('命中后无需审批即可执行，如 npm test、git status；支持 * 通配'), keywords: 'allow whitelist 白名单 允许', wide: true, paths: ['permissions.allowCommands'], render: () => <RuleList label={tr('自动允许的命令')} rules={permissions.allowCommands} placeholder={tr('如 npm run lint')} onChange={(allowCommands) => patch('permissions', { allowCommands })} /> },
    { key: 'denyCommands', section: 'permissions', label: tr('禁止的命令'), hint: tr('命中后一律拒绝，优先级高于允许列表；支持 * 通配'), keywords: 'deny blacklist 黑名单 禁止', wide: true, paths: ['permissions.denyCommands'], render: () => <RuleList label={tr('禁止的命令')} rules={permissions.denyCommands} placeholder={tr('如 git push --force')} onChange={(denyCommands) => patch('permissions', { denyCommands })} /> },
    { key: 'confirmDelete', section: 'permissions', label: tr('删除前确认'), hint: tr('删除任务或移除项目前弹出确认'), keywords: 'delete 删除 任务 项目', render: () => <Toggle label={tr('删除前确认')} checked={general.confirmDelete} onChange={(confirmDelete) => patch('general', { confirmDelete })} /> },

    { key: 'mcp', section: 'mcp', label: tr('MCP 服务器'), hint: tr('通过 Model Context Protocol 接入外部工具'), keywords: 'mcp server 工具 协议', wide: true, render: () => renderMcp() },

    { key: 'skills', section: 'skills', label: tr('技能'), hint: tr('上传 Markdown / 文本技能文件，在对话输入框用 / 名称即可调用其内容'), keywords: 'skill 技能 slash / prompt 提示词 模板 上传 导入', wide: true, render: () => renderSkills() },

    { key: 'providers', section: 'providers', label: tr('提供商与模型'), hint: tr('OpenAI 兼容接口、Anthropic 或本机 Ollama；每个模型可展开“高级”覆盖参数'), keywords: 'provider model api key endpoint 端点 密钥 测试连接 默认模型 温度 temperature max tokens 超时 重试 上下文', wide: true, render: () => renderProviders() },
    { key: 'globalParams', section: 'providers', label: tr('全局默认参数'), hint: tr('未在模型“高级”中单独设置时使用'), keywords: 'temperature 温度 max tokens 超时 timeout 重试 retry 上下文 history 默认', wide: true, paths: ['modelParams'], render: () => (
      <ParamsForm label={tr('全局')} value={modelParams} errorPrefix="modelParams" errors={errors} onChange={(value) => patch('modelParams', value)} />
    ) },

    { key: 'imageProvider', section: 'providers', label: tr('图片生成 · 提供商'), hint: tr('用上方已配置的提供商调用其 OpenAI 兼容 /images/generations 接口；密钥复用提供商设置'), keywords: 'image provider 生图 图片 提供商 dall-e flux', wide: true, paths: ['image.providerId'], render: () => (
      <div className="image-provider">
        <Select className="field-select" label={tr('生图提供商')} value={image.providerId}
          options={draft.providers.length === 0
            ? [{ value: '', label: tr('请先在上方添加提供商') }]
            : [{ value: '', label: tr('未选择') }, ...draft.providers.map((item) => ({ value: item.id, label: item.name }))]}
          onChange={(providerId) => patch('image', { providerId })} />
        {draft.providers.length === 0 && <p className="field-hint">{tr('还没有提供商。先在「提供商与模型」里添加提供商并保存 API Key。')}</p>}
      </div>
    ) },
    { key: 'imageModel', section: 'providers', label: tr('生图模型 ID'), hint: tr('生图模型名称，如 dall-e-3、flux-schnell 或 provider 的其它图像模型'), keywords: 'image model 生图 模型 id', paths: ['image.modelId'], render: () => (
      <input aria-label={tr('生图模型 ID')} value={image.modelId} placeholder="dall-e-3" spellCheck={false} onChange={(event) => patch('image', { modelId: event.target.value })} />
    ) },
    { key: 'imageSize', section: 'providers', label: tr('生图默认尺寸'), hint: tr('generate_image 未显式指定 size 时使用；auto 表示交给模型决定'), keywords: 'image size 生图 尺寸 分辨率', paths: ['image.size'], render: () => (
      <Select className="field-select" label={tr('默认尺寸')} value={image.size}
        options={imageSizes.map((size) => ({ value: size, label: size === 'auto' ? tr('自动（模型决定）') : `${size} px` }))}
        onChange={(size) => patch('image', { size })} />
    ) },
    { key: 'imageHint', section: 'providers', label: tr('图片生成说明'), keywords: 'image generate 生图 说明 工具', wide: true, render: () => (
      <div className="about-block">
        <p>{tr('配置后模型会获得 generate_image 工具：传入提示词即可生成图片，结果自动保存到项目 .cubex/images 并直接显示在对话里。')}</p>
        <p>{tr('接口为 OpenAI 兼容的 POST /images/generations，支持返回 b64_json 或 url 两种格式；可在「插件」分区关闭该功能。')}</p>
      </div>
    ) },

    { key: 'plugins', section: 'plugins', label: tr('已安装插件'), hint: tr('内置浏览器与电脑控制插件，以及插件目录中你自己编写的插件；启用后其工具会提供给模型'), keywords: 'plugin browser computer 浏览器 电脑 控制 插件 扩展', wide: true, render: () => renderPlugins() },
    { key: 'pluginDev', section: 'plugins', label: tr('编写插件'), hint: tr('在插件目录中新建文件夹，放入 plugin.json 与入口脚本即可'), keywords: 'plugin develop 开发 编写 接口 manifest', wide: true, render: () => (
      <div className="about-block">
        <p>{tr('每个插件是插件目录下的一个文件夹：')}<code>plugin.json</code>{tr(' 声明 name、description、version 与 tools，每个工具包含 name、description、command（如 ')}<code>node index.js</code>{tr('、')}<code>python main.py</code>{tr('）和可选的 parameters（JSON Schema）。')}</p>
        <p>{tr('调用时在插件文件夹中执行 command：参数以 JSON 通过标准输入和环境变量 ')}<code>CUBEX_ARGS</code>{tr(' 传入，')}<code>CUBEX_TOOL</code>{tr(' 为工具名，')}<code>CUBEX_PROJECT_ROOT</code>{tr(' 为当前项目根目录；标准输出即返回给模型的结果，单次最长 120 秒。')}</p>
        <p>{tr('插件目录为空时会生成示例插件 hello 供参考。插件调用需要审批（完全自动模式除外），修改插件后点击“刷新”重新加载。')}</p>
        <p>{tr('完整的接口列表、Work 模式模块扩展与 MCP 说明见项目根目录的 plugins.md 开发文档。')}</p>
      </div>
    ) },

    { key: 'githubToken', section: 'github', label: tr('访问令牌'), hint: tr('需要 repo 权限的 Personal Access Token；通过系统加密保存在本机'), keywords: 'github token pat 令牌 密钥', wide: true, render: () => (
      <div className="github-token">
        <div className="key-row">
          <input type="password" aria-label={tr('GitHub 访问令牌')} value={githubToken} placeholder={github.hasToken ? tr('已保存，输入新令牌可替换') : tr('ghp_… 或 github_pat_…')} spellCheck={false} autoComplete="off" onChange={(event) => setGithubToken(event.target.value)} />
          <button type="button" className="btn-secondary" disabled={githubBusy !== null || !githubToken.trim()} onClick={() => void saveGithubToken(false)}>{githubBusy === 'token' ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}{tr('验证并保存')}</button>
          {github.hasToken && <button type="button" className="btn-secondary danger" disabled={githubBusy !== null} onClick={() => void saveGithubToken(true)}>{tr('清除')}</button>}
        </div>
        <p className="field-hint">{github.hasToken ? (githubLogin ? tr('已连接：{login}', { login: githubLogin }) : tr('已连接')) : tr('未配置令牌时，模型不会获得推送工具')}</p>
      </div>
    ) },
    { key: 'githubRepo', section: 'github', label: tr('目标仓库'), hint: tr('留空则使用项目文件夹名；仓库不存在时自动创建'), keywords: 'github repo 仓库', paths: ['github.repo'], render: () => (
      <input aria-label={tr('目标仓库')} value={github.repo} placeholder={tr('用户名/仓库名 或 仓库名')} spellCheck={false} onChange={(event) => patch('github', { repo: event.target.value })} />
    ) },
    { key: 'githubBranch', section: 'github', label: tr('推送分支'), keywords: 'github branch 分支', paths: ['github.branch'], render: () => (
      <input aria-label={tr('推送分支')} value={github.branch} spellCheck={false} onChange={(event) => patch('github', { branch: event.target.value })} />
    ) },
    { key: 'githubPrivate', section: 'github', label: tr('新建仓库设为私有'), keywords: 'github private 私有', render: () => <Toggle label={tr('新建仓库设为私有')} checked={github.private} onChange={(value) => patch('github', { private: value })} /> },
    { key: 'githubAutoPush', section: 'github', label: tr('允许 AI 自动推送'), hint: tr('开启后模型完成阶段性改动时会主动提交并推送；关闭时仅在你明确要求时推送'), keywords: 'github auto push 自动 推送 上传', render: () => <Toggle label={tr('允许 AI 自动推送')} checked={github.autoPush} onChange={(autoPush) => patch('github', { autoPush })} /> },
    { key: 'githubPushNow', section: 'github', label: tr('立即推送'), hint: tr('使用已保存的设置把所选项目提交并推送一次'), keywords: 'github push 推送 上传 立即', wide: true, render: () => (
      <div className="github-push">
        <div className="key-row">
          <Select className="field-select" label={tr('要推送的项目')} value={pushProjectId || activeProjects[0]?.id || ''} disabled={activeProjects.length === 0}
            options={activeProjects.length === 0 ? [{ value: '', label: tr('暂无项目') }] : activeProjects.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setPushProjectId} />
          <button type="button" className="btn-primary" disabled={githubBusy !== null || !settings.github.hasToken || activeProjects.length === 0 || dirty} onClick={() => void pushNow()}>{githubBusy === 'push' ? <LoaderCircle size={14} className="spin" /> : <CloudUpload size={14} />}{tr('推送')}</button>
        </div>
        <p className="field-hint">{!settings.github.hasToken ? tr('请先保存访问令牌') : dirty ? tr('请先保存设置更改') : pushResult ?? tr('推送前会自动初始化 Git 仓库并提交全部改动（遵循 .gitignore）')}</p>
      </div>
    ) },

    { key: 'automations', section: 'automation', label: tr('自动化任务'), hint: tr('应用运行期间按间隔或在每天/每周的指定时间，在指定项目中新建任务并发送指令；错过的定时会在应用下次运行时补跑一次；保存设置后生效'), keywords: 'automation schedule cron 自动化 定时 计划 任务', wide: true, render: () => renderAutomations() },

    { key: 'autoSwitchToChat', section: 'work', label: tr('运行后切换到 AI 对话'), hint: tr('在 Work 模式运行工作流时自动跳转到对应会话查看进度；关闭则留在画布，在后台运行'), keywords: 'work switch chat 切换 对话 工作流', render: () => <Toggle label={tr('运行后切换到 AI 对话')} checked={work.autoSwitchToChat} onChange={(autoSwitchToChat) => patch('work', { autoSwitchToChat })} /> },
    { key: 'confirmBeforeRun', section: 'work', label: tr('运行工作流前确认'), hint: tr('点击运行时先弹出确认，避免误触'), keywords: 'work confirm run 确认 运行', render: () => <Toggle label={tr('运行工作流前确认')} checked={work.confirmBeforeRun} onChange={(confirmBeforeRun) => patch('work', { confirmBeforeRun })} /> },
    { key: 'showControlBanner', section: 'work', label: tr('操控时显示提示条'), hint: tr('电脑或浏览器被自动操控时，在界面顶部显示醒目提示条'), keywords: 'control banner 操控 提示 浏览器 电脑', render: () => <Toggle label={tr('操控时显示提示条')} checked={work.showControlBanner} onChange={(showControlBanner) => patch('work', { showControlBanner })} /> },
    { key: 'escToStopControl', section: 'work', label: tr('按 Esc 结束操控'), hint: tr('操控进行中按 Esc 立即请求停止电脑/浏览器操控'), keywords: 'esc stop control 结束 操控', render: () => <Toggle label={tr('按 Esc 结束操控')} checked={work.escToStopControl} onChange={(escToStopControl) => patch('work', { escToStopControl })} /> },

    { key: 'browserHomepage', section: 'browser', label: tr('起始页'), hint: tr('新建浏览器任务时自动打开的网址，留空则显示空白工作台'), keywords: 'browser homepage 起始页 主页 网址', paths: ['browser.homepage'], render: () => (
      <input aria-label={tr('起始页')} value={browser.homepage} placeholder={tr('https://example.com（可留空）')} spellCheck={false} onChange={(event) => patch('browser', { homepage: event.target.value })} />
    ) },
    { key: 'browserSearchEngine', section: 'browser', label: tr('默认搜索引擎'), hint: tr('地址栏输入关键词按 Ctrl/Cmd+Enter，或 AI 搜索时使用的引擎'), keywords: 'browser search engine 搜索 引擎 bing google baidu', paths: ['browser.searchEngine'], render: () => (
      <Select<SearchEngine> className="field-select" label={tr('默认搜索引擎')} value={browser.searchEngine}
        options={searchEngines.map((engine) => ({ value: engine, label: engine === 'custom' ? tr('自定义') : ({ bing: 'Bing', google: 'Google', duckduckgo: 'DuckDuckGo', baidu: tr('百度') } as Record<string, string>)[engine] }))}
        onChange={(searchEngine) => patch('browser', { searchEngine })} />
    ) },
    { key: 'browserSearchTemplate', section: 'browser', label: tr('自定义搜索地址'), hint: tr('仅在搜索引擎选“自定义”时生效，用 {q} 表示查询词，例如 https://example.com/s?q={q}'), keywords: 'browser search template 自定义 搜索 地址', paths: ['browser.searchTemplate'], render: () => (
      <input aria-label={tr('自定义搜索地址')} value={browser.searchTemplate} placeholder={tr('https://example.com/search?q={q}')} spellCheck={false} disabled={browser.searchEngine !== 'custom'} onChange={(event) => patch('browser', { searchTemplate: event.target.value })} />
    ) },
    { key: 'browserStepApproval', section: 'browser', label: tr('逐步审批浏览器操作'), hint: tr('打开网址、点击、输入等敏感操作在执行前请求确认（受审批模式影响）'), keywords: 'browser approval step 审批 逐步 操作', render: () => <Toggle label={tr('逐步审批浏览器操作')} checked={browser.stepApproval} onChange={(stepApproval) => patch('browser', { stepApproval })} /> },
    { key: 'browserCrawlMode', section: 'browser', label: tr('全网爬取方式'), hint: tr('browser_crawl 批量抓取网页时的呈现方式：后台并行抓取并显示进度，或在可见视图里逐页打开'), keywords: 'browser crawl mode 爬取 全网 并行 逐页 后台 前台', paths: ['browser.crawlMode'], render: () => (
      <Select<CrawlMode> className="field-select" label={tr('全网爬取方式')} value={browser.crawlMode}
        options={[{ value: 'background', label: tr('后台并行（带进度）') }, { value: 'visible', label: tr('前台逐页可见') }]}
        onChange={(crawlMode) => patch('browser', { crawlMode })} />
    ) },
    { key: 'browserCrawlPages', section: 'browser', label: tr('单次爬取最多页数'), hint: tr('browser_crawl 单次最多抓取的网页数，3–20'), keywords: 'browser crawl pages 页数 爬取 最多', paths: ['browser.crawlPages'], render: () => <NumberField label={tr('单次爬取最多页数')} value={browser.crawlPages} min={3} max={20} unit={tr('页')} onChange={(value) => patch('browser', { crawlPages: value ?? Number.NaN })} /> },
    { key: 'browserLeaseMinutes', section: 'browser', label: tr('会话保留时长'), hint: tr('浏览器任务空闲后保留会话与登录状态的时长，1–180 分钟'), keywords: 'browser lease session 会话 时长 租约', paths: ['browser.leaseMinutes'], render: () => <NumberField label={tr('会话保留时长')} value={browser.leaseMinutes} min={1} max={180} unit={tr('分钟')} onChange={(value) => patch('browser', { leaseMinutes: value ?? Number.NaN })} /> },
    { key: 'browserAllowDownloads', section: 'browser', label: tr('允许下载文件'), hint: tr('关闭时会阻止页面触发的文件下载，避免自动写入磁盘'), keywords: 'browser download 下载', render: () => <Toggle label={tr('允许下载文件')} checked={browser.allowDownloads} onChange={(allowDownloads) => patch('browser', { allowDownloads })} /> },
    { key: 'browserAllowNewWindows', section: 'browser', label: tr('允许打开新窗口'), hint: tr('页面尝试打开新窗口/标签页时，在当前视图内加载 http/https 网址；关闭则一律拦截'), keywords: 'browser popup new window 新窗口 弹窗', render: () => <Toggle label={tr('允许打开新窗口')} checked={browser.allowNewWindows} onChange={(allowNewWindows) => patch('browser', { allowNewWindows })} /> },
    { key: 'browserUserAgent', section: 'browser', label: tr('自定义 User-Agent'), hint: tr('留空则使用默认 UA；仅在需要模拟特定浏览器时填写'), keywords: 'browser user agent ua 标识', paths: ['browser.userAgent'], render: () => (
      <input aria-label={tr('自定义 User-Agent')} value={browser.userAgent} placeholder={tr('留空使用默认')} spellCheck={false} onChange={(event) => patch('browser', { userAgent: event.target.value })} />
    ) },

    { key: 'shell', section: 'worktree', label: tr('命令 Shell'), hint: tr('执行命令使用的终端'), keywords: 'shell powershell bash cmd 终端', render: () => <Choice label={tr('命令 Shell')} value={agent.shell} options={shells} labels={shellLabels} onChange={(shell) => patch('agent', { shell })} /> },
    { key: 'commandTimeoutSec', section: 'worktree', label: tr('命令超时'), hint: tr('单条命令最长执行时间，5–1800 秒'), keywords: 'command timeout 命令', paths: ['agent.commandTimeoutSec'], render: () => <NumberField label={tr('命令超时')} value={agent.commandTimeoutSec} min={5} max={1800} unit={tr('秒')} onChange={(value) => patch('agent', { commandTimeoutSec: value ?? Number.NaN })} /> },
    { key: 'verifyChanges', section: 'worktree', label: tr('改动后自动验证'), hint: tr('修改代码后运行测试、类型检查或构建'), keywords: 'verify test 测试 验证', render: () => <Toggle label={tr('改动后自动验证')} checked={agent.verifyChanges} onChange={(verifyChanges) => patch('agent', { verifyChanges })} /> },

    { key: 'contextFiles', section: 'rules', label: tr('项目上下文文件'), hint: tr('项目根目录的 goal.md、plan.md、memory.md、agents.md 会自动注入系统提示并在任务推进时实时更新'), keywords: 'memory plan goal agents 记忆 规则 上下文 文件', wide: true, render: () => (
      <div className="about-block">
        <p>{tr('打开新项目或项目中缺少这四个文件时会自动创建；已存在则原样作为参考。助手每完成一个阶段会更新 plan.md 与 memory.md，你也可以直接在项目中手动编辑。')}</p>
      </div>
    ) },
    { key: 'planFirst', section: 'rules', label: tr('复杂任务先给计划'), hint: tr('多步骤任务先列出简短计划再动手'), keywords: 'plan 计划', render: () => <Toggle label={tr('复杂任务先给计划')} checked={agent.planFirst} onChange={(planFirst) => patch('agent', { planFirst })} /> },
    { key: 'autoTodo', section: 'rules', label: tr('复杂任务自动生成待办'), hint: tr('除简单问答外，动手前先拆成待办清单并逐项完成，防止长任务中途丢失进度'), keywords: 'todo 待办 清单 任务 记忆 拆解 进度', render: () => <Toggle label={tr('复杂任务自动生成待办')} checked={agent.autoTodo} onChange={(autoTodo) => patch('agent', { autoTodo })} /> },
    { key: 'autoSelectRecommended', section: 'rules', label: tr('自动选择推荐项'), hint: tr('开启后直接采用助手标记的推荐选项；没有有效推荐项时仍会询问。多选问题只采用被推荐的那一项。'), keywords: 'recommended 推荐 自动 询问 选项', paths: ['agent.autoSelectRecommended'], render: () => <Toggle label={tr('自动选择推荐项')} checked={agent.autoSelectRecommended} onChange={(autoSelectRecommended) => patch('agent', { autoSelectRecommended })} /> },
    { key: 'maxSteps', section: 'rules', label: tr('单轮最多步数'), hint: tr('模型连续调用工具的上限，1–200'), keywords: 'steps 步数 循环', paths: ['agent.maxSteps'], render: () => <NumberField label={tr('单轮最多步数')} value={agent.maxSteps} min={1} max={200} unit={tr('步')} onChange={(value) => patch('agent', { maxSteps: value ?? Number.NaN })} /> },
    { key: 'subagentConcurrency', section: 'rules', label: tr('子智能体并发上限'), hint: tr('每批最多 32 个子任务，超出并发上限的任务自动排队。'), keywords: 'subagent delegate 并发 子智能体', paths: ['agent.maxConcurrentSubagents'], render: () => <NumberField label={tr('子智能体并发上限')} value={agent.maxConcurrentSubagents} min={1} max={16} onChange={(value) => patch('agent', { maxConcurrentSubagents: value ?? Number.NaN })} /> },
    { key: 'subagentProfiles', section: 'rules', label: tr('子智能体配置'), hint: tr('分别设置角色、模型和指令，主智能体可按任务选择配置。研究和审查角色始终只读。'), keywords: 'subagent delegate 角色 模型 权限 子智能体', paths: ['agent.subagentProfiles'], wide: true, render: () => (
      <div className="item-list">
        {agent.subagentProfiles.map((profile, index) => {
          const update = (value: Partial<Settings['agent']['subagentProfiles'][number]>) => edit((current) => ({ ...current, agent: { ...current.agent, subagentProfiles: current.agent.subagentProfiles.map((item) => item.id === profile.id ? { ...item, ...value } : item) } }))
          const readOnlyRole = profile.role === 'researcher' || profile.role === 'reviewer'
          return (
            <div className="item-card" key={profile.id}>
              <div className="item-body">
                <div className="grid-form">
                  <label className="field">
                    <span>{tr('子智能体名称')}</span>
                    <input value={profile.name} maxLength={40} onChange={(event) => update({ name: event.target.value })} />
                    <FieldError message={errors.get(`agent.subagentProfiles.${index}.name`)} />
                  </label>
                  <label className="field">
                    <span>{tr('子智能体角色')}</span>
                    <Select<Settings['agent']['subagentProfiles'][number]['role']> className="field-select" label={tr('子智能体角色')} value={profile.role}
                      options={[{ value: 'general', label: tr('通用子智能体') }, { value: 'researcher', label: tr('研究子智能体') }, { value: 'coder', label: tr('编码子智能体') }, { value: 'reviewer', label: tr('审查子智能体') }]}
                      onChange={(role) => update({ role, ...(role === 'researcher' || role === 'reviewer' ? { toolAccess: 'read-only' as const } : {}) })} />
                  </label>
                  <label className="field">
                    <span>{tr('子智能体模型')}</span>
                    <Select className="field-select" label={tr('子智能体模型')} value={profile.modelId}
                      options={[{ value: '', label: tr('沿用主智能体模型') }, ...(profile.modelId && !draft.models.some((model) => model.id === profile.modelId) ? [{ value: profile.modelId, label: tr('子智能体模型已删除，请重选') }] : []), ...draft.models.map((model) => ({ value: model.id, label: model.name }))]}
                      onChange={(modelId) => update({ modelId })} />
                  </label>
                  <label className="field">
                    <span>{tr('子智能体工具权限')}</span>
                    <Select<Settings['agent']['subagentProfiles'][number]['toolAccess']> className="field-select" label={tr('子智能体工具权限')} value={readOnlyRole ? 'read-only' : profile.toolAccess}
                      options={[{ value: 'read-only', label: tr('只读与检索') }, ...(!readOnlyRole ? [{ value: 'project' as const, label: tr('沿用项目权限与审批') }] : [])]}
                      onChange={(toolAccess) => update({ toolAccess })} />
                  </label>
                  <label className="field">
                    <span>{tr('子智能体专属指令')}</span>
                    <textarea rows={3} maxLength={8000} value={profile.instruction} onChange={(event) => update({ instruction: event.target.value })} />
                    <FieldError message={errors.get(`agent.subagentProfiles.${index}.instruction`)} />
                  </label>
                </div>
                <button type="button" className="btn-secondary" onClick={() => edit((current) => ({ ...current, agent: { ...current.agent, subagentProfiles: current.agent.subagentProfiles.filter((item) => item.id !== profile.id) } }))}><Trash2 size={14} />{tr('移除子智能体配置')}</button>
              </div>
            </div>
          )
        })}
        <button type="button" className="btn-secondary" disabled={agent.subagentProfiles.length >= 16} onClick={() => edit((current) => ({ ...current, agent: { ...current.agent, subagentProfiles: [...current.agent.subagentProfiles, { id: crypto.randomUUID(), name: tr('子智能体配置 {n}', { n: current.agent.subagentProfiles.length + 1 }), role: 'general', modelId: '', instruction: '', toolAccess: 'project' }] } }))}><Plus size={14} />{tr('添加子智能体配置')}</button>
      </div>
    ) },
    { key: 'handoff', section: 'rules', label: tr('从其他 app 中继续未完成的工作'), hint: tr('复制下方提示词，在原来的 AI 应用里发送，让它把项目交接资料写入四个上下文文件，然后在 CubexDesktop 中打开该项目即可续接'), keywords: 'handoff continue 继续 交接 迁移 复制 提示词', wide: true, render: () => (
      <div className="handoff-block">
        <button type="button" className="btn-primary" onClick={() => void copyHandoff()}>{copied ? <><Check size={14} />{tr('已复制')}</> : <><Copy size={14} />{tr('复制交接提示词')}</>}</button>
        <pre className="handoff-text">{handoffPrompt}</pre>
      </div>
    ) },

    { key: 'fontFamily', section: 'general', group: '字体与排版', label: tr('界面字体'), hint: tr('整体界面字体风格'), keywords: 'font family 字体 黑体 宋体', render: () => <Choice label={tr('界面字体')} value={appearance.fontFamily} options={fontFamilies} labels={fontFamilyLabels} onChange={(fontFamily) => patch('appearance', { fontFamily })} /> },
    { key: 'fontSize', section: 'general', group: '字体与排版', label: tr('界面字号'), hint: '12–18', keywords: 'font 字体', paths: ['appearance.fontSize'], render: () => <NumberField label={tr('界面字号')} value={appearance.fontSize} min={12} max={18} unit="px" onChange={(value) => patch('appearance', { fontSize: value ?? Number.NaN })} /> },
    { key: 'codeFontSize', section: 'general', group: '字体与排版', label: tr('代码字号'), hint: tr('工具输出与差异的字号，11–18'), keywords: 'code font mono 等宽', paths: ['appearance.codeFontSize'], render: () => <NumberField label={tr('代码字号')} value={appearance.codeFontSize} min={11} max={18} unit="px" onChange={(value) => patch('appearance', { codeFontSize: value ?? Number.NaN })} /> },
    { key: 'density', section: 'general', group: '字体与排版', label: tr('界面密度'), keywords: 'density 紧凑', render: () => <Choice label={tr('界面密度')} value={appearance.density} options={densities} labels={densityLabels} onChange={(density) => patch('appearance', { density })} /> },
    { key: 'reduceMotion', section: 'general', group: '字体与排版', label: tr('减少动效'), hint: tr('关闭过渡与动画'), keywords: 'motion animation 动画', render: () => <Toggle label={tr('减少动效')} checked={appearance.reduceMotion} onChange={(reduceMotion) => patch('appearance', { reduceMotion })} /> },
    { key: 'showUsage', section: 'general', group: '对话与通知', label: tr('显示 Token 用量'), hint: tr('在每条回复下方显示输入 / 输出 Token 数'), keywords: 'usage token 用量', render: () => <Toggle label={tr('显示 Token 用量')} checked={chat.showUsage} onChange={(showUsage) => patch('chat', { showUsage })} /> },
    { key: 'expandTools', section: 'general', group: '对话与通知', label: tr('默认展开工具输出'), keywords: 'tool output 工具', render: () => <Toggle label={tr('默认展开工具输出')} checked={chat.expandTools} onChange={(expandTools) => patch('chat', { expandTools })} /> },
    { key: 'autoScroll', section: 'general', group: '对话与通知', label: tr('自动滚动到最新消息'), keywords: 'scroll 滚动', render: () => <Toggle label={tr('自动滚动到最新消息')} checked={chat.autoScroll} onChange={(autoScroll) => patch('chat', { autoScroll })} /> },
    { key: 'notifyOnDone', section: 'general', group: '对话与通知', label: tr('完成时系统通知'), hint: tr('窗口不在前台时，回复完成或等待审批会发送通知'), keywords: 'notify notification 通知', render: () => <Toggle label={tr('完成时系统通知')} checked={chat.notifyOnDone} onChange={(notifyOnDone) => patch('chat', { notifyOnDone })} /> },


    { key: 'sendKey', section: 'shortcuts', label: tr('发送方式'), keywords: 'send enter ctrl 快捷键', render: () => <Choice label={tr('发送方式')} value={chat.sendKey} options={sendKeys} labels={sendKeyLabels} onChange={(sendKey) => patch('chat', { sendKey })} /> },
    { key: 'shortcutList', section: 'shortcuts', label: tr('常用快捷键'), keywords: 'shortcut hotkey 快捷键 键盘', wide: true, render: () => (
      <ul className="shortcut-list">
        {shortcutList.map((item) => <li key={item.keys}><kbd>{item.keys}</kbd><span>{tr(item.action)}</span></li>)}
      </ul>
    ) },
  ]

  function renderArchived() {
    const archived = projects.filter((item) => item.archived)
    if (archived.length === 0) return <div className="settings-empty">{tr('没有已归档的项目。在左侧项目菜单中选择“归档”后会出现在这里。')}</div>
    return (
      <ul className="archived-list">
        {archived.map((item) => (
          <li key={item.id}>
            <div className="archived-text">
              <span className="item-title">{item.name}</span>
              <span className="item-meta truncate">{item.path}</span>
            </div>
            <button type="button" className="btn-secondary" disabled={restoring === item.id} onClick={() => void restoreProject(item.id)}><ArchiveRestore size={14} />{restoring === item.id ? tr('恢复中…') : tr('恢复')}</button>
          </li>
        ))}
      </ul>
    )
  }

  function renderMcp() {
    const list = draft.mcp.servers
    const statusLabel: Record<McpStatus['status'], string> = { stopped: '未运行', connecting: '连接中', ready: '已连接', error: '连接失败' }
    return (
      <div className="automation-block">
        <div className="settings-section-head">
          <div><h3>{tr('MCP 服务器')}</h3><p>{tr('{count} / 20 · 以 stdio 方式启动本地进程，保存后自动连接', { count: list.length })}</p></div>
          <div className="row-actions">
            <button type="button" className="btn-secondary" disabled={mcpBusy} onClick={() => void loadMcp()}>{mcpBusy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{tr('刷新状态')}</button>
            <button type="button" className="btn-secondary" onClick={addMcp} disabled={list.length >= 20}><Plus size={14} />{tr('添加服务器')}</button>
          </div>
        </div>
        {list.length === 0 ? <div className="settings-empty">{tr('还没有 MCP 服务器。例如添加命令 npx、参数 -y 与 @modelcontextprotocol/server-filesystem 及目录路径，即可让模型使用其工具。')}</div> : list.map((item, index) => {
          const expanded = open.has(item.id)
          const issue = errorFor(`mcp.servers.${index}`)
          const live = mcpStatus?.find((entry) => entry.id === item.id)
          const test = mcpTests[item.id]
          const shown = test && test !== 'pending' ? test : live
          const tag = !item.enabled ? { text: tr('已停用'), cls: '' }
            : live ? { text: tr(statusLabel[live.status]), cls: live.status === 'ready' ? ' ok' : live.status === 'error' ? ' danger' : '' }
            : { text: tr('未保存'), cls: '' }
          return (
            <div className={`model-item${issue ? ' has-error' : ''}`} key={item.id}>
              <button type="button" className="item-summary" aria-expanded={expanded} onClick={() => toggle(item.id)}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="item-title">{item.name || tr('未命名服务器')}</span>
                <span className="item-meta truncate">{[item.command, ...item.args].join(' ') || tr('未设置启动命令')}{live?.status === 'ready' ? tr(' · {count} 个工具', { count: live.tools.length }) : ''}</span>
                {issue && <span className="tag danger">{tr('有错误')}</span>}
                <span className={`tag${tag.cls}`}>{tag.text}</span>
              </button>
              {expanded && (
                <div className="item-body">
                  <div className="grid-form">
                    <label className="field">
                      <span>{tr('名称')}</span>
                      <input value={item.name} spellCheck={false} aria-invalid={!!errors.get(`mcp.servers.${index}.name`)} onChange={(event) => updateMcp(item.id, { name: event.target.value })} />
                      <FieldError message={errors.get(`mcp.servers.${index}.name`) ?? errors.get('mcp.servers')} />
                    </label>
                    <label className="field">
                      <span>{tr('启动命令')}</span>
                      <input value={item.command} spellCheck={false} placeholder={tr('如 npx、uvx、node、python')} aria-invalid={!!errors.get(`mcp.servers.${index}.command`)} onChange={(event) => updateMcp(item.id, { command: event.target.value })} />
                      <FieldError message={errors.get(`mcp.servers.${index}.command`)} />
                    </label>
                    <label className="field full">
                      <span>{tr('参数（每行一个）')}</span>
                      <LinesField label={tr('参数')} value={item.args.join('\n')} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\projects'} parse={(text) => updateMcp(item.id, { args: parseArgs(text) })} invalid={!!errorFor(`mcp.servers.${index}.args`)} />
                      <FieldError message={errorFor(`mcp.servers.${index}.args`)} />
                    </label>
                    <label className="field full">
                      <span>{tr('环境变量（每行 KEY=VALUE）')}</span>
                      <LinesField label={tr('环境变量')} value={formatEnv(item.env)} placeholder="API_KEY=xxxx" parse={(text) => updateMcp(item.id, { env: parseEnv(text) })} invalid={!!errorFor(`mcp.servers.${index}.env`)} />
                      <FieldError message={errorFor(`mcp.servers.${index}.env`)} />
                    </label>
                  </div>
                  {test === 'pending' && <p className="field-hint">{tr('正在启动并握手…')}</p>}
                  {shown && (
                    <div className="mcp-status">
                      {shown.status === 'error' && <p className="field-error">{shown.error ?? tr('连接失败')}</p>}
                      {shown.status === 'ready' && (shown.tools.length > 0 ? (
                        <ul className="plugin-tools">
                          {shown.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></li>)}
                        </ul>
                      ) : <p className="field-hint">{tr('已连接，但该服务器没有提供工具。')}</p>)}
                    </div>
                  )}
                  <div className="row-actions">
                    <Toggle label={tr('启用 MCP 服务器 {name}', { name: item.name })} checked={item.enabled} onChange={(enabled) => updateMcp(item.id, { enabled })} />
                    <span className="field-hint">{item.enabled ? tr('已启用') : tr('已停用')}</span>
                    <span className="spacer" />
                    <button type="button" className="btn-secondary" disabled={test === 'pending' || !item.command.trim() || !!issue} onClick={() => void testMcp(item)}>{test === 'pending' ? <LoaderCircle size={14} className="spin" /> : <PlugZap size={14} />}{tr('测试连接')}</button>
                    <button type="button" className="btn-secondary danger" onClick={() => removeMcp(item.id)}><Trash2 size={14} />{tr('删除')}</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        <p className="field-hint">{tr('启用的服务器工具会通过 mcp_call 提供给模型；除完全自动模式外，每次调用都需要你批准。')}</p>
      </div>
    )
  }

  function renderPlugins() {
    const enabledIn = (item: PluginInfo) => item.name === 'browser' && item.builtin ? draft.plugins.browser
      : item.name === 'search' && item.builtin ? draft.plugins.search
      : item.name === 'computer' && item.builtin ? draft.plugins.computer
      : item.name === 'image' && item.builtin ? draft.plugins.image
      : !item.error && !draft.plugins.disabled.includes(item.name)
    return (
      <div className="plugin-block">
        <div className="settings-section-head">
          <div><h3>{tr('插件')}</h3><p>{plugins ? tr('{count} 个', { count: plugins.length }) : tr('加载中…')}</p></div>
          <div className="row-actions">
            <button type="button" className="btn-secondary" disabled={pluginsBusy} onClick={() => void loadPlugins()}>{pluginsBusy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{tr('刷新')}</button>
            <button type="button" className="btn-secondary" onClick={() => void openPluginsDir()}><FolderOpen size={14} />{tr('打开插件目录')}</button>
          </div>
        </div>
        {plugins === null ? <div className="settings-empty">{tr('正在读取插件…')}</div> : (
          <ul className="plugin-list">
            {plugins.map((item) => (
              <li key={`${item.builtin ? 'builtin' : 'user'}-${item.name}-${item.path ?? ''}`} className={`plugin-item${item.error ? ' has-error' : ''}`}>
                <div className="plugin-text">
                  <div className="plugin-title">
                    <span className="item-title">{item.name}</span>
                    {item.version && <span className="item-meta">v{item.version}</span>}
                    <span className={`tag${item.builtin ? ' ok' : ''}`}>{item.builtin ? tr('内置') : tr('自定义')}</span>
                    {item.error && <span className="tag danger">{tr('加载失败')}</span>}
                  </div>
                  {item.description && <p className="plugin-desc">{item.description}</p>}
                  {item.error && <p className="field-error">{item.error}</p>}
                  {item.tools.length > 0 && (
                    <ul className="plugin-tools">
                      {item.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></li>)}
                    </ul>
                  )}
                </div>
                <Toggle label={tr('启用插件 {name}', { name: item.name })} checked={enabledIn(item)} onChange={(value) => { if (!item.error) togglePlugin(item.name, value) }} />
              </li>
            ))}
          </ul>
        )}
        {draft.plugins.computer && <p className="field-hint">{tr('电脑控制可以截屏、输入和点击，每一步都会请求你批准。')}</p>}
        {draft.plugins.image && <p className="field-hint">{tr('图片生成使用「模型」分区中配置的生图模型，生成结果会保存到项目 .cubex/images。')}</p>}
      </div>
    )
  }

  function renderSkills() {
    return (
      <div className="plugin-block">
        <div className="settings-section-head">
          <div><h3>{tr('技能')}</h3><p>{skills ? tr('{count} 个', { count: skills.length }) : tr('加载中…')}</p></div>
          <div className="row-actions">
            <button type="button" className="btn-secondary" disabled={skillsBusy} onClick={() => void loadSkills()}>{skillsBusy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{tr('刷新')}</button>
            <button type="button" className="btn-secondary" onClick={() => void openSkillsDir()}><FolderOpen size={14} />{tr('打开技能目录')}</button>
            <button type="button" className="btn-primary" disabled={skillsBusy} onClick={() => void importSkills()}><Upload size={14} />{tr('导入技能')}</button>
          </div>
        </div>
        <p className="field-hint">{tr('支持 .md / .markdown / .txt；可用 YAML 头（name、description）自定义名称与说明。在对话输入框输入 / 加名称即可调用。')}</p>
        {skills === null ? <div className="settings-empty">{tr('正在读取技能…')}</div> : skills.length === 0 ? <div className="settings-empty">{tr('还没有技能，点击“导入技能”添加文件')}</div> : (
          <ul className="plugin-list">
            {skills.map((item) => (
              <li key={item.id} className="plugin-item">
                <div className="plugin-text">
                  <div className="plugin-title">
                    <span className="item-title">/{item.name}</span>
                    <span className={`tag${item.builtin ? ' ok' : ''}`}>{item.builtin ? tr('内置') : tr('自定义')}</span>
                  </div>
                  {item.description && <p className="plugin-desc">{item.description}</p>}
                  {skillPreview?.id === item.id && <pre className="skill-preview">{skillPreview.content}</pre>}
                </div>
                <div className="row-actions">
                  <button type="button" className="btn-secondary" onClick={() => void previewSkill(item.id)}>{skillPreview?.id === item.id ? tr('收起') : tr('预览')}</button>
                  {!item.builtin && <button type="button" className="icon-button danger" aria-label={tr('删除技能 {name}', { name: item.name })} title={tr('删除')} onClick={() => void removeSkill(item.id)}><Trash2 size={14} /></button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  function renderAutomations() {
    const list = draft.automations
    return (
      <div className="automation-block">
        <div className="settings-section-head">
          <div><h3>{tr('自动化')}</h3><p>{list.length} / 30</p></div>
          <button type="button" className="btn-secondary" onClick={addAutomation} disabled={list.length >= 30 || activeProjects.length === 0}><Plus size={14} />{tr('添加自动化')}</button>
        </div>
        {activeProjects.length === 0 && <div className="settings-empty">{tr('请先打开一个项目，再为它添加自动化任务。')}</div>}
        {list.length === 0 ? (activeProjects.length > 0 && <div className="settings-empty">{tr('还没有自动化。可用于每日依赖检查、定时汇总 TODO、定期跑测试等。')}</div>) : list.map((item, index) => {
          const expanded = open.has(item.id)
          const issue = errorFor(`automations.${index}`)
          const persisted = settings.automations.find((entry) => entry.id === item.id)
          const projectName = projects.find((entry) => entry.id === item.projectId)?.name ?? tr('项目不存在')
          const preset = intervalPresets.some((entry) => entry.value === item.intervalMin)
          const scheduleLabel = ((): string => {
            if (item.schedule === 'interval') {
              const found = intervalPresets.find((entry) => entry.value === item.intervalMin)?.label
              return found ? tr(found) : tr('每 {minutes} 分钟', { minutes: item.intervalMin })
            }
            if (item.schedule === 'daily') return tr('每天 {time}', { time: item.time })
            const days = [...item.weekdays].sort((a, b) => a - b)
            if (days.length === 7) return tr('每天 {time}', { time: item.time })
            const label = days.join() === '1,2,3,4,5' ? tr('工作日') : days.map((day) => tr(weekdayNames[day])).join(tr('、'))
            return tr('每周{label} {time}', { label, time: item.time })
          })()
          const next = persisted?.enabled ? nextRunAt(persisted, Date.now()) : null
          return (
            <div className={`model-item${issue ? ' has-error' : ''}`} key={item.id}>
              <button type="button" className="item-summary" aria-expanded={expanded} onClick={() => toggle(item.id)}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="item-title">{item.name || tr('未命名自动化')}</span>
                <span className="item-meta truncate">{projectName} · {scheduleLabel}{next !== null ? tr(' · 下次 {time}', { time: new Date(next).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : ''}{persisted?.lastRun ? tr(' · 上次 {time}', { time: new Date(persisted.lastRun).toLocaleString('zh-CN') }) : ''}</span>
                {issue && <span className="tag danger">{tr('有错误')}</span>}
                <span className={`tag${item.enabled ? ' ok' : ''}`}>{item.enabled ? tr('已启用') : tr('已停用')}</span>
              </button>
              {expanded && (
                <div className="item-body">
                  <div className="grid-form">
                    <label className="field">
                      <span>{tr('名称')}</span>
                      <input value={item.name} aria-invalid={!!errors.get(`automations.${index}.name`)} onChange={(event) => updateAutomation(item.id, { name: event.target.value })} />
                      <FieldError message={errors.get(`automations.${index}.name`)} />
                    </label>
                    <label className="field">
                      <span>{tr('项目')}</span>
                      <Select className="field-select" label={tr('项目')} value={item.projectId}
                        options={[
                          ...(!activeProjects.some((entry) => entry.id === item.projectId) ? [{ value: item.projectId, label: projectName }] : []),
                          ...activeProjects.map((entry) => ({ value: entry.id, label: entry.name })),
                        ]}
                        onChange={(value) => updateAutomation(item.id, { projectId: value })} />
                    </label>
                    <label className="field">
                      <span>{tr('模型')}</span>
                      <Select className="field-select" label={tr('模型')} value={item.modelId}
                        options={[{ value: '', label: tr('使用默认模型') }, ...draft.models.map((model) => ({ value: model.id, label: model.name }))]}
                        onChange={(value) => updateAutomation(item.id, { modelId: value })} />
                    </label>
                    <label className="field">
                      <span>{tr('任务来源')}</span>
                      <Select className="field-select" label={tr('任务来源')} value={item.workflowId ?? ''}
                        options={[
                          { value: '', label: tr('直接发送指令') },
                          ...(item.workflowId && !workflows.some((wf) => wf.id === item.workflowId) ? [{ value: item.workflowId, label: tr('工作流不存在（请重选）') }] : []),
                          ...workflows.map((wf) => ({ value: wf.id, label: tr('工作流：{name}', { name: wf.name }) })),
                        ]}
                        onChange={(value) => updateAutomation(item.id, { workflowId: value || undefined })} />
                    </label>
                    <label className="field">
                      <span>{tr('执行方式')}</span>
                      <Select<Automation['schedule']> className="field-select" label={tr('执行方式')} value={item.schedule}
                        options={[{ value: 'interval', label: tr('按间隔') }, { value: 'daily', label: tr('每天定时') }, { value: 'weekly', label: tr('每周定时') }]}
                        onChange={(value) => updateAutomation(item.id, { schedule: value })} />
                    </label>
                    {item.schedule === 'interval' ? (
                      <label className="field">
                        <span>{tr('执行间隔')}</span>
                        <div className="interval-row">
                          <Select className="field-select" label={tr('执行间隔')} value={preset ? String(item.intervalMin) : 'custom'}
                            options={[...intervalPresets.map((entry) => ({ value: String(entry.value), label: tr(entry.label) })), { value: 'custom', label: tr('自定义') }]}
                            onChange={(value) => { if (value !== 'custom') updateAutomation(item.id, { intervalMin: Number(value) }) }} />
                          <NumberField label={tr('间隔分钟数')} value={item.intervalMin} min={10} max={10080} unit={tr('分钟')} onChange={(value) => updateAutomation(item.id, { intervalMin: value ?? Number.NaN })} />
                        </div>
                        <FieldError message={errors.get(`automations.${index}.intervalMin`)} />
                      </label>
                    ) : (
                      <label className="field">
                        <span>{tr('执行时间')}</span>
                        <input type="time" aria-label={tr('执行时间')} value={item.time} aria-invalid={!!errors.get(`automations.${index}.time`)} onChange={(event) => updateAutomation(item.id, { time: event.target.value })} />
                        <FieldError message={errors.get(`automations.${index}.time`)} />
                      </label>
                    )}
                    {item.schedule === 'weekly' && (
                      <div className="field full">
                        <span>{tr('执行日')}</span>
                        <div className="weekday-chips" role="group" aria-label={tr('执行日')}>
                          {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                            const active = item.weekdays.includes(day)
                            return (
                              <button type="button" key={day} className={`weekday-chip${active ? ' active' : ''}`} aria-pressed={active} onClick={() => updateAutomation(item.id, { weekdays: active ? item.weekdays.filter((entry) => entry !== day) : [...item.weekdays, day].sort((a, b) => a - b) })}>{tr(weekdayNames[day])}</button>
                            )
                          })}
                        </div>
                        <FieldError message={errors.get(`automations.${index}.weekdays`)} />
                      </div>
                    )}
                    <label className="field full">
                      <span>{item.workflowId ? tr('附加指令（可选）') : tr('指令')}</span>
                      <textarea rows={4} value={item.prompt} maxLength={8000} aria-invalid={!!errors.get(`automations.${index}.prompt`)} placeholder={item.workflowId ? tr('已绑定工作流，将按工作流执行；此处留空即可，如需补充要求可填写') : tr('例如：运行 npm test，若有失败则定位原因并给出修复建议，把结论追加到 memory.md')} onChange={(event) => updateAutomation(item.id, { prompt: event.target.value })} />
                      <FieldError message={errors.get(`automations.${index}.prompt`)} />
                    </label>
                  </div>
                  <div className="row-actions">
                    <Toggle label={tr('启用自动化 {name}', { name: item.name })} checked={item.enabled} onChange={(enabled) => updateAutomation(item.id, { enabled })} />
                    <span className="field-hint">{item.enabled ? tr('已启用') : tr('已停用')}</span>
                    <span className="spacer" />
                    <button type="button" className="btn-secondary" disabled={!persisted || dirty || autoBusy !== null} title={!persisted || dirty ? tr('请先保存设置') : undefined} onClick={() => persisted && void runAutomationNow(persisted)}>{autoBusy === item.id ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{tr('立即运行')}</button>
                    <button type="button" className="btn-secondary danger" onClick={() => removeAutomation(item.id)}><Trash2 size={14} />{tr('删除')}</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  function renderProviders() {
    return (
      <div className="provider-block">
        <div className="settings-section-head">
          <div><h3>{tr('提供商')}</h3><p>{draft.providers.length} / 20</p></div>
          <button className="btn-secondary" onClick={addProvider} disabled={draft.providers.length >= 20}><Plus size={14} />{tr('添加提供商')}</button>
        </div>
        {draft.providers.length === 0 ? <div className="settings-empty">{tr('尚未配置提供商。添加后填写端点与 API Key。')}</div> : (
          <div>
            {draft.providers.map((provider, index) => {
              const expanded = open.has(provider.id)
              const issue = errorFor(`providers.${index}`)
              const keyDraft = keyDrafts[provider.id] ?? ''
              const persisted = settings.providers.some((item) => item.id === provider.id)
              return (
                <div className={`model-item${issue ? ' has-error' : ''}`} key={provider.id}>
                  <button type="button" className="item-summary" aria-expanded={expanded} onClick={() => toggle(provider.id)}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="item-title">{provider.name || tr('未命名提供商')}</span>
                    <span className="item-meta truncate">{tr(providerLabels[provider.kind])} · {provider.baseUrl}</span>
                    {issue && <span className="tag danger">{tr('有错误')}</span>}
                    <span className={`tag${provider.kind === 'ollama' || provider.hasKey ? ' ok' : ''}`}>{provider.kind === 'ollama' ? tr('本机') : provider.hasKey ? tr('已配置 Key') : keyDraft.trim() ? tr('待保存 Key') : tr('未配置 Key')}</span>
                  </button>
                  {expanded && (
                    <div className="item-body">
                      <div className="grid-form">
                        <label className="field">
                          <span>{tr('名称')}</span>
                          <input value={provider.name} aria-invalid={!!errors.get(`providers.${index}.name`)} onChange={(e) => updateProvider(index, { name: e.target.value })} />
                          <FieldError message={errors.get(`providers.${index}.name`)} />
                        </label>
                        <label className="field">
                          <span>{tr('类型')}</span>
                          <Select<ProviderConfig['kind']> className="field-select" label={tr('类型')} value={provider.kind}
                            options={providerKinds.map((kind) => ({ value: kind, label: tr(providerLabels[kind]) }))}
                            onChange={(kind) => updateProvider(index, { kind, baseUrl: Object.values(defaultBaseUrl).includes(provider.baseUrl) ? defaultBaseUrl[kind] : provider.baseUrl })} />
                        </label>
                        <label className="field full">
                          <span>{tr('端点')}</span>
                          <input value={provider.baseUrl} aria-invalid={!!errors.get(`providers.${index}.baseUrl`)} onChange={(e) => updateProvider(index, { baseUrl: e.target.value.trim() })} placeholder={tr('HTTP 或 HTTPS')} spellCheck={false} />
                          <FieldError message={errors.get(`providers.${index}.baseUrl`)} />
                          {!errors.get(`providers.${index}.baseUrl`) && provider.kind === 'openai-compatible' && <span className="field-hint">{tr('通常以 /v1 结尾，程序会自动拼接 /chat/completions')}</span>}
                        </label>
                        {provider.kind !== 'ollama' && (
                          <div className="field full">
                            <span>API Key</span>
                            <div className="key-row">
                              <input type="password" autoComplete="off" value={keyDraft} onChange={(e) => setKeyDrafts((current) => ({ ...current, [provider.id]: e.target.value }))} placeholder={provider.hasKey ? tr('已加密保存，输入新值可替换') : 'sk-…'} />
                              {persisted && !dirty && (
                                <button className="btn-secondary" type="button" disabled={keyBusy === provider.id || !keyDraft.trim()} onClick={() => void saveKey(provider.id, keyDraft)}><KeyRound size={14} />{tr('保存 Key')}</button>
                              )}
                              {provider.hasKey && persisted && <button className="btn-secondary" type="button" disabled={keyBusy === provider.id} onClick={() => void saveKey(provider.id, '')}>{tr('清除')}</button>}
                            </div>
                            <span className="field-hint">{persisted && !dirty ? tr('点击“保存 Key”立即生效') : tr('点击底部“保存”时会一并加密保存')}</span>
                          </div>
                        )}
                      </div>
                      {(() => {
                        const state = discovery[provider.id]
                        return (
                          <>
                            <div className="item-actions">
                              <button className="btn-secondary" type="button" disabled={state?.status === 'loading'} onClick={() => void detectModels(provider)}>
                                {state?.status === 'loading' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{tr('自动检测模型')}
                              </button>
                              <span className="spacer" />
                              <button className="btn-danger" onClick={() => removeProvider(index)}><Trash2 size={14} />{tr('删除提供商')}</button>
                            </div>
                            {state?.status === 'error' && (
                              <div className="test-result fail" role="status"><X size={14} /><span>{state.message}</span></div>
                            )}
                            {state?.status === 'done' && (
                              state.models.length === 0
                                ? <div className="test-result" role="status"><Info size={14} /><span>{tr('未检测到可用模型')}</span></div>
                                : (
                                  <div className="discovery-list">
                                    <p className="field-hint">{tr('检测到 {count} 个模型，点击“添加”即可创建：', { count: state.models.length })}</p>
                                    {state.models.map((item) => {
                                      const exists = draft.models.some((m) => m.providerId === provider.id && m.modelId === item.modelId)
                                      return (
                                        <div className="discovery-row" key={item.modelId}>
                                          <span className="discovery-id truncate">{item.modelId}</span>
                                          {item.contextWindow ? <span className="item-meta">{tr('上下文 {n}', { n: item.contextWindow.toLocaleString() })}</span> : null}
                                          <span className="spacer" />
                                          {exists
                                            ? <span className="tag ok"><Check size={11} />{tr('已添加')}</span>
                                            : <button className="btn-secondary" type="button" onClick={() => addDiscoveredModel(provider, item)}><Plus size={14} />{tr('添加')}</button>}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="settings-section-head sub">
          <div><h3>{tr('模型')}</h3><p>{tr('{count} / 60 · 默认模型用于新会话', { count: draft.models.length })}</p></div>
          <button className="btn-secondary" onClick={addModel} disabled={draft.models.length >= 60 || draft.providers.length === 0}><Plus size={14} />{tr('添加模型')}</button>
        </div>
        <FieldError message={errors.get('defaultModelId')} />
        {draft.models.length === 0 ? <div className="settings-empty">{draft.providers.length === 0 ? tr('请先添加提供商。') : tr('尚未配置模型。')}</div> : (
          <div>
            {draft.models.map((model, index) => {
              const expanded = open.has(model.id)
              const provider = draft.providers.find((item) => item.id === model.providerId)
              const isDefault = draft.defaultModelId === model.id
              const issue = errorFor(`models.${index}`)
              const test = tests[model.id]
              return (
                <div className={`model-item${issue ? ' has-error' : ''}`} key={model.id}>
                  <button type="button" className="item-summary" aria-expanded={expanded} onClick={() => toggle(model.id)}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="item-title">{model.name || tr('未命名模型')}</span>
                    <span className="item-meta truncate">{provider?.name ?? tr('提供商缺失')}{model.modelId ? ` · ${model.modelId}` : ''}</span>
                    {issue && <span className="tag danger">{tr('有错误')}</span>}
                    {test && test !== 'pending' && <span className={`tag${test.ok ? ' ok' : ' danger'}`}>{test.ok ? tr('连接正常') : tr('连接失败')}</span>}
                    {isDefault && <span className="tag ok"><Star size={11} />{tr('默认')}</span>}
                  </button>
                  {expanded && (
                    <div className="item-body">
                      <div className="grid-form">
                        <label className="field">
                          <span>{tr('显示名称')}</span>
                          <input value={model.name} aria-invalid={!!errors.get(`models.${index}.name`)} onChange={(e) => updateModel(index, { name: e.target.value })} />
                          <FieldError message={errors.get(`models.${index}.name`)} />
                        </label>
                        <label className="field">
                          <span>{tr('提供商')}</span>
                          <Select className="field-select" label={tr('提供商')} value={model.providerId} invalid={!!errors.get(`models.${index}.providerId`)}
                            options={[...(!provider ? [{ value: model.providerId, label: tr('请选择') }] : []), ...draft.providers.map((item) => ({ value: item.id, label: item.name }))]}
                            onChange={(value) => updateModel(index, { providerId: value })} />
                          <FieldError message={errors.get(`models.${index}.providerId`)} />
                        </label>
                        <label className="field">
                          <span>{tr('模型 ID')}</span>
                          <input value={model.modelId} aria-invalid={!!errors.get(`models.${index}.modelId`)} onChange={(e) => updateModel(index, { modelId: e.target.value.trim() })} placeholder={tr('如 gpt-4.1、claude-sonnet-4-5、qwen2.5-coder')} spellCheck={false} />
                          <FieldError message={errors.get(`models.${index}.modelId`) && tr('请填写服务商提供的模型 ID')} />
                        </label>
                        <label className="field">
                          <span>{tr('上下文窗口（可选）')}</span>
                          <div className="key-row">
                            <input type="number" min={4000} value={model.contextWindow ?? ''} aria-invalid={!!errors.get(`models.${index}.contextWindow`)} onChange={(e) => updateModel(index, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} placeholder={tr('如 128000')} />
                            {(() => {
                              const ctx = discovery[`ctx-${model.id}`]
                              return (
                                <button className="btn-secondary" type="button" disabled={!provider || ctx?.status === 'loading'} onClick={() => void detectContext(model)}>
                                  {ctx?.status === 'loading' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{tr('自动检测')}
                                </button>
                              )
                            })()}
                          </div>
                          {(() => {
                            const ctx = discovery[`ctx-${model.id}`]
                            if (ctx?.status === 'error') return <span className="field-hint danger">{ctx.message}</span>
                            if (ctx?.status === 'info') return <span className="field-hint">{ctx.message}</span>
                            return null
                          })()}
                          <FieldError message={errors.get(`models.${index}.contextWindow`) && tr('范围 4000–4000000 的整数')} />
                        </label>
                      </div>
                      {(() => {
                        const advKey = `${model.id}:adv`
                        const advOpen = open.has(advKey)
                        const overrides = Object.keys(model.params ?? {}).length + (model.systemPromptExtra?.trim() ? 1 : 0)
                        return (
                          <div className={`advanced-block${advOpen ? ' open' : ''}`}>
                            <button type="button" className="advanced-toggle" aria-expanded={advOpen} onClick={() => toggle(advKey)}>
                              {advOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              <span>{tr('高级')}</span>
                              <span className="item-meta">{overrides > 0 ? tr('已覆盖 {count} 项', { count: overrides }) : tr('使用全局默认参数')}</span>
                            </button>
                            {advOpen && (
                              <div className="advanced-body">
                                <p className="field-hint">{tr('留空的项沿用“全局默认参数”。')}</p>
                                <ParamsForm label={`${model.name || tr('模型')}`} value={model.params ?? {}} fallback={draft.modelParams} errorPrefix={`models.${index}.params`} errors={errors}
                                  onChange={(params) => updateModel(index, { params: Object.keys(params).length > 0 ? params : undefined })} />
                                <label className="field full">
                                  <span>{tr('模型专属提示词（追加到系统提示末尾）')}</span>
                                  <textarea rows={4} maxLength={4000} value={model.systemPromptExtra ?? ''} aria-invalid={!!errors.get(`models.${index}.systemPromptExtra`)} placeholder={tr('如：该模型偏好简洁输出，请避免重复解释。')} onChange={(e) => updateModel(index, { systemPromptExtra: e.target.value || undefined })} />
                                  <FieldError message={errors.get(`models.${index}.systemPromptExtra`)} />
                                </label>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                      {test && (
                        <div className={`test-result${test === 'pending' ? '' : test.ok ? ' ok' : ' fail'}`} role="status">
                          {test === 'pending' ? <><LoaderCircle size={14} className="spin" />{tr('正在测试连接…')}</> : <>{test.ok ? <Check size={14} /> : <X size={14} />}<span>{test.message}{test.latencyMs > 0 ? tr('（{ms} ms）', { ms: test.latencyMs }) : ''}</span></>}
                        </div>
                      )}
                      <div className="item-actions">
                        <button className="btn-secondary" disabled={test === 'pending' || !provider} onClick={() => void testModel(model)}><PlugZap size={14} />{tr('测试连接')}</button>
                        {!isDefault && <button className="btn-secondary" onClick={() => edit((current) => ({ ...current, defaultModelId: model.id }))}><Star size={14} />{tr('设为默认')}</button>}
                        <button className="btn-danger" onClick={() => removeModel(index)}><Trash2 size={14} />{tr('删除模型')}</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const pool = page ? rows.filter((row) => row.section === page) : rows.filter((row) => !hiddenSections.has(row.section))
  const visible = needle
    ? pool.filter((row) => {
      const meta = sections.find((item) => item.id === row.section)!
      return [row.label, row.hint ?? '', row.keywords ?? '', meta.title].join(' ').toLowerCase().includes(needle)
    })
    : pool.filter((row) => row.section === activeSection)
  const grouped = sections.map((meta) => ({ meta, rows: sortByGroup(visible.filter((row) => row.section === meta.id)) })).filter((group) => group.rows.length > 0)
  const totalErrors = errors.size

  return (
    <div className="settings-page">
      {!page && (
        <aside className="settings-nav" aria-label={tr('设置分类')}>
          <button className="nav-action settings-back" onClick={onClose}><ArrowLeft size={16} /><span>{tr('返回会话')}</span><kbd>Esc</kbd></button>
          <label className="settings-search">
            <Search size={14} />
            <input type="search" aria-label={tr('搜索设置')} placeholder={tr('搜索设置')} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <nav>
            {sections.filter((meta) => !meta.hidden).map((meta) => {
              const Icon = meta.icon
              const count = sectionErrors(meta.id)
              return (
                <button key={meta.id} className="nav-row" aria-current={!needle && section === meta.id ? 'page' : undefined} onClick={() => { setQuery(''); setSection(meta.id) }}>
                  <Icon size={15} /><span className="truncate">{tr(meta.title)}</span>{count > 0 && <span className="nav-badge">{count}</span>}
                </button>
              )
            })}
          </nav>
        </aside>
      )}
      <main className="settings">
        {page && (
          <div className="settings-toolbar">
            <button className="nav-action settings-back" onClick={onClose}><ArrowLeft size={16} /><span>{tr('返回会话')}</span><kbd>Esc</kbd></button>
          </div>
        )}
        <div className="settings-inner">
          {grouped.length === 0 && <div className="settings-empty">{tr('没有找到与“{query}”相关的设置', { query })}</div>}
          {grouped.map(({ meta, rows: items }) => (
            <section className="settings-section" key={meta.id}>
              <header className="settings-group-head">
                <h1>{tr(meta.title)}</h1>
                <p>{tr(meta.hint)}</p>
              </header>
              <div className="setting-list">
                {items.map((row, index) => {
                  const message = row.paths ? errorFor(...row.paths) : undefined
                  const showGroup = !!row.group && row.group !== items[index - 1]?.group
                  return (
                    <div key={row.key} className={`setting-row${row.wide ? ' wide' : ''}${message ? ' has-error' : ''}`}>
                      {showGroup && <div className="setting-group-title">{row.group}</div>}
                      <div className="setting-text">
                        <span className="setting-label">{row.label}</span>
                        {row.hint && <span className="setting-hint">{row.hint}</span>}
                      </div>
                      <div className="setting-control">
                        {row.render()}
                        <FieldError message={message} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="settings-actions">
          <div className="settings-actions-inner">
            {totalErrors > 0 ? <span className="save-feedback danger-text">{tr('有 {count} 处设置需要修正，已在对应位置标出', { count: totalErrors })}</span>
              : saving ? <span className="save-feedback"><LoaderCircle size={13} className="spin" />{tr('正在自动保存…')}</span>
              : dirty ? <span className="save-feedback">{tr('改动将自动保存…')}</span>
              : saved ? <span className="save-feedback ok-text"><Check size={14} />{tr('已自动保存并生效')}</span>
              : <span className="save-feedback">{tr('改动会自动保存并立即生效')}</span>}
          </div>
        </div>
      </main>
    </div>
  )
}

function FieldError({ message }: { message?: string | false }) {
  if (!message) return null
  return <span className="field-error" role="alert">{message}</span>
}
