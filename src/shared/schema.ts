import { z } from 'zod'

const identifier = z.string().min(1).max(100)
const shortText = z.string().trim().min(1).max(120)
const isoTime = z.string().datetime()

export const providerKinds = ['openai-compatible', 'anthropic', 'ollama'] as const
export const approvalModes = ['ask', 'auto-edit', 'full-auto'] as const
export const toolNames = ['read_file', 'list_directory', 'search_files', 'write_file', 'edit_file', 'run_command', 'ask_user', 'manage_todos', 'delegate', 'github_push', 'browser_open', 'web_search', 'computer_use', 'generate_image', 'plugin_call', 'mcp_call', 'browser_navigate', 'browser_click', 'browser_type', 'browser_extract', 'browser_screenshot', 'browser_wait', 'browser_search', 'browser_tab', 'browser_crawl', 'browser_extract_links'] as const

export const projectSchema = z.object({
  id: identifier,
  name: shortText,
  path: z.string().min(1).max(4096),
  archived: z.boolean().optional(),
})

export const providerSchema = z.object({
  id: identifier,
  name: shortText,
  kind: z.enum(providerKinds),
  baseUrl: z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || url.protocol === 'http:')
    } catch { return false }
  }, '端点须为 HTTP 或 HTTPS 地址，且不能包含凭据、查询参数或片段'),
  hasKey: z.boolean(),
})

export const thinkingLevels = ['off', 'low', 'medium', 'high'] as const
export type ThinkingLevel = (typeof thinkingLevels)[number]

export const computerModes = ['current', 'isolated'] as const

export const computerSchema = z.object({
  mode: z.enum(computerModes),
  idleWaitSec: z.number().int().min(0, '不能为负数').max(300, '最多 300 秒'),
  mirror: z.boolean(),
})

export const floatingSchema = z.object({
  opacity: z.number().min(0.3, '最低 30%').max(1),
  autoShow: z.boolean(),
})

export const speechModels = [
  { id: 'Xenova/whisper-tiny', label: '轻量（默认）', size: '约 40 MB' },
  { id: 'Xenova/whisper-base', label: '均衡', size: '约 78 MB' },
  { id: 'Xenova/whisper-small', label: '较准（慢）', size: '约 242 MB' },
] as const

export const speechDownloadSources = ['auto', 'official', 'mirror'] as const
export type SpeechDownloadSource = (typeof speechDownloadSources)[number]

export const speechDownloadSourceLabels: Record<SpeechDownloadSource, string> = {
  auto: '自动（推荐）',
  official: 'HuggingFace 官方',
  mirror: '国内镜像 hf-mirror',
}

export const speechDownloadHostLabels: Record<'official' | 'mirror', string> = {
  official: 'huggingface.co',
  mirror: 'hf-mirror.com',
}

export const speechSchema = z.object({
  model: z.string().trim().min(1).max(120),
  downloadSource: z.enum(speechDownloadSources),
})

export const modelParamsSchema = z.object({
  temperature: z.number().min(0, '温度不能小于 0').max(2, '温度不能大于 2').nullable(),
  maxTokens: z.number().int().min(0, '不能为负数').max(200_000, '最多 200000'),
  timeoutSec: z.number().int().min(10, '至少 10 秒').max(900, '最多 900 秒'),
  retries: z.number().int().min(0, '不能为负数').max(5, '最多 5 次'),
  historyLimit: z.number().int().min(10, '至少 10 条').max(400, '最多 400 条'),
  thinkingLevel: z.enum(thinkingLevels).nullable(),
})

export const thinkingLevelLabels: Record<ThinkingLevel, string> = { off: '关闭', low: '低', medium: '中', high: '高' }

const thinkingModelPattern = /deepseek-r|deepseek-reasoner|qwen3|glm-4\.5|glm-z1|kimi-k2-thinking|gpt-5|gpt-o|o[1-9]-|claude-3-7|claude-sonnet-4|claude-opus-4|reasoner|thinking|magistral|hunyuan-t1|doubao-[\w.-]*thinking|seed-oss|pangu-pro-moe/i
const plainModelPattern = /deepseek-chat|deepseek-v3|qwen-max|qwen-plus|qwen-turbo|glm-4(?!\.)|gpt-4|gpt-3\.5|kimi-k2(?!-thinking)|llama|mistral|gemma|phi-|yi-|baichuan|internlm|minicpm|ernie(?!-x1)/i

// 依据模型 ID 判断是否支持思考强度：已知推理模型按支持，已知普通模型按不支持，其余默认支持（用户可自行关闭）。
export function supportsThinkingLevel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (!id) return false
  if (thinkingModelPattern.test(id)) return true
  return !plainModelPattern.test(id)
}

export const modelSchema = z.object({
  id: identifier,
  providerId: identifier,
  name: shortText,
  modelId: z.string().trim().min(1).max(160),
  contextWindow: z.number().int().min(4000).max(4_000_000).optional(),
  params: modelParamsSchema.partial().optional(),
  systemPromptExtra: z.string().max(4000, '最多 4000 字').optional(),
})

export type ModelParams = z.infer<typeof modelParamsSchema>

