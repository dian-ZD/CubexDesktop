const networkHints: Record<string, string> = {
  ENOTFOUND: '无法解析域名，请检查端点地址是否拼写正确、网络或代理是否可用',
  EAI_AGAIN: 'DNS 解析暂时失败，请检查网络或代理',
  ECONNREFUSED: '连接被拒绝，目标服务未启动或端口错误（本机 Ollama 请确认已运行）',
  ECONNRESET: '连接被对方重置，可能是网络不稳定、代理中断或服务端主动断开',
  ETIMEDOUT: '连接超时，请检查网络或代理',
  EPIPE: '连接意外中断',
  EHOSTUNREACH: '目标主机不可达，请检查网络',
  ENETUNREACH: '网络不可达，请检查网络连接',
  UND_ERR_CONNECT_TIMEOUT: '建立连接超时，请检查网络、代理或端点地址',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时，服务端响应过慢',
  UND_ERR_BODY_TIMEOUT: '读取响应超时，服务端长时间没有输出',
  UND_ERR_SOCKET: '网络连接被中断',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书为自签名，不被信任',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链中存在自签名证书，可能被代理或安全软件拦截',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务端证书',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名与端点不匹配',
}

const statusHints: Record<number, string> = {
  400: '请求参数被拒绝，常见原因是模型 ID 错误、该模型不支持工具调用或参数超出范围',
  401: 'API Key 无效、已过期或与端点不匹配',
  403: '没有访问该模型的权限，或账户余额/额度不足',
  404: '端点或模型不存在，请检查端点地址（OpenAI 兼容端点通常以 /v1 结尾）和模型 ID',
  408: '服务端请求超时',
  413: '请求内容过大，请开启新会话或减少上下文消息数',
  422: '请求格式无法被服务端处理，请检查模型 ID 与提供商类型',
  429: '请求过于频繁或额度用尽，请稍后重试',
  500: '模型服务内部错误',
  502: '网关错误，中转服务或上游暂时不可用',
  503: '模型服务暂时不可用或过载',
  504: '网关超时，上游响应过慢',
}

export function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = errorCode(error)
  return Boolean(code && (code in networkHints || code.startsWith('UND_ERR') || code.startsWith('E'))) || error.message === 'fetch failed'
}

export function describeNetworkError(error: unknown, url: string): string {
  const code = errorCode(error)
  let host: string
  try { host = new URL(url).host } catch { host = url }
  const hint = (code && networkHints[code]) ?? '无法连接到模型服务，请检查网络、代理和端点地址'
  return `无法连接 ${host}：${hint}${code ? `（${code}）` : ''}`
}

export function statusHint(status: number): string | undefined {
  return statusHints[status] ?? (status >= 500 ? '模型服务暂时异常，请稍后重试' : undefined)
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
