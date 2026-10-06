import { randomUUID } from 'node:crypto'
import type { MessageCard, Workflow, WorkflowRun, WorkflowStep } from '../shared/schema'
import { describeError } from './errors'
import type { StateStore } from './store'
import { composeNodeInstruction, workflowStepPlan } from './workflow'

export interface NodeMeta {
  index: number
  total: number
  title: string
  attempt: number
  card?: MessageCard
}

export interface NodeRunOutcome {
  ok: boolean
  cancelled?: boolean
  error?: string
  output?: string
}

export interface NodeRunner {
  runNode(threadId: string, instruction: string, meta: NodeMeta): Promise<NodeRunOutcome>
  abortRun(threadId: string): boolean
  drainQueue(threadId: string): Promise<void>
}

const MAX_RETRIES = 2
const MAX_NODE_OUTPUT = 20_000

export class WorkflowRunner {
  private running = new Map<string, Promise<void>>()

  constructor(private readonly store: StateStore, private readonly runner: NodeRunner) {}

  async start(threadId: string, workflow: Workflow): Promise<void> {
    const plan = workflowStepPlan(workflow)
    if (plan.length === 0) throw new Error('工作流至少需要一个可执行节点（备注节点不会被执行）')
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (!target) throw new Error('会话不存在')
      if (target.title === '新任务') target.title = workflow.name.slice(0, 60) || '工作流'
      target.workflowRun = {
        workflowId: workflow.id,
        name: workflow.name,
        status: 'running',
        steps: plan.map((step) => ({ ...step, status: 'pending' as const })),
        startedAt: new Date().toISOString(),
      }
      target.updatedAt = new Date().toISOString()
    })
    this.launch(threadId)
  }

  async resume(threadId: string): Promise<void> {
    const run = this.runOf(threadId)
    if (!run) throw new Error('该任务没有工作流')
    if (run.status !== 'paused') throw new Error('工作流不在暂停状态，无法继续')
    if (this.running.has(threadId)) throw new Error('工作流正在推进，请稍后再试')
    const thread = this.store.get().threads.find((item) => item.id === threadId)
    if (!thread || thread.status !== 'idle') throw new Error('当前会话正在运行，请等这轮回复结束后再继续工作流')
    await this.patchRun(threadId, { status: 'running' })
    this.launch(threadId)
  }

  async pause(threadId: string): Promise<void> {
    const run = this.runOf(threadId)
    if (!run || run.status !== 'running') return
    await this.patchRun(threadId, { status: 'paused' })
    this.runner.abortRun(threadId)
    await this.system(threadId, '⏸ 工作流已暂停，可在任务面板继续、重试或跳过当前步骤。')
  }

  async retryNode(threadId: string, nodeId: string): Promise<void> {
    const run = this.requireControllable(threadId)
    const step = run.steps.find((item) => item.nodeId === nodeId)
    if (!step) throw new Error('步骤不存在')
    if (step.status !== 'failed') throw new Error('只能重试失败的步骤')
    await this.patchStep(threadId, nodeId, { status: 'pending', error: undefined, startedAt: undefined, finishedAt: undefined })
    await this.patchRun(threadId, { status: 'running' })
    this.launch(threadId)
  }

  async skipNode(threadId: string, nodeId: string): Promise<void> {
    const run = this.requireControllable(threadId)
    const step = run.steps.find((item) => item.nodeId === nodeId)
    if (!step) throw new Error('步骤不存在')
    if (step.status !== 'failed' && step.status !== 'pending') throw new Error('只能跳过失败或尚未开始的步骤')
    await this.patchStep(threadId, nodeId, { status: 'skipped', error: undefined, finishedAt: new Date().toISOString() })
    await this.patchRun(threadId, { status: 'running' })
    this.launch(threadId)
  }

  private requireControllable(threadId: string): WorkflowRun {
    const run = this.runOf(threadId)
    if (!run) throw new Error('该任务没有工作流')
    if (run.status !== 'paused') throw new Error('请先暂停工作流再操作步骤')
    if (this.running.has(threadId)) throw new Error('工作流正在推进，请稍后再试')
    return run
  }

  private launch(threadId: string): void {
    if (this.running.has(threadId)) return
    const task = this.advance(threadId)
      .catch((error: unknown) => this.pauseWith(threadId, describeError(error)))
      .finally(() => { this.running.delete(threadId) })
    this.running.set(threadId, task)
  }

  private async advance(threadId: string): Promise<void> {
    for (;;) {
      const thread = this.store.get().threads.find((item) => item.id === threadId)
      const run = thread?.workflowRun
      if (!thread || !run || run.status !== 'running') return
      const step = run.steps.find((item) => item.status === 'pending' && this.ready(run.steps, item.deps))
      if (!step) { await this.finish(threadId); return }
      const workflow = this.store.get().workflows?.find((item) => item.id === run.workflowId)
      const node = workflow?.nodes.find((item) => item.id === step.nodeId)
      if (!workflow || !node) {
        await this.patchStep(threadId, step.nodeId, { status: 'failed', error: '工作流已被修改或删除，无法继续', finishedAt: new Date().toISOString() })
        await this.pauseWith(threadId, '工作流已被修改或删除，已暂停。')
        return
      }
      const index = run.steps.findIndex((item) => item.nodeId === step.nodeId) + 1
      const total = run.steps.length
      const upstream = step.deps.flatMap((dep) => {
        const item = run.steps.find((entry) => entry.nodeId === dep)
        return item?.status === 'done' && item.output ? [{ title: item.title, output: item.output }] : []
      })
      const completed = run.steps
        .filter((item) => item.status === 'done' || item.status === 'skipped' || item.status === 'failed')
        .map((item) => ({ title: item.title, status: item.status }))
      const notes = workflow.nodes.filter((item) => item.kind === 'note').map((item) => ({ title: item.title, prompt: item.prompt }))
      await this.patchStep(threadId, step.nodeId, { status: 'running', startedAt: new Date().toISOString() })

      let outcome: NodeRunOutcome = { ok: false, error: '节点未执行' }
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const instruction = composeNodeInstruction({ workflowName: run.name, index, total, title: node.title, kind: node.kind, prompt: node.prompt, upstream, completed, notes })
        try {
          outcome = await this.runner.runNode(threadId, instruction, {
            index,
            total,
            title: node.title,
            attempt,
            ...(index === 1 && attempt === 0 ? { card: { kind: 'workflow' as const, workflowId: workflow.id, name: workflow.name, steps: total } } : {}),
          })
        } catch (error) {
          outcome = { ok: false, error: describeError(error) }
        }
        if (outcome.ok || outcome.cancelled) break
      }

      if (outcome.cancelled) {
        await this.patchStep(threadId, step.nodeId, { status: 'pending', startedAt: undefined })
        const latest = this.runOf(threadId)
        if (latest?.status === 'running') await this.patchRun(threadId, { status: 'paused' })
        return
      }
      if (!outcome.ok) {
        await this.patchStep(threadId, step.nodeId, { status: 'failed', error: (outcome.error ?? '未知错误').slice(0, 4000), finishedAt: new Date().toISOString() })
        await this.pauseWith(threadId, `步骤「${node.title}」执行失败（已自动重试 ${MAX_RETRIES} 次），工作流已暂停。`)
        return
      }
      const output = (outcome.output ?? '').trim().slice(0, MAX_NODE_OUTPUT)
      await this.patchStep(threadId, step.nodeId, { status: 'done', output: output || undefined, finishedAt: new Date().toISOString() })
    }
  }

  private async finish(threadId: string): Promise<void> {
    const run = this.runOf(threadId)
    if (!run) return
    const unfinished = run.steps.filter((item) => item.status === 'pending' || item.status === 'running')
    if (unfinished.length > 0) {
      await this.pauseWith(threadId, '部分步骤因上游未完成而无法继续，工作流已暂停。')
      return
    }
    const done = run.steps.filter((item) => item.status === 'done').length
    const skipped = run.steps.filter((item) => item.status === 'skipped').length
    await this.patchRun(threadId, { status: 'done', finishedAt: new Date().toISOString() })
    await this.system(threadId, `✅ 工作流「${run.name}」已完成（完成 ${done} 步${skipped ? `，跳过 ${skipped} 步` : ''}）。`)
    await this.runner.drainQueue(threadId)
  }

  private async pauseWith(threadId: string, message: string): Promise<void> {
    const run = this.runOf(threadId)
    if (!run || run.status !== 'running') return
    this.runner.abortRun(threadId)
    await this.patchRun(threadId, { status: 'paused' })
    await this.system(threadId, `⏸ ${message}`)
  }

  private ready(steps: WorkflowStep[], deps: string[]): boolean {
    return deps.every((dep) => {
      const item = steps.find((entry) => entry.nodeId === dep)
      return !item || item.status === 'done' || item.status === 'skipped'
    })
  }

  private runOf(threadId: string): WorkflowRun | undefined {
    return this.store.get().threads.find((item) => item.id === threadId)?.workflowRun
  }

  private async patchRun(threadId: string, patch: Partial<WorkflowRun>): Promise<void> {
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (!target?.workflowRun) return
      Object.assign(target.workflowRun, patch)
      target.updatedAt = new Date().toISOString()
    })
  }

  private async patchStep(threadId: string, nodeId: string, patch: Partial<WorkflowStep>): Promise<void> {
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      const run = target?.workflowRun
      if (!run) return
      run.steps = run.steps.map((item) => (item.nodeId === nodeId ? Object.assign({}, item, patch) : item))
      target.updatedAt = new Date().toISOString()
    })
  }

  private async system(threadId: string, content: string): Promise<void> {
    await this.store.update((draft) => {
      const target = draft.threads.find((item) => item.id === threadId)
      if (!target) return
      target.messages = [...target.messages, { id: randomUUID(), role: 'system' as const, time: new Date().toISOString(), level: 'info' as const, content }].slice(-400)
      target.updatedAt = new Date().toISOString()
    })
  }
}