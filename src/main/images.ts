import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderConfig } from '../shared/schema'
import { describeNetworkError, isNetworkError, statusHint } from './errors'

export interface GenerateImageInput {
  provider: ProviderConfig
  apiKey: string | undefined
  modelId: string
  prompt: string
  size: string
  root: string
  signal: AbortSignal
}

export interface GeneratedImage {
  dataUrl: string
  file: string
  revisedPrompt?: string
}

const TIMEOUT_MS = 300_000
const MAX_IMAGE_BYTES = 12_000_000
const SUPPORTED_MIME = /^(image\/(png|jpeg|gif|webp))$/

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const { provider, apiKey, modelId, prompt, size, root, signal } = input
  if (!modelId.trim()) throw new Error('尚未配置图片生成模型，请在设置 → 图片生成中选择提供商与模型')
  if (provider.kind !== 'openai-compatible') throw new Error('图片生成目前仅支持 OpenAI 兼容提供商')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/images/generations`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) throw new Error('已取消')
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, prompt, n: 1, ...(size && size !== 'auto' ? { size } : {}) }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim().slice(0, 400)
      const hint = statusHint(response.status)
      throw new Error(`生图服务返回 ${response.status}${text ? `：${text}` : ''}${hint ? `\n提示：${hint}` : ''}`)
    }
    const data = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>; error?: { message?: string } }
    if (data.error?.message) throw new Error(`生图服务报错：${data.error.message}`)
    const item = data.data?.[0]
    if (!item) throw new Error('生图服务没有返回图片数据')
    const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
    if (item.b64_json) {
      const mime = sniffMime(Buffer.from(item.b64_json, 'base64'))
      const saved = await persist(root, item.b64_json, mime)
      return { dataUrl: `data:${mime};base64,${item.b64_json}`, file: saved, ...(revisedPrompt ? { revisedPrompt } : {}) }
    }
    if (item.url) {
      const image = await downloadImage(item.url, signal)
      const saved = await persist(root, image.base64, image.mime)
      return { dataUrl: `data:${image.mime};base64,${image.base64}`, file: saved, ...(revisedPrompt ? { revisedPrompt } : {}) }
    }
    throw new Error('生图服务返回的结果里既没有 b64_json 也没有 url')
  } catch (error) {
    if (signal.aborted) throw new Error('已取消', { cause: error })
    if (isNetworkError(error)) throw new Error(describeNetworkError(error, url), { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

async function downloadImage(target: string, signal: AbortSignal): Promise<{ base64: string; mime: string }> {
  let parsed: URL
  try { parsed = new URL(target) } catch { throw new Error(`生图服务返回了无效的图片地址：${target.slice(0, 200)}`) }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('仅支持 http/https 图片地址')
  const response = await fetch(parsed.toString(), { signal })
  if (!response.ok) throw new Error(`下载生成的图片失败（${response.status}）`)
  const mime = (response.headers.get('content-type')?.split(';')[0] ?? 'image/png').trim()
  if (!SUPPORTED_MIME.test(mime)) throw new Error(`不支持的图片格式：${mime || '未知'}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`生成的图片过大（${buffer.byteLength} 字节），无法放入对话`)
  return { base64: buffer.toString('base64'), mime }
}

function sniffMime(buffer: Buffer): string {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length > 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  if (buffer.length > 6 && buffer.slice(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  return 'image/png'
}

async function persist(root: string, base64: string, mime: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.byteLength === 0) throw new Error('生成的图片数据为空')
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`生成的图片过大（${buffer.byteLength} 字节），无法放入对话`)
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : 'webp'
  const dir = join(root, '.cubex', 'images')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `img-${Date.now()}.${ext}`)
  await writeFile(file, buffer)
  return file
}
