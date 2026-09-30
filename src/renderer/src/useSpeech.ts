import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiLanguage } from '../../shared/schema'

export type SpeechStatus = 'idle' | 'recording' | 'loading' | 'transcribing'

type WorkerOut =
  | { type: 'progress'; status: string; file?: string; progress?: number }
  | { type: 'ready' }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string }

async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const buffer = await blob.arrayBuffer()
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) throw new Error('浏览器不支持音频解码')
  const ctx = new AudioCtx()
  try {
    const decoded = await ctx.decodeAudioData(buffer)
    const targetRate = 16000
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return rendered.getChannelData(0).slice()
  } finally {
    void ctx.close()
  }
}

export interface UseSpeech {
  status: SpeechStatus
  progress: number
  toggle: () => void
  supported: boolean
}

export function useSpeech(uiLanguage: UiLanguage, onText: (text: string) => void, onError: (message: string) => void): UseSpeech {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const [progress, setProgress] = useState(0)
  const workerRef = useRef<Worker | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const onTextRef = useRef(onText)
  const onErrorRef = useRef(onError)
  const langRef = useRef<UiLanguage>(uiLanguage)
  onTextRef.current = onText
  onErrorRef.current = onError
  langRef.current = uiLanguage

  const supported = typeof window !== 'undefined' && typeof Worker !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      const worker = new Worker(new URL('./speech.worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('message', (event: MessageEvent<WorkerOut>) => {
        const data = event.data
        if (data.type === 'progress') {
          if (data.status === 'progress' && typeof data.progress === 'number') setProgress(Math.round(data.progress))
        } else if (data.type === 'result') {
          setStatus('idle')
          setProgress(0)
          const text = data.text.trim()
          if (text) onTextRef.current(text)
        } else if (data.type === 'error') {
          setStatus('idle')
          setProgress(0)
          onErrorRef.current(data.message || '语音识别失败')
        }
      })
      workerRef.current = worker
    }
    return workerRef.current
  }, [])

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) chunksRef.current.push(event.data) })
      recorder.addEventListener('stop', () => {
        stopStream()
        const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/webm' })
        chunksRef.current = []
        if (blob.size === 0) { setStatus('idle'); return }
        setStatus('loading')
        decodeToMono16k(blob).then((audio) => {
          setStatus('transcribing')
          getWorker().postMessage({ type: 'transcribe', audio, language: langRef.current === 'en' ? 'en' : 'zh' }, [audio.buffer])
        }).catch((error: unknown) => {
          setStatus('idle')
          onErrorRef.current(error instanceof Error ? error.message : '音频处理失败')
        })
      })
      recorderRef.current = recorder
      recorder.start()
      setStatus('recording')
    } catch (error) {
      stopStream()
      setStatus('idle')
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') onErrorRef.current('麦克风权限被拒绝，请在系统设置中允许本应用使用麦克风')
      else if (name === 'NotFoundError') onErrorRef.current('未检测到麦克风设备，请检查设备连接')
      else onErrorRef.current('无法启动麦克风')
    }
  }, [getWorker, stopStream])

  const toggle = useCallback(() => {
    if (!supported) { onErrorRef.current('当前环境不支持语音输入，请使用键盘输入'); return }
    if (status === 'recording') {
      recorderRef.current?.stop()
      recorderRef.current = null
      return
    }
    if (status === 'idle') void start()
  }, [status, supported, start])

  useEffect(() => () => {
    recorderRef.current?.stop()
    stopStream()
    workerRef.current?.terminate()
    workerRef.current = null
  }, [stopStream])

  return { status, progress, toggle, supported }
}
