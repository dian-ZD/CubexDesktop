import { Check, CircleDashed, CircleMinus, CircleX, LoaderCircle, Pause, Play, RotateCw, SkipForward } from 'lucide-react'
import type { WorkflowRun, WorkflowStep } from '../../../shared/schema'
import { useI18n } from '../i18n'

export type WorkflowAction = 'pause' | 'resume' | 'retry-node' | 'skip-node'

interface WorkflowStripProps {
  run: WorkflowRun
  onControl: (action: WorkflowAction, nodeId?: string) => void
}

function StatusIcon({ status }: { status: WorkflowStep['status'] }) {
  if (status === 'done') return <Check size={12} />
  if (status === 'running') return <LoaderCircle size={12} className="spin" />
  if (status === 'failed') return <CircleX size={12} />
  if (status === 'skipped') return <CircleMinus size={12} />
  return <CircleDashed size={12} />
}

export function WorkflowStrip({ run, onControl }: WorkflowStripProps) {
  const { tr } = useI18n()
  const total = run.steps.length
  const current = run.steps.findIndex((step) => step.status === 'running' || step.status === 'failed')
  const done = run.steps.filter((step) => step.status === 'done').length
  const failed = run.steps.find((step) => step.status === 'failed')
  const label = run.status === 'running' ? tr('运行中') : run.status === 'paused' ? tr('已暂停') : tr('已完成')
  const hint = failed?.error ? tr('失败原因：{error}', { error: failed.error.slice(0, 200) }) : undefined
  return (
    <section className={`workflow-strip ${run.status}`} aria-label={tr('工作流进度')}>
      <div className="workflow-strip-head">
        <span className={`workflow-state-dot ${run.status}`} aria-hidden="true" />
        <strong className="workflow-name truncate" title={run.name}>{run.name}</strong>
        <span className="workflow-state">{label}</span>
        <span className="workflow-count">{current >= 0 ? tr('步骤 {i}/{n}', { i: current + 1, n: total }) : tr('完成 {done}/{n}', { done, n: total })}</span>
        {hint && <span className="workflow-hint truncate" title={failed?.error}>{hint}</span>}
        <div className="workflow-actions">
          {run.status === 'running' && (
            <button type="button" className="btn-secondary" onClick={() => onControl('pause')}><Pause size={13} />{tr('暂停')}</button>
          )}
          {run.status === 'paused' && (
            <>
              {failed && <button type="button" className="btn-secondary" onClick={() => onControl('retry-node', failed.nodeId)}><RotateCw size={13} />{tr('重试该步骤')}</button>}
              {failed && <button type="button" className="btn-secondary" onClick={() => onControl('skip-node', failed.nodeId)}><SkipForward size={13} />{tr('跳过该步骤')}</button>}
              {!failed && <button type="button" className="btn-primary" onClick={() => onControl('resume')}><Play size={13} />{tr('继续')}</button>}
            </>
          )}
        </div>
      </div>
      <ol className="workflow-steps">
        {run.steps.map((step, index) => (
          <li key={step.nodeId} className={`workflow-step ${step.status}`} title={step.error ?? step.output ?? step.title}>
            <span className="workflow-step-icon" aria-hidden="true"><StatusIcon status={step.status} /></span>
            <span className="workflow-step-index">{index + 1}</span>
            <span className="truncate">{step.title}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}