export const mergeModelParams = (base: ModelParams, override?: Partial<ModelParams>): ModelParams => {
  const merged: ModelParams = { ...base }
  if (!override) return merged
  for (const key of Object.keys(override) as (keyof ModelParams)[]) {
    const value = override[key]
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  return merged
}

export const languages = ['zh-CN', 'en', 'auto'] as const
export const uiLanguages = ['zh-CN', 'en'] as const
export const responseStyles = ['concise', 'balanced', 'detailed'] as const
export const themes = ['dark', 'light', 'system'] as const
export const accents = ['matcha', 'ocean', 'sunset', 'violet', 'rose', 'mono'] as const
export const fontFamilies = ['system', 'sans', 'inter', 'roboto', 'system-ui', 'serif', 'georgia', 'source-serif', 'rounded', 'yahei', 'pingfang', 'source-han-sans', 'source-han-serif', 'kaiti', 'mono', 'jetbrains-mono'] as const
export const densities = ['comfortable', 'compact'] as const
export const shells = ['auto', 'powershell', 'pwsh', 'cmd', 'bash', 'sh'] as const
export const sendKeys = ['enter', 'ctrl-enter'] as const

const commandPattern = z.string().trim().min(1, '规则不能为空').max(200)

export const generalSchema = z.object({
  language: z.enum(languages),
  uiLanguage: z.enum(uiLanguages),
  responseStyle: z.enum(responseStyles),
  confirmDelete: z.boolean(),
})

export const backgroundSchema = z.object({
  image: z.string().max(15_000_000).regex(/^data:image\/(png|jpeg|jpg|gif|webp);base64,/, '仅支持 png / jpeg / gif / webp 图片').optional(),
  opacity: z.number().min(0).max(1),
})

export const appearanceSchema = z.object({
  theme: z.enum(themes),
  accent: z.enum(accents),
  fontFamily: z.enum(fontFamilies),
  fontSize: z.number().int().min(12, '字号最小 12').max(18, '字号最大 18'),
  codeFontSize: z.number().int().min(11, '代码字号最小 11').max(18, '代码字号最大 18'),
  density: z.enum(densities),
  reduceMotion: z.boolean(),
  background: backgroundSchema,
})

export const subagentRoles = ['general', 'researcher', 'coder', 'reviewer'] as const
export const subagentProfileSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(40),
  role: z.enum(subagentRoles),
  modelId: z.string().max(100),
  instruction: z.string().max(8000),
  toolAccess: z.enum(['read-only', 'project']),
})
export type SubagentProfile = z.infer<typeof subagentProfileSchema>

export const agentSchema = z.object({
  maxSteps: z.number().int().min(1, '至少 1 步').max(200, '最多 200 步'),
  commandTimeoutSec: z.number().int().min(5, '至少 5 秒').max(1800, '最多 1800 秒'),
  shell: z.enum(shells),
  planFirst: z.boolean(),
  verifyChanges: z.boolean(),
  autoTodo: z.boolean(),
  autoSelectRecommended: z.boolean().default(false),
  maxConcurrentSubagents: z.number().int().min(1).max(16).default(8),
  subagentProfiles: z.array(subagentProfileSchema).max(16).refine((profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length, '子智能体配置 ID 不能重复').default([]),
})

export const permissionsSchema = z.object({
  readOnly: z.boolean(),
  sandbox: z.boolean(),
  sandboxNetwork: z.boolean(),
  allowCommands: z.array(commandPattern).max(100, '最多 100 条'),
  denyCommands: z.array(commandPattern).max(100, '最多 100 条'),
})

export const chatSchema = z.object({
  sendKey: z.enum(sendKeys),
  showUsage: z.boolean(),
  expandTools: z.boolean(),
  autoScroll: z.boolean(),
  notifyOnDone: z.boolean(),
})

export const githubSchema = z.object({
  hasToken: z.boolean(),
  autoPush: z.boolean(),
  repo: z.string().trim().max(200).refine((value) => !value || /^[\w.-]+(\/[\w.-]+)?$/.test(value), '格式应为 仓库名 或 用户名/仓库名'),
  branch: z.string().trim().min(1, '分支不能为空').max(100).regex(/^[\w./-]+$/, '分支名只能包含字母、数字、. _ / -'),
  private: z.boolean(),
})

export const pluginsSchema = z.object({
  browser: z.boolean(),
  search: z.boolean(),
  computer: z.boolean(),
  image: z.boolean(),
  disabled: z.array(z.string().max(100)).max(100),
})

export const mcpServerSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1, '名称不能为空').max(60).regex(/^[\w.-]+$/, '名称只能包含字母、数字、_ . -'),
  command: z.string().trim().min(1, '启动命令不能为空').max(1000),
  args: z.array(z.string().max(1000)).max(50),
  env: z.record(z.string().max(100), z.string().max(4000)),
  enabled: z.boolean(),
})

export const mcpSchema = z.object({
  servers: z.array(mcpServerSchema).max(20).superRefine((servers, ctx) => {
    if (new Set(servers.map((item) => item.name)).size !== servers.length) ctx.addIssue({ code: 'custom', message: 'MCP 服务器名称必须唯一' })
  }),
})

export const workSchema = z.object({
  autoSwitchToChat: z.boolean(),
  confirmBeforeRun: z.boolean(),
  showControlBanner: z.boolean(),
  escToStopControl: z.boolean(),
})

