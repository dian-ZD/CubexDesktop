import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { StateStore } from '../src/main/store'
import { WorkflowRunner, type NodeMeta, type NodeRunOutcome, type NodeRunner } from '../src/main/workflowRunner'
import { workflowControlInputSchema, type Workflow, type WorkflowNode } from '../src/shared/schema'

const now = () => new Date().toISOString()

class FakeRunner implements NodeRunner {
  calls: Array<{ instruction: string; meta: NodeMeta }> = []
  outcomes: Array<NodeRunOutcome | undefined> = []
  drained: string[] = []
  aborts = 0
  manual = false
  private resolvers: Array<(outcome: NodeRunOutcome) => void> = []

  async runNode(_threadId: string, instruction: string, meta: NodeMeta): Promise<NodeRunOutcome> {
    this.calls.push({ instruction, meta })
    if (this.manual) return new Promise<NodeRunOutcome>((resolve) => this.resolvers.push(resolve))
    return this.outcomes.shift() ?? { ok: true, output: `产出：${meta.title}` }
  }

  abortRun(): boolean {
    this.aborts += 1
    return true
  }

  async drainQueue(threadId: string): Promise<void> {
    this.drained.push(threadId)
  }

  release(outcome: NodeRunOutcome): void {
    this.resolvers.shift()?.(outcome)
  }
}

const node = (id: string, title: string, kind?: WorkflowNode['kind']): WorkflowNode => ({ id, title, prompt: `${title} 的任务说明`, x: 0, y: 0, ...(kind ? { kind } : {}) })
const flow = (nodes: WorkflowNode[], edges: Array<{ from: string; to: string }> = []): Workflow => ({ id: 'wf1', projectId: 'p1', name: '测试工作流', nodes, edges, updatedAt: now() })

let dir: string
let store: StateStore
let fake: FakeRunner
let runner: WorkflowRunner

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubex-wf-'))
  store = new StateStore(join(dir, 'state.json'))
  await store.load()
  await store.update((state) => {
    state.projects.push({ id: 'p1', name: 'proj', path: dir })
    state.threads.push({ id: 't1', projectId: 'p1', title: '新任务', modelId: 'm1', status: 'idle', createdAt: now(), updatedAt: now(), messages: [] })
  })
  fake = new FakeRunner()
  runner = new WorkflowRunner(store, fake)
})

const thread = () => store.get().threads.find((item) => item.id === 't1')!
const run = () => thread().workflowRun!
const save = (workflow: Workflow) => store.update((state) => { state.workflows = [workflow] })

