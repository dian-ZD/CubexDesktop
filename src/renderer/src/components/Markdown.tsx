import { createContext, memo, useContext, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useI18n } from '../i18n'
import { extractSources, parseSourceLine, type SourceRef } from '../sources'

export type OpenTarget = { kind: 'url' | 'file' | 'folder'; value: string }
export const OpenTargetContext = createContext<((target: OpenTarget) => void) | null>(null)

const SOURCE_HEADING = /参考来源|来源列表|资料来源|Sources/i

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][]; align: Array<'left' | 'center' | 'right'> }
  | { kind: 'sources'; items: SourceRef[] }
  | { kind: 'hr' }
  | { kind: 'para'; text: string }

const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const splitRow = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++])
      index++
      blocks.push({ kind: 'code', lang: fence[2].toLowerCase(), text: body.join('\n') })
      continue
    }
    if (!line.trim()) { index++; continue }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const title = heading[2].replace(/#+\s*$/, '')
      blocks.push({ kind: 'heading', level: heading[1].length, text: title })
      index++
      // 「参考来源」小节：把紧随其后的编号行收集为来源卡片，其余仍按常规块解析。
      if (SOURCE_HEADING.test(title)) {
        const items: SourceRef[] = []
        while (index < lines.length) {
          const next = lines[index]
          if (!next.trim()) break
          if (/^(#{1,6}\s|\s*>|\s*(`{3,}|~{3,}))/.test(next)) break
          const ref = parseSourceLine(next)
          if (!ref) break
          items.push(ref)
          index++
        }
        if (items.length) blocks.push({ kind: 'sources', items })
      }
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ kind: 'hr' }); index++; continue }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1])) {
      const head = splitRow(line)
      const align = splitRow(lines[index + 1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left') as Array<'left' | 'center' | 'right'>
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(splitRow(lines[index++]))
      blocks.push({ kind: 'table', head, rows, align })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index])) body.push(lines[index++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    const item = listItem.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const items: string[] = []
      while (index < lines.length) {
        const match = listItem.exec(lines[index])
        if (match && /\d/.test(match[2]) === ordered && match[1].length < 2) { items.push(match[3]); index++; continue }
        if (lines[index].trim() && /^\s{2,}/.test(lines[index]) && items.length) { items[items.length - 1] += `\n${lines[index].trim()}`; index++; continue }
        break
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items })
      continue
    }
    const body: string[] = []
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*>|\s*(`{3,}|~{3,}))/.test(lines[index]) && !listItem.test(lines[index])) body.push(lines[index++])
    if (body.length === 0) body.push(lines[index++])
    blocks.push({ kind: 'para', text: body.join('\n') })
  }
  return blocks
}

const inlinePattern = /(`+)([\s\S]+?)\1|\[\[(url|file|dir):([^\]]+?)(?:\|([^\]]+?))?\]\]|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)|\[(\d{1,3})\]/g

function inline(text: string, keyBase = 'i', citations?: Map<number, SourceRef>): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let count = 0
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index ?? 0
    if (start > last) out.push(...breaks(text.slice(last, start), `${keyBase}t${count}`))
    const key = `${keyBase}-${count++}`
    if (match[2] !== undefined) out.push(<code key={key} className="md-inline-code">{match[2].trim()}</code>)
    else if (match[3] !== undefined) {
      const type = match[3]
      const value = match[4].trim()
      const label = match[5]?.trim() || value
      if (type === 'url') out.push(<UrlToken key={key} url={value} label={label} />)
      else out.push(<PathToken key={key} kind={type === 'dir' ? 'folder' : 'file'} value={value} label={label} />)
    }
    else if (match[6] !== undefined || match[7] !== undefined) out.push(<strong key={key}>{inline(match[6] ?? match[7], key, citations)}</strong>)
    else if (match[8] !== undefined) out.push(<del key={key}>{inline(match[8], key, citations)}</del>)
    else if (match[9] !== undefined || match[10] !== undefined) out.push(<em key={key}>{inline(match[9] ?? match[10], key, citations)}</em>)
    else if (match[11] !== undefined) out.push(link(match[12], inline(match[11], key, citations), key))
    else if (match[13] !== undefined) out.push(cite(match[13], key, citations))
    last = start + match[0].length
  }
  if (last < text.length) out.push(...breaks(text.slice(last), `${keyBase}e`))
  return out
}

// 正文中的 [n] 引用角标：命中「参考来源」小节时渲染为可点角标，否则原样保留。
function cite(number: string, key: string, citations?: Map<number, SourceRef>): ReactNode {
  const ref = citations?.get(Number(number))
  if (!ref) return <span key={key} className="md-cite-plain">[{number}]</span>
  return <CiteToken key={key} refItem={ref} />
}

function CiteToken({ refItem }: { refItem: SourceRef }) {
  const open = useContext(OpenTargetContext)
  const label = `${refItem.title} — ${refItem.url}`
  if (!open) return <a className="md-cite" href={refItem.url} target="_blank" rel="noreferrer noopener" title={label}>[{refItem.index}]</a>
  return <button type="button" className="md-cite" title={label} onClick={() => open({ kind: 'url', value: refItem.url })}>[{refItem.index}]</button>
}