export const searchEngines = ['bing', 'google', 'duckduckgo', 'baidu', 'custom'] as const
export type SearchEngine = (typeof searchEngines)[number]

export const crawlModes = ['background', 'visible'] as const
export type CrawlMode = (typeof crawlModes)[number]

export const browserSettingsSchema = z.object({
  homepage: z.string().trim().max(4000).default(''),
  stepApproval: z.boolean(),
  leaseMinutes: z.number().int().min(1).max(180),
  allowDownloads: z.boolean(),
  allowNewWindows: z.boolean(),
  userAgent: z.string().trim().max(500).default(''),
  searchEngine: z.enum(searchEngines).default('bing'),
  searchTemplate: z.string().trim().max(2000).default(''),
  crawlMode: z.enum(crawlModes).default('background'),
  crawlPages: z.number().int().min(3).max(20).default(8),
})

export const soundSchema = z.object({
  enabled: z.boolean(),
  onDone: z.boolean(),
  onApproval: z.boolean(),
  onQuestion: z.boolean(),
  volume: z.number().min(0).max(1),
})

export const imageSizes = ['1024x1024', '1024x1536', '1536x1024', '512x512', '768x768', 'auto'] as const

export const imageSettingsSchema = z.object({
  providerId: z.string().max(100).default(''),
  modelId: z.string().trim().max(160).default(''),
  size: z.enum(imageSizes).default('1024x1024'),
})

export const automationSchedules = ['interval', 'daily', 'weekly'] as const

export const automationSchema = z.object({
  id: identifier,
  name: shortText,
  projectId: identifier,
  modelId: z.string().max(100),
  workflowId: identifier.optional(),
  prompt: z.string().trim().max(8000).default(''),
  schedule: z.enum(automationSchedules).default('interval'),
  intervalMin: z.number().int().min(10, '间隔至少 10 分钟').max(10_080, '间隔最多 7 天'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM').default('09:00'),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
  enabled: z.boolean(),
  lastRun: z.string().max(40).optional(),
}).superRefine((value, ctx) => {
  if (value.schedule === 'weekly' && value.weekdays.length === 0) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: '每周执行至少选择一天' })
  if (!value.workflowId && !value.prompt.trim()) ctx.addIssue({ code: 'custom', path: ['prompt'], message: '指令不能为空（或改为选择工作流）' })
})

export const betaSchema = z.object({
  tokenSaving: z.boolean(),
  agentLoop: z.boolean(),
})

export const settingsSchema = z.object({
  providers: z.array(providerSchema).max(20),
  models: z.array(modelSchema).max(60),
  defaultModelId: z.string().max(100),
  approvalMode: z.enum(approvalModes),
  general: generalSchema,
  appearance: appearanceSchema,
  modelParams: modelParamsSchema,
  agent: agentSchema,
  permissions: permissionsSchema,
  chat: chatSchema,
  github: githubSchema,
  plugins: pluginsSchema,
  mcp: mcpSchema,
  work: workSchema,
  browser: browserSettingsSchema,
  sound: soundSchema,
  computer: computerSchema,
  floating: floatingSchema,
  speech: speechSchema,
  image: imageSettingsSchema,
  beta: betaSchema,
  automations: z.array(automationSchema).max(30),
}).superRefine((value, ctx) => {
  if (new Set(value.providers.map((item) => item.id)).size !== value.providers.length) {
    ctx.addIssue({ code: 'custom', message: '提供商标识必须唯一', path: ['providers'] })
  }
  if (new Set(value.models.map((item) => item.id)).size !== value.models.length) {
    ctx.addIssue({ code: 'custom', message: '模型标识必须唯一', path: ['models'] })
  }
  value.models.forEach((model, index) => {
    if (!value.providers.some((provider) => provider.id === model.providerId)) {
      ctx.addIssue({ code: 'custom', message: '模型引用的提供商不存在', path: ['models', index, 'providerId'] })
    }
  })
  if (value.defaultModelId && !value.models.some((model) => model.id === value.defaultModelId)) {
    ctx.addIssue({ code: 'custom', message: '默认模型不存在', path: ['defaultModelId'] })
  }
})

export const toolCallSchema = z.object({
  id: identifier,
  name: z.enum(toolNames),
  args: z.record(z.string(), z.unknown()),
})

export const toolResultSchema = z.object({
  callId: identifier,
  name: z.enum(toolNames),
  ok: z.boolean(),
  output: z.string().max(60_000),
  denied: z.boolean().optional(),
  diff: z.string().max(60_000).optional(),
  image: z.string().max(15_000_000).regex(/^data:image\/(png|jpeg|jpg|gif|webp);base64,/, '仅支持 png / jpeg / gif / webp 图片').optional(),
  durationMs: z.number().nonnegative().optional(),
})

export const messageCardSchema = z.object({
  kind: z.literal('workflow'),
  workflowId: identifier,
  name: shortText,
  steps: z.number().int().nonnegative(),
})

export const messageImageSchema = z.object({
  dataUrl: z.string().max(15_000_000).regex(/^data:image\/(png|jpeg|jpg|gif|webp);base64,/, '仅支持 png / jpeg / gif / webp 图片'),
  name: z.string().max(200).optional(),
})

