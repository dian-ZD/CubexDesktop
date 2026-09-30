import type { Message } from '../shared/schema'

export const DEFAULT_CONTEXT_WINDOW = 128_000
const KEEP_RECENT = 8
const OLD_TOOL_OUTPUT = 1_500

export function estimateTokens(text: string): number {
  let wide = 0
  for (const char of text) if (char.charCodeAt(0) > 0x2e80) wide++
  return Math.ceil(wide + (text.length - wide) / 4)
}

export function messageTokens(message: Message): number {
  switch (message.role) {
    case 'user':
    case 'system':
      return estimateTokens(message.content) + 4
    case 'assistant':
      return estimateTokens(message.content) + message.toolCalls.reduce((sum, call) => sum + estimateTokens(JSON.stringify(call.args)) + 8, 4)
    case 'tool':
      return message.results.reduce((sum, result) => sum + estimateTokens(result.output) + estimateTokens(result.diff ?? '') + 8, 0)
  }
}

function shrinkTool(message: Message): Message {
  if (message.role !== 'tool') return message
  return {
    ...message,
    results: message.results.map((result) => result.output.length <= OLD_TOOL_OUTPUT && !result.diff && !result.image ? result : {
      ...result,
      diff: undefined,
      image: undefined,
      output: result.output.length > OLD_TOOL_OUTPUT ? `${result.output.slice(0, OLD_TOOL_OUTPUT)}\n…（较早的工具输出已截断以节省上下文）` : result.output,
    }),
  }
}

export interface ContextFit {
  messages: Message[]
  dropped: number
  tokens: number
}

export function fitContext(messages: Message[], options: { contextWindow?: number; reserve: number; limit: number }): ContextFit {
  const window = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const budget = Math.max(2_000, Math.floor(window * 0.9) - options.reserve)
  let list = messages.slice(-options.limit)
  let dropped = messages.length - list.length
  list = list.map((message, index) => index < list.length - KEEP_RECENT ? shrinkTool(message) : message)
  const costs = list.map(messageTokens)
  let total = costs.reduce((sum, value) => sum + value, 0)
  let start = 0
  while (total > budget && start < list.length - 1) {
    total -= costs[start]
    start++
  }
  const nextUser = list.findIndex((message, index) => index >= start && message.role === 'user')
  if (nextUser > start) {
    for (let index = start; index < nextUser; index++) total -= costs[index]
    start = nextUser
  }
  dropped += start
  return { messages: list.slice(start), dropped, tokens: total }
}
