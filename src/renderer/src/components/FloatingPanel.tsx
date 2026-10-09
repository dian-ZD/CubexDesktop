import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Gauge, LoaderCircle, Mic, MicOff, PictureInPicture2, Square, X } from 'lucide-react'
import type { AppState, PendingQuestion } from '../../../shared/schema'
import { api, isDesktop } from '../bridge'
import { useI18n } from '../i18n'
import { useSpeech } from '../useSpeech'

interface FloatingPanelProps {
  state: AppState
  onClose: () => void
  onOpenMain: () => void
}

const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 120) || '…'

export function FloatingPanel({ state, onClose, onOpenMain }: FloatingPanelProps) {
  const { tr } = useI18n()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [mirror, setMirror] = useState<string | null>(null)
  const [mirrorError, setMirrorError] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const thread = useMemo(() => {
    const running = state.threads.find((item) => item.status === 'running')
    const mostRecent = [...state.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    return running ?? mostRecent ?? null
  }, [state.threads])

  const project = thread ? state.projects.find((item) => item.id === thread.projectId) ?? null : null
  const models = state.settings.models
  const modelId = thread?.modelId || state.settings.defaultModelId
  const model = models.find((item) => item.id === modelId)
  const active = thread?.status === 'running'

  useEffect(() => {
    if (!isDesktop) return
    return api.onDesktopMirror((frame) => {
      setMirror(frame ? frame.image : null)
      setMirrorError('')
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = useCallback(async () => {
    const content = input.trim()
    if (!thread || !content || busy) return
    setBusy(true)
    try {
      const result = await api.sendMessage({ threadId: thread.id, content, modelId })
      if (!result.ok) { setInput(content); return }
      setInput('')
    } finally {
      setBusy(false)
    }
  }, [input, thread, modelId, busy])

  const answer = useCallback(async (question: PendingQuestion, value: string) => {
    if (!thread) return
    await api.answerQuestion({ threadId: thread.id, callId: question.callId, answer: value }).catch(() => undefined)
  }, [thread])

  const speechText = useCallback((text: string) => setInput((current) => (current ? `${current} ${text}` : text)), [])
  const speechError = useCallback((message: string) => { setMirrorError(message) }, [])
  const speech = useSpeech(state.settings.general.uiLanguage, speechText, speechError, state.settings.speech?.model, state.settings.speech?.downloadSource)

  const thinking = state.threads.filter((item) => item.status === 'running').length

  return (
    <div className="floating-panel" role="region" aria-label={tr('悬浮助手')}>
      <header className="floating-head">
        <button type="button" className="floating-title" onClick={onOpenMain} title={tr('打开主窗口')}>
          <PictureInPicture2 size={14} />
          <span className="truncate">{thread ? thread.title : tr('没有进行中的任务')}</span>
        </button>
        <div className="floating-head-actions">
          {active && <span className="floating-status" role="status"><LoaderCircle size={12} className="spin" />{tr('运行中')}</span>}
          <button type="button" className="icon-button" aria-label={tr('打开主窗口')} title={tr('打开主窗口')} onClick={onOpenMain}><Gauge size={14} /></button>
          <button type="button" className="icon-button" aria-label={tr('关闭悬浮窗')} title={tr('关闭悬浮窗')} onClick={onClose}><X size={14} /></button>
        </div>
      </header>

      {mirror && mirror.startsWith('data:image') && (
        <div className="floating-mirror" role="img" aria-label={tr('独立桌面实时镜像')}>
          <img src={mirror} alt={tr('独立桌面实时镜像')} />
          <span className="floating-mirror-tag">{tr('独立桌面')}</span>
        </div>
      )}
      {mirrorError && <div className="floating-mirror-error">{mirrorError}</div>}

      <div className="floating-body">
        {!thread && <p className="floating-empty">{tr('还没有任务。回到主窗口描述你想做的事，我会在这里显示进度。')}</p>}
        {thread && (
          <>
            <div className="floating-meta">
              <span className={`dot${active ? ' running' : ''}`} />
              <span className="truncate">{model?.name ?? tr('未选择模型')}</span>
              {project && <span className="truncate floating-project">{project.name}</span>}
              {thinking > 1 && <span className="floating-count">{tr('{n} 个任务运行中', { n: thinking })}</span>}
            </div>
            {(thread.todos?.length ?? 0) > 0 && (
              <ul className="floating-todos">
                {thread.todos!.slice(0, 6).map((todo) => (
                  <li key={todo.id} className={`todo-dot ${todo.status}`}>
                    <span className="truncate">{todo.content}</span>
                  </li>
                ))}
              </ul>
            )}
            <ol className="floating-feed">
              {thread.messages.slice(-6).map((message) => (
                <li key={message.id} className={`floating-feed-item ${message.role}`}>
                  <span className="floating-feed-role">{message.role === 'user' ? tr('你') : message.role === 'assistant' ? tr('助手') : message.role === 'tool' ? tr('工具') : tr('系统')}</span>
                  <span className="truncate">{message.role === 'system' ? message.content : message.role === 'assistant' ? preview(message.content) : message.role === 'tool' ? tr('{n} 个工具结果', { n: message.results.length }) : preview(message.content)}</span>
                </li>
              ))}
            </ol>
            {thread.question && (
              <div className="floating-question" role="group" aria-label={tr('助手需要你补充信息')}>
                <p className="truncate">{thread.question.question}</p>
                <div className="floating-question-options">
                  {(thread.question.options ?? []).map((option) => (
                    <button key={option} type="button" className="btn-secondary" onClick={() => void answer(thread.question!, option)}>{option}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <form className="floating-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          aria-label={tr('消息')}
          placeholder={thread ? tr('随时插一句话…') : tr('没有任务')}
          disabled={!thread || busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }}
        />
        <div className="floating-composer-actions">
          <button type="button" className="icon-button" disabled={busy} aria-label={speech.status === 'recording' ? tr('停止语音输入') : tr('语音输入')} onClick={speech.toggle}>
            {speech.status === 'recording' ? <MicOff size={14} /> : <Mic size={14} />}
          </button>
          {active ? (
            <button type="button" className="icon-button" aria-label={tr('停止回复')} title={tr('停止回复')} onClick={() => void api.cancelThread({ threadId: thread!.id })}><Square size={14} /></button>
          ) : (
            <button type="submit" className="btn-primary" disabled={!thread || !input.trim() || busy} aria-label={tr('发送')}><ArrowUp size={14} /></button>
          )}
        </div>
      </form>
    </div>
  )
}
