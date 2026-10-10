import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillStore } from '../src/main/skills'
import { layout, extractJson } from '../src/main/workflowGenerate'
import { composeNodeInstruction } from '../src/main/workflow'

describe('SkillStore（Agent Skills 标准目录式）', () => {
  let dir: string
  let store: SkillStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cubex-skills-'))
    store = new SkillStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('导入单文件时转换为标准 skills/<name>/SKILL.md 结构', async () => {
    const source = join(dir, 'source.md')
    await writeFile(source, '---\nname: my-skill\ndescription: 测试技能\n---\n\n技能正文内容', 'utf8')
    const imported = await store.import([source])
    expect(imported).toHaveLength(1)
    expect(imported[0].id.startsWith('skill:')).toBe(true)
    const entries = await readdir(join(dir, 'my-skill'))
    expect(entries).toContain('SKILL.md')
    const detail = await store.read(imported[0].id)
    expect(detail.name).toBe('my-skill')
    expect(detail.description).toBe('测试技能')
    expect(detail.content).toContain('技能正文内容')
  })

  it('list 只识别含 SKILL.md 的目录，read 会附加参考文件', async () => {
    await mkdir(join(dir, 'guide'), { recursive: true })
    await writeFile(join(dir, 'guide', 'SKILL.md'), '---\nname: 指南\ndescription: 附参考文件\n---\n\n正文', 'utf8')
    await writeFile(join(dir, 'guide', 'notes.md'), '# 参考\n这是参考内容', 'utf8')
    await mkdir(join(dir, 'not-a-skill'), { recursive: true })
    await writeFile(join(dir, 'not-a-skill', 'other.txt'), 'x', 'utf8')
    const list = await store.list()
    const fileSkills = list.filter((item) => !item.builtin)
    expect(fileSkills.map((item) => item.name)).toEqual(['指南'])
    const detail = await store.read(fileSkills[0].id)
    expect(detail.content).toContain('正文')
    expect(detail.content).toContain('参考文件：notes.md')
  })

  it('内置技能保留且不可删除；非法 id 拒绝', async () => {
    const list = await store.list()
    expect(list.some((item) => item.builtin)).toBe(true)
    expect(list.some((item) => item.id === 'builtin:review')).toBe(true)
    expect(list.some((item) => item.id === 'builtin:work-builder')).toBe(false)
    await expect(store.remove('builtin:review')).rejects.toThrow('内置技能不可删除')
    await expect(store.read('skill:../escape')).rejects.toThrow('非法技能路径')
  })
})

describe('工作流生成（workflowGenerate）', () => {
  it('extractJson 容忍围栏与前后噪声', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('好的，这是结果：{"a":1} 以上。')).toEqual({ a: 1 })
    expect(() => extractJson('完全没有 JSON')).toThrow('JSON')
  })

  it('layout 把模型输出转成带坐标的工作流，无边时自动串成链', () => {
    const workflow = layout('p1', {
      name: '演示',
      nodes: [
        { title: '调研', kind: 'search', prompt: '搜索资料' },
        { title: '产出', kind: 'response', prompt: '整理成报告' },
        { title: '说明', kind: 'note', prompt: '背景' },
      ],
      edges: [],
    })
    expect(workflow.name).toBe('演示')
    expect(workflow.nodes).toHaveLength(3)
    expect(workflow.nodes[0].kind).toBe('search')
    expect(workflow.nodes[2].kind).toBe('note')
    // 3 个节点自动串成 2 条边
    expect(workflow.edges).toHaveLength(2)
    expect(workflow.edges[0]).toEqual({ from: workflow.nodes[0].id, to: workflow.nodes[1].id })
    // 坐标在画布范围内且非重叠起点
    expect(workflow.nodes[0].x).toBe(80)
    expect(workflow.nodes.every((node) => node.prompt.length > 0)).toBe(true)
  })

  it('layout 拒绝空节点、越界连线与未知类型回落 task', () => {
    expect(() => layout('p1', { nodes: [] })).toThrow('没有任何节点')
    expect(() => layout('p1', { nodes: [{ title: 'a', prompt: '' }] })).toThrow('没有填写指令')
    const workflow = layout('p1', { nodes: [{ title: 'a', prompt: 'x', kind: 'bogus' }, { title: 'b', prompt: 'y' }], edges: [{ from: 0, to: 99 }] })
    expect(workflow.nodes[0].kind).toBeUndefined() // 未知类型回落为 task（无 kind 字段）
    expect(workflow.edges).toHaveLength(1) // 0→1 越界被丢弃后自动串链
  })

  it('layout 保留模型输出的合法 config，丢弃未知字段与空值', () => {
    const workflow = layout('p1', {
      nodes: [{ title: '查价', kind: 'browser', prompt: '打开页面查价格', config: { url: ' https://example.com ', extract: '价格', bogus: 'x', other: '  ' } }],
    })
    expect(workflow.nodes[0].config).toEqual({ url: 'https://example.com', extract: '价格' })
  })

  it('composeNodeInstruction 把画布配置作为「本步参数」注入', () => {
    const instruction = composeNodeInstruction({
      workflowName: '演示', index: 1, total: 1, title: '查价', kind: 'browser', prompt: '打开页面查价格',
      config: { url: 'https://example.com', extract: '价格' },
      upstream: [], completed: [], notes: [],
    })
    expect(instruction).toContain('本步参数（画布配置，必须遵守）')
    expect(instruction).toContain('网址：https://example.com')
    expect(instruction).toContain('要提取的内容：价格')
    // 无配置时不出现参数块
    const bare = composeNodeInstruction({ workflowName: '演示', index: 1, total: 1, title: 'a', prompt: 'x', upstream: [], completed: [], notes: [] })
    expect(bare).not.toContain('本步参数')
  })
})
