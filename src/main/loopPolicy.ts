/**
 * agent 循环停机策略。
 *
 * 逻辑移植自 https://github.com/kernel4632/agent-core 的 features/loop.js
 * （该包深度绑定 Bun 运行时：Bun.hash / Bun.Glob / Bun.spawn，无法在 Electron 里直接运行，
 *  因此只移植与「循环何时停止」相关的部分，不引入依赖）。
 *
 * 默认（beta.agentLoop = false）走 DEFAULT_LOOP_POLICY，行为与引入本文件之前完全一致。
 */

export interface LoopPolicy {
  /** 模型连续多少轮不调用工具就结束本轮；1 表示不补问（旧行为） */
  noToolRounds: number
  /** 补问时临时追加的提示（只随本次请求发送，不写入历史） */
  noToolPrompt: string
  /** 历史 token 达到上下文窗口的这个比例时触发自动摘要压缩 */
  compactRatio: number
}

export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  noToolRounds: 1,
  noToolPrompt: '',
  compactRatio: 0.9,
}

export const OPTIMIZED_LOOP_POLICY: LoopPolicy = {
  noToolRounds: 3,
  noToolPrompt: '请继续使用工具推进任务（读取文件、修改代码、执行命令等），不要只用文字作答；如果任务确实已经完成，再用文字给出最终结论。',
  compactRatio: 0.8,
}

export function resolveLoopPolicy(enabled: boolean): LoopPolicy {
  return enabled ? OPTIMIZED_LOOP_POLICY : DEFAULT_LOOP_POLICY
}

export interface NoToolStep {
  /** true：连续补问已用尽，结束本轮 */
  done: boolean
  /** true：下一次请求临时带上补问提示 */
  nudge: boolean
}

/**
 * 对应 loop.js 里的三行：
 *   noToolCount += 1
 *   if (noToolCount === noToolRounds - 1) temporaryPrompt = llm.noToolPrompt
 *   if (noToolCount >= noToolRounds) return { reason: 'no-tool', ...answer }
 *
 * 入参 count 是已经自增过的连续无工具轮数。
 * 注意 noToolRounds = 1 时永远 done，不产生补问——这就是关闭开关时的原始行为。
 */
export function nextNoToolStep(count: number, rounds: number): NoToolStep {
  if (count >= rounds) return { done: true, nudge: false }
  if (rounds > 1 && count === rounds - 1) return { done: false, nudge: true }
  return { done: false, nudge: false }
}