export const messageSchema = z.discriminatedUnion('role', [
  z.object({ id: identifier, role: z.literal('user'), time: isoTime, content: z.string().max(60_000), card: messageCardSchema.optional(), images: z.array(messageImageSchema).max(8).optional(), steering: z.boolean().optional() }),
  z.object({
    id: identifier,
    role: z.literal('assistant'),
    time: isoTime,
    content: z.string().max(200_000),
    toolCalls: z.array(toolCallSchema).max(20),
    modelId: z.string().max(100),
    usage: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).optional(),
  }),
  z.object({ id: identifier, role: z.literal('tool'), time: isoTime, results: z.array(toolResultSchema).min(1).max(20) }),
  z.object({ id: identifier, role: z.literal('system'), time: isoTime, content: z.string().max(4000), level: z.enum(['info', 'error']) }),
])

export const pendingApprovalSchema = z.object({
  callId: identifier,
  name: z.enum(toolNames),
  args: z.record(z.string(), z.unknown()),
  summary: z.string().max(2000),
})

export const pendingQuestionSchema = z.object({
  callId: identifier,
  question: z.string().max(2000),
  options: z.array(z.string().max(200)).max(6),
  recommended: z.string().max(200).optional(),
  multiple: z.boolean().optional(),
})

export const queuedMessageSchema = z.object({
  id: identifier,
  content: z.string().max(60_000),
  modelId: z.string().max(100).optional(),
  time: isoTime,
  images: z.array(messageImageSchema).max(8).optional(),
})

export const todoStatuses = ['pending', 'active', 'done'] as const

export const todoItemSchema = z.object({
  id: identifier,
  content: z.string().trim().min(1).max(300),
  status: z.enum(todoStatuses),
})

export const agentModes = ['code', 'work', 'browser'] as const
export type AgentMode = (typeof agentModes)[number]

export const searchEngineTemplates: Record<Exclude<SearchEngine, 'custom'>, string> = {
  bing: 'https://www.bing.com/search?q={q}',
  google: 'https://www.google.com/search?q={q}',
  duckduckgo: 'https://duckduckgo.com/?q={q}',
  baidu: 'https://www.baidu.com/s?wd={q}',
}

export function buildSearchUrl(query: string, engine: SearchEngine, template = ''): string {
  const tpl = engine === 'custom'
    ? (template.includes('{q}') ? template : 'https://www.bing.com/search?q={q}')
    : searchEngineTemplates[engine]
  return tpl.replace('{q}', encodeURIComponent(query.trim()))
}

export const workflowStepSchema = z.object({
  nodeId: identifier,
  title: shortText,
  deps: z.array(identifier).max(20),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  output: z.string().max(20_000).optional(),
  error: z.string().max(4_000).optional(),
  startedAt: isoTime.optional(),
  finishedAt: isoTime.optional(),
})

export const workflowRunSchema = z.object({
  workflowId: identifier,
  name: shortText,
  status: z.enum(['running', 'paused', 'done']),
  steps: z.array(workflowStepSchema).max(20),
  startedAt: isoTime,
  finishedAt: isoTime.optional(),
})

export const subagentRunSchema = z.object({
  id: identifier,
  batchId: identifier,
  name: z.string().max(40),
  role: z.enum(subagentRoles),
  modelId: z.string().max(100),
  instruction: z.string().max(8000),
  status: z.enum(['queued', 'running', 'awaiting-approval', 'completed', 'failed', 'cancelled']),
  step: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
  detail: z.string().max(2000).optional(),
  summary: z.string().max(12000).optional(),
  startedAt: isoTime.optional(),
  finishedAt: isoTime.optional(),
})
export type SubagentRun = z.infer<typeof subagentRunSchema>

export const threadSchema = z.object({
  id: identifier,
  projectId: identifier,
  title: shortText,
  modelId: z.string().max(100),
  status: z.enum(['idle', 'running', 'awaiting-approval', 'awaiting-input']),
  createdAt: isoTime,
  updatedAt: isoTime,
  messages: z.array(messageSchema).max(400),
  pending: pendingApprovalSchema.optional(),
  question: pendingQuestionSchema.optional(),
  queue: z.array(queuedMessageSchema).max(20).optional(),
  todos: z.array(todoItemSchema).max(40).optional(),
  pinned: z.boolean().optional(),
  mode: z.enum(agentModes).optional(),
  workflowRun: workflowRunSchema.optional(),
  subagentRuns: z.array(subagentRunSchema).max(64).optional(),
})

export const workflowNodeKinds = ['task', 'check', 'review', 'note', 'computer', 'browser', 'launch', 'command', 'search', 'file', 'git', 'plugin', 'mcp', 'wait', 'ask'] as const

export const workflowNodeSchema = z.object({
  id: identifier,
  title: shortText,
  prompt: z.string().max(8000),
  x: z.number().min(-10_000).max(10_000),
  y: z.number().min(-10_000).max(10_000),
  kind: z.enum(workflowNodeKinds).optional(),
})

export const workflowSchema = z.object({
  id: identifier,
  projectId: identifier,
  name: shortText,
  nodes: z.array(workflowNodeSchema).max(20, '单个工作流最多 20 个节点'),
  edges: z.array(z.object({ from: identifier, to: identifier })).max(60),
  updatedAt: isoTime,
})

