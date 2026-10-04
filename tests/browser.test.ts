import { describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt } from '../src/main/prompt'
import { browserTools, extensionToolNames, sensitiveExtensionTools, summarizeCall } from '../src/main/tools'
import { browserBoundsInputSchema, browserNavigateInputSchema, browserStateSchema, browserTabInputSchema, createThreadInputSchema, defaultSettings, migrateState, settingsSchema, stateSchema, threadSchema, type ToolCall } from '../src/shared/schema'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  shell: { openExternal: () => undefined },
}))

const project = { id: 'p1', name: 'demo', path: 'C:\\demo' }
const call = (name: ToolCall['name'], args: Record<string, unknown>): ToolCall => ({ id: `c-${name}`, name, args })

describe('浏览器模式提示词', () => {
  it('mode 为 browser 时注入浏览器模式段落', () => {
    const prompt = buildSystemPrompt(defaultSettings(), project, { mode: 'browser' })
    expect(prompt).toContain('浏览器模式（当前会话')
    expect(prompt).toContain('browser_navigate')
    expect(prompt).toContain('browser_crawl')
    expect(prompt).toContain('browser_extract_links')
    expect(prompt).toContain('动作 → 验证 → 取证')
    expect(prompt).toContain('先理解需求')
  })

  it('非 browser 模式不注入浏览器模式段落', () => {
    expect(buildSystemPrompt(defaultSettings(), project)).not.toContain('浏览器模式（当前会话')
    expect(buildSystemPrompt(defaultSettings(), project, { mode: 'code' })).not.toContain('浏览器模式（当前会话')
  })
})

describe('浏览器工具集合', () => {
  it('十个浏览器工具都在扩展工具与浏览器工具集合中', () => {
    for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_extract', 'browser_screenshot', 'browser_wait', 'browser_search', 'browser_tab', 'browser_crawl', 'browser_extract_links'] as const) {
      expect(browserTools.has(name)).toBe(true)
      expect(extensionToolNames.has(name)).toBe(true)
    }
  })

  it('导航/点击/输入/标签/全网爬取属于敏感操作，读取类不属于', () => {
    expect(sensitiveExtensionTools.has('browser_navigate')).toBe(true)
    expect(sensitiveExtensionTools.has('browser_click')).toBe(true)
    expect(sensitiveExtensionTools.has('browser_type')).toBe(true)
    expect(sensitiveExtensionTools.has('browser_tab')).toBe(true)
    expect(sensitiveExtensionTools.has('browser_crawl')).toBe(true)
    expect(sensitiveExtensionTools.has('browser_extract')).toBe(false)
    expect(sensitiveExtensionTools.has('browser_extract_links')).toBe(false)
    expect(sensitiveExtensionTools.has('browser_screenshot')).toBe(false)
    expect(sensitiveExtensionTools.has('browser_wait')).toBe(false)
  })

  it('summarizeCall 为浏览器工具生成可读摘要', () => {
    expect(summarizeCall(call('browser_navigate', { url: 'https://example.com' }))).toContain('example.com')
    expect(summarizeCall(call('browser_click', { selector: '#ok' }))).toContain('#ok')
    expect(summarizeCall(call('browser_type', { selector: '#q', text: 'hi' }))).toContain('#q')
    expect(summarizeCall(call('browser_crawl', { query: '特斯拉 价格' }))).toContain('特斯拉 价格')
    expect(summarizeCall(call('browser_crawl', { urls: ['https://a.com', 'https://b.com'] }))).toContain('2 个种子链接')
  })
})

describe('浏览器相关 schema', () => {
  it('threadSchema 接受 browser 模式，createThreadInput 亦然', () => {
    const thread = { id: 't1', projectId: 'p1', title: '任务', modelId: 'm', status: 'idle', messages: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', mode: 'browser' }
    expect(threadSchema.safeParse(thread).success).toBe(true)
    expect(createThreadInputSchema.safeParse({ projectId: 'p1', modelId: 'm', mode: 'browser' }).success).toBe(true)
    expect(createThreadInputSchema.safeParse({ projectId: 'p1', modelId: 'm', mode: 'nope' }).success).toBe(false)
  })

  it('browserBounds/browserNavigate/browserState 输入校验', () => {
    expect(browserBoundsInputSchema.safeParse({ threadId: 't1', x: 0, y: 0, width: 800, height: 600 }).success).toBe(true)
    expect(browserBoundsInputSchema.safeParse({ threadId: 't1', x: 0, y: 0, width: -1, height: 600 }).success).toBe(false)
    expect(browserNavigateInputSchema.safeParse({ threadId: 't1', url: 'https://example.com' }).success).toBe(true)
    expect(browserNavigateInputSchema.safeParse({ threadId: 't1', url: '' }).success).toBe(false)
    expect(browserStateSchema.safeParse({ threadId: 't1', url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [], activeTabId: null }).success).toBe(true)
    expect(browserTabInputSchema.safeParse({ threadId: 't1', action: 'new' }).success).toBe(true)
    expect(browserTabInputSchema.safeParse({ threadId: 't1', action: 'activate', tabId: 'tab-1' }).success).toBe(true)
    expect(browserTabInputSchema.safeParse({ threadId: 't1', action: 'nope' }).success).toBe(false)
  })

  it('设置含 browser 分组，默认值合法且迁移补齐', () => {
    const settings = defaultSettings()
    expect(settings.browser.stepApproval).toBe(true)
    expect(settings.browser.crawlMode).toBe('background')
    expect(settings.browser.crawlPages).toBe(8)
    expect(settingsSchema.safeParse(settings).success).toBe(true)
    expect(settingsSchema.safeParse({ ...settings, browser: { ...settings.browser, crawlPages: 99 } }).success).toBe(false)
    const state = migrateState({ version: 3, projects: [], threads: [], settings: { ...settings, browser: undefined } }) as { settings: { browser: { crawlMode: string; crawlPages: number } } }
    expect(stateSchema.safeParse(state).success).toBe(true)
    expect(state.settings.browser).toEqual(settings.browser)
    expect(state.settings.browser.crawlMode).toBe('background')
    expect(state.settings.browser.crawlPages).toBe(8)
  })
})

describe('浏览器引擎选项', () => {
  it('setOptions 合并配置且不抛错', async () => {
    const { browserEngine } = await import('../src/main/browser')
    expect(() => browserEngine.setOptions({ allowDownloads: true, allowNewWindows: true, userAgent: 'UA', homepage: 'https://a.com' })).not.toThrow()
    expect(() => browserEngine.setWindow(null)).not.toThrow()
    expect(browserEngine.state('missing')).toEqual({ threadId: 'missing', url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [], activeTabId: null })
    expect(browserEngine.hasSession('missing')).toBe(false)
  })
})
