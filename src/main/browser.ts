import { BrowserWindow, WebContentsView, shell, type Rectangle } from 'electron'
import { randomUUID } from 'node:crypto'

export const BROWSER_PARTITION = 'persist:cubex-agent-browser'

export interface BrowserActionResult {
  ok: boolean
  verified: boolean
  title: string
  url: string
  snippet: string
  screenshot?: string
  detail?: string
  links?: PageLink[]
}

export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string; submit?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; dy?: number; selector?: string }
  | { kind: 'wait'; selector?: string; ms?: number }
  | { kind: 'extract'; selector?: string }
  | { kind: 'links'; selector?: string }
  | { kind: 'screenshot' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload' }

export interface PageLink {
  title: string
  url: string
  text: string
  snippet?: string
}

export interface BrowserTabInfo {
  id: string
  title: string
  url: string
  loading: boolean
}

interface Tab {
  id: string
  view: WebContentsView
  navigated: boolean
}

// 一个会话（threadId）持有一组标签页；同一时刻只有 activeTabId 对应的视图会被挂到窗口上，
// 其余标签保留 WebContents 在后台继续运行（保活），切换时再替换挂载的视图。
interface Lease {
  tabs: Tab[]
  activeTabId: string | null
  bounds: Rectangle | null
  attachedView: WebContentsView | null
}

const NAV_TIMEOUT = 30_000
const ACTION_TIMEOUT = 15_000
// 等待页面加载完成的上限：不少页面（长轮询、流式、持续重绘）永远处于 loading 态，
// 若不设上限，onceLoaded 会永久挂起并拖死整个 agent 循环，Esc 也无法中断。
const LOAD_WAIT_TIMEOUT = 8_000
const SETTLE_EXTRA = 400
// executeJavaScript 读取页面文本/截图同样可能因页面脚本阻塞而长时间不返回，需要兜底。
const READOUT_TIMEOUT = 10_000
const CAPTURE_TIMEOUT = 5_000

function isHttp(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function clip(text: string, max = 8000): string {
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…（内容过长已截断）` : trimmed
}

// 给可能永不 resolve 的 Promise 兜底：到时未完成则 reject，让上层逻辑能够继续推进，
// 而不是被一个挂起的页面/脚本无限阻塞（这是“操控浏览器卡死”的主要根源）。
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`等待超时（${Math.round(ms / 1000)} 秒）`)), ms)
    }),
  ])
}

const READOUT_SCRIPT = (selector: string) => `(() => {
  const sel = ${JSON.stringify(selector)};
  let nodes;
  try { nodes = sel ? Array.from(document.querySelectorAll(sel)) : [document.body]; }
  catch (e) { nodes = [document.body]; }
  const text = nodes.map((node) => node ? (node.innerText || node.textContent || '') : '').join('\\n\\n');
  return { title: document.title || '', url: location.href, text };
})()`

export interface BrowserState {
  threadId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  tabs: BrowserTabInfo[]
  activeTabId: string | null
}

export interface BrowserOptions {
  allowDownloads: boolean
  allowNewWindows: boolean
  userAgent: string
  homepage: string
}

export interface BrowserTabInput {
  threadId: string
  action: 'new' | 'close' | 'activate'
  tabId?: string
  url?: string
}

const DEFAULT_OPTIONS: BrowserOptions = { allowDownloads: false, allowNewWindows: false, userAgent: '', homepage: '' }

export class BrowserEngine {
  private window: BrowserWindow | null = null
  private leases = new Map<string, Lease>()
  private onFrame: ((state: BrowserState) => void) | null = null
  private options: BrowserOptions = { ...DEFAULT_OPTIONS }
  // 当前正在前台展示的会话；只有它的活动标签会被挂到窗口上。
  private currentThreadId: string | null = null
  // session 级的权限/下载处理只需注册一次（同一 partition 的所有标签共用），避免重复累积监听器。
  private sessionPrepared = false

  setWindow(window: BrowserWindow | null): void {
    this.window = window
  }

  setOptions(options: Partial<BrowserOptions>): void {
    this.options = { ...this.options, ...options }
  }

  setStateListener(listener: (state: BrowserState) => void): void {
    this.onFrame = listener
  }

  private emitState(threadId: string): void {
    if (this.onFrame) this.onFrame(this.state(threadId))
  }

  state(threadId: string): BrowserState {
    const lease = this.leases.get(threadId)
    const active = lease ? lease.tabs.find((tab) => tab.id === lease.activeTabId) ?? null : null
    const wc = active && !active.view.webContents.isDestroyed() ? active.view.webContents : null
    const tabs: BrowserTabInfo[] = lease
      ? lease.tabs
        .filter((tab) => !tab.view.webContents.isDestroyed())
        .map((tab) => ({ id: tab.id, title: tab.view.webContents.getTitle(), url: tab.view.webContents.getURL(), loading: tab.view.webContents.isLoading() }))
      : []
    return {
      threadId,
      url: wc ? wc.getURL() : '',
      title: wc ? wc.getTitle() : '',
      loading: wc ? wc.isLoading() : false,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
      tabs,
      activeTabId: lease ? lease.activeTabId : null,
    }
  }

  private prepareSession(session: Electron.Session): void {
    if (this.sessionPrepared) return
    this.sessionPrepared = true
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.on('will-download', (event) => { if (!this.options.allowDownloads) event.preventDefault() })
  }

  private ensureLease(threadId: string): Lease {
    const existing = this.leases.get(threadId)
    if (existing) return existing
    const lease: Lease = { tabs: [], activeTabId: null, bounds: null, attachedView: null }
    this.leases.set(threadId, lease)
    return lease
  }

  private createTab(threadId: string, lease: Lease, url?: string): Tab {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    })
    // 默认 WebContentsView 底色是纯白，页面加载前/透明页面会露出突兀的白框；置为透明后透出应用底色。
    view.setBackgroundColor('#00000000')
    const wc = view.webContents
    if (this.options.userAgent) wc.setUserAgent(this.options.userAgent)
    // 页面内新窗口链接（window.open / target=_blank / Ctrl+点击）一律拦截，改为在本会话内开一个新标签。
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isHttp(target)) this.newTab(threadId, target)
      return { action: 'deny' }
    })
    this.prepareSession(wc.session)
    const notify = () => this.emitState(threadId)
    wc.on('did-navigate', notify)
    wc.on('did-navigate-in-page', notify)
    wc.on('page-title-updated', notify)
    wc.on('did-start-loading', notify)
    wc.on('did-stop-loading', notify)
    wc.on('did-finish-load', notify)
    const tab: Tab = { id: randomUUID(), view, navigated: false }
    lease.tabs.push(tab)
    if (!lease.activeTabId) lease.activeTabId = tab.id
    const target = url ?? (this.options.homepage && isHttp(this.options.homepage) ? this.options.homepage : undefined)
    if (target && isHttp(target)) {
      tab.navigated = true
      void wc.loadURL(target).catch(() => undefined)
    }
    return tab
  }

  private pickTab(lease: Lease, tabId?: string): Tab | null {
    if (tabId) {
      const found = lease.tabs.find((tab) => tab.id === tabId)
      if (found) return found
    }
    return lease.tabs.find((tab) => tab.id === lease.activeTabId) ?? null
  }

  private ensureTab(threadId: string, lease: Lease, tabId?: string): Tab {
    return this.pickTab(lease, tabId) ?? this.createTab(threadId, lease)
  }

  // 渲染进程上报的 bounds 来自 getBoundingClientRect，单位是 CSS 像素，与 Electron 视图使用的 DIP 一一对应；
  // 不要按显示器缩放系数再乘一遍，否则在高 DPI 屏幕上会把视图放大并整体偏移。
  private applyBounds(lease: Lease): void {
    const view = lease.attachedView
    if (!view || !lease.bounds || !this.window || this.window.isDestroyed()) return
    const x = Math.round(lease.bounds.x)
    const y = Math.round(lease.bounds.y)
    // 把视图宽高裁剪进窗口内容区，避免某些时序下量到偏大的 frame 尺寸，
    // 导致原生视图比容器宽、在右侧/底部露出多余的一块。
    const [winW, winH] = this.window.getContentSize()
    const width = Math.max(0, Math.min(Math.round(lease.bounds.width), winW - x))
    const height = Math.max(0, Math.min(Math.round(lease.bounds.height), winH - y))
    view.setBounds({ x, y, width, height })
  }

  // 把租约当前活动标签的原生视图同步到窗口上：活动标签变了就替换挂载的视图，
  // 未导航过的标签不挂载（保持空态，避免露出空白视图）。
  private syncAttached(lease: Lease): void {
    if (!this.window || this.window.isDestroyed()) return
    const active = lease.tabs.find((tab) => tab.id === lease.activeTabId) ?? null
    const desired = active && active.navigated && !active.view.webContents.isDestroyed() ? active.view : null
    if (lease.attachedView !== desired) {
      if (lease.attachedView) {
        try {
          this.window.contentView.removeChildView(lease.attachedView)
        } catch {
          // 忽略移除失败
        }
        lease.attachedView = null
      }
      if (desired) {
        desired.setBounds({ x: 0, y: 0, width: 0, height: 0 })
        this.window.contentView.addChildView(desired)
        lease.attachedView = desired
      }
    }
    this.applyBounds(lease)
  }

  private detachLease(lease: Lease): void {
    if (!lease.attachedView) return
    try {
      this.window?.contentView.removeChildView(lease.attachedView)
    } catch {
      // 忽略移除失败
    }
    lease.attachedView = null
  }

  attach(threadId: string): void {
    if (!this.window || this.window.isDestroyed()) return
    const lease = this.ensureLease(threadId)
    for (const [id, other] of this.leases) {
      if (id !== threadId) this.detachLease(other)
    }
    this.currentThreadId = threadId
    this.syncAttached(lease)
  }

  setBounds(threadId: string, bounds: Rectangle): void {
    const lease = this.ensureLease(threadId)
    lease.bounds = bounds
    // 再次上报 bounds 意味着浏览器工作台重新可见（切回 Browser 视图、窗口尺寸变化等），
    // 这里顺带重新挂载视图，避免已经导航过的页面在切回后只剩空白。
    this.attach(threadId)
    // 切换会话后主动把该会话当前状态推给渲染端，否则地址栏/前进后退按钮会停留在空状态，
    // 让人以为“点了会话切不过去”。
    this.emitState(threadId)
  }

  hide(threadId: string): void {
    const lease = this.leases.get(threadId)
    if (lease) this.detachLease(lease)
    if (this.currentThreadId === threadId) this.currentThreadId = null
  }

  close(threadId: string): void {
    const lease = this.leases.get(threadId)
    if (!lease) return
    this.detachLease(lease)
    for (const tab of lease.tabs) {
      if (!tab.view.webContents.isDestroyed()) {
        try {
          tab.view.webContents.close()
        } catch {
          // 忽略关闭失败
        }
      }
    }
    lease.tabs = []
    lease.activeTabId = null
    this.leases.delete(threadId)
    if (this.currentThreadId === threadId) this.currentThreadId = null
  }

  closeAll(): void {
    for (const id of [...this.leases.keys()]) this.close(id)
  }

  hasSession(threadId: string): boolean {
    const lease = this.leases.get(threadId)
    return !!lease && lease.tabs.some((tab) => !tab.view.webContents.isDestroyed())
  }

  newTab(threadId: string, url?: string): void {
    if (!this.window || this.window.isDestroyed()) return
    const lease = this.ensureLease(threadId)
    const tab = this.createTab(threadId, lease, url)
    tab.navigated = true
    lease.activeTabId = tab.id
    if (this.currentThreadId === threadId) this.syncAttached(lease)
    this.emitState(threadId)
  }

  private closeTab(threadId: string, tabId: string): void {
    const lease = this.leases.get(threadId)
    if (!lease) return
    const index = lease.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const [tab] = lease.tabs.splice(index, 1)
    if (lease.attachedView === tab.view) {
      try {
        this.window?.contentView.removeChildView(tab.view)
      } catch {
        // 忽略移除失败
      }
      lease.attachedView = null
    }
    if (!tab.view.webContents.isDestroyed()) {
      try {
        tab.view.webContents.close()
      } catch {
        // 忽略关闭失败
      }
    }
    if (lease.activeTabId === tabId) {
      const next = lease.tabs[Math.min(index, lease.tabs.length - 1)] ?? null
      lease.activeTabId = next ? next.id : null
    }
    if (this.currentThreadId === threadId) this.syncAttached(lease)
    this.emitState(threadId)
  }

  private activateTab(threadId: string, tabId: string): void {
    const lease = this.leases.get(threadId)
    if (!lease || !lease.tabs.some((tab) => tab.id === tabId)) return
    lease.activeTabId = tabId
    if (this.currentThreadId === threadId) this.syncAttached(lease)
    this.emitState(threadId)
  }

  tab(input: BrowserTabInput): BrowserState {
    const { threadId, action } = input
    if (action === 'new') this.newTab(threadId, input.url)
    else if (action === 'close' && input.tabId) this.closeTab(threadId, input.tabId)
    else if (action === 'activate' && input.tabId) this.activateTab(threadId, input.tabId)
    return this.state(threadId)
  }

  private async capture(tab: Tab | null): Promise<string | undefined> {
    if (!tab || tab.view.webContents.isDestroyed()) return undefined
    try {
      const image = await raceTimeout(tab.view.webContents.capturePage(), CAPTURE_TIMEOUT)
      if (image.isEmpty()) return undefined
      return image.toDataURL()
    } catch {
      return undefined
    }
  }

  async captureReference(threadId: string, tabId?: string): Promise<{ title: string; url: string; selection: string; screenshot?: string }> {
    const lease = this.leases.get(threadId)
    const tab = lease ? this.pickTab(lease, tabId) : null
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('浏览器会话不可用')
    const wc = tab.view.webContents
    let selection: string
    try {
      selection = await wc.executeJavaScript(`(() => (window.getSelection ? String(window.getSelection()) : '').trim())()`, true) as string
    } catch {
      selection = ''
    }
    const screenshot = await this.capture(tab)
    return { title: wc.getTitle(), url: wc.getURL(), selection: (selection || '').slice(0, 20_000), screenshot }
  }

  private async readout(tab: Tab | null, selector = ''): Promise<{ title: string; url: string; text: string }> {
    if (!tab || tab.view.webContents.isDestroyed()) return { title: '', url: '', text: '' }
    try {
      const script = tab.view.webContents.executeJavaScript(READOUT_SCRIPT(selector), true)
      return await raceTimeout(script, READOUT_TIMEOUT) as { title: string; url: string; text: string }
    } catch {
      return { title: '', url: tab.view.webContents.getURL(), text: '' }
    }
  }

  private static readonly LINKS_SCRIPT = (selector: string, limit: number) => `(() => {
    const sel = ${JSON.stringify(selector)};
    const out = [];
    const seen = new Set();
    let nodes;
    try { nodes = sel ? Array.from(document.querySelectorAll(sel)) : Array.from(document.querySelectorAll('a[href]')); }
    catch (e) { nodes = Array.from(document.querySelectorAll('a[href]')); }
    for (const node of nodes) {
      const anchor = node instanceof HTMLAnchorElement ? node : (node.closest ? node.closest('a[href]') : null)
      if (!anchor) continue
      let href = anchor.href
      if (!href || !/^https?:/i.test(href)) continue
      const text = (anchor.innerText || anchor.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
      if (!text && !anchor.title) continue
      const key = href + '|' + text
      if (seen.has(key)) continue
      seen.add(key)
      let snippet = '';
      const box = anchor.parentElement && anchor.parentElement.parentElement;
      if (box && box.innerText) snippet = box.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300);
      out.push({ title: (anchor.title || text || '').slice(0, 160), url: href.slice(0, 2048), text, snippet })
      if (out.length >= ${limit}) break
    }
    return { title: document.title || '', url: location.href, links: out };
  })()`

  private async extractLinks(tab: Tab | null, selector?: string, limit = 60): Promise<PageLink[] | undefined> {
    if (!tab || tab.view.webContents.isDestroyed()) return undefined
    try {
      const script = BrowserEngine.LINKS_SCRIPT(selector ?? '', limit)
      const data = await raceTimeout(tab.view.webContents.executeJavaScript(script, true), READOUT_TIMEOUT) as { links: PageLink[] }
      return Array.isArray(data?.links) ? data.links : []
    } catch {
      return undefined
    }
  }

  async run(threadId: string, action: BrowserAction, signal: AbortSignal, tabId?: string): Promise<BrowserActionResult> {
    if (!this.window || this.window.isDestroyed()) throw new Error('主窗口不可用，无法运行浏览器动作')
    const lease = this.ensureLease(threadId)
    const tab = this.ensureTab(threadId, lease, tabId)
    tab.navigated = true
    // 让被操作的标签成为前台活动标签，用户才能实时看到这一步动作。
    lease.activeTabId = tab.id
    this.attach(threadId)
    const wc = tab.view.webContents
    if (signal.aborted) throw new Error('已取消')

    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms)
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('已取消')) }, { once: true })
        }),
      ])

    let verified = true
    let detail = ''

    switch (action.kind) {
      case 'navigate': {
        if (!isHttp(action.url)) throw new Error('仅支持 http/https 网址')
        await withTimeout(this.safeLoad(wc, action.url), NAV_TIMEOUT, '页面加载')
        await this.settle(wc, signal)
        break
      }
      case 'reload': {
        wc.reload()
        await withTimeout(this.onceLoaded(wc), NAV_TIMEOUT, '刷新')
        break
      }
      case 'back': {
        if (wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); await this.settle(wc, signal) }
        else { verified = false; detail = '没有可返回的历史' }
        break
      }
      case 'forward': {
        if (wc.navigationHistory.canGoForward()) { wc.navigationHistory.goForward(); await this.settle(wc, signal) }
        else { verified = false; detail = '没有可前进的历史' }
        break
      }
      case 'click': {
        const script = `(() => {
          const el = document.querySelector(${JSON.stringify(action.selector)});
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`
        const clicked = await withTimeout(wc.executeJavaScript(script, true), ACTION_TIMEOUT, '点击') as boolean
        if (!clicked) { verified = false; detail = `未找到元素：${action.selector}` }
        else await this.settle(wc, signal)
        break
      }
      case 'type': {
        const script = `(() => {
          const el = document.querySelector(${JSON.stringify(action.selector)});
          if (!el) return false;
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, ${JSON.stringify(action.text)}); else el.value = ${JSON.stringify(action.text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (${action.submit ? 'true' : 'false'} && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
          return true;
        })()`
        const typed = await withTimeout(wc.executeJavaScript(script, true), ACTION_TIMEOUT, '输入') as boolean
        if (!typed) { verified = false; detail = `未找到输入框：${action.selector}` }
        else if (action.submit) await this.settle(wc, signal)
        break
      }
      case 'press': {
        const key = action.key
        wc.sendInputEvent({ type: 'keyDown', keyCode: key })
        wc.sendInputEvent({ type: 'char', keyCode: key })
        wc.sendInputEvent({ type: 'keyUp', keyCode: key })
        if (/enter/i.test(key)) await this.settle(wc, signal)
        break
      }
      case 'scroll': {
        const dy = action.dy ?? 600
        const script = action.selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(action.selector)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`
          : `(() => { window.scrollBy(0, ${dy}); return true; })()`
        const done = await withTimeout(wc.executeJavaScript(script, true), ACTION_TIMEOUT, '滚动') as boolean
        if (!done) { verified = false; detail = `未找到元素：${action.selector}` }
        break
      }
      case 'wait': {
        if (action.selector) {
          const found = await this.waitForSelector(wc, action.selector, action.ms ?? ACTION_TIMEOUT, signal)
          if (!found) { verified = false; detail = `等待元素超时：${action.selector}` }
        } else {
          await withTimeout(new Promise((resolve) => setTimeout(resolve, action.ms ?? 1000)), (action.ms ?? 1000) + 500, '等待')
        }
        break
      }
      case 'extract':
      case 'links':
      case 'screenshot':
        break
    }

    const readout = await this.readout(tab, action.kind === 'extract' ? (action.selector ?? '') : '')
    const wantShot = action.kind === 'screenshot' || action.kind === 'extract' || action.kind === 'navigate'
    const screenshot = wantShot ? await this.capture(tab) : undefined
    const snippet = clip(readout.text, action.kind === 'extract' ? 20_000 : 4000)
    const links = action.kind === 'links' ? await this.extractLinks(tab, action.selector) : undefined
    this.emitState(threadId)

    return {
      ok: true,
      verified,
      title: readout.title,
      url: readout.url || wc.getURL(),
      snippet: snippet || '（页面没有可见文本）',
      ...(screenshot ? { screenshot } : {}),
      ...(detail ? { detail } : {}),
      ...(links ? { links } : {}),
    }
  }

  async manualNavigate(threadId: string, url: string, tabId?: string): Promise<void> {
    if (!this.window || this.window.isDestroyed()) throw new Error('主窗口不可用')
    const lease = this.ensureLease(threadId)
    const tab = this.ensureTab(threadId, lease, tabId)
    const wc = tab.view.webContents
    if (url === 'cubex://back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return }
    if (url === 'cubex://forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return }
    if (url === 'cubex://reload') { wc.reload(); return }
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`
    if (!isHttp(target)) throw new Error('仅支持 http/https 网址')
    tab.navigated = true
    lease.activeTabId = tab.id
    this.attach(threadId)
    try {
      await raceTimeout(this.safeLoad(wc, target), NAV_TIMEOUT)
    } catch {
      // 手动导航不向 UI 抛错：加载仍在后台进行，地址栏状态由 emitState 同步。
    }
  }

  // loadURL 的 Promise 在遇到重定向/新导航打断时会以 ERR_ABORTED 之类 reject，
  // 但页面其实在正常加载；若直接抛出会让界面误报“无法打开网页”。这里吞掉这类非致命错误。
  private async safeLoad(wc: Electron.WebContents, target: string): Promise<void> {
    try {
      await wc.loadURL(target)
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? ''
      const message = error instanceof Error ? error.message : String(error)
      if (code === 'ERR_ABORTED' || /ERR_ABORTED/.test(message)) return
      throw error
    }
  }

  // 带上限的等待页面加载完成：到了 LOAD_WAIT_TIMEOUT 就放弃等待直接继续，
  // 避免永不停止加载的页面（长轮询/流式页面）把整个动作卡死。
  private async onceLoaded(wc: Electron.WebContents): Promise<void> {
    if (!wc.isLoading()) return
    await raceTimeout(
      new Promise<void>((resolve) => {
        const done = () => { cleanup(); resolve() }
        const cleanup = () => { wc.off('did-finish-load', done); wc.off('did-fail-load', done); clearTimeout(timer) }
        const timer = setTimeout(done, LOAD_WAIT_TIMEOUT)
        wc.once('did-finish-load', done)
        wc.once('did-fail-load', done)
      }),
      LOAD_WAIT_TIMEOUT + 1_000,
    )
  }

  private async settle(wc: Electron.WebContents, signal?: AbortSignal): Promise<void> {
    const loaded = this.onceLoaded(wc)
    if (signal) {
      await Promise.race([
        loaded,
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('已取消'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } else {
      await loaded
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_EXTRA))
  }

  private async waitForSelector(wc: Electron.WebContents, selector: string, ms: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('已取消')
      try {
        const found = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`, true) as boolean
        if (found) return true
      } catch {
        // 页面可能正在导航，忽略后重试
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }
}

export const browserEngine = new BrowserEngine()

export function openExternal(url: string): void {
  if (isHttp(url)) void shell.openExternal(url)
}