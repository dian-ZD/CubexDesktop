import type { Thread } from '../../shared/schema'

export interface SearchHit { title: string; url: string; snippet: string }

// 标记后的 JSON 可能被截断或后面还有正文，按括号配平取出首个完整对象。
export function takeJsonObject(raw: string): string {
  const start = raw.indexOf('{')
  if (start < 0) return raw
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return raw.slice(start)
}

const SEARCH_MARKERS = new Set(['web_search', 'browser_search', 'browser_crawl'])

// 汇总线程里所有搜索/爬取工具结果的结构化来源，按 URL 去重（保持出现顺序）。
export function collectSources(thread: Thread): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (const message of thread.messages) {
    if (message.role !== 'tool') continue
    for (const result of message.results) {
      if (!SEARCH_MARKERS.has(result.name) || !result.ok) continue
      const marker = result.output.indexOf('[CUBEX_SEARCH]')
      if (marker < 0) continue
      try {
        const parsed = JSON.parse(takeJsonObject(result.output.slice(marker + '[CUBEX_SEARCH]'.length))) as { results?: SearchHit[] }
        for (const hit of parsed.results ?? []) {
          if (!hit.url || seen.has(hit.url)) continue
          seen.add(hit.url)
          hits.push({ title: hit.title || hit.url, url: hit.url, snippet: hit.snippet || '' })
        }
      } catch { /* 忽略无法解析的结果 */ }
    }
  }
  return hits
}

export interface SourceRef { index: number; title: string; url: string }

// 解析助手回答「参考来源」小节的单行，支持 `1. 标题 — url`、`[1] 标题 url`、`1. url` 等常见写法。
export function parseSourceLine(line: string): SourceRef | null {
  const text = line.trim()
  const numbered = /^(?:[-*]\s*)?(?:\[(\d{1,3})\]|(\d{1,3})[.、)])\s*(.+)$/.exec(text)
  if (!numbered) return null
  const index = Number(numbered[1] ?? numbered[2])
  if (!Number.isFinite(index) || index < 1) return null
  const rest = numbered[3].trim()
  const urlMatch = /https?:\/\/[^\s<>"'）】]+/.exec(rest)
  if (!urlMatch) return null
  const url = urlMatch[0].replace(/[.,;:)\]。、，！？]+$/, '')
  const title = rest.replace(urlMatch[0], '').replace(/\s*[—\-–|｜]\s*$/, '').trim() || url
  return { index, title, url }
}

// 从一条助手消息里提取「参考来源」小节（标题行到下一个标题/结尾之间的编号行）。
export function extractSources(content: string): SourceRef[] {
  const lines = content.split('\n')
  const out: SourceRef[] = []
  let inSection = false
  for (const line of lines) {
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      const isSourceHeading = /参考来源|来源列表|资料来源|Sources/i.test(heading[1])
      if (isSourceHeading) { inSection = true; continue }
      if (inSection) break
      continue
    }
    if (!inSection) continue
    const ref = parseSourceLine(line)
    if (ref) out.push(ref)
  }
  return out
}

// 把来源清单导出为 Markdown 报告（供「导出资料报告」使用）。
export function sourcesToMarkdown(title: string, hits: SearchHit[], cited?: SourceRef[]): string {
  const lines = [`# 资料报告：${title}`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, `来源数量：${hits.length}`, '']
  const citedUrls = new Map((cited ?? []).map((item) => [item.url, item.index]))
  hits.forEach((hit, position) => {
    lines.push(`## ${citedUrls.get(hit.url) ?? position + 1}. ${hit.title}`, '', `- 地址：${hit.url}`)
    if (hit.snippet) lines.push(`- 摘要：${hit.snippet}`)
    lines.push('')
  })
  if (hits.length === 0) lines.push('（本任务未收集到来源）', '')
  return lines.join('\n')
}
