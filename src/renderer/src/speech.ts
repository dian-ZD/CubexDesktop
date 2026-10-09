// 语音识别：动态加载 @xenova/transformers 并直接跑在渲染进程主线程。
// 打包后页面位于 app.asar 内的 file://，其中无法创建可用的 Web Worker（实测 sandbox bundle 起不来），
// 因此不再使用 worker：whisper-tiny 体积小，主线程 WASM 推理在短语音下可以接受。
type AsrPipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>

export type SpeechLanguage = 'zh' | 'en'

export interface SpeechProgress {
  status: string
  file?: string
  progress: number
}

export const speechModels = [
  { id: 'Xenova/whisper-tiny', label: '轻量（默认）', size: '约 40 MB' },
  { id: 'Xenova/whisper-base', label: '均衡', size: '约 78 MB' },
  { id: 'Xenova/whisper-small', label: '较准（慢）', size: '约 242 MB' },
] as const

export const DEFAULT_SPEECH_MODEL = 'Xenova/whisper-tiny'

const WASM_PATHS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/'
const RATE = 16_000
// 模型下载源：官方直连与国内镜像。auto 会先试官方，失败再自动切镜像重试。
const REMOTE_HOSTS = { official: 'https://huggingface.co/', mirror: 'https://hf-mirror.com/' } as const
export type DownloadSource = keyof typeof REMOTE_HOSTS | 'auto'
// 超过 30 秒才分块：短录音单次解码可以避免把首尾静音块的幻觉文本拼进结果。
const SINGLE_PASS_LIMIT = RATE * 30

// whisper 在静音/非语音片段上的典型幻觉，整段命中时按“没有识别到内容”处理。
const HALLUCINATIONS = ['（音乐）', '(音乐)', '音乐', '字幕由', '字幕提供', '由 Amara.org 社群提供的字幕', '请观看', '谢谢观看', '感谢观看', '感谢您的观看', 'Thanks for watching', 'MBC', 'APP', 'APP 提供']

const cache = new Map<string, Promise<AsrPipeline>>()

async function loadTransformers() {
  const module = await import('@xenova/transformers')
  module.env.allowLocalModels = false
  module.env.useBrowserCache = true
  // onnxruntime-web 默认从 CDN 取 wasm；显式指定，避免打包环境下解析失败。
  module.env.backends.onnx.wasm.wasmPaths = WASM_PATHS
  return module
}

function hostsFor(source: DownloadSource): Array<keyof typeof REMOTE_HOSTS> {
  return source === 'auto' ? ['official', 'mirror'] : [source]
}

async function loadAsrFrom(host: keyof typeof REMOTE_HOSTS, modelId: string, onProgress?: (progress: SpeechProgress) => void): Promise<AsrPipeline> {
  const module = await loadTransformers()
  module.env.remoteHost = REMOTE_HOSTS[host]
  return module.pipeline('automatic-speech-recognition', modelId, {
    quantized: true,
    progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
      onProgress?.({ status: progress.status, file: progress.file, progress: progress.progress ?? 0 })
    },
  }) as unknown as Promise<AsrPipeline>
}

// 按下载源依次尝试（auto：官方失败自动切国内镜像），每个源各自缓存，避免重复下载。
export async function loadAsr(modelId = DEFAULT_SPEECH_MODEL, source: DownloadSource = 'auto', onProgress?: (progress: SpeechProgress) => void): Promise<AsrPipeline> {
  let lastError: unknown
  for (const host of hostsFor(source)) {
    const key = `${host}|${modelId}`
    try {
      const existing = cache.get(key)
      if (existing) return await existing
      const pending = loadAsrFrom(host, modelId, onProgress)
      cache.set(key, pending)
      pending.catch(() => cache.delete(key))
      return await pending
    } catch (error) {
      lastError = error
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? '未知错误')
  throw new Error(`语音模型下载失败：${detail}。可到 设置 → 通用 → 语音输入 里更换「下载源」后重试（无法访问 HuggingFace 时请选国内镜像）。`)
}

/** 去掉首尾静音并把电平归一化到约 -3 dBFS；whisper 对电平极低的录音更容易输出幻觉。 */
export function prepareAudio(audio: Float32Array, rate = RATE): { samples: Float32Array; peak: number } {
  let peak = 0
  for (let index = 0; index < audio.length; index++) {
    const value = Math.abs(audio[index])
    if (value > peak) peak = value
  }
  if (peak < 1e-4 || audio.length < rate * 0.2) return { samples: new Float32Array(0), peak }
  const frame = Math.max(1, Math.round(rate * 0.02))
  const rmsAt = (from: number) => {
    let sum = 0
    for (let index = from; index < Math.min(from + frame, audio.length); index++) sum += audio[index] * audio[index]
    return Math.sqrt(sum / frame)
  }
  const threshold = Math.max(0.006, peak * 0.02)
  let start = 0
  for (let index = 0; index + frame <= audio.length; index += frame) {
    if (rmsAt(index) > threshold) { start = Math.max(0, index - frame); break }
  }
  let end = audio.length
  for (let index = audio.length - frame; index > start; index -= frame) {
    if (rmsAt(index) > threshold) { end = Math.min(audio.length, index + frame * 2); break }
  }
  const trimmed = audio.slice(start, end)
  const gain = peak > 0 ? Math.min(4, 0.7 / peak) : 1
  const samples = new Float32Array(trimmed.length)
  for (let index = 0; index < trimmed.length; index++) samples[index] = Math.max(-1, Math.min(1, trimmed[index] * gain))
  return { samples, peak }
}

/** 结果整体是幻觉短语时返回空串，让上层提示“没有识别到内容”。 */
export function stripHallucination(text: string): string {
  const cleaned = text.trim()
  if (!cleaned) return ''
  const stripped = cleaned.replace(/[（()）\s。.，,！!？?、~—-]/g, '')
  for (const phrase of HALLUCINATIONS) {
    const normalized = phrase.replace(/[（()）\s。.，,！!？?、~—-]/g, '')
    if (stripped === normalized) return ''
  }
  return cleaned
}

export async function transcribe(audio: Float32Array, language: SpeechLanguage, modelId = DEFAULT_SPEECH_MODEL, source: DownloadSource = 'auto', onProgress?: (progress: SpeechProgress) => void): Promise<string> {
  const prepared = prepareAudio(audio)
  if (prepared.samples.length < RATE * 0.3) return ''
  const asr = await loadAsr(modelId, source, onProgress)
  const options: Record<string, unknown> = { language, task: 'transcribe' }
  if (prepared.samples.length > SINGLE_PASS_LIMIT) {
    options.chunk_length_s = 30
    options.stride_length_s = 5
  }
  const output = await asr(prepared.samples, options)
  const text = Array.isArray(output) ? output.map((item) => item.text ?? '').join('') : (output.text ?? '')
  return stripHallucination(text)
}

// 供隔离回归探针使用：复现 useSpeech 的解码 + 重采样链路，避免与真实代码脱节。
;(globalThis as unknown as { __cubexSpeech?: unknown }).__cubexSpeech = { transcribe, prepareAudio }