export const stateSchema = z.object({
  version: z.literal(3),
  projects: z.array(projectSchema).max(50),
  threads: z.array(threadSchema).max(200),
  settings: settingsSchema,
  notice: z.string().max(2000).optional(),
  workflows: z.array(workflowSchema).max(50).optional(),
})

export const createThreadInputSchema = z.object({ projectId: identifier, modelId: z.string().max(100), mode: z.enum(agentModes).optional() }).strict()
export const sendMessageInputSchema = z.object({ threadId: identifier, content: z.string().trim().max(60_000), modelId: z.string().max(100).optional(), card: messageCardSchema.optional(), images: z.array(messageImageSchema).max(8).optional() }).strict().refine((value) => value.content.length > 0 || (value.images?.length ?? 0) > 0, { message: '请输入内容或添加图片' })
export const regenerateMessageInputSchema = z.object({ threadId: identifier, messageId: identifier, modelId: z.string().max(100).optional() }).strict()
export const rollbackMessageInputSchema = z.object({ threadId: identifier, messageId: identifier }).strict()
export const deleteMessageInputSchema = z.object({ threadId: identifier, messageId: identifier }).strict()
export const threadInputSchema = z.object({ threadId: identifier }).strict()
export const exportTextInputSchema = z.object({ title: z.string().trim().min(1).max(120), defaultName: z.string().trim().min(1).max(80), content: z.string().max(2_000_000) }).strict()
export const projectInputSchema = z.object({ projectId: identifier }).strict()
export const updateProjectInputSchema = z.object({ projectId: identifier, name: shortText.optional(), archived: z.boolean().optional() }).strict()
export const updateThreadInputSchema = z.object({ threadId: identifier, title: shortText.optional(), pinned: z.boolean().optional() }).strict()
export const windowActions = ['minimize', 'maximize', 'close', 'fullscreen'] as const
export const windowActionSchema = z.enum(windowActions)
export const approvalInputSchema = z.object({ threadId: identifier, callId: identifier, approved: z.boolean() }).strict()
export const answerInputSchema = z.object({ threadId: identifier, callId: identifier, answer: z.string().trim().min(1).max(4000) }).strict()
export const dequeueInputSchema = z.object({ threadId: identifier, queuedId: identifier }).strict()
export const steerInputSchema = z.object({ threadId: identifier, content: z.string().trim().min(1).max(60_000) }).strict()
export const providerKeyInputSchema = z.object({ providerId: identifier, apiKey: z.string().max(4000) }).strict()
export const projectPathInputSchema = z.object({ projectId: identifier, path: z.string().max(2000) }).strict()
export const saveProjectFileInputSchema = z.object({ projectId: identifier, path: z.string().min(1).max(2000), content: z.string().max(400_000), expectedContent: z.string().max(400_000) }).strict()
export const copyTextInputSchema = z.object({ text: z.string().max(2_000_000) }).strict()
export const runShellInputSchema = z.object({ projectId: identifier, command: z.string().trim().min(1).max(4000) }).strict()
export const panelWindowInputSchema = z.object({ threadId: identifier }).strict()
export const openExternalInputSchema = z.object({ url: z.string().url().max(4000) }).strict()
export const fileEntrySchema = z.object({ name: z.string(), path: z.string(), kind: z.enum(['file', 'directory']), skipped: z.boolean().optional() })
export const fileContentSchema = z.object({ path: z.string(), content: z.string(), truncated: z.boolean(), size: z.number().nonnegative() })
export const testConnectionInputSchema = z.object({ provider: providerSchema, model: modelSchema, apiKey: z.string().max(4000).optional() }).strict()
export const listProviderModelsInputSchema = z.object({ provider: providerSchema, apiKey: z.string().max(4000).optional() }).strict()
export const probeContextWindowInputSchema = z.object({ provider: providerSchema, model: modelSchema, apiKey: z.string().max(4000).optional() }).strict()
export const streamDeltaSchema = z.object({ threadId: identifier, messageId: identifier, delta: z.string() })
export const activityPhaseSchema = z.enum(['thinking', 'planning', 'writing', 'tool', 'delegating', 'waiting'])
export type ActivityPhase = z.infer<typeof activityPhaseSchema>
export const agentActivitySchema = z.object({
  threadId: identifier,
  phase: activityPhaseSchema,
  label: z.string(),
  detail: z.string().optional(),
  step: z.number().int().nonnegative().optional(),
  agents: z.array(z.string()).optional(),
})
export type AgentActivity = z.infer<typeof agentActivitySchema>
export const githubTokenInputSchema = z.object({ token: z.string().trim().max(400) }).strict()
export const githubPushInputSchema = z.object({ projectId: identifier, message: z.string().trim().max(500).optional() }).strict()
export const saveWorkflowInputSchema = workflowSchema.strict()
export const workflowInputSchema = z.object({ workflowId: identifier }).strict()
export const workflowControlInputSchema = z.object({
  threadId: identifier,
  action: z.enum(['pause', 'resume', 'retry-node', 'skip-node']),
  nodeId: identifier.optional(),
}).strict()
export const automationInputSchema = z.object({ automationId: identifier }).strict()
export const browserBoundsInputSchema = z.object({ threadId: identifier, x: z.number().int(), y: z.number().int(), width: z.number().int().nonnegative().max(20_000), height: z.number().int().nonnegative().max(20_000) }).strict()
export const browserNavigateInputSchema = z.object({ threadId: identifier, url: z.string().trim().min(1).max(4000) }).strict()
export const browserTabSchema = z.object({ id: identifier, title: z.string(), url: z.string(), loading: z.boolean() })
export const browserStateSchema = z.object({ threadId: identifier, url: z.string(), title: z.string(), loading: z.boolean(), canGoBack: z.boolean(), canGoForward: z.boolean(), tabs: z.array(browserTabSchema), activeTabId: identifier.nullable() })
export type BrowserTab = z.infer<typeof browserTabSchema>
export type BrowserState = z.infer<typeof browserStateSchema>
export const browserTabInputSchema = z.object({ threadId: identifier, action: z.enum(['new', 'close', 'activate']), tabId: identifier.optional(), url: z.string().trim().max(4000).optional() }).strict()
export const pluginToolSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/i, '工具名只能包含字母、数字、_ -'),
  description: z.string().max(1000),
  command: z.string().trim().min(1).max(2000),
  parameters: z.record(z.string(), z.unknown()).optional(),
})
export const pluginManifestSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/i, '插件名只能包含字母、数字、_ -'),
  description: z.string().max(1000).default(''),
  version: z.string().max(40).optional(),
  tools: z.array(pluginToolSchema).min(1).max(20),
})

