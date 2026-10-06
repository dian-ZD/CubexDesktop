import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOP_POLICY, nextNoToolStep, OPTIMIZED_LOOP_POLICY, resolveLoopPolicy } from '../src/main/loopPolicy'

describe('loopPolicy', () => {
  it('默认策略与引入本模块之前的行为一致', () => {
    expect(DEFAULT_LOOP_POLICY.noToolRounds).toBe(1)
    expect(DEFAULT_LOOP_POLICY.compactRatio).toBe(0.9)
    expect(DEFAULT_LOOP_POLICY.noToolPrompt).toBe('')
    expect(resolveLoopPolicy(false)).toBe(DEFAULT_LOOP_POLICY)
  })

  it('开启后是 3 轮补问、80% 触发压缩', () => {
    expect(resolveLoopPolicy(true)).toBe(OPTIMIZED_LOOP_POLICY)
    expect(OPTIMIZED_LOOP_POLICY.noToolRounds).toBe(3)
    expect(OPTIMIZED_LOOP_POLICY.compactRatio).toBe(0.8)
    expect(OPTIMIZED_LOOP_POLICY.noToolPrompt.length).toBeGreaterThan(10)
  })

  // 与 agent-core features/loop.js 的三行逐条对应：
  //   noToolCount += 1
  //   if (noToolCount === noToolRounds - 1) temporaryPrompt = llm.noToolPrompt
  //   if (noToolCount >= noToolRounds) return { reason: 'no-tool' }
  it('关闭时第 1 轮无工具就结束，且永不补问', () => {
    expect(nextNoToolStep(1, 1)).toEqual({ done: true, nudge: false })
  })

  it('开启后第 1、2 轮继续，第 2 轮设置补问，第 3 轮结束', () => {
    expect(nextNoToolStep(1, 3)).toEqual({ done: false, nudge: false })
    expect(nextNoToolStep(2, 3)).toEqual({ done: false, nudge: true })
    expect(nextNoToolStep(3, 3)).toEqual({ done: true, nudge: false })
  })

  it('2 轮时第 1 轮就补问', () => {
    expect(nextNoToolStep(1, 2)).toEqual({ done: false, nudge: true })
    expect(nextNoToolStep(2, 2)).toEqual({ done: true, nudge: false })
  })

  it('轮数很大时既不补问也不结束', () => {
    expect(nextNoToolStep(5, 100)).toEqual({ done: false, nudge: false })
  })
})
