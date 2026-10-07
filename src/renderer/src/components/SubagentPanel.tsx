import { useState } from 'react'
import type { SubagentRun } from '../../../shared/schema'
import { useI18n } from '../i18n'

const statusLabels: Record<SubagentRun['status'], string> = {
  queued: '子任务排队中',
  running: '子任务执行中',
  'awaiting-approval': '子任务等待审批',
  completed: '子任务已完成',
  failed: '子任务未完成',
  cancelled: '子任务已取消',
}

const roleLabels: Record<SubagentRun['role'], string> = {
  general: '通用子智能体',
  researcher: '研究子智能体',
  coder: '编码子智能体',
  reviewer: '审查子智能体',
}

export function SubagentPanel({ runs, pendingCallId }: { runs: SubagentRun[]; pendingCallId?: string }) {
  const { tr } = useI18n()
  const [visibleCount, setVisibleCount] = useState(8)
  if (!runs.length) return null
  const active = runs.filter((run) => run.status === 'running' || run.status === 'awaiting-approval').length
  const queued = runs.filter((run) => run.status === 'queued').length
  const completed = runs.filter((run) => run.status === 'completed').length
  const visible = runs.slice().sort((a, b) => {
    const priority = (run: SubagentRun) => run.status === 'running' || run.status === 'awaiting-approval' ? 0 : run.status === 'queued' ? 1 : 2
    return priority(a) - priority(b)
  }).slice(0, visibleCount)

  return (
    <section className="subagent-panel" aria-label={tr('子智能体进度')}>
      <h3>{tr('子智能体进度')}</h3>
      <p className="subagent-overview" role="status">{tr('执行中 {active} · 排队 {queued} · 完成 {done}/{total}', { active, queued, done: completed, total: runs.length })}</p>
      <div className="subagent-list">
        {visible.map((run) => {
          const status = run.status === 'running' && pendingCallId?.startsWith(`${run.id}:`) ? 'awaiting-approval' : run.status
          return (
            <details className="subagent-card" key={run.id}>
              <summary>
                <span className="subagent-name">{run.name}</span>
                <span className={`subagent-status ${status}`}>{tr(statusLabels[status])}</span>
              </summary>
              <div className="subagent-detail">
                <p>{tr(roleLabels[run.role])} · {tr('子智能体模型')}：{run.modelId}</p>
                <p>{tr('已执行 {step}/{max} 步（步数上限）', { step: run.step, max: run.maxSteps })}</p>
                {run.detail && <p>{tr(run.detail)}</p>}
                <strong>{tr('子任务指令')}</strong>
                <pre>{run.instruction}</pre>
                {run.summary && <><strong>{tr('子任务结果')}</strong><pre>{run.summary}</pre></>}
              </div>
            </details>
          )
        })}
      </div>
      {visibleCount < runs.length && <button type="button" className="btn-secondary" onClick={() => setVisibleCount((count) => count + 8)}>{tr('加载更多子任务')}</button>}
    </section>
  )
}
