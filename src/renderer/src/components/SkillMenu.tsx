import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { SkillMeta } from '../../../shared/schema'
import { useI18n } from '../i18n'

interface SkillMenuProps {
  skills: SkillMeta[]
  query: string
  onPick: (skill: SkillMeta) => void
  onClose: () => void
}

export function SkillMenu({ skills, query, onPick, onClose }: SkillMenuProps) {
  const { tr } = useI18n()
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter((skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q))
  }, [skills, query])

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
    <div className="skill-menu" role="listbox" aria-label={tr('技能')} ref={listRef}>
      <div className="skill-menu-head"><Sparkles size={13} />{tr('技能')}<span className="skill-menu-hint">{tr('↑↓ 选择 · Enter 确认 · Esc 取消')}</span></div>
      {filtered.length === 0 ? (
        <div className="skill-menu-empty">{tr('未找到匹配的技能，可在设置中导入')}</div>
      ) : (
        <ul>
          {filtered.map((skill, index) => (
            <li key={skill.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                data-index={index}
                className={`skill-menu-item${index === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => { event.preventDefault(); onPick(skill) }}
              >
                <span className="skill-menu-name">/{skill.name}{skill.builtin && <span className="skill-menu-tag">{tr('内置')}</span>}</span>
                {skill.description && <span className="skill-menu-desc">{skill.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
