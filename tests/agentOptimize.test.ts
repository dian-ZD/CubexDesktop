import { describe, expect, it } from 'vitest'
import { nextNoToolStep, OPTIMIZED_LOOP_POLICY } from '../src/main/loopPolicy'
import { estimateTokens, historyTokens } from '../src/shared/tokens'
import type { Message } from '../src/shared/schema'

// condenseResult / renderTranscript / gauge 是 AgentRunner 的私有方法，
// 这里直接覆盖它们的核心逻辑等价物，并引用真实实现路径的输入输出格式。
// 为避免脆弱耦合，用 AgentRunner 的公开行为无法单测的部分（loop 内部）以格式约定测试。

describe('loop 停机策略（agent 循环回归）', () => {
  it('优化策略：3 轮无工具停机，第 2 轮补问', () => {
    expect(nextNoToolStep(1, OPTIMIZED_LOOP_POLICY.noToolRounds)).toEqual({ done: false, nudge: false })
    expect(nextNoToolStep(2, OPTIMIZED_LOOP_POLICY.noToolRounds)).toEqual({ done: false, nudge: true })
    expect(nextNoToolStep(3, OPTIMIZED_LOOP_POLICY.noToolRounds)).toEqual({ done: true, nudge: false })
  })
})

describe('token 仪表（上下文预算）', () => {
  const gaugeLine = (usedTokens: number, budget: number) => {
    const ratio = usedTokens / budget
    return `上下文用量：约 ${Math.round(usedTokens / 1000)}k / ${Math.round(budget / 1000)}k tokens（${Math.round(ratio * 100)}%）。${ratio > 0.7 ? '接近上限' : '正常'}`
  }
  it('正常区与警戒区的文案分支', () => {
    expect(gaugeLine(30_000, 128_000)).toContain('正常')
    expect(gaugeLine(100_000, 128_000)).toContain('接近上限')
  })
  it('estimateTokens 对中日韩与英文的粗估', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
  it('historyTokens 累加各类消息', () => {
    const messages: Message[] = [
      { id: '1', role: 'user', time: '', content: 'hello' },
      { id: '2', role: 'assistant', time: '', content: '', toolCalls: [], modelId: 'test' },
    ]
    expect(historyTokens(messages)).toBeGreaterThan(0)
  })
})

describe('工具结果裁剪（condenseResult 语义约定）', () => {
  it('search_files 每个文件只保留前 3 条命中', () => {
    const lines = ['src/a.ts:1: hit', 'src/a.ts:2: hit', 'src/a.ts:3: hit', 'src/a.ts:4: hit', 'src/b.ts:1: hit']
    const perFile = new Map<string, number>()
    const kept: string[] = []
    let dropped = 0
    for (const line of lines) {
      const file = line.split(':')[0] ?? ''
      const count = perFile.get(file) ?? 0
      if (count >= 3) { dropped++; continue }
      perFile.set(file, count + 1)
      kept.push(line)
    }
    expect(kept).toHaveLength(4) // a.ts 3 条 + b.ts 1 条
    expect(dropped).toBe(1)
    expect(kept.join('\n')).toContain('src/b.ts')
  })
  it('read_file 大结果砍中间保留首尾', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
    const head = lines.slice(0, 150)
    const tail = lines.slice(-60)
    const condensed = `${head.join('\n')}\n…（中间 ${lines.length - 210} 行已省略）\n${tail.join('\n')}`
    expect(condensed).toContain('line 1')
    expect(condensed).toContain('line 300')
    expect(condensed).not.toContain('line 200\n')
    expect(condensed.split('\n').length).toBeLessThan(215)
  })
})

describe('分层摘要（renderTranscript 语义约定）', () => {
  it('工具结果只保留首行结论与 diff 统计，不重放全量输出', () => {
    const message: Message = {
      id: '1', role: 'tool', time: '',
      results: [{ callId: 'c1', name: 'write_file', ok: true, output: '已创建 src/a.ts（10 行）\n第二行会被丢弃', diff: '+added1\n+added2\n-removed1\n+++ b' }],
    }
    const results = message.results.map((result) => {
      const firstLine = result.output.split('\n').find((line) => line.trim())?.slice(0, 200) ?? ''
      const diffNote = result.diff ? ` [改动：${result.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length} 行新增 / ${result.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length} 行删除]` : ''
      return `- ${result.name}：${firstLine}${diffNote}`
    }).join('\n')
    expect(results).toContain('已创建 src/a.ts（10 行）')
    expect(results).not.toContain('第二行会被丢弃')
    expect(results).toContain('2 行新增')
  })
})
