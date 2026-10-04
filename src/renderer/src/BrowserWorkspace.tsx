import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, LoaderCircle, Plus, Quote, RotateCw, X } from 'lucide-react'
import { buildSearchUrl, type BrowserState, type SearchEngine } from '../../shared/schema'
import { api, isDesktop } from './bridge'
import { useI18n } from './i18n'
import { useModalOpen } from './ui'

const initialState = (threadId: string): BrowserState => ({ threadId, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [], activeTabId: null })

const looksLikeUrl = (text: string): boolean => {
  if (/^https?:\/\//i.test(text) || text.startsWith('cubex://')) return true
  if (/\s/.test(text)) return false
  return /^[^\s.]+\.[^\s.]+/.test(text)
}

export function BrowserWorkspace({ threadId, active, onError, searchEngine, searchTemplate, onReference }: { threadId: string; active: boolean; onError: (message: string) => void; searchEngine: SearchEngine; searchTemplate: string; onReference: (ref: { title: string; url: string; selection: string; screenshot?: string }) => void }) {
  const { tr } = useI18n()
  const modalOpen = useModalOpen()
  const frameRef = useRef<HTMLDivElement>(null)
  const editingRef = useRef(false)
  const [state, setState] = useState<BrowserState>(() => initialState(threadId))
  const [address, setAddress] = useState('')

  useEffect(() => {
    setState(initialState(threadId))
    setAddress('')
    editingRef.current = false
  }, [threadId])

  useEffect(() => {
    if (!isDesktop) return
    return api.onBrowserState((next) => {
      if (next.threadId !== threadId) return
      setState(next)
      if (!editingRef.current) setAddress(next.url)
    })
  }, [threadId])

  useEffect(() => {
    if (!isDesktop || active) return
    // 切出 Browser 视图时主动隐藏原生视图（兜底，防止残留覆盖其他界面）。
    void api.browserHide({ threadId }).catch(() => undefined)
  }, [threadId, active])

  const reportBounds = useCallback(() => {
    if (!isDesktop || !active) return
    const el = frameRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    void api.browserBounds({ threadId, x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }).then((result) => {
      if (!result.ok) onError(result.error)
    }).catch(() => undefined)
  }, [threadId, active, onError])

  // 模态弹窗打开期间把原生视图摘下：它是原生图层，永远盖在 DOM 之上，
  // 若不摘下，弹窗遮罩压暗应用时浏览器画面仍全亮，看起来像单独弹出的窗口。
  const visible = active && !modalOpen

  useEffect(() => {
    if (!isDesktop) return
    if (!visible) {
      void api.browserHide({ threadId }).catch(() => undefined)
      return
    }
    reportBounds()
    const el = frameRef.current
    const observer = new ResizeObserver(() => reportBounds())
    if (el) observer.observe(el)
    window.addEventListener('resize', reportBounds)
    const raf = requestAnimationFrame(reportBounds)
    // 布局/淡入动画结束后再量一次，确保原生视图落在最终位置，避免切入时错位。
    const settle = window.setTimeout(reportBounds, 240)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
      cancelAnimationFrame(raf)
      window.clearTimeout(settle)
      void api.browserHide({ threadId }).catch(() => undefined)
    }
  }, [threadId, visible, reportBounds])

  const navigate = useCallback((raw: string, forceSearch = false) => {
    const text = raw.trim()
    if (!text) return
    editingRef.current = false
    const url = text.startsWith('cubex://') || (!forceSearch && looksLikeUrl(text))
      ? text
      : buildSearchUrl(text, searchEngine, searchTemplate)
    void api.browserNavigate({ threadId, url }).then((result) => {
      if (!result.ok) onError(result.error)
    }).catch(() => onError(tr('无法打开该网址，请重试。')))
  }, [threadId, onError, tr, searchEngine, searchTemplate])

  const captureReference = useCallback(() => {
    void api.browserCapture({ threadId }).then((result) => {
      if (result.ok) onReference(result.data)
      else onError(result.error)
    }).catch(() => onError(tr('引用网页内容失败，请重试。')))
  }, [threadId, onReference, onError, tr])

  const tabAction = useCallback((input: { action: 'new' | 'close' | 'activate'; tabId?: string; url?: string }) => {
    if (!isDesktop) return
    void api.browserTab({ threadId, ...input }).then((result) => {
      if (!result.ok) { onError(result.error); return }
      setState(result.data)
      if (!editingRef.current) setAddress(result.data.url)
      // 切换/新建标签会更换挂载的原生视图，重新上报 bounds 让新视图落在正确位置。
      reportBounds()
    }).catch(() => undefined)
  }, [threadId, onError, reportBounds])

  return (
    <div className="browser-workspace">
      <div className="browser-tabs" role="tablist" aria-label={tr('标签页')}>
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === state.activeTabId}
            className={`browser-tab${tab.id === state.activeTabId ? ' active' : ''}`}
            title={tab.title || tab.url || tr('新标签页')}
            onClick={() => { if (tab.id !== state.activeTabId) tabAction({ action: 'activate', tabId: tab.id }) }}
          >
            {tab.loading ? <LoaderCircle size={12} className="spin browser-tab-icon" /> : <Globe size={12} className="browser-tab-icon" />}
            <span className="browser-tab-title">{tab.title || tab.url || tr('新标签页')}</span>
            <button
              type="button"
              className="browser-tab-close"
              aria-label={tr('关闭标签')}
              title={tr('关闭标签')}
              onClick={(event) => { event.stopPropagation(); tabAction({ action: 'close', tabId: tab.id }) }}
            ><X size={12} /></button>
          </div>
        ))}
        <button type="button" className="browser-tab-add" aria-label={tr('新建标签')} title={tr('新建标签')} onClick={() => tabAction({ action: 'new' })}><Plus size={14} /></button>
      </div>
      <div className="browser-toolbar">
        <div className="browser-nav-buttons" role="group" aria-label={tr('浏览器导航')}>
          <button className="icon-button" disabled={!state.canGoBack} aria-label={tr('后退')} title={tr('后退')} onClick={() => navigate('cubex://back')}><ArrowLeft size={16} /></button>
          <button className="icon-button" disabled={!state.canGoForward} aria-label={tr('前进')} title={tr('前进')} onClick={() => navigate('cubex://forward')}><ArrowRight size={16} /></button>
          <button className="icon-button" aria-label={tr('刷新')} title={tr('刷新')} onClick={() => navigate('cubex://reload')}>{state.loading ? <LoaderCircle size={15} className="spin" /> : <RotateCw size={15} />}</button>
        </div>
        <form className="browser-address" onSubmit={(event) => { event.preventDefault(); navigate(address) }}>
          <Globe size={15} className="browser-address-icon" />
          <input
            type="text"
            value={address}
            spellCheck={false}
            placeholder={tr('输入网址，或输入关键词按 Ctrl/⌘+Enter 搜索')}
            aria-label={tr('地址栏')}
            onFocus={() => { editingRef.current = true }}
            onChange={(event) => { editingRef.current = true; setAddress(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); navigate(address, true) } }}
            onBlur={() => { editingRef.current = false; setAddress(state.url) }}
          />
        </form>
        <button className="icon-button" type="button" disabled={!state.url} aria-label={tr('引用到对话')} title={tr('把选中的网页文字和当前截图加入对话（未选中则引用整页截图）')} onClick={captureReference}><Quote size={16} /></button>
      </div>
      <div className="browser-frame" ref={frameRef}>
        {!state.url && (
          <div className="browser-frame-empty">
            <Globe size={40} />
            <strong>{tr('浏览器工作台')}</strong>
            <span>{tr('在上方输入网址，或直接向助手描述要访问的页面。')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
