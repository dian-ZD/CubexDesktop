import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Cpu } from 'lucide-react'
import { mergeModelParams, supportsThinkingLevel, thinkingLevelLabels, thinkingLevels, type ModelConfig, type ModelParams, type ThinkingLevel } from '../../../shared/schema'
import { useI18n } from '../i18n'

// 滑块直径：刻度点与填充条都按它的半径内缩，保证圆点中心、滑块中心、填充条末端对齐。
const THUMB = 10

export interface ModelPickerProps {
  models: ModelConfig[]
  value: string
  fallbackParams: ModelParams
  compact?: boolean
  className?: string
  label?: string
  disabled?: boolean
  onChangeModel: (id: string) => void
  onChangeThinking: (level: ThinkingLevel) => void
}

export function ModelPicker({ models, value, fallbackParams, compact = false, className, label, disabled = false, onChangeModel, onChangeThinking }: ModelPickerProps) {
  const { tr } = useI18n()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'slider' | 'models'>('slider')
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const model = models.find((item) => item.id === value)
  const merged = mergeModelParams(fallbackParams, model?.params)
  const level: ThinkingLevel = merged.thinkingLevel ?? 'medium'
  const thinkingSupported = model ? supportsThinkingLevel(model.modelId) : true

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  useEffect(() => { if (!open) setMode('slider') }, [open])

  const options = useMemo(() => models.map((item) => {
    const params = mergeModelParams(fallbackParams, item.params)
    const supported = supportsThinkingLevel(item.modelId)
    return {
      value: item.id,
      label: item.name,
      hint: item.modelId,
      thinking: params.thinkingLevel ?? 'medium',
      supported,
    }
  }), [models, fallbackParams])

  // 刻度点与滑块都按「半径内缩」定位，保证圆点中心与滑块中心、填充条末端完全对齐。
  const index = thinkingLevels.indexOf(level)
  const ratio = thinkingLevels.length > 1 ? index / (thinkingLevels.length - 1) : 0
  const stopFromClientX = (clientX: number) => {
    const track = trackRef.current
    if (!track) return index
    const rect = track.getBoundingClientRect()
    const inner = rect.width - THUMB * 2
    if (inner <= 0) return index
    const next = (clientX - rect.left - THUMB) / inner
    return Math.round(Math.max(0, Math.min(1, next)) * (thinkingLevels.length - 1))
  }

  const pick = (next: number) => {
    const clamped = Math.max(0, Math.min(thinkingLevels.length - 1, next))
    if (thinkingLevels[clamped] !== level && thinkingSupported) onChangeThinking(thinkingLevels[clamped])
  }

  return (
    <div ref={rootRef} className={`model-picker tint-${level}${open ? ' open' : ''}${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`} data-thinking={level}>
      <button type="button" className="model-picker-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={label ?? tr('模型')} disabled={disabled} title={model ? `${model.name} · ${model.modelId}` : tr('模型')} onClick={() => setOpen((item) => !item)}>
        <Cpu size={13} />
        <span className="model-picker-trigger-name truncate">{model?.name ?? tr('选择模型')}</span>
        <ChevronRight size={12} className="model-picker-trigger-chevron" />
      </button>
      {open && (
        <div className="model-picker-popover" role="dialog" aria-label={tr('模型与思考强度')}>
          {mode === 'slider' ? (
            <div className="model-picker-dial">
              <button type="button" className={`model-picker-level${thinkingSupported ? '' : ' unsupported'}`} onClick={() => setMode('models')} title={tr('切换模型')}>
                <span className="model-picker-level-name">{thinkingSupported ? tr(thinkingLevelLabels[level]) : tr('当前模型不支持')}</span>
                <span className="model-picker-level-model truncate">{model?.name ?? tr('选择模型')}</span>
              </button>
              <div className="model-picker-track-wrap">
                <div
                  ref={trackRef}
                  className={`model-picker-track${dragging ? ' dragging' : ''}`}
                  role="slider"
                  tabIndex={0}
                  aria-label={tr('思考强度')}
                  aria-valuemin={0}
                  aria-valuemax={thinkingLevels.length - 1}
                  aria-valuenow={index}
                  aria-disabled={!thinkingSupported}
                  onPointerDown={(event) => {
                    if (!thinkingSupported) return
                    pick(stopFromClientX(event.clientX))
                    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 合成事件可能没有真实指针 */ }
                    setDragging(true)
                  }}
                  onPointerMove={(event) => { if (dragging && thinkingSupported) pick(stopFromClientX(event.clientX)) }}
                  onPointerUp={(event) => { setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId) }}
                  onPointerCancel={() => setDragging(false)}
                  onKeyDown={(event) => {
                    if (!thinkingSupported) return
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); pick(index - 1) }
                    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); pick(index + 1) }
                  }}
                >
                  <span className="model-picker-fill" style={{ width: `calc(${ratio} * (100% - ${THUMB * 2}px))` }} />
                  {thinkingLevels.map((item, position) => (
                    <span key={item} className={`model-picker-stop${position <= index ? ' on' : ''}`} style={{ left: `calc(${THUMB}px + ${position / (thinkingLevels.length - 1)} * (100% - ${THUMB * 2}px))` }}>
                      <i />
                    </span>
                  ))}
                  <span className="model-picker-thumb" style={{ left: `calc(${THUMB}px + ${ratio} * (100% - ${THUMB * 2}px))` }} />
                </div>
                <div className="model-picker-ticks" aria-hidden="true">
                  {thinkingLevels.map((item, position) => (
                    <span key={item} className={`model-picker-tick${position <= index ? ' on' : ''}`}>{tr(thinkingLevelLabels[item])}</span>
                  ))}
                </div>
              </div>
              <button type="button" className="model-picker-switch" onClick={() => setMode('models')}>{tr('切换模型')}<ChevronRight size={12} /></button>
            </div>
          ) : (
            <div className="model-picker-list" role="listbox" aria-label={tr('模型')}>
              <button type="button" className="model-picker-back" onClick={() => setMode('slider')}>{tr('返回思考强度')}</button>
              {models.length === 0 && <div className="model-picker-empty">{tr('尚未配置模型，请到设置中添加。')}</div>}
              {options.map((option) => (
                <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={`model-picker-option${option.value === value ? ' active' : ''}`} onClick={() => { onChangeModel(option.value); setMode('slider') }}>
                  <span className="model-picker-option-name truncate">{option.label}</span>
                  <span className="model-picker-option-id truncate">{option.hint}</span>
                  {option.supported
                    ? <span className={`model-picker-chip tint-${option.thinking}`}>{tr(thinkingLevelLabels[option.thinking])}</span>
                    : <span className="model-picker-chip unsupported">{tr('不支持')}</span>}
                  {option.value === value && <Check size={13} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
