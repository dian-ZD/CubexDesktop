import { useEffect, useMemo, useRef, useState } from 'react'
import { Puzzle, Sparkles } from 'lucide-react'
import type { SlashEntry } from '../../../shared/schema'
import { useI18n } from '../i18n'

interface SkillMenuProps {
  entries: SlashEntry[]
  query: string
  onPick: (entry: SlashEntry) => void
  onClose: () => void
}

/** 输入框 / 菜单：技能 + 声明了 slash 的插件工具统一列出 */
export function SkillMenu({ entries, query, onPick, onClose }: SkillMenuProps) {
  const { tr } = useI18n()
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((entry) => entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q))
  }, [entries, query])

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (filtered.length === 0) { if (event.key === 'Escape') onClose(); return } // 无匹配时不拦截其它按键，让输入框正常发送/换行
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % filtered.length) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value - 1 + filtered.length) % filtered.length) }
      else if (event.key === 'Enter' || event.key === 'Tab') {
        const pick = filtered[active]
        if (pick) { event.preventDefault(); onPick(pick) }
      }
      else if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [filtered, active, onPick, onClose])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="skill-menu" role="listbox" aria-label={tr('技能与插件')} ref={listRef}>
      <div className="skill-menu-head"><Sparkles size={13} />{tr('技能与插件')}<span className="skill-menu-hint">{tr('↑↓ 选择 · Enter 确认 · Esc 取消')}</span></div>
      {filtered.length === 0 ? (
        <div className="skill-menu-empty">{tr('未找到匹配的技能或插件，可在设置中导入')}</div>
      ) : (
        <ul>
          {filtered.map((entry, index) => (
            <li key={entry.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                data-index={index}
                className={`skill-menu-item${index === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => { event.preventDefault(); onPick(entry) }}
              >
                <span className="skill-menu-name">{entry.kind === 'skill' ? <Sparkles size={12} className="skill-menu-icon" /> : <Puzzle size={12} className="skill-menu-icon" />}/{entry.name}{entry.kind === 'skill' && entry.builtin && <span className="skill-menu-tag">{tr('内置')}</span>}{entry.kind === 'plugin' && <span className="skill-menu-tag">{tr('插件')}</span>}</span>
                {entry.description && <span className="skill-menu-desc">{entry.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
