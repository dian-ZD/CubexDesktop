import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PROJECT_FILES = ['goal.md', 'plan.md', 'memory.md', 'agents.md'] as const
export type ProjectFileName = (typeof PROJECT_FILES)[number]

const MAX_FILE_CHARS = 12_000

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function projectFileTemplates(projectName: string): Record<ProjectFileName, string> {
  const stamp = today()
  return {
    'goal.md': `# 目标\n\n> 项目：${projectName}\n> 创建于 ${stamp}，由 Cubex 自动生成。描述本项目的最终目标、验收标准与边界；目标变化时请及时更新。\n\n## 最终目标\n\n（待补充）\n\n## 验收标准\n\n- （待补充）\n\n## 非目标 / 边界\n\n- （待补充）\n`,
    'plan.md': `# 计划\n\n> 更新于 ${stamp}。记录任务拆解与进度，每完成一步就勾选并写下结论。\n\n## 当前阶段\n\n（待补充）\n\n## 待办\n\n- [ ] （待补充）\n\n## 已完成\n\n- （暂无）\n`,
    'memory.md': `# 记忆\n\n> 更新于 ${stamp}。记录项目中长期有效的事实：技术栈、约定、关键决策、踩过的坑、验证方式。只记结论，不记过程。\n\n## 技术栈与约定\n\n- （待补充）\n\n## 关键决策\n\n- （待补充）\n\n## 已知问题与坑\n\n- （待补充）\n\n## 验证方式\n\n- （待补充）\n`,
    'agents.md': `# 智能体协作说明\n\n> 更新于 ${stamp}。给接手本项目的任何 AI 智能体阅读：如何在本项目中安全、高效地工作。\n\n## 开始前必读\n\n- 先阅读 goal.md、plan.md、memory.md，再动手。\n- 遵循项目现有的代码风格与目录约定。\n\n## 常用命令\n\n- （待补充：安装 / 构建 / 测试 / 检查）\n\n## 禁止事项\n\n- 未经用户同意不要提交、推送、删除文件或修改全局环境。\n\n## 交接要求\n\n- 每次任务结束前更新 plan.md 的进度与 memory.md 的新结论。\n`,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function ensureProjectFiles(root: string, projectName: string): Promise<ProjectFileName[]> {
  const templates = projectFileTemplates(projectName)
  const created: ProjectFileName[] = []
  for (const name of PROJECT_FILES) {
    const target = join(root, name)
    if (await exists(target)) continue
    try {
      await writeFile(target, templates[name], { encoding: 'utf8', flag: 'wx' })
      created.push(name)
    } catch {
      continue
    }
  }
  return created
}

export interface ProjectContextFile {
  name: ProjectFileName
  content: string
  truncated: boolean
}

export async function readProjectFiles(root: string): Promise<ProjectContextFile[]> {
  const files: ProjectContextFile[] = []
  for (const name of PROJECT_FILES) {
    try {
      const raw = await readFile(join(root, name), 'utf8')
      const truncated = raw.length > MAX_FILE_CHARS
      files.push({ name, content: truncated ? raw.slice(0, MAX_FILE_CHARS) : raw, truncated })
    } catch {
      continue
    }
  }
  return files
}

export function renderProjectContext(files: ProjectContextFile[]): string {
  if (files.length === 0) return ''
  const sections = files.map((file) => `## ${file.name}\n\n${file.content.trim()}${file.truncated ? '\n\n（内容过长，已截断）' : ''}`)
  return `# 项目上下文文件（自动引用）\n以下文件位于项目根目录，是本项目的目标、计划、记忆与协作说明，请把它们当作最高优先级的参考；若与用户当前要求冲突，以用户为准并更新对应文件。\n\n${sections.join('\n\n')}`
}

export const PROJECT_FILE_RULES = [
  '项目根目录的 goal.md、plan.md、memory.md、agents.md 是需要你实时维护的上下文文件：开始任务前先据此理解现状；任务推进中每完成一个明确步骤就用 edit_file 更新 plan.md 的进度；得到长期有效的新结论（技术栈、约定、决策、坑、验证方式）时写入 memory.md；用户目标发生变化时更新 goal.md；发现对后续智能体有用的工作方式时更新 agents.md。',
  '维护这些文件时只做增量修改，保留已有内容与结构，不要整篇重写；每次任务结束前确保 plan.md 与 memory.md 已反映最新状态。',
]
