import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, CircleCheck, CircleDashed, ExternalLink, FileCode2, FileText, FoldVertical, Folder, FolderOpen, Gauge, Globe, ListChecks, LoaderCircle, MessageSquarePlus, PictureInPicture2, Play, Plug, Puzzle, RotateCw, Terminal, Trash2, TriangleAlert, Wrench } from 'lucide-react'
import type { FileContent, FileEntry, Project, Thread, ToolResult } from '../../shared/schema'
import type { OpenTarget } from './Markdown'
import { api, isDesktop } from './bridge'
import { useI18n } from './i18n'

export type OpenRequest = { target: OpenTarget; nonce: number }

export type PanelView = 'files' | 'terminal' | 'browser' | 'summary' | 'changes'

export const panelViews: Array<{ id: PanelView; label: string; icon: typeof Folder }> = [
  { id: 'files', label: '文件', icon: Folder },
  { id: 'terminal', label: '终端', icon: Terminal },
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'summary', label: '摘要', icon: ListChecks },
  { id: 'changes', label: '变更', icon: FileCode2 },
]

interface RightPanelProps {
  thread: Thread | null
  project: Project | null
  detached?: boolean
  onDetach?: () => void
  onError: (message: string) => void
  onAddToChat?: (text: string) => void
  openRequest?: OpenRequest | null
  contextWindow?: number
}

export function RightPanel({ thread, project, detached, onDetach, onError, onAddToChat, openRequest, contextWindow }: RightPanelProps) {
  const { tr } = useI18n()
  const [view, setView] = useState<PanelView>('summary')
  const index = panelViews.findIndex((item) => item.id === view)

  useEffect(() => {
    if (!openRequest) return
    setView(openRequest.target.kind === 'url' ? 'browser' : 'files')
  }, [openRequest])

  const fileRequest = openRequest && openRequest.target.kind !== 'url' ? openRequest : null
  const urlRequest = openRequest && openRequest.target.kind === 'url' ? openRequest : null

  return (
    <aside className={`right-panel${detached ? ' detached' : ''}`} aria-label={tr('任务面板')}>
      <div className="right-panel-head">
        <div className="segmented" role="tablist" aria-label={tr('面板视图')} style={{ ['--seg-index' as string]: index }}>
          <span className="segmented-thumb" aria-hidden="true" />
          {panelViews.map((item) => (
            <button key={item.id} role="tab" aria-selected={view === item.id} className={view === item.id ? 'active' : ''} title={tr(item.label)} onClick={() => setView(item.id)}>
              <item.icon size={14} /><span>{tr(item.label)}</span>
            </button>
          ))}
        </div>
        <div className="right-panel-actions">
          {!detached && onDetach && isDesktop && <button className="icon-button" aria-label={tr('弹出为独立窗口')} title={tr('弹出为独立置顶窗口')} onClick={onDetach}><PictureInPicture2 size={15} /></button>}
        </div>
      </div>
      <div className="right-panel-body" role="tabpanel">
        {view === 'files' && <FilesView project={project} onError={onError} openRequest={fileRequest} />}
        {view === 'terminal' && <TerminalView project={project} onError={onError} />}
        {view === 'browser' && <BrowserView onAddToChat={onAddToChat} openRequest={urlRequest} />}
        {view === 'summary' && (
          <div className="panel-summary-wrap">
            {thread ? <SummaryView thread={thread} project={project} contextWindow={contextWindow} onError={onError} /> : <PanelEmpty icon={ListChecks} text={tr('选择或新建任务后显示任务摘要')} />}
          </div>
        )}
        {view === 'changes' && (thread ? <ChangesView thread={thread} /> : <PanelEmpty icon={FileCode2} text={tr('选择或新建任务后显示文件变更')} />)}
      </div>
    </aside>
  )
}

