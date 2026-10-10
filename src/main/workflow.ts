import type { Workflow, WorkflowNode, WorkflowNodeKind } from '../shared/schema'
import { nodeConfigFields } from '../shared/schema'

export function orderWorkflowNodes(workflow: Workflow): WorkflowNode[] {
  const ids = new Set(workflow.nodes.map((node) => node.id))
  const incoming = new Map<string, number>(workflow.nodes.map((node) => [node.id, 0]))
  const next = new Map<string, string[]>()
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  }
  const byPosition = (a: WorkflowNode, b: WorkflowNode) => a.x - b.x || a.y - b.y
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const ready = workflow.nodes.filter((node) => incoming.get(node.id) === 0).sort(byPosition)
  const ordered: WorkflowNode[] = []
  while (ready.length) {
    const node = ready.shift()!
    ordered.push(node)
    for (const id of next.get(node.id) ?? []) {
      const count = (incoming.get(id) ?? 1) - 1
      incoming.set(id, count)
      if (count === 0) {
        ready.push(nodes.get(id)!)
        ready.sort(byPosition)
      }
    }
  }
  if (ordered.length !== workflow.nodes.length) throw new Error('工作流存在循环连线，请检查节点之间的连接')
  return ordered
}

export const kindHints: Record<string, string> = {
  response: '这是模型回复步骤：根据输入要求生成最终给用户看的文字回复，不要修改文件或调用无关工具。',
  image: '这是生图步骤：使用已配置的图片模型生成图片；提示词应包含主体、风格、构图与用途。',
  video: '这是生视频步骤：使用已配置的视频模型生成视频；提示词应包含主体动作、镜头、时长、画幅和风格。',
  check: '这是检查步骤：执行验证（如测试、构建或人工核对），如未通过请先修复再继续。',
  review: '这是审阅步骤：先总结前面步骤的产出，自查是否符合要求，指出问题后再继续。',
  computer: '这是电脑操控步骤：使用 computer_use 工具完成截屏、输入、按键或点击等操作来达成目标。',
  browser: '这是浏览器操控步骤：使用 browser_open 工具打开网页并提取所需信息或验证页面状态。',
  launch: '这是打开应用步骤：使用 computer_use 的 open 操作启动指定的应用、文件或网址。',
  command: '这是命令执行步骤：使用 run_command 工具运行指定的 shell 命令，并根据输出判断是否成功。',
  search: '这是搜索步骤：使用 search_files 或 list_directory 工具在项目中定位所需的文件或代码片段。',
  file: '这是文件读写步骤：使用 read_file / write_file / edit_file 工具完成文件内容的查看或修改。',
  git: '这是 Git/GitHub 步骤：使用 github_push 工具提交并推送改动到远程仓库。',
  plugin: '这是插件调用步骤：使用 plugin_call 工具调用用户安装的插件完成特定任务。',
  mcp: '这是 MCP 调用步骤：使用 mcp_call 工具调用已连接的 MCP 服务器工具完成任务。',
  wait: '这是等待步骤：确认前置条件或外部状态已就绪后再继续，不要提前进入下一步。',
  ask: '这是询问步骤：使用 ask_user 工具向用户确认关键信息后再继续。',
}

export function composeWorkflowPrompt(workflow: Workflow): string {
  const ordered = orderWorkflowNodes(workflow)
  if (ordered.length === 0) throw new Error('工作流没有任何节点')
  const notes = ordered.filter((node) => node.kind === 'note')
  const steps = ordered.filter((node) => node.kind !== 'note')
  if (steps.length === 0) throw new Error('工作流至少需要一个可执行节点（备注节点不会被执行）')
  const noteBlock = notes.length
    ? `\n\n## 背景信息（仅供参考，不需要执行）\n${notes.map((node) => `- ${node.title}：${node.prompt.trim()}`).join('\n')}`
    : ''
  const stepBlock = steps
    .map((node, index) => {
      const hint = node.kind ? kindHints[node.kind] : undefined
      return `## 步骤 ${index + 1}：${node.title}\n${hint ? `${hint}\n` : ''}${node.prompt.trim()}`
    })
    .join('\n\n')
  return `请按顺序执行工作流「${workflow.name}」。每完成一步，简要汇报结果再进入下一步；前一步的产出可作为后一步的输入。${noteBlock}\n\n${stepBlock}`
}

