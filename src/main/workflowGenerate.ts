import { randomUUID } from 'node:crypto'
import { workflowNodeKinds, nodeConfigFields, workflowSchema, type Message, type Settings, type Workflow, type WorkflowNodeKind } from '../shared/schema'
import { streamChat } from './llm'

/** 让 LLM 把自然语言需求转成 Work 画布工作流的提示词；输出严格 JSON。 */
const GENERATE_SYSTEM = [
  '你是 CubexDesktop Work 模式的工作流编排器。把用户需求拆解为可依次执行的节点工作流。',
  '',
  '输出严格 JSON，不要任何解释文字、不要 Markdown 围栏：',
  '{"name":"工作流名称","nodes":[{"title":"节点标题","kind":"task|response|image|video|check|review|note|computer|browser|launch|command|search|file|git|plugin|mcp|wait|ask","prompt":"该节点的具体指令","config":{}}],"edges":[{"from":0,"to":1}]}',
  '',
  '规则：',
  '- 节点数 1–20；edges 的 from/to 是 nodes 从 0 开始的序号；连线不得成环。',
  '- 每个节点 prompt 非空且自包含（写清输入、动作与期望产出）。',
  '- config 是节点类型的专属参数（可选）：browser 填 url/extract；command 填 command；git 填 message/push；search 填 query/scope；file 填 path/action；image 填 size/count；video 填 size/seconds；check 填 command/onFail；ask 填 question/options；launch 填 target；其余类型可留空对象。确定的具体参数放 config 而不是 prompt。',
  '- 把目标拆成有清晰输入与产出的步骤，并在关键改动后安排 check/review 验证步骤。',
  '- 只需要产出最终给用户看的文字时用 response；生图用 image；生视频用 video，不要伪装成 task。',
  '- 涉及电脑、浏览器、命令、文件写入、Git 推送等副作用时用对应专用类型，prompt 中写明确认与安全要求。',
  '- 需要并行推进的独立子任务（多文件同类操作、调研+编码、独立复查）在 prompt 中说明用 delegate 委派子智能体完成。',
  '- 背景信息（不需要执行的）放 note 节点。',
  '- name 用简洁中文短语概括整个工作流。',
].join('\n')

const allowedKinds = new Set<string>(workflowNodeKinds)

export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回工作流 JSON，请稍后重试或换一个模型')
  return JSON.parse(trimmed.slice(start, end + 1))
}

/** 把模型的 nodes/edges（按序号）转换为带坐标排布的 Workflow：从左到右每列 4 个、列距 300。 */
export function layout(projectId: string, generated: { name?: unknown; nodes?: unknown; edges?: unknown }): Workflow {
  if (!Array.isArray(generated.nodes) || generated.nodes.length === 0) throw new Error('生成的工作流没有任何节点')
  if (generated.nodes.length > 20) throw new Error('生成的工作流超过 20 个节点，请简化需求')
  const nodes = generated.nodes.map((raw, index) => {
    const item = raw as { title?: unknown; kind?: unknown; prompt?: unknown; config?: unknown }
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 60) : `步骤 ${index + 1}`
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim().slice(0, 8000) : ''
    if (!prompt) throw new Error(`节点「${title}」没有填写指令，请重试生成`)
    const kind = typeof item.kind === 'string' && allowedKinds.has(item.kind) ? item.kind as WorkflowNodeKind : 'task'
    // config：只保留该类型已定义字段里的非空字符串值
    const config: Record<string, string> = {}
    if (item.config && typeof item.config === 'object' && !Array.isArray(item.config)) {
      for (const field of nodeConfigFields[kind]) {
        const value = (item.config as Record<string, unknown>)[field.key]
        if (typeof value === 'string' && value.trim()) config[field.key] = value.trim().slice(0, 4000)
      }
    }
    const x = 80 + Math.floor(index / 4) * 300
    const y = 80 + (index % 4) * 160
    return { id: `node-${randomUUID().slice(0, 8)}`, title, prompt, x, y, ...(kind !== 'task' ? { kind } : {}), ...(Object.keys(config).length ? { config } : {}) }
  })
  const edges = (Array.isArray(generated.edges) ? generated.edges : [])
    .map((raw) => {
      const item = raw as { from?: unknown; to?: unknown }
      const from = typeof item.from === 'number' ? Math.trunc(item.from) : -1
      const to = typeof item.to === 'number' ? Math.trunc(item.to) : -1
      if (from < 0 || to < 0 || from >= nodes.length || to >= nodes.length || from === to) return null
      return { from: nodes[from].id, to: nodes[to].id }
    })
    .filter((edge): edge is { from: string; to: string } => edge !== null)
  // 无边时按顺序串成链，保证工作流可执行
  const finalEdges = edges.length ? edges : nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }))
  const name = typeof generated.name === 'string' && generated.name.trim() ? generated.name.trim().slice(0, 60) : '生成的工作流'
  const workflow: Workflow = { id: randomUUID(), projectId, name, nodes, edges: finalEdges, updatedAt: new Date().toISOString() }
  const parsed = workflowSchema.safeParse(workflow)
  if (!parsed.success) throw new Error('生成的工作流未通过校验，请重试或调整描述')
  return workflow
}

export async function generateWorkflowWithModel(input: {
  settings: Settings
  secrets: { get: (id: string) => string | undefined }
  projectId: string
  request: string
  modelId?: string
}): Promise<Workflow> {
  const modelId = input.modelId || input.settings.defaultModelId
  const model = input.settings.models.find((item) => item.id === modelId)
  if (!model) throw new Error('尚未选择模型，请先在设置中配置提供商与模型')
  const provider = input.settings.providers.find((item) => item.id === model.providerId)
  if (!provider) throw new Error('模型所属的提供商已被删除')
  const apiKey = provider.kind === 'ollama' ? undefined : input.secrets.get(provider.id)
  if (provider.kind !== 'ollama' && !apiKey) throw new Error(`提供商「${provider.name}」尚未配置 API Key`)
  const userMessage: Message = { id: randomUUID(), role: 'user', time: new Date().toISOString(), content: input.request }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const turn = await streamChat({
      provider, apiKey, model,
      system: GENERATE_SYSTEM,
      messages: [userMessage],
      tools: [],
      signal: controller.signal,
      onText: () => undefined,
      timeoutMs: 180_000,
      retries: 1,
    })
    return layout(input.projectId, extractJson(turn.content) as { name?: unknown; nodes?: unknown; edges?: unknown })
  } finally {
    clearTimeout(timer)
  }
}
