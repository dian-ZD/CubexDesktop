import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useI18n } from './i18n'

export interface MenuItem {
  label: string
  icon?: LucideIcon
  danger?: boolean
  disabled?: boolean
  hint?: string
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'separator'

interface DialogRequest {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  input?: { value: string; placeholder?: string; maxLength?: number }
  resolve: (value: string | boolean | null) => void
}

type ToastKind = 'success' | 'error' | 'info' | 'warning'
interface Toast { id: number; kind: ToastKind; text: string }

interface UiApi {
  confirm: (options: { title: string; message?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  prompt: (options: { title: string; message?: string; value?: string; placeholder?: string; confirmLabel?: string; maxLength?: number }) => Promise<string | null>
  toast: (text: string, kind?: ToastKind) => void
  openMenu: (anchor: HTMLElement | { x: number; y: number }, items: MenuEntry[]) => void
}

const UiContext = createContext<UiApi | null>(null)

export function useUi(): UiApi {
  const value = useContext(UiContext)
  if (!value) throw new Error('UiProvider 缺失')
  return value
}

const toastIcon: Record<ToastKind, LucideIcon> = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle }

export function UiProvider({ children }: { children: ReactNode }) {
  const { tr } = useI18n()
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; alignRight?: boolean; items: MenuEntry[] } | null>(null)
  const seq = useRef(0)

  const confirm = useCallback<UiApi['confirm']>((options) => new Promise((resolve) => {
    setDialog({ ...options, resolve: (value) => resolve(value === true) })
  }), [])

  const prompt = useCallback<UiApi['prompt']>((options) => new Promise((resolve) => {
    setDialog({ title: options.title, message: options.message, confirmLabel: options.confirmLabel, input: { value: options.value ?? '', placeholder: options.placeholder, maxLength: options.maxLength }, resolve: (value) => resolve(typeof value === 'string' ? value : null) })
  }), [])

  const toast = useCallback<UiApi['toast']>((text, kind = 'info') => {
    const id = ++seq.current
    setToasts((current) => [...current.slice(-3), { id, kind, text }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), kind === 'error' ? 6000 : 3200)
  }, [])

  const openMenu = useCallback<UiApi['openMenu']>((anchor, items) => {
    if (anchor instanceof HTMLElement) {
      const rect = anchor.getBoundingClientRect()
      setMenu({ x: rect.right, y: rect.bottom + 4, alignRight: true, items })
    } else setMenu({ ...anchor, items })
  }, [])

  const api = useRef<UiApi>({ confirm, prompt, toast, openMenu })
  api.current = { confirm, prompt, toast, openMenu }
  const [stable] = useState<UiApi>(() => ({
    confirm: (options) => api.current.confirm(options),
    prompt: (options) => api.current.prompt(options),
    toast: (text, kind) => api.current.toast(text, kind),
    openMenu: (anchor, items) => api.current.openMenu(anchor, items),
  }))

  return (
    <UiContext.Provider value={stable}>
      {children}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {dialog && <Dialog request={dialog} onClose={() => setDialog(null)} />}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => {
          const Icon = toastIcon[item.kind]
          return <div key={item.id} className={`toast ${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'}><Icon size={16} /><span>{item.text}</span><button className="icon-button" aria-label={tr('关闭提示')} onClick={() => setToasts((current) => current.filter((toastItem) => toastItem.id !== item.id))}><X size={13} /></button></div>
        })}
      </div>
    </UiContext.Provider>
  )
}

function Dialog({ request, onClose }: { request: DialogRequest; onClose: () => void }) {
  const { tr } = useI18n()
  const [value, setValue] = useState(request.input?.value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const finish = useCallback((result: string | boolean | null) => {
    request.resolve(result)
    onClose()
  }, [request, onClose])

  useEffect(() => {
    if (request.input) { inputRef.current?.focus(); inputRef.current?.select() } else confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(request.input ? null : false) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request, finish])

  const invalid = request.input ? value.trim().length === 0 : false
  const submit = () => { if (!invalid) finish(request.input ? value.trim() : true) }

  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(request.input ? null : false) }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <div className="dialog-head">
          {request.danger && <span className="dialog-icon danger"><AlertTriangle size={17} /></span>}
          <h2 id="dialog-title">{request.title}</h2>
        </div>
        {request.message && <p className="dialog-message">{request.message}</p>}
        {request.input && <input ref={inputRef} className="dialog-input" value={value} placeholder={request.input.placeholder} maxLength={request.input.maxLength ?? 120} onChange={(event) => setValue(event.target.value)} />}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={() => finish(request.input ? null : false)}>{tr('取消')}</button>
          <button ref={confirmRef} type="submit" className={request.danger ? 'btn-danger' : 'btn-primary'} disabled={invalid}>{request.confirmLabel ?? tr('确定')}</button>
        </div>
      </form>
    </div>
  )
}

function ContextMenu({ x, y, alignRight, items, onClose }: { x: number; y: number; alignRight?: boolean; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const wanted = alignRight ? x - rect.width : x
    const left = Math.max(8, Math.min(wanted, window.innerWidth - rect.width - 8))
    const top = y + rect.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - rect.height - 8) : y
    setPos({ left, top })
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y, alignRight])

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.left, top: pos.top }}>
      {items.map((item, index) => item === 'separator' ? <div key={index} className="menu-separator" role="separator" /> : (
        <button key={index} type="button" role="menuitem" className={`menu-item${item.danger ? ' danger' : ''}`} disabled={item.disabled} onClick={() => { onClose(); item.onSelect() }}>
          {item.icon ? <item.icon size={15} /> : <span className="menu-icon-space" />}
          <span>{item.label}</span>
          {item.hint && <kbd>{item.hint}</kbd>}
        </button>
      ))}
    </div>
  )
}

export interface SelectOption<T extends string> { value: T; label: string; hint?: string; icon?: LucideIcon }

export function Select<T extends string>({ value, options, onChange, disabled, label, icon: Icon, className, invalid }: { value: T; options: Array<SelectOption<T>>; onChange: (value: T) => void; disabled?: boolean; label: string; icon?: LucideIcon; className?: string; invalid?: boolean }) {
  const { tr } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((item) => item.value === value)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.select-option') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', onKey, true)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('.select-option[aria-selected="true"], .select-option')?.focus())
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  return (
    <div ref={ref} className={`select${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label} aria-invalid={invalid || undefined} title={current?.hint ?? label} disabled={disabled} onClick={() => setOpen((item) => !item)}>
        {Icon && <Icon size={14} />}
        <span className="truncate">{current?.label ?? tr('未选择')}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="select-popover" role="listbox" aria-label={label}>
          {options.length === 0 && <div className="select-empty">{tr('暂无可选项')}</div>}
          {options.map((item) => (
            <button key={item.value} type="button" role="option" aria-selected={item.value === value} className="select-option" onClick={() => { onChange(item.value); setOpen(false) }}>
              {item.icon && <item.icon size={14} />}
              <span className="select-option-text"><span>{item.label}</span>{item.hint && <small>{item.hint}</small>}</span>
              {item.value === value && <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
