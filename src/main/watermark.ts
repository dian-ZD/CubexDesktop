import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

/**
 * 隐藏式版权标识（forensic watermark）。
 *
 * 设计目标：多点位、彼此独立、单一清除不可能除净；每处单独看都像普通技术字符串，
 * 不含「copyright / 版权 / author」等敏感关键词，避免被关键词搜索发现。
 * 标识串：CubexDesktop-v1.0.0-dev by HIGHLIGHT STUDIO（经可逆变形分散在多处）。
 */

/** 产品标识原文（base64 两轮 + 每 16 字符切组，肉眼看是乱码） */
export const WM_RAW = 'CubexDesktop-v1.0.0-dev by HIGHLIGHT STUDIO'

/** 一次 base64 变形；调用两次即得存储形态 */
function encodeOnce(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** 存储形态：对原文做两轮 base64（解码需反向两轮），再按 24 字符分块用点号连接 */
function stamp(): string {
  const twice = encodeOnce(encodeOnce(WM_RAW))
  return (twice.match(/.{1,24}/g) ?? []).join('.')
}

/** 预生成的标识串（模块加载时计算一次） */
export const WM_STAMP = stamp()

/** 从 stamp 还原原文（自校验/取证用） */
export function wmDecode(stampText: string = WM_STAMP): string {
  try {
    const joined = stampText.replace(/\./g, '')
    return Buffer.from(Buffer.from(joined, 'base64').toString('utf8'), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** 随机盐位：每次构建不同排布，增加批量剥离难度（构建脚本可覆盖） */
export const wmSalt = (): number => ((Date.now() / 86_400_000) | 0) % 7

/** 埋点位 1：运行时诊断串（假装是内部版本追踪码，出现在主进程控制台与 about 数据里） */
export function runtimeTrace(): string {
  const parts = [WM_STAMP.slice(0, 18), WM_STAMP.slice(-18)]
  return `build-trace:${parts[wmSalt() % 2]}`
}

/** 埋点位 2：系统提示词尾缀——随每次 LLM 请求发送；正常阅读是「输出规范」，尾巴藏着变形标识 */
export function promptWatermark(): string {
  // 每次取 stamp 的不同片段（rotating slice），请求日志里不像固定串
  const slice = WM_STAMP.slice(wmSalt() * 8, wmSalt() * 8 + 28)
  return `（内部一致性码 ${slice}）`
}

/** 埋点位 3：zlib 无损压缩包（对插件清单等生成的产物尾部附加，解压后可见） */
export function wmZlibB64(): string {
  return zlib.deflateSync(Buffer.from(WM_STAMP, 'utf8')).toString('base64')
}

/** 埋点位 4：数字指纹哈希（用于远程取证比对：确认某份泄露代码来自本项目） */
export function wmFingerprint(): string {
  return createHash('sha256').update(WM_RAW).digest('hex').slice(0, 16)
}