export interface WorkflowPlanStep {
  nodeId: string
  title: string
  deps: string[]
}

export function workflowStepPlan(workflow: Workflow): WorkflowPlanStep[] {
  const ordered = orderWorkflowNodes(workflow).filter((node) => node.kind !== 'note')
  const ids = new Set(ordered.map((node) => node.id))
  const deps = new Map<string, string[]>(ordered.map((node) => [node.id, []]))
  for (const edge of workflow.edges) {
    if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) continue
    deps.get(edge.to)!.push(edge.from)
  }
  return ordered.map((node) => ({ nodeId: node.id, title: node.title.trim(), deps: deps.get(node.id) ?? [] }))
}

export interface NodeInstructionInput {
  workflowName: string
  index: number
  total: number
  title: string
  kind?: WorkflowNodeKind
  prompt: string
  config?: Record<string, string>
  upstream: Array<{ title: string; output: string }>
  completed: Array<{ title: string; status: string }>
  notes: Array<{ title: string; prompt: string }>
}

const NOTE_LIMIT = 2000

export function composeNodeInstruction(input: NodeInstructionInput): string {
  const blocks: string[] = [`【工作流「${input.workflowName}」第 ${input.index}/${input.total} 步：${input.title}】`]
  const hint = input.kind ? kindHints[input.kind] : undefined
  if (hint) blocks.push(hint)
  // 节点专属配置项（画布上按类型单独配置的参数，直接作为本步的明确参数，优先级高于指令里的模糊描述）。
  const fields = input.kind ? nodeConfigFields[input.kind] : []
  const config = input.config ?? {}
  const filled = fields.filter((field) => (config[field.key] ?? '').trim().length > 0)
  if (filled.length) {
    blocks.push(`## 本步参数（画布配置，必须遵守）\n${filled.map((field) => `- ${field.label}：${config[field.key]!.trim()}`).join('\n')}`)
  }
  // 通用提醒：多而独立的子工作应委派子智能体并行完成（Work 节点通常覆盖多个文件/事项）。
  blocks.push('本步若包含多个互不相干、可并行的独立子工作（多文件同类修改、并行调研、独立复查），优先用 delegate 把它们拆成子任务并行委派：每个子任务的 instruction 必须完整自包含（目标、负责文件、约束、验收标准），修改同一文件的子任务串行安排；子任务返回后核对结果再汇总为本步产出。')
  if (input.notes.length) {
    const notes = input.notes.map((note) => `- ${note.title}：${note.prompt.trim().slice(0, NOTE_LIMIT)}`).join('\n')
    blocks.push(`## 背景信息（工作流备注，仅供参考，不需要执行）\n${notes}`)
  }
  if (input.upstream.length) {
    const upstream = input.upstream.map((item) => `### ${item.title}\n${item.output.trim()}`).join('\n\n')
    blocks.push(`## 上游步骤产出（可直接使用，不必重复调研）\n${upstream}`)
  }
  if (input.completed.length) {
    const done = input.completed
      .map((item) => `- [${item.status === 'done' ? 'x' : item.status === 'skipped' ? '-' : '!'}] ${item.title}`)
      .join('\n')
    blocks.push(`## 已完成步骤（勿重复执行）\n${done}`)
  }
  blocks.push(`## 本步任务\n${input.prompt.trim()}`)
  blocks.push('要求：只完成本步任务，不要提前执行后续步骤；完成后用一两句话总结本步产出（这段总结会作为下游步骤的输入）。')
  return blocks.join('\n\n')
}

export { dueAutomations, nextRunAt } from '../shared/schedule'