function normalizeRel(project: Project | null, raw: string): string {
  let value = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (project) {
    const root = project.path.replace(/\\/g, '/').replace(/\/+$/, '')
    if (value.toLowerCase().startsWith(root.toLowerCase())) value = value.slice(root.length)
    const name = root.split('/').pop() ?? ''
    if (name && value.toLowerCase().startsWith(name.toLowerCase() + '/')) value = value.slice(name.length)
  }
  value = value.replace(/^\.?\//, '').replace(/^\/+/, '')
  return value
}

function FilesView({ project, onError, openRequest }: { project: Project | null; onError: (message: string) => void; openRequest?: OpenRequest | null }) {
  const { tr } = useI18n()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [file, setFile] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (target: string) => {
    if (!project || !isDesktop) return
    setLoading(true)
    const result = await api.listFiles({ projectId: project.id, path: target || '.' })
    setLoading(false)
    if (!result.ok) { onError(result.error); return }
    setEntries(result.data)
    setPath(target)
    setFile(null)
  }, [project, onError])

  const openFile = useCallback(async (rel: string) => {
    if (!project || !isDesktop) return
    setLoading(true)
    const result = await api.readProjectFile({ projectId: project.id, path: rel })
    setLoading(false)
    if (!result.ok) { onError(result.error); return }
    setFile(result.data)
  }, [project, onError])

  useEffect(() => { void load('') }, [load])

  useEffect(() => {
    if (!openRequest || !project) return
    const rel = normalizeRel(project, openRequest.target.value)
    if (openRequest.target.kind === 'folder') void load(rel)
    else void openFile(rel)
  }, [openRequest, project, load, openFile])

  const open = async (entry: FileEntry) => {
    if (!project) return
    if (entry.kind === 'directory') { void load(entry.path); return }
    setLoading(true)
    const result = await api.readProjectFile({ projectId: project.id, path: entry.path })
    setLoading(false)
    if (!result.ok) { onError(result.error); return }
    setFile(result.data)
  }

  const up = () => {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    void load(parent)
  }

  if (!project) return <PanelEmpty icon={Folder} text={tr('请先选择项目')} />
  if (!isDesktop) return <PanelEmpty icon={Folder} text={tr('文件浏览仅在桌面应用中可用')} />

  if (file) {
    return (
      <div className="panel-file">
        <div className="panel-crumbs">
          <button className="icon-button" aria-label={tr('返回目录')} title={tr('返回目录')} onClick={() => setFile(null)}><ArrowLeft size={14} /></button>
          <span className="truncate" title={file.path}>{file.path}</span>
          <span className="panel-meta">{formatSize(file.size)}</span>
        </div>
        <pre className="panel-code">{file.content.split('\n').map((line, i) => <span key={i}><i>{i + 1}</i>{line}{'\n'}</span>)}</pre>
        {file.truncated && <div className="panel-note">{tr('文件过大，仅显示前 400 KB')}</div>}
      </div>
    )
  }

  return (
    <div className="panel-files">
      <div className="panel-crumbs">
        <button className="icon-button" aria-label={tr('上一级')} title={tr('上一级')} disabled={!path} onClick={up}><ArrowLeft size={14} /></button>
        <span className="truncate" title={path || project.path}>{path || project.name}</span>
        <button className="icon-button" aria-label={tr('刷新')} title={tr('刷新')} onClick={() => void load(path)}><RotateCw size={13} className={loading ? 'spin' : ''} /></button>
      </div>
      <ul className="file-list">
        {entries.length === 0 && !loading && <li className="panel-note">{tr('（空目录）')}</li>}
        {entries.map((entry) => (
          <li key={entry.path}>
            <button className={`file-row${entry.skipped ? ' skipped' : ''}`} onClick={() => void open(entry)} title={entry.path}>
              {entry.kind === 'directory' ? <FolderOpen size={14} /> : <FileText size={14} />}
              <span className="truncate">{entry.name}</span>
              {entry.kind === 'directory' && <ChevronRight size={13} className="file-arrow" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface TerminalRecord { id: number; command: string; output?: string; durationMs?: number }

function TerminalView({ project, onError }: { project: Project | null; onError: (message: string) => void }) {
  const { tr } = useI18n()
  const [command, setCommand] = useState('')
  const [records, setRecords] = useState<TerminalRecord[]>([])
  const [running, setRunning] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    const node = outputRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [records])

  const run = async () => {
    const text = command.trim()
    if (!text || !project || running) return
    const id = ++seq.current
    setRecords((current) => [...current.slice(-49), { id, command: text }])
    setCommand('')
    setRunning(true)
    const result = await api.runShell({ projectId: project.id, command: text })
    setRunning(false)
    if (!result.ok) { onError(result.error); setRecords((current) => current.map((item) => item.id === id ? { ...item, output: tr('错误：{msg}', { msg: result.error }) } : item)); return }
    setRecords((current) => current.map((item) => item.id === id ? { ...item, output: result.data.output, durationMs: result.data.durationMs } : item))
  }

  if (!project) return <PanelEmpty icon={Terminal} text={tr('请先选择项目')} />
  if (!isDesktop) return <PanelEmpty icon={Terminal} text={tr('终端仅在桌面应用中可用')} />

  return (
    <div className="panel-terminal">
      <div className="terminal-output" ref={outputRef}>
        {records.length === 0 && <div className="panel-note">{tr('在项目根目录')} <code>{project.name}</code> {tr('执行命令，输出显示在这里。')}</div>}
        {records.map((record) => (
          <div key={record.id} className="terminal-record">
            <div className="terminal-cmd"><span className="prompt">❯</span>{record.command}{record.durationMs !== undefined && <span className="panel-meta">{record.durationMs} ms</span>}</div>
            {record.output === undefined ? <div className="terminal-running"><LoaderCircle size={12} className="spin" />{tr('运行中…')}</div> : <pre>{record.output}</pre>}
          </div>
        ))}
      </div>
      <form className="terminal-input" onSubmit={(event) => { event.preventDefault(); void run() }}>
        <span className="prompt">❯</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={tr('输入命令，Enter 执行')} spellCheck={false} disabled={running} aria-label={tr('终端命令')} />
        <button type="submit" className="icon-button" aria-label={tr('执行命令')} title={tr('执行命令')} disabled={!command.trim() || running}><Play size={14} /></button>
      </form>
    </div>
  )
}

interface ConsoleLog { id: number; level: 'log' | 'info' | 'warning' | 'error'; message: string; source?: string; line?: number }

const consoleLevelName: Record<number, ConsoleLog['level']> = { 0: 'log', 1: 'warning', 2: 'error' }

function BrowserView({ onAddToChat, openRequest }: { onAddToChat?: (text: string) => void; openRequest?: OpenRequest | null }) {
  const { tr } = useI18n()
  const [url, setUrl] = useState('http://localhost:3000')
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [logs, setLogs] = useState<ConsoleLog[]>([])
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const seq = useRef(0)
  const logsRef = useRef<HTMLDivElement>(null)

  const normalize = useCallback((raw: string) => /^https?:\/\//i.test(raw) ? raw : `http://${raw}`, [])

  const open = () => {
    const target = normalize(url)
    setLogs([])
    setLoadError(null)
    setLoadedUrl(target)
  }

  const reload = () => {
    const node = webviewRef.current
    setLoadError(null)
    if (node && loadedUrl) { setLoading(true); node.reload() }
    else open()
  }

  useEffect(() => {
    if (!openRequest) return
    const target = normalize(openRequest.target.value)
    setUrl(target)
    setLogs([])
    setLoadError(null)
    setLoadedUrl(target)
  }, [openRequest, normalize])

  useEffect(() => {
    if (!isDesktop) return
    const node = webviewRef.current
    if (!node) return
    const onConsole = (event: Electron.ConsoleMessageEvent) => {
      const level = consoleLevelName[event.level as number] ?? 'log'
      setLogs((current) => [...current.slice(-199), { id: ++seq.current, level, message: event.message, source: event.sourceId, line: event.line }])
    }
    const onStart = () => { setLoading(true); setLoadError(null) }
    const onStop = () => setLoading(false)
    const onFail = (event: Electron.DidFailLoadEvent) => {
      setLoading(false)
      if (event.errorCode === -3 || !event.validatedURL) return
      setLoadError(tr('页面加载失败（{code}）：{desc}', { code: event.errorCode, desc: event.errorDescription || tr('无法访问该地址') }))
    }
    node.addEventListener('console-message', onConsole as EventListener)
    node.addEventListener('did-start-loading', onStart as EventListener)
    node.addEventListener('did-stop-loading', onStop as EventListener)
    node.addEventListener('did-fail-load', onFail as EventListener)
    return () => {
      node.removeEventListener('console-message', onConsole as EventListener)
      node.removeEventListener('did-start-loading', onStart as EventListener)
      node.removeEventListener('did-stop-loading', onStop as EventListener)
      node.removeEventListener('did-fail-load', onFail as EventListener)
    }
  }, [loadedUrl, tr])

  useEffect(() => {
    const node = logsRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [logs])

  const errorCount = logs.filter((item) => item.level === 'error').length
  const shown = onlyErrors ? logs.filter((item) => item.level === 'error') : logs

  const formatLog = (log: ConsoleLog) => {
    const where = log.source ? tr('\n  位置：{loc}', { loc: `${log.source}${log.line ? `:${log.line}` : ''}` }) : ''
    return `[${log.level.toUpperCase()}] ${log.message}${where}`
  }

  const addOne = (log: ConsoleLog) => {
    onAddToChat?.(tr('请帮我修复以下浏览器控制台报错（页面：{page}）：', { page: loadedUrl ?? url }) + `\n\n\`\`\`\n${formatLog(log)}\n\`\`\``)
  }

  const addAllErrors = () => {
    const errors = logs.filter((item) => item.level === 'error')
    if (errors.length === 0) return
    const body = errors.map(formatLog).join('\n\n')
    onAddToChat?.(tr('请帮我修复以下 {n} 条浏览器控制台报错（页面：{page}）：', { n: errors.length, page: loadedUrl ?? url }) + `\n\n\`\`\`\n${body}\n\`\`\``)
  }

  if (!isDesktop) {
    return (
      <div className="panel-browser">
        <form className="browser-bar" onSubmit={(event) => { event.preventDefault(); void api.openExternal({ url: normalize(url) }) }}>
          <Globe size={14} />
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={tr('输入网址')} aria-label={tr('网址')} spellCheck={false} />
          <button type="submit" className="icon-button" aria-label={tr('在系统浏览器打开')} title={tr('在系统浏览器打开')}><ExternalLink size={14} /></button>
        </form>
        <PanelEmpty icon={Globe} text={tr('内嵌浏览器与控制台日志捕获仅在桌面应用中可用。')} />
      </div>
    )
  }

  return (
    <div className="panel-browser">
      <form className="browser-bar" onSubmit={(event) => { event.preventDefault(); open() }}>
        <Globe size={14} />
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={tr('输入网址后回车加载')} aria-label={tr('网址')} spellCheck={false} />
        <button type="button" className="icon-button" aria-label={tr('重新加载')} title={tr('重新加载')} onClick={reload}><RotateCw size={13} className={loading ? 'spin' : undefined} /></button>
        <button type="button" className="icon-button" aria-label={tr('在系统浏览器打开')} title={tr('在系统浏览器打开')} onClick={() => void api.openExternal({ url: normalize(url) })}><ExternalLink size={14} /></button>
      </form>
      <div className="browser-frame">
        {loadedUrl
          ? <webview ref={webviewRef as never} src={loadedUrl} className="browser-webview" partition="persist:cubex-preview" allowpopups={'true' as never} />
          : <PanelEmpty icon={Globe} text={tr('输入本地预览地址（如 http://localhost:3000）后回车，页面控制台日志会显示在下方，可一键添加到对话让 AI 修复。')} />}
        {loadError && (
          <div className="browser-error">
            <TriangleAlert size={20} />
            <p>{loadError}</p>
            <button className="btn-secondary" onClick={reload}><RotateCw size={13} />{tr('重试')}</button>
          </div>
        )}
      </div>
      <div className={`browser-console${consoleOpen ? '' : ' collapsed'}`}>
        <div className="browser-console-head">
          <button className="console-toggle" onClick={() => setConsoleOpen((value) => !value)} aria-expanded={consoleOpen} title={consoleOpen ? tr('隐藏控制台') : tr('显示控制台')}>
            <ChevronRight size={13} className={consoleOpen ? 'rot90' : undefined} />
            <span className="console-title"><Terminal size={13} />{tr('控制台')}<span className="panel-meta">{logs.length}</span>{errorCount > 0 && <span className="console-error-count"><TriangleAlert size={12} />{errorCount}</span>}</span>
          </button>
          {consoleOpen && (
            <div className="console-actions">
              <button className={`console-filter${onlyErrors ? ' active' : ''}`} onClick={() => setOnlyErrors((value) => !value)} title={tr('只看报错')}>{tr('只看报错')}</button>
              <button className="icon-button" aria-label={tr('清空日志')} title={tr('清空日志')} disabled={logs.length === 0} onClick={() => setLogs([])}><Trash2 size={13} /></button>
              <button className="console-add-all" disabled={errorCount === 0} onClick={addAllErrors} title={tr('把所有报错添加到对话')}><MessageSquarePlus size={13} />{tr('添加全部报错')}</button>
            </div>
          )}
        </div>
        {consoleOpen && (
          <div className="browser-console-body" ref={logsRef}>
            {shown.length === 0 ? <div className="panel-note">{loadedUrl ? tr('暂无日志') : tr('加载页面后，控制台日志会显示在这里。')}</div> : shown.map((log) => (
              <div key={log.id} className={`console-line ${log.level}`}>
                <span className="console-msg">{log.message}</span>
                {log.source && <span className="console-src">{log.source}{log.line ? `:${log.line}` : ''}</span>}
                <button className="icon-button console-add" aria-label={tr('添加到对话')} title={tr('添加到对话')} onClick={() => addOne(log)}><MessageSquarePlus size={12} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryView({ thread, project, contextWindow, onError }: { thread: Thread; project: Project | null; contextWindow?: number; onError: (message: string) => void }) {
  const { tr } = useI18n()
  const summary = useMemo(() => summarize(thread), [thread])
  const [plugins, setPlugins] = useState<string[]>([])
  const [mcp, setMcp] = useState<string[]>([])
  const [compacting, setCompacting] = useState(false)

  const window = contextWindow && contextWindow > 0 ? contextWindow : 128_000
  const usedTokens = useMemo(() => {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const message = thread.messages[i]
      if (message.role === 'assistant' && message.usage) return message.usage.input + message.usage.output
    }
    return 0
  }, [thread.messages])
  const ratio = Math.min(1, usedTokens / window)
  const percent = Math.round(ratio * 100)
  const canCompact = ratio >= 0.7 && thread.status === 'idle'

  const compact = async () => {
    if (!canCompact || compacting) return
    setCompacting(true)
    try {
      const result = await api.compactThread({ threadId: thread.id })
      if (!result.ok) onError(result.error)
    } catch { onError(tr('压缩上下文失败，请重试。')) } finally { setCompacting(false) }
  }
  useEffect(() => {
    let cancelled = false
    void api.listPlugins().then((result) => {
      if (!cancelled && result.ok) setPlugins(result.data.filter((item) => item.enabled && !item.error).map((item) => item.name))
    })
    const statusText = { stopped: tr('未运行'), connecting: tr('连接中'), ready: tr('已连接'), error: tr('连接失败') } as const
    void api.listMcp().then((result) => {
      if (!cancelled && result.ok) setMcp(result.data.filter((item) => item.enabled).map((item) => item.status === 'ready' ? `${item.name} · ${tr('{n} 个工具', { n: item.tools.length })}` : `${item.name} · ${statusText[item.status]}`))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const done = thread.status === 'idle' && thread.messages.some((message) => message.role === 'assistant')
  const todos = thread.todos ?? []
  const todoDone = todos.filter((item) => item.status === 'done').length
  return (
    <div className="panel-summary">
      <section className="summary-card context-card">
        <header><Gauge size={14} />{tr('上下文用量')}<span className="panel-meta">{percent}%</span></header>
        <div className={`context-bar${ratio >= 0.9 ? ' danger' : ratio >= 0.7 ? ' warn' : ''}`} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <span className="context-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="context-meta">
          <span>{usedTokens > 0 ? tr('约 {used} / {total} tokens', { used: usedTokens.toLocaleString(), total: window.toLocaleString() }) : tr('发送一轮对话后显示用量')}</span>
          <button type="button" className="context-compact" disabled={!canCompact || compacting} onClick={() => void compact()} title={canCompact ? tr('移除较早的消息以释放上下文') : tr('上下文使用超过 70% 后可压缩')}>
            {compacting ? <LoaderCircle size={12} className="spin" /> : <FoldVertical size={12} />}{tr('压缩上下文')}
          </button>
        </div>
      </section>
      {todos.length > 0 && (
        <section className="summary-card todo-card">
          <header><ListChecks size={14} />{tr('任务待办')}<span className="panel-meta">{todoDone}/{todos.length}</span></header>
          <div className="todo-progress" aria-hidden="true"><span className="todo-progress-fill" style={{ width: `${Math.round((todoDone / todos.length) * 100)}%` }} /></div>
          <ol className="agent-todo-list">
            {todos.map((item) => (
              <li key={item.id} className={item.status}>
                {item.status === 'done' ? <CircleCheck size={14} /> : item.status === 'active' ? <LoaderCircle size={14} className="spin" /> : <CircleDashed size={14} />}
                <span>{item.content}</span>
              </li>
            ))}
          </ol>
          {done && todoDone === todos.length && <div className="summary-done"><CircleCheck size={14} />{tr('全部待办已完成')}</div>}
        </section>
      )}
      <section className="summary-group">
        <header><Globe size={13} />{tr('联网搜索')}<span className="panel-meta">{summary.searches.length}</span></header>
        {summary.searches.length === 0 ? <p className="panel-note">{tr('联网搜索到的网页会显示在这里。可在设置 → 插件中开启联网搜索。')}</p> : (
          <ul className="search-hits">
            {summary.searches.map((hit) => (
              <li key={hit.url}>
                <a href={hit.url} target="_blank" rel="noreferrer" title={hit.url}>
                  <span className="search-hit-title truncate"><ExternalLink size={12} />{hit.title}</span>
                  {hit.snippet && <span className="search-hit-snippet">{hit.snippet}</span>}
                  <span className="search-hit-url truncate">{hit.url}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <SummaryGroup icon={FileText} title={tr('上下文')} items={project ? [project.name, ...summary.contextFiles] : summary.contextFiles} empty={tr('尚未引用上下文')} />
      <SummaryGroup icon={FileCode2} title={tr('读写文件')} items={summary.files.map((item) => trFileEntry(tr, item))} empty={tr('尚未读写文件')} />
      <SummaryGroup icon={Wrench} title={tr('工具')} items={summary.tools} empty={tr('尚未调用工具')} />
      <SummaryGroup icon={Puzzle} title={tr('插件')} items={plugins} empty={tr('尚未启用插件，可在设置 → 插件中开启')} />
      <SummaryGroup icon={Plug} title="MCP" items={mcp} empty={tr('尚未配置 MCP 服务器，可在设置 → MCP 中添加')} />
    </div>
  )
}

function SummaryGroup({ icon: Icon, title, items, empty }: { icon: typeof Folder; title: string; items: string[]; empty: string }) {
  return (
    <section className="summary-group">
      <header><Icon size={13} />{title}<span className="panel-meta">{items.length}</span></header>
      {items.length === 0 ? <p className="panel-note">{empty}</p> : <ul>{items.slice(0, 30).map((item) => <li key={item} className="truncate" title={item}>{item}</li>)}</ul>}
    </section>
  )
}

function ChangesView({ thread }: { thread: Thread }) {
  const { tr } = useI18n()
  const changes = useMemo(() => collectChanges(thread), [thread])
  const [selected, setSelected] = useState<string | null>(null)
  const active = changes.find((item) => item.path === selected) ?? changes[changes.length - 1] ?? null
  if (changes.length === 0) return <PanelEmpty icon={FileCode2} text={tr('本任务尚未修改文件。写入或编辑后，改动会在这里按文件列出并高亮显示。')} />
  return (
    <div className="panel-changes">
      <ul className="change-list">
        {changes.map((item) => (
          <li key={item.path}>
            <button className={`change-row${active?.path === item.path ? ' active' : ''}`} onClick={() => setSelected(item.path)} title={item.path === '未知文件' ? tr('未知文件') : item.path}>
              <FileCode2 size={13} /><span className="truncate">{item.path === '未知文件' ? tr('未知文件') : item.path}</span>
              <span className="change-stat"><b className="add">+{item.added}</b><b className="del">-{item.removed}</b></span>
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <pre className="diff panel-diff">
          {active.diffs.map((diff, i) => <span key={i} className="hunk-block">{diff.split('\n').map((line, j) => <span key={j} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>)}</span>)}
        </pre>
      )}
    </div>
  )
}

function PanelEmpty({ icon: Icon, text }: { icon: typeof Folder; text: string }) {
  return <div className="right-panel-empty"><Icon size={22} strokeWidth={1.4} /><span>{text}</span></div>
}

function trFileEntry(tr: (zhText: string, vars?: Record<string, string | number>) => string, entry: string): string {
  const space = entry.indexOf(' ')
  if (space <= 0) return entry
  const verb = entry.slice(0, space)
  const rest = entry.slice(space + 1)
  if (verb === '读' || verb === '写' || verb === '览') return `${tr(verb)} ${rest}`
  return entry
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const CONTEXT_FILES = new Set(['goal.md', 'plan.md', 'memory.md', 'agents.md'])

export interface SearchHit { title: string; url: string; snippet: string }

export function summarize(thread: Thread): { todos: Array<{ text: string; done: boolean }>; files: string[]; tools: string[]; contextFiles: string[]; searches: SearchHit[] } {
  const todos: Array<{ text: string; done: boolean }> = []
  const files = new Set<string>()
  const tools = new Set<string>()
  const contextFiles = new Set<string>()
  const searches: SearchHit[] = []
  const seenUrls = new Set<string>()
  const lastAssistant = [...thread.messages].reverse().find((message) => message.role === 'assistant' && /^\s*[-*]\s+\[[ xX]\]/m.test(message.content))
  if (lastAssistant && lastAssistant.role === 'assistant') {
    for (const line of lastAssistant.content.split('\n')) {
      const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line)
      if (match) todos.push({ text: match[2].trim(), done: match[1] !== ' ' })
    }
  }
  for (const message of thread.messages) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        if (result.name !== 'web_search' || !result.ok) continue
        const marker = result.output.indexOf('[CUBEX_SEARCH]')
        if (marker < 0) continue
        try {
          const parsed = JSON.parse(result.output.slice(marker + '[CUBEX_SEARCH]'.length)) as { results?: SearchHit[] }
          for (const hit of parsed.results ?? []) {
            if (!hit.url || seenUrls.has(hit.url)) continue
            seenUrls.add(hit.url)
            searches.push({ title: hit.title || hit.url, url: hit.url, snippet: hit.snippet || '' })
          }
        } catch { /* 忽略无法解析的结果 */ }
      }
      continue
    }
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls) {
      tools.add(call.name)
      const path = typeof call.args.path === 'string' ? call.args.path : ''
      if (!path) continue
      const base = path.split('/').pop()?.toLowerCase() ?? ''
      if (CONTEXT_FILES.has(base)) contextFiles.add(path)
      else files.add(`${call.name === 'read_file' ? '读' : call.name === 'write_file' || call.name === 'edit_file' ? '写' : '览'} ${path}`)
    }
  }
  return { todos: todos.slice(0, 40), files: [...files], tools: [...tools], contextFiles: [...contextFiles], searches: searches.slice(0, 30) }
}

export interface FileChange { path: string; added: number; removed: number; diffs: string[] }

export function collectChanges(thread: Thread): FileChange[] {
  const map = new Map<string, FileChange>()
  const calls = new Map<string, { name: string; path: string }>()
  for (const message of thread.messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) if (typeof call.args.path === 'string') calls.set(call.id, { name: call.name, path: call.args.path })
    } else if (message.role === 'tool') {
      for (const result of message.results) addChange(map, calls.get(result.callId)?.path, result)
    }
  }
  return [...map.values()]
}

function addChange(map: Map<string, FileChange>, path: string | undefined, result: ToolResult) {
  if (!result.ok || !result.diff) return
  const target = path ?? /^\+\+\+ b\/(.+)$/m.exec(result.diff)?.[1] ?? '未知文件'
  const entry = map.get(target) ?? { path: target, added: 0, removed: 0, diffs: [] }
  for (const line of result.diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) entry.added++
    else if (line.startsWith('-') && !line.startsWith('---')) entry.removed++
  }
  entry.diffs.push(result.diff)
  map.set(target, entry)
}
