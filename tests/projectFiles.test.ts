import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_FILES, PROJECT_FILE_RULES, ensureProjectFiles, readProjectFiles, renderProjectContext } from '../src/main/projectFiles'
import { buildSystemPrompt } from '../src/main/prompt'
import { defaultSettings } from '../src/shared/schema'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubex-project-files-'))
})

describe('项目上下文文件', () => {
  it('缺失时创建四个文件并写入中文模板', async () => {
    const created = await ensureProjectFiles(root, '演示项目')
    expect(created).toEqual([...PROJECT_FILES])
    const goal = await readFile(join(root, 'goal.md'), 'utf8')
    expect(goal).toContain('# 目标')
    expect(goal).toContain('演示项目')
    for (const name of PROJECT_FILES) await expect(readFile(join(root, name), 'utf8')).resolves.not.toBe('')
  })

  it('已存在的文件不会被覆盖，只补齐缺失的', async () => {
    await writeFile(join(root, 'memory.md'), '# 我的记忆\n\n- 关键约定 A\n', 'utf8')
    const created = await ensureProjectFiles(root, 'x')
    expect(created).toEqual(['goal.md', 'plan.md', 'agents.md'])
    await expect(readFile(join(root, 'memory.md'), 'utf8')).resolves.toBe('# 我的记忆\n\n- 关键约定 A\n')
  })

  it('读取并渲染为上下文，过长内容会截断', async () => {
    await writeFile(join(root, 'plan.md'), '# 计划\n- [ ] 步骤一\n', 'utf8')
    await writeFile(join(root, 'memory.md'), 'x'.repeat(20_000), 'utf8')
    const files = await readProjectFiles(root)
    expect(files.map((file) => file.name)).toEqual(['plan.md', 'memory.md'])
    expect(files[1].truncated).toBe(true)
    expect(files[1].content.length).toBe(12_000)
    const rendered = renderProjectContext(files)
    expect(rendered).toContain('# 项目上下文文件（自动引用）')
    expect(rendered).toContain('## plan.md')
    expect(rendered).toContain('步骤一')
    expect(rendered).toContain('已截断')
  })

  it('没有文件时不注入上下文', async () => {
    expect(renderProjectContext(await readProjectFiles(root))).toBe('')
  })

  it('系统提示词包含维护规则并附带项目上下文', () => {
    const settings = defaultSettings()
    const project = { id: 'p1', name: '演示', path: root, createdAt: new Date().toISOString() }
    const prompt = buildSystemPrompt(settings, project, { projectContext: '# 项目上下文文件（自动引用）\n\n## goal.md\n\n做一个待办应用' })
    expect(prompt).toContain(PROJECT_FILE_RULES[0])
    expect(prompt.endsWith('做一个待办应用')).toBe(true)
    const readOnly = buildSystemPrompt({ ...settings, permissions: { ...settings.permissions, readOnly: true } }, project)
    expect(readOnly).not.toContain(PROJECT_FILE_RULES[0])
  })
})
