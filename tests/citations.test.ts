import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/main/prompt'
import { defaultSettings, type Thread } from '../src/shared/schema'
import { collectSources, extractSources, parseSourceLine, sourcesToMarkdown, takeJsonObject } from '../src/renderer/src/sources'

const project = { id: 'p1', name: 'demo', path: 'C:\\demo' }

function toolThread(output: string, name: 'web_search' | 'browser_search' | 'browser_crawl' = 'browser_search'): Thread {
  return {
    id: 't1', projectId: 'p1', title: '调研任务', modelId: 'm1', status: 'idle',
    createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
    messages: [
      { id: 'm1', role: 'user', time: '2026-10-04T00:00:00.000Z', content: '查一下' },
      { id: 'm2', role: 'tool', time: '2026-10-04T00:00:01.000Z', results: [{ callId: 'c1', name, ok: true, output }] },
    ],
  } as Thread
}

describe('来源解析', () => {
  it('takeJsonObject 按括号配平取首个完整对象，容忍截断', () => {
    expect(takeJsonObject('{"a":1} 后续文本')).toBe('{"a":1}')
    expect(takeJsonObject('{"a":{"b":2}} 尾巴')).toBe('{"a":{"b":2}}')
    expect(takeJsonObject('{"a":"{"}')).toBe('{"a":"{"}')
    expect(takeJsonObject('{"a":1')).toBe('{"a":1')
  })

  it('collectSources 解析 [CUBEX_SEARCH] 标记并按 URL 去重', () => {
    const marker = '[CUBEX_SEARCH]{"results":[{"title":"A","url":"https://a.example/x","snippet":"sa"},{"title":"A2","url":"https://a.example/x","snippet":"dup"},{"title":"B","url":"https://b.example/y","snippet":""}]}'
    const hits = collectSources(toolThread(`前置说明\n${marker}\n后置正文`))
    expect(hits).toHaveLength(2)
    expect(hits[0]).toEqual({ title: 'A', url: 'https://a.example/x', snippet: 'sa' })
    expect(hits[1].title).toBe('B')
  })

  it('collectSources 忽略失败结果与无标记输出', () => {
    const thread = toolThread('[CUBEX_SEARCH]{"results":[]}')
    const toolMessage = thread.messages[1]
    if (toolMessage.role !== 'tool') throw new Error('期望工具消息')
    toolMessage.results[0].ok = false
    expect(collectSources(thread)).toHaveLength(0)
    expect(collectSources(toolThread('普通文本，没有标记'))).toHaveLength(0)
  })

  it('parseSourceLine 支持常见来源行写法', () => {
    expect(parseSourceLine('1. 某某文档 — https://example.com/a')).toEqual({ index: 1, title: '某某文档', url: 'https://example.com/a' })
    expect(parseSourceLine('- [2] 另一份资料 https://example.com/b。')).toEqual({ index: 2, title: '另一份资料', url: 'https://example.com/b' })
    expect(parseSourceLine('3、https://example.com/c')).toEqual({ index: 3, title: 'https://example.com/c', url: 'https://example.com/c' })
    expect(parseSourceLine('没有编号也没有链接')).toBeNull()
    expect(parseSourceLine('1. 只有文字没有地址')).toBeNull()
  })

  it('extractSources 只取「参考来源」小节并止于下一个标题', () => {
    const content = [
      '结论甲 [1]，结论乙 [2]。',
      '',
      '## 参考来源',
      '1. 文档一 — https://example.com/1',
      '2. 文档二 — https://example.com/2',
      '',
      '### 备注',
      '3. 不该出现 — https://example.com/3',
    ].join('\n')
    const refs = extractSources(content)
    expect(refs.map((item) => item.index)).toEqual([1, 2])
    expect(refs[1].url).toBe('https://example.com/2')
    expect(extractSources('没有来源小节，[1] 也不该被解析')).toHaveLength(0)
  })

  it('sourcesToMarkdown 生成可读报告并标注被引用编号', () => {
    const hits = collectSources(toolThread('[CUBEX_SEARCH]{"results":[{"title":"A","url":"https://a.example/x","snippet":"摘要 A"}]}'))
    const report = sourcesToMarkdown('调研任务', hits, [{ index: 5, title: 'A', url: 'https://a.example/x' }])
    expect(report).toContain('# 资料报告：调研任务')
    expect(report).toContain('来源数量：1')
    expect(report).toContain('## 5. A')
    expect(report).toContain('- 地址：https://a.example/x')
    expect(report).toContain('- 摘要：摘要 A')
  })
})

describe('引用溯源提示词', () => {
  it('browser 模式要求附「参考来源」并标注 [n] 角标', () => {
    const prompt = buildSystemPrompt(defaultSettings(), project, { mode: 'browser' })
    expect(prompt).toContain('## 参考来源')
    expect(prompt).toContain('角标编号必须与小节编号一致')
  })

  it('通用提示词要求 web_search 后附来源小节', () => {
    const prompt = buildSystemPrompt(defaultSettings(), project, { mode: 'code' })
    expect(prompt).toContain('## 参考来源')
    expect(prompt).toContain('web_search 联网查资料后')
  })
})
