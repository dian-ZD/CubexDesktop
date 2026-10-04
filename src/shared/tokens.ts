import type { Message } from './schema'

/**
 * 粗略估算一段文本占用的 token 数。
 * 中日韩等宽字符按 1 个 token 计，其余（英文、数字、符号）按约 4 字符 1 个 token 计。
 * 这是估算值，用于在模型服务不返回 usage 时兜底，以及判断上下文占用比例。
 */
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

/** 估算整段历史消息的 token 总量（含图片等未计入的粗略占位）。 */
export function historyTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0)
}