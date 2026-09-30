import { describe, expect, it } from 'vitest'
import { estimateTokens, fitContext } from '../src/main/context'
import type { Message } from '../src/shared/schema'

const time = new Date().toISOString()
let seq = 0
const user = (content: string): Message => ({ id: `m${seq++}`, role: 'user', time, content })
const assistant = (content: string): Message => ({ id: `m${seq++}`, role: 'assistant', time, content, toolCalls: [], modelId: 'x' })
const tool = (output: string): Message => ({ id: `m${seq++}`, role: 'tool', time, results: [{ callId: `c${seq}`, name: 'read_file', ok: true, output }] })

describe('上下文管理', () => {
  it('中日韩字符按 1 token 估算，其余按 4 字符估算', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('预算充足时保留全部消息', () => {
    const messages = [user('hi'), assistant('hello')]
    const fit = fitContext(messages, { reserve: 0, limit: 100 })
    expect(fit.messages).toHaveLength(2)
    expect(fit.dropped).toBe(0)
  })

  it('超出条数上限时从头部裁剪并从 user 消息开始', () => {
    const messages = [user('a'), assistant('b'), user('c'), assistant('d'), user('e')]
    const fit = fitContext(messages, { reserve: 0, limit: 4 })
    expect(fit.messages[0].role).toBe('user')
    expect(fit.messages.map((item) => item.id)).toEqual(messages.slice(2).map((item) => item.id))
    expect(fit.dropped).toBe(2)
  })

  it('超出 token 预算时丢弃较早的轮次', () => {
    const big = 'x'.repeat(40_000)
    const messages = [user(big), assistant(big), user(big), assistant(big), user('最新问题')]
    const fit = fitContext(messages, { contextWindow: 20_000, reserve: 2_000, limit: 100 })
    expect(fit.messages[0].role).toBe('user')
    expect(fit.messages.at(-1)).toEqual(messages.at(-1))
    expect(fit.dropped).toBeGreaterThan(0)
    expect(fit.tokens).toBeLessThanOrEqual(16_000)
  })

  it('截断较早的长工具输出，保留最近消息原样', () => {
    const long = 'y'.repeat(5_000)
    const messages = [user('q'), tool(long), ...Array.from({ length: 8 }, (_, index) => index % 2 ? assistant('a') : user('b'))]
    const fit = fitContext(messages, { reserve: 0, limit: 100 })
    const shrunk = fit.messages[1]
    expect(shrunk.role === 'tool' && shrunk.results[0].output.length).toBeLessThan(2_000)
    expect(messages[1].role === 'tool' && messages[1].results[0].output.length).toBe(5_000)
  })
})
