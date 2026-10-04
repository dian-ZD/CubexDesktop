import { describe, expect, it, vi } from 'vitest'
import { composeWorkflowPrompt, dueAutomations, orderWorkflowNodes } from '../src/main/workflow'
import { describeSchedule, isDue, latestSlot, nextRunAt } from '../src/shared/schedule'
import { repoNameFor } from '../src/main/github'
import { threadToShareHtml } from '../src/main/share'
import { automationSchema, createInitialState, githubSchema, migrateState, settingsSchema, workflowSchema, type Automation, type Thread, type Workflow } from '../src/shared/schema'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const time = '2026-09-27T00:00:00.000Z'
const node = (id: string, x: number, prompt = `做 ${id}`) => ({ id, title: `节点${id}`, prompt, x, y: 0 })
const workflow = (nodes: Workflow['nodes'], edges: Workflow['edges']): Workflow => ({ id: 'w1', projectId: 'p1', name: '发布流程', nodes, edges, updatedAt: time })
const automation = (patch: Partial<Automation> = {}): Automation => ({ id: 'a1', name: '日报', projectId: 'p1', modelId: '', prompt: '总结', schedule: 'interval', intervalMin: 60, time: '09:00', weekdays: [1, 2, 3, 4, 5], enabled: true, ...patch })