export type Project = z.infer<typeof projectSchema>
export type ProviderConfig = z.infer<typeof providerSchema>
export type ModelConfig = z.infer<typeof modelSchema>
export type Settings = z.infer<typeof settingsSchema>
export type UiLanguage = (typeof uiLanguages)[number]
export type ToolName = (typeof toolNames)[number]
export type ToolCall = z.infer<typeof toolCallSchema>
export type ToolResult = z.infer<typeof toolResultSchema>
export type Message = z.infer<typeof messageSchema>
export type AssistantMessage = Extract<Message, { role: 'assistant' }>
export type MessageCard = z.infer<typeof messageCardSchema>
export type MessageImage = z.infer<typeof messageImageSchema>
export type PendingApproval = z.infer<typeof pendingApprovalSchema>
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>
export type QueuedMessage = z.infer<typeof queuedMessageSchema>
export type TodoItem = z.infer<typeof todoItemSchema>
export type TodoStatus = (typeof todoStatuses)[number]
export type Thread = z.infer<typeof threadSchema>
export type AppState = z.infer<typeof stateSchema>
export type StreamDelta = z.infer<typeof streamDeltaSchema>
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }
export type ConnectionTest = { ok: boolean; latencyMs: number; message: string }
export type DiscoveredModelInfo = { modelId: string; contextWindow?: number }
export type ContextProbeInfo = { contextWindow: number; attempts: number; capped: boolean }
export type WindowAction = (typeof windowActions)[number]
export type WindowState = { maximized: boolean; focused: boolean; panelDetached?: boolean }
export type ControlState = { active: true; kind: 'computer' | 'browser'; label: string; threadId: string } | { active: false }
export type FileEntry = z.infer<typeof fileEntrySchema>
export type FileContent = z.infer<typeof fileContentSchema>
export type ShellOutput = { output: string; durationMs: number }
export type Automation = z.infer<typeof automationSchema>
export type Workflow = z.infer<typeof workflowSchema>
export type WorkflowNode = z.infer<typeof workflowNodeSchema>
export type WorkflowNodeKind = (typeof workflowNodeKinds)[number]
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type WorkflowRun = z.infer<typeof workflowRunSchema>
export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginInfo = { name: string; description: string; version?: string; builtin: boolean; enabled: boolean; tools: { name: string; description: string }[]; path?: string; error?: string }
export type McpServer = z.infer<typeof mcpServerSchema>
export type McpStatus = { id: string; name: string; enabled: boolean; status: 'stopped' | 'connecting' | 'ready' | 'error'; error?: string; tools: { name: string; description: string }[] }
export const mcpTestInputSchema = z.object({ server: mcpServerSchema }).strict()
export type GithubPushResult = { repo: string; url: string; branch: string; log: string }
export type SkillMeta = { id: string; name: string; description: string; builtin: boolean; fileName?: string }
export type SkillDetail = SkillMeta & { content: string }