async function settle(timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (run().status === 'running') {
    if (Date.now() - start > timeoutMs) throw new Error('等待工作流推进超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('DAG 推进', () => {
  it('按拓扑序执行，并把上游产出注入下游指令', async () => {
    const workflow = flow([node('a', '构建'), node('b', '测试')], [{ from: 'a', to: 'b' }])
    await save(workflow)
    fake.outcomes.push({ ok: true, output: '构建成功，产物在 dist/' })
    await runner.start('t1', workflow)
    await settle()
    expect(fake.calls.map((call) => call.meta.title)).toEqual(['构建', '测试'])
    expect(fake.calls[0].instruction).toContain('第 1/2 步：构建')
    expect(fake.calls[1].instruction).toContain('第 2/2 步：测试')
    expect(fake.calls[1].instruction).toContain('构建成功，产物在 dist/')
    expect(fake.calls[1].instruction).toContain('[x] 构建')
    expect(run().status).toBe('done')
    expect(run().steps.map((step) => step.status)).toEqual(['done', 'done'])
    expect(run().steps[0].output).toBe('构建成功，产物在 dist/')
    expect(fake.drained).toEqual(['t1'])
  })

  it('备注节点不执行，但作为背景注入', async () => {
    const workflow = flow([node('n', '背景', 'note'), { ...node('a', '构建'), x: 250 }])
    await save(workflow)
    await runner.start('t1', workflow)
    await settle()
    expect(fake.calls.length).toBe(1)
    expect(fake.calls[0].meta.title).toBe('构建')
    expect(fake.calls[0].instruction).toContain('背景信息')
    expect(fake.calls[0].instruction).toContain('背景 的任务说明')
  })

  it('没有可执行节点时拒绝启动', async () => {
    const workflow = flow([node('n', '背景', 'note')])
    await save(workflow)
    await expect(runner.start('t1', workflow)).rejects.toThrow('可执行节点')
  })
})

describe('失败与重试', () => {
  it('失败自动重试到上限后暂停，后续步骤不动', async () => {
    const workflow = flow([node('a', '构建'), node('b', '部署')], [{ from: 'a', to: 'b' }])
    await save(workflow)
    fake.outcomes.push({ ok: false, error: '构建失败' }, { ok: false, error: '构建失败' }, { ok: false, error: '构建失败' })
    await runner.start('t1', workflow)
    await settle()
    expect(fake.calls.map((call) => call.meta.attempt)).toEqual([0, 1, 2])
    expect(run().status).toBe('paused')
    expect(run().steps[0].status).toBe('failed')
    expect(run().steps[0].error).toContain('构建失败')
    expect(run().steps[1].status).toBe('pending')
  })

  it('重试成功则继续后续步骤', async () => {
    const workflow = flow([node('a', '构建')])
    await save(workflow)
    fake.outcomes.push({ ok: false, error: '瞬时故障' })
    await runner.start('t1', workflow)
    await settle()
    expect(fake.calls.length).toBe(2)
    expect(fake.calls[1].meta.attempt).toBe(1)
    expect(run().status).toBe('done')
    expect(run().steps[0].status).toBe('done')
  })

  it('工作流已被删除时节点失败并暂停', async () => {
    const workflow = flow([node('a', '构建')])
    await runner.start('t1', workflow)
    await settle()
    expect(run().status).toBe('paused')
    expect(run().steps[0].status).toBe('failed')
    expect(run().steps[0].error).toContain('已被修改或删除')
  })
})

describe('暂停 / 继续 / 重试 / 跳过', () => {
  it('暂停把当前步骤退回待执行，继续后重跑并推进', async () => {
    const workflow = flow([node('a', '构建'), node('b', '测试')], [{ from: 'a', to: 'b' }])
    await save(workflow)
    fake.manual = true
    await runner.start('t1', workflow)
    await tick()
    expect(run().steps[0].status).toBe('running')
    await runner.pause('t1')
    fake.release({ ok: false, cancelled: true })
    await tick()
    expect(fake.aborts).toBe(1)
    expect(run().status).toBe('paused')
    expect(run().steps[0].status).toBe('pending')
    fake.manual = false
    await runner.resume('t1')
    await settle()
    expect(fake.calls.map((call) => call.meta.title)).toEqual(['构建', '构建', '测试'])
    expect(run().status).toBe('done')
    expect(run().steps.map((step) => step.status)).toEqual(['done', 'done'])
  })

  it('重试失败步骤后继续', async () => {
    const workflow = flow([node('a', '构建'), node('b', '测试')], [{ from: 'a', to: 'b' }])
    await save(workflow)
    fake.outcomes.push({ ok: false, error: 'x' }, { ok: false, error: 'x' }, { ok: false, error: 'x' })
    await runner.start('t1', workflow)
    await settle()
    expect(run().status).toBe('paused')
    await runner.retryNode('t1', 'a')
    await settle()
    expect(run().steps[0].status).toBe('done')
    expect(run().steps[1].status).toBe('done')
    expect(run().status).toBe('done')
  })

  it('跳过失败步骤后，依赖它的步骤仍可执行', async () => {
    const workflow = flow([node('a', '构建'), node('b', '测试')], [{ from: 'a', to: 'b' }])
    await save(workflow)
    fake.outcomes.push({ ok: false, error: 'x' }, { ok: false, error: 'x' }, { ok: false, error: 'x' })
    await runner.start('t1', workflow)
    await settle()
    await runner.skipNode('t1', 'a')
    await settle()
    expect(run().steps[0].status).toBe('skipped')
    expect(run().steps[1].status).toBe('done')
    expect(run().status).toBe('done')
  })

  it('未暂停时拒绝重试/跳过，非失败步骤拒绝重试', async () => {
    const workflow = flow([node('a', '构建')])
    await save(workflow)
    await runner.start('t1', workflow)
    await settle()
    await expect(runner.retryNode('t1', 'a')).rejects.toThrow('先暂停')
    await expect(runner.skipNode('t1', 'a')).rejects.toThrow('先暂停')
  })
})

describe('重启恢复', () => {
  it('加载时把运行中的工作流归一化为暂停，当前步骤退回待执行', async () => {
    await store.update((state) => {
      const target = state.threads[0]
      target.status = 'running'
      target.workflowRun = { workflowId: 'wf1', name: '测试工作流', status: 'running', steps: [{ nodeId: 'a', title: '构建', deps: [], status: 'running' }], startedAt: now() }
    })
    await store.flush()
    const fresh = new StateStore(join(dir, 'state.json'))
    await fresh.load()
    const target = fresh.get().threads[0]
    expect(target.status).toBe('idle')
    expect(target.workflowRun?.status).toBe('paused')
    expect(target.workflowRun?.steps[0].status).toBe('pending')
    const last = target.messages.at(-1)
    expect(last && last.role === 'system' ? last.content : '').toContain('工作流已暂停')
  })
})

describe('契约', () => {
  it('workflowControlInputSchema 校验动作与未知字段', () => {
    expect(workflowControlInputSchema.safeParse({ threadId: 't1', action: 'pause' }).success).toBe(true)
    expect(workflowControlInputSchema.safeParse({ threadId: 't1', action: 'retry-node', nodeId: 'a' }).success).toBe(true)
    expect(workflowControlInputSchema.safeParse({ threadId: 't1', action: 'bad' }).success).toBe(false)
    expect(workflowControlInputSchema.safeParse({ threadId: 't1', action: 'pause', extra: 1 }).success).toBe(false)
  })
})