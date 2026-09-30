import { pipeline, env } from '@xenova/transformers'

env.allowLocalModels = false
env.useBrowserCache = true

const MODEL_ID = 'Xenova/whisper-tiny'

type AsrOutput = { text?: string }
type AsrPipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<AsrOutput | AsrOutput[]>

type LoadMessage = { type: 'load' }
type TranscribeMessage = { type: 'transcribe'; audio: Float32Array; language: 'zh' | 'en' }
type InMessage = LoadMessage | TranscribeMessage

let asrPromise: Promise<AsrPipeline> | null = null

function getAsr(): Promise<AsrPipeline> {
  if (!asrPromise) {
    asrPromise = pipeline('automatic-speech-recognition', MODEL_ID, {
      quantized: true,
      progress_callback: (progress: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
        self.postMessage({ type: 'progress', status: progress.status, file: progress.file, progress: progress.progress ?? 0 })
      },
    }) as unknown as Promise<AsrPipeline>
  }
  return asrPromise
}

self.addEventListener('message', (event: MessageEvent<InMessage>) => {
  const data = event.data
  if (data.type === 'load') {
    getAsr().then(() => self.postMessage({ type: 'ready' })).catch((error: unknown) => {
      asrPromise = null
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return
  }
  if (data.type === 'transcribe') {
    getAsr().then(async (asr) => {
      const output = await asr(data.audio, { language: data.language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 })
      const text = Array.isArray(output) ? output.map((item) => item.text ?? '').join('') : (output.text ?? '')
      self.postMessage({ type: 'result', text: (text ?? '').trim() })
    }).catch((error: unknown) => {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }
})