export interface CubexAPI {
  getState: () => Promise<Result<AppState>>
  selectProject: () => Promise<Result<Project | null>>
  createThread: (input: { projectId: string; modelId: string; mode?: AgentMode }) => Promise<Result<Thread>>
  sendMessage: (input: { threadId: string; content: string; modelId?: string; card?: MessageCard; images?: MessageImage[] }) => Promise<Result<void>>
  regenerateMessage: (input: { threadId: string; messageId: string; modelId?: string }) => Promise<Result<void>>
  rollbackMessage: (input: { threadId: string; messageId: string }) => Promise<Result<void>>
  deleteMessage: (input: { threadId: string; messageId: string }) => Promise<Result<void>>
  cancelThread: (input: { threadId: string }) => Promise<Result<void>>
  deleteThread: (input: { threadId: string }) => Promise<Result<void>>
  updateThread: (input: { threadId: string; title?: string; pinned?: boolean }) => Promise<Result<void>>
  compactThread: (input: { threadId: string }) => Promise<Result<{ removed: number }>>
  exportThread: (input: { threadId: string }) => Promise<Result<string | null>>
  exportText: (input: { title: string; defaultName: string; content: string }) => Promise<Result<string | null>>
  deleteProject: (input: { projectId: string }) => Promise<Result<void>>
  updateProject: (input: { projectId: string; name?: string; archived?: boolean }) => Promise<Result<void>>
  revealProject: (input: { projectId: string }) => Promise<Result<void>>
  windowControl: (action: WindowAction) => Promise<Result<void>>
  resolveApproval: (input: { threadId: string; callId: string; approved: boolean }) => Promise<Result<void>>
  answerQuestion: (input: { threadId: string; callId: string; answer: string }) => Promise<Result<void>>
  dequeueMessage: (input: { threadId: string; queuedId: string }) => Promise<Result<void>>
  steerMessage: (input: { threadId: string; content: string }) => Promise<Result<void>>
  pickFiles: (input: { projectId: string }) => Promise<Result<string[]>>
  listFiles: (input: { projectId: string; path: string }) => Promise<Result<FileEntry[]>>
  readProjectFile: (input: { projectId: string; path: string }) => Promise<Result<FileContent>>
  saveProjectFile: (input: { projectId: string; path: string; content: string; expectedContent: string }) => Promise<Result<FileContent>>
  runShell: (input: { projectId: string; command: string }) => Promise<Result<ShellOutput>>
  openPanelWindow: (input: { threadId: string }) => Promise<Result<void>>
  closePanelWindow: () => Promise<Result<void>>
  openExternal: (input: { url: string }) => Promise<Result<void>>
  saveSettings: (settings: Settings) => Promise<Result<void>>
  setProviderKey: (input: { providerId: string; apiKey: string }) => Promise<Result<void>>
  testConnection: (input: { provider: ProviderConfig; model: ModelConfig; apiKey?: string }) => Promise<Result<ConnectionTest>>
  listProviderModels: (input: { provider: ProviderConfig; apiKey?: string }) => Promise<Result<DiscoveredModelInfo[]>>
  probeContextWindow: (input: { provider: ProviderConfig; model: ModelConfig; apiKey?: string }) => Promise<Result<ContextProbeInfo>>
  shareThreadImage: (input: { threadId: string }) => Promise<Result<string | null>>
  setGithubToken: (input: { token: string }) => Promise<Result<string | null>>
  githubPush: (input: { projectId: string; message?: string }) => Promise<Result<GithubPushResult>>
  listPlugins: () => Promise<Result<PluginInfo[]>>
  openPluginsDir: () => Promise<Result<void>>
  listSkills: () => Promise<Result<SkillMeta[]>>
  importSkills: () => Promise<Result<SkillMeta[]>>
  deleteSkill: (input: { id: string }) => Promise<Result<void>>
  readSkill: (input: { id: string }) => Promise<Result<SkillDetail>>
  openSkillsDir: () => Promise<Result<void>>
  listMcp: () => Promise<Result<McpStatus[]>>
  testMcp: (input: { server: McpServer }) => Promise<Result<McpStatus>>
  saveWorkflow: (workflow: Workflow) => Promise<Result<void>>
  deleteWorkflow: (input: { workflowId: string }) => Promise<Result<void>>
  runWorkflow: (input: { workflowId: string }) => Promise<Result<Thread>>
  runAutomation: (input: { automationId: string }) => Promise<Result<void>>
  browserBounds: (input: { threadId: string; x: number; y: number; width: number; height: number }) => Promise<Result<BrowserState>>
  browserHide: (input: { threadId: string }) => Promise<Result<null>>
  browserNavigate: (input: { threadId: string; url: string }) => Promise<Result<BrowserState>>
  browserCapture: (input: { threadId: string }) => Promise<Result<{ title: string; url: string; selection: string; screenshot?: string }>>
  browserTab: (input: { threadId: string; action: 'new' | 'close' | 'activate'; tabId?: string; url?: string }) => Promise<Result<BrowserState>>
  onBrowserState: (listener: (state: BrowserState) => void) => () => void
  workflowControl: (input: { threadId: string; action: 'pause' | 'resume' | 'retry-node' | 'skip-node'; nodeId?: string }) => Promise<Result<void>>
  openFloatingWindow: () => Promise<Result<void>>
  closeFloatingWindow: () => Promise<Result<void>>
  focusMainWindow: () => Promise<Result<void>>
  copyText: (input: { text: string }) => Promise<Result<void>>
  onDesktopMirror: (listener: (frame: { image: string; width: number; height: number } | null) => void) => () => void
  onState: (listener: (state: AppState) => void) => () => void
  onDelta: (listener: (delta: StreamDelta) => void) => () => void
  onActivity: (listener: (activity: AgentActivity) => void) => () => void
  onWindowState: (listener: (state: WindowState) => void) => () => void
  onControl: (listener: (control: ControlState) => void) => () => void
}

export { channels } from './channels'

export const providerLabels: Record<ProviderConfig['kind'], string> = {
  'openai-compatible': 'OpenAI 兼容',
  anthropic: 'Anthropic',
  ollama: 'Ollama（本机）',
}