function PathToken({ kind, value, label }: { kind: 'file' | 'folder'; value: string; label?: string }) {
  const open = useContext(OpenTargetContext)
  const text = label ?? value
  if (!open) return <span className="md-path" title={value}>{text}</span>
  return (
    <button type="button" className={`md-path md-path-${kind}`} title={value} onClick={() => open({ kind, value: value.trim() })}>{text}</button>
  )
}

function UrlToken({ url, label }: { url: string; label?: string }) {
  const open = useContext(OpenTargetContext)
  const text = label ?? url
  if (!/^https?:\/\//i.test(url)) return <span className="md-link-disabled" title={url}>{text}</span>
  if (!open) return <a href={url} target="_blank" rel="noreferrer noopener">{text}</a>
  return <button type="button" className="md-url" title={url} onClick={() => open({ kind: 'url', value: url })}>{text}</button>
}

function breaks(text: string, key: string): ReactNode[] {
  return text.split('\n').flatMap((part, index) => index === 0 ? [part] : [<br key={`${key}-${index}`} />, part])
}

function link(href: string, label: ReactNode, key: string): ReactNode {
  if (!/^https:\/\//i.test(href)) return <span key={key} className="md-link-disabled" title={href}>{label}</span>
  return <a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
}

const keywords = new Set('abstract as async await break case catch class const continue def default del delete do elif else enum export extends false final finally fn for from func function go if impl import in instanceof interface is let match mod module mut new nil none null of package pass private protected pub public raise return self static struct super switch this throw true try type typeof undefined use var void while with yield'.split(' '))
const tokenPattern = /(\/\/[^\n]*|#(?![\w-]*[{(])[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|0x[\da-f]+)\b|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/gi
const hashComment = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'ps1', 'powershell', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'r', 'dockerfile', 'makefile', 'ini', 'conf'])

function highlight(code: string, lang: string): ReactNode[] {
  if (code.length > 40_000 || ['text', 'txt', 'plain', 'log'].includes(lang)) return [code]
  const hashOk = hashComment.has(lang)
  const out: ReactNode[] = []
  let last = 0
  let count = 0
  for (const match of code.matchAll(tokenPattern)) {
    const start = match.index ?? 0
    let cls = ''
    if (match[1]) cls = match[1].startsWith('#') && !hashOk ? '' : 'tk-comment'
    else if (match[2]) cls = 'tk-string'
    else if (match[3]) cls = 'tk-number'
    else if (match[4]) cls = keywords.has(match[4]) ? 'tk-keyword' : 'tk-fn'
    else if (match[5]) cls = keywords.has(match[5]) ? 'tk-keyword' : /^[A-Z]/.test(match[5]) ? 'tk-type' : ''
    if (!cls) continue
    if (start > last) out.push(code.slice(last, start))
    out.push(<span key={count++} className={cls}>{match[0]}</span>)
    last = start + match[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { tr } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    }).catch(() => undefined)
  }
  return (
    <div className="md-code">
      <div className="md-code-head"><span>{lang || 'text'}</span><button type="button" className={copied ? 'copied' : ''} onClick={copy} aria-label={tr('复制代码')}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? tr('已复制') : tr('复制')}</button></div>
      <pre><code>{highlight(text, lang)}</code></pre>
    </div>
  )
}

function renderBlock(block: Block, key: number, citations?: Map<number, SourceRef>): ReactNode {
  switch (block.kind) {
    case 'code': return <CodeBlock key={key} lang={block.lang} text={block.text} />
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3'
      return <Tag key={key} className="md-heading">{inline(block.text, 'i', citations)}</Tag>
    }
    case 'hr': return <hr key={key} />
    case 'quote': return <blockquote key={key}><Markdown source={block.text} /></blockquote>
    case 'sources': return (
      <ol key={key} className="md-sources">
        {block.items.map((item) => (
          <li key={`${item.index}-${item.url}`}>
            <span className="md-cite">{item.index}</span>
            <a href={item.url} target="_blank" rel="noreferrer noopener" title={item.url}>{item.title}</a>
          </li>
        ))}
      </ol>
    )
    case 'list': {
      const items = block.items.map((item, index) => {
        const task = /^\[([ xX])\]\s+(.*)$/s.exec(item)
        if (task) return <li key={index} className="md-task"><span className={`md-check${task[1] !== ' ' ? ' done' : ''}`}>{task[1] !== ' ' && <Check size={10} />}</span>{inline(task[2], 'i', citations)}</li>
        return <li key={index}>{inline(item, 'i', citations)}</li>
      })
      return block.ordered ? <ol key={key} start={block.start}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'table': return (
      <div key={key} className="md-table-wrap"><table>
        <thead><tr>{block.head.map((cell, index) => <th key={index} style={{ textAlign: block.align[index] ?? 'left' }}>{inline(cell, 'i', citations)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.head.map((_, index) => <td key={index} style={{ textAlign: block.align[index] ?? 'left' }}>{inline(row[index] ?? '', 'i', citations)}</td>)}</tr>)}</tbody>
      </table></div>
    )
    case 'para': return <p key={key}>{inline(block.text, 'i', citations)}</p>
  }
}

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const cited = extractSources(source)
  const citations = cited.length ? new Map(cited.map((item) => [item.index, item])) : undefined
  return <div className="md">{parseBlocks(source).map((block, index) => renderBlock(block, index, citations))}</div>
})