describe('工作流', () => {
  it('按连线拓扑排序，无依赖时按位置从左到右', () => {
    const ordered = orderWorkflowNodes(workflow([node('c', 500), node('a', 0), node('b', 250)], [{ from: 'b', to: 'c' }]))
    expect(ordered.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    const reversed = orderWorkflowNodes(workflow([node('a', 0), node('b', 250)], [{ from: 'b', to: 'a' }]))
    expect(reversed.map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('忽略悬空连线与自环，检测循环', () => {
    expect(orderWorkflowNodes(workflow([node('a', 0)], [{ from: 'a', to: 'a' }, { from: 'x', to: 'a' }])).length).toBe(1)
    expect(() => orderWorkflowNodes(workflow([node('a', 0), node('b', 1)], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]))).toThrow('循环')
  })

  it('合成提示词包含有序步骤，空工作流报错', () => {
    const prompt = composeWorkflowPrompt(workflow([node('b', 250, '  部署  '), node('a', 0, '构建')], [{ from: 'a', to: 'b' }]))
    expect(prompt).toContain('发布流程')
    expect(prompt.indexOf('步骤 1：节点a')).toBeLessThan(prompt.indexOf('步骤 2：节点b'))
    expect(prompt).toContain('构建\n\n## 步骤 2')
    expect(prompt.endsWith('部署')).toBe(true)
    expect(() => composeWorkflowPrompt(workflow([], []))).toThrow('没有任何节点')
  })

  it('工作流节点数量受限', () => {
    const many = Array.from({ length: 21 }, (_, index) => node(`n${index}`, index))
    expect(workflowSchema.safeParse(workflow(many, [])).success).toBe(false)
    expect(workflowSchema.safeParse(workflow(many.slice(0, 20), [])).success).toBe(true)
  })

  it('节点类型可选且兼容旧数据，非法类型被拒绝', () => {
    expect(workflowSchema.safeParse(workflow([node('a', 0)], [])).success).toBe(true)
    expect(workflowSchema.safeParse(workflow([{ ...node('a', 0), kind: 'check' }], [])).success).toBe(true)
    expect(workflowSchema.safeParse(workflow([{ ...node('a', 0), kind: 'bad' } as never], [])).success).toBe(false)
  })

  it('备注节点进入背景信息且不计入步骤，检查与审阅节点附加提示', () => {
    const prompt = composeWorkflowPrompt(workflow([
      { ...node('memo', 0, '项目使用 pnpm'), kind: 'note' },
      node('a', 100, '实现功能'),
      { ...node('b', 200, '运行测试'), kind: 'check' },
      { ...node('c', 300, '总结产出'), kind: 'review' },
    ], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]))
    expect(prompt).toContain('背景信息')
    expect(prompt).toContain('节点memo：项目使用 pnpm')
    expect(prompt).not.toContain('步骤 1：节点memo')
    expect(prompt).toContain('步骤 1：节点a')
    expect(prompt).toContain('这是检查步骤')
    expect(prompt).toContain('这是审阅步骤')
  })

  it('全为备注节点时无法运行', () => {
    expect(() => composeWorkflowPrompt(workflow([{ ...node('a', 0), kind: 'note' }], []))).toThrow('可执行节点')
  })
})

describe('自动化', () => {
  it('仅返回已启用且到期的任务', () => {
    const now = Date.parse(time)
    const items = [
      automation({ id: 'never' }),
      automation({ id: 'due', lastRun: new Date(now - 60 * 60_000).toISOString() }),
      automation({ id: 'fresh', lastRun: new Date(now - 30 * 60_000).toISOString() }),
      automation({ id: 'off', enabled: false }),
    ]
    expect(dueAutomations(items, now).map((item) => item.id)).toEqual(['never', 'due'])
  })

  it('校验间隔与指令', () => {
    expect(automationSchema.safeParse(automation()).success).toBe(true)
    expect(automationSchema.safeParse(automation({ intervalMin: 5 })).success).toBe(false)
    expect(automationSchema.safeParse(automation({ intervalMin: 20_000 })).success).toBe(false)
    expect(automationSchema.safeParse(automation({ prompt: '   ' })).success).toBe(false)
  })

  it('旧自动化缺少定时字段时默认按间隔', () => {
    const legacy: Record<string, unknown> = { ...automation() }
    delete legacy.schedule
    delete legacy.time
    delete legacy.weekdays
    const parsed = automationSchema.parse(legacy)
    expect(parsed.schedule).toBe('interval')
    expect(parsed.time).toBe('09:00')
    expect(automationSchema.safeParse(automation({ schedule: 'daily', time: '25:00' })).success).toBe(false)
    expect(automationSchema.safeParse(automation({ schedule: 'weekly', weekdays: [] })).success).toBe(false)
  })
})

describe('定时自动化', () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime()
  const iso = (ms: number) => new Date(ms).toISOString()

  it('每天定时：到点执行一次，同一时刻不重复', () => {
    const daily = automation({ schedule: 'daily', time: '09:00', lastRun: iso(at(27, 9, 1)) })
    expect(isDue(daily, at(28, 8, 59))).toBe(false)
    expect(isDue(daily, at(28, 9, 0))).toBe(true)
    expect(isDue({ ...daily, lastRun: iso(at(28, 9, 0)) }, at(28, 18))).toBe(false)
    expect(nextRunAt(daily, at(28, 8))).toBe(at(28, 9))
    expect(nextRunAt(daily, at(28, 10))).toBe(at(29, 9))
  })

  it('错过的定时在下次运行时补跑一次，首次启用不补跑旧时刻', () => {
    const daily = automation({ schedule: 'daily', time: '09:00', lastRun: iso(at(25, 9)) })
    expect(isDue(daily, at(27, 20))).toBe(true)
    const fresh = automation({ schedule: 'daily', time: '09:00' })
    expect(isDue(fresh, at(28, 9, 3))).toBe(true)
    expect(isDue(fresh, at(28, 12))).toBe(false)
  })

  it('每周定时只在选中的星期执行', () => {
    const base = new Date(2026, 8, 28)
    const today = base.getDay()
    const weekly = automation({ schedule: 'weekly', time: '09:00', weekdays: [(today + 1) % 7], lastRun: iso(at(20, 9)) })
    expect(latestSlot(weekly, at(28, 12))).toBe(at(22, 9))
    expect(nextRunAt(weekly, at(28, 12))).toBe(at(29, 9))
    expect(isDue({ ...weekly, lastRun: iso(at(22, 9, 1)) }, at(28, 12))).toBe(false)
    expect(isDue({ ...weekly, lastRun: iso(at(22, 9, 1)) }, at(29, 9))).toBe(true)
  })

  it('间隔模式的下次时间与描述文案', () => {
    const interval = automation({ lastRun: iso(at(28, 9)) })
    expect(nextRunAt(interval, at(28, 9, 30))).toBe(at(28, 10))
    expect(describeSchedule(interval, (minutes) => `每 ${minutes} 分钟`)).toBe('每 60 分钟')
    expect(describeSchedule(automation({ schedule: 'daily', time: '08:30' }), String)).toBe('每天 08:30')
    expect(describeSchedule(automation({ schedule: 'weekly', weekdays: [1, 2, 3, 4, 5] }), String)).toBe('每周工作日 09:00')
    expect(describeSchedule(automation({ schedule: 'weekly', weekdays: [6, 0] }), String)).toBe('每周周日、周六 09:00')
  })
})

describe('GitHub 与迁移', () => {
  it('仓库与分支格式校验', () => {
    const base = createInitialState().settings.github
    expect(githubSchema.safeParse({ ...base, repo: 'alice/demo' }).success).toBe(true)
    expect(githubSchema.safeParse({ ...base, repo: 'bad repo' }).success).toBe(false)
    expect(githubSchema.safeParse({ ...base, branch: 'feat/x' }).success).toBe(true)
    expect(githubSchema.safeParse({ ...base, branch: 'a b' }).success).toBe(false)
  })

  it('从设置或目录推断仓库名', () => {
    expect(repoNameFor('alice/demo', 'C:\\work\\x')).toBe('demo')
    expect(repoNameFor('', 'C:\\work\\我的 项目 app')).toBe('app')
    expect(() => repoNameFor('', 'C:\\work\\中文')).toThrow('仓库名')
  })

  it('旧设置迁移后补齐 GitHub、插件与自动化并丢弃非法项', () => {
    const settings: Record<string, unknown> = { ...createInitialState().settings }
    delete settings.github
    delete settings.plugins
    settings.automations = [automation(), automation({ id: 'bad', intervalMin: 1 })]
    const migrated = migrateState({ version: 2, projects: [], threads: [], settings }) as { settings: unknown }
    const parsed = settingsSchema.parse(migrated.settings)
    expect(parsed.github.branch).toBe('main')
    expect(parsed.plugins.browser).toBe(true)
    expect(parsed.plugins.computer).toBe(false)
    expect(parsed.plugins.image).toBe(true)
    expect(parsed.image.size).toBe('1024x1024')
    expect(parsed.automations.map((item) => item.id)).toEqual(['a1'])
  })
})

describe('分享图片', () => {
  it('转义对话内容并渲染代码块', () => {
    const thread = {
      id: 't1', projectId: 'p1', title: '<script>标题</script>', modelId: 'm1', status: 'idle', createdAt: time, updatedAt: time,
      messages: [
        { id: 'u1', role: 'user', time, content: '<img src=x onerror=alert(1)>' },
        { id: 'a1', role: 'assistant', time, content: '看 `a<b` 与\n```ts\nconst x = "<div>"\n```', toolCalls: [], modelId: 'm1' },
      ],
    } as unknown as Thread
    const html = threadToShareHtml(thread, '项目&名')
    expect(html).not.toContain('<script>标题')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('项目&amp;名')
    expect(html).toContain('<code>a&lt;b</code>')
    expect(html).toContain('<pre>const x = &quot;&lt;div&gt;&quot;</pre>')
    expect(html).toContain("default-src 'none'")
  })
})