export const approvalLabels: Record<Settings['approvalMode'], { name: string; hint: string }> = {
  ask: { name: '逐项确认', hint: '写文件与执行命令都需要你批准' },
  'auto-edit': { name: '自动编辑', hint: '自动写文件，执行命令需要批准' },
  'full-auto': { name: '完全自动', hint: '文件与命令都自动执行；文件操作限制在项目目录内，命令不受沙箱限制，请谨慎使用' },
}

export function defaultSettings(): Settings {
  return {
    providers: [],
    models: [],
    defaultModelId: '',
    approvalMode: 'ask',
    general: { language: 'zh-CN', uiLanguage: 'zh-CN', responseStyle: 'balanced', confirmDelete: true },
    appearance: { theme: 'light', accent: 'matcha', fontFamily: 'system', fontSize: 14, codeFontSize: 13, density: 'comfortable', reduceMotion: false, background: { opacity: 0.35 } },
    modelParams: { temperature: null, maxTokens: 0, timeoutSec: 120, retries: 2, historyLimit: 200, thinkingLevel: null },
    computer: { mode: 'current', idleWaitSec: 3, mirror: true },
    floating: { opacity: 0.92, autoShow: true },
    speech: { model: 'Xenova/whisper-tiny', downloadSource: 'auto' },
    agent: { maxSteps: 40, commandTimeoutSec: 180, shell: 'auto', planFirst: true, verifyChanges: true, autoTodo: true, autoSelectRecommended: false, maxConcurrentSubagents: 8, subagentProfiles: [] },
    permissions: { readOnly: false, sandbox: true, sandboxNetwork: false, allowCommands: [], denyCommands: ['rm -rf /', 'format', 'shutdown', 'git push --force'] },
    chat: { sendKey: 'enter', showUsage: true, expandTools: false, autoScroll: true, notifyOnDone: true },
    github: { hasToken: false, autoPush: false, repo: '', branch: 'main', private: true },
    plugins: { browser: true, search: true, computer: false, image: true, disabled: [] },
    mcp: { servers: [] },
    work: { autoSwitchToChat: true, confirmBeforeRun: true, showControlBanner: true, escToStopControl: true },
    browser: { homepage: '', stepApproval: true, leaseMinutes: 30, allowDownloads: false, allowNewWindows: false, userAgent: '', searchEngine: 'bing', searchTemplate: '', crawlMode: 'background', crawlPages: 8 },
    sound: { enabled: true, onDone: true, onApproval: true, onQuestion: true, volume: 0.5 },
    image: { providerId: '', modelId: '', size: '1024x1024' },
    beta: { tokenSaving: false, agentLoop: false },
    automations: [],
  }
}

export function createInitialState(): AppState {
  return { version: 3, projects: [], threads: [], settings: defaultSettings() }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function mergeGroup<T extends Record<string, unknown>>(schema: z.ZodType<T>, fallback: T, raw: unknown): T {
  if (!isRecord(raw)) return fallback
  const out = { ...fallback }
  for (const key of Object.keys(fallback) as Array<keyof T>) {
    if (!(key in raw)) continue
    const candidate = { ...out, [key]: raw[key as string] }
    if (schema.safeParse(candidate).success) out[key] = raw[key as string] as T[keyof T]
  }
  return out
}

export function migrateState(raw: unknown): unknown {
  if (!isRecord(raw) || (raw.version !== 2 && raw.version !== 3) || !isRecord(raw.settings)) return raw
  const defaults = defaultSettings()
  const legacy: Record<string, unknown> = { ...raw.settings }
  delete legacy.systemPrompt
  const settings = {
    ...legacy,
    general: mergeGroup(generalSchema, defaults.general, legacy.general),
    appearance: mergeGroup(appearanceSchema, defaults.appearance, legacy.appearance),
    modelParams: mergeGroup(modelParamsSchema, defaults.modelParams, legacy.modelParams),
    agent: mergeGroup(agentSchema, defaults.agent, legacy.agent),
    permissions: mergeGroup(permissionsSchema, defaults.permissions, legacy.permissions),
    chat: mergeGroup(chatSchema, defaults.chat, legacy.chat),
    github: mergeGroup(githubSchema, defaults.github, legacy.github),
    plugins: mergeGroup(pluginsSchema, defaults.plugins, legacy.plugins),
    mcp: mcpSchema.safeParse(legacy.mcp).success ? mcpSchema.parse(legacy.mcp) : defaults.mcp,
    work: mergeGroup(workSchema, defaults.work, legacy.work),
    browser: mergeGroup(browserSettingsSchema, defaults.browser, legacy.browser),
    sound: mergeGroup(soundSchema, defaults.sound, legacy.sound),
    computer: mergeGroup(computerSchema, defaults.computer, legacy.computer),
    floating: mergeGroup(floatingSchema, defaults.floating, legacy.floating),
    speech: mergeGroup(speechSchema, defaults.speech, legacy.speech),
    image: mergeGroup(imageSettingsSchema, defaults.image, legacy.image),
    beta: mergeGroup(betaSchema, defaults.beta, legacy.beta),
    automations: Array.isArray(legacy.automations)
      ? legacy.automations.flatMap((item) => {
          const parsed = automationSchema.safeParse(item)
          return parsed.success ? [parsed.data] : []
        })
      : [],
  }
  return { ...raw, version: 3, settings }
}
