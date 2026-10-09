import { describe, expect, it } from 'vitest'
import { sanitizeHistory } from '../src/main/llm'
import { buildSystemPrompt } from '../src/main/prompt'
import { matchesCommandRule } from '../src/main/tools'
import { createInitialState, defaultSettings, migrateState, stateSchema, type Message } from '../src/shared/schema'

const time = '2026-01-01T00:00:00.000Z'
const project = { id: 'p1', name: 'demo', path: 'C:\\demo' }

describe('migrateState', () => {
  it('v2 状态升级为 v3，去掉自定义提示词并补齐新分组', () => {
    const legacy = { version: 2, projects: [], threads: [], settings: { providers: [], models: [], defaultModelId: '', approvalMode: 'auto-edit', systemPrompt: '旧提示词' } }
    const migrated = migrateState(legacy) as { version: number; settings: Record<string, unknown> }
    expect(migrated.version).toBe(3)
    expect(migrated.settings).not.toHaveProperty('systemPrompt')
    expect(migrated.settings.approvalMode).toBe('auto-edit')
    expect(migrated.settings.agent).toEqual(defaultSettings().agent)
    expect(stateSchema.safeParse(migrated).success).toBe(true)
  })

  it('保留合法的旧值，丢弃非法的单项而不重置整个分组', () => {
    const state = createInitialState()
    const raw = { ...state, settings: { ...state.settings, appearance: { ...state.settings.appearance, theme: 'light', fontSize: 99 } } }
    const migrated = migrateState(raw) as ReturnType<typeof createInitialState>
    expect(migrated.settings.appearance.theme).toBe('light')
    expect(migrated.settings.appearance.fontSize).toBe(14)
    expect(stateSchema.safeParse(migrated).success).toBe(true)
  })

  it('旧配置补齐电脑操控、悬浮窗与思考强度默认值', () => {
    const state = createInitialState()
    const raw = {
      ...state,
      settings: {
        ...state.settings,
        computer: undefined,
        floating: undefined,
        modelParams: { temperature: null, maxTokens: 0, timeoutSec: 60, retries: 1, historyLimit: 50 },
      },
    }
    const migrated = stateSchema.parse(migrateState(raw))
    expect(migrated.settings.computer).toEqual({ mode: 'current', idleWaitSec: 3, mirror: true })
    expect(migrated.settings.floating).toEqual({ opacity: 0.92, autoShow: true })
    expect(migrated.settings.modelParams.thinkingLevel).toBeNull()
    expect(migrated.settings.modelParams.timeoutSec).toBe(60)
  })

  it('独立桌面模式与自定义透明度在迁移后保留', () => {
    const state = createInitialState()
    state.settings.computer = { mode: 'isolated', idleWaitSec: 8, mirror: false }
    state.settings.floating = { opacity: 0.6, autoShow: false }
    state.settings.modelParams.thinkingLevel = 'high'
    const migrated = stateSchema.parse(migrateState(JSON.parse(JSON.stringify(state))))
    expect(migrated.settings.computer.mode).toBe('isolated')
    expect(migrated.settings.computer.mirror).toBe(false)
    expect(migrated.settings.floating.opacity).toBe(0.6)
    expect(migrated.settings.modelParams.thinkingLevel).toBe('high')
  })

  it('独立桌面模式只在合法枚举内', () => {
    const state = createInitialState()
    for (const mode of ['current', 'isolated'] as const) {
      expect(stateSchema.safeParse({ ...state, settings: { ...state.settings, computer: { ...state.settings.computer, mode } } }).success).toBe(true)
    }
    expect(stateSchema.safeParse({ ...state, settings: { ...state.settings, computer: { ...state.settings.computer, mode: 'nope' } } }).success).toBe(false)
  })

  it('无法识别的数据原样返回', () => {
    expect(migrateState(null)).toBeNull()
    expect(migrateState({ version: 1 })).toEqual({ version: 1 })
  })

  it('旧配置补齐子智能体默认值并保留已有智能体设置', () => {
    const state = createInitialState()
    const raw = { ...state, settings: { ...state.settings, agent: { maxSteps: 75, commandTimeoutSec: 120, shell: 'auto', planFirst: false, verifyChanges: true, autoTodo: false } } }
    const migrated = stateSchema.parse(migrateState(raw))
    expect(migrated.settings.agent).toMatchObject({ maxSteps: 75, planFirst: false, autoTodo: false, maxConcurrentSubagents: 8, subagentProfiles: [] })
    expect(migrated.settings.agent.autoSelectRecommended).toBe(false)
  })

  it('自动选择推荐项的显式设置在迁移后保留', () => {
    const state = createInitialState()
    state.settings.agent.autoSelectRecommended = true
    const restored = stateSchema.parse(migrateState(JSON.parse(JSON.stringify(state))))
    expect(restored.settings.agent.autoSelectRecommended).toBe(true)
  })

  it('子智能体配置和并发上限可持久化，非法并发单独回退', () => {
    const state = createInitialState()
    state.settings.agent.maxConcurrentSubagents = 16
    state.settings.agent.subagentProfiles = [{ id: 'review', name: '审查', role: 'reviewer', modelId: 'review-model', instruction: '检查边界条件', toolAccess: 'read-only' }]
    const restored = stateSchema.parse(migrateState(JSON.parse(JSON.stringify(state))))
    expect(restored.settings.agent).toEqual(state.settings.agent)
    const invalid = { ...state, settings: { ...state.settings, agent: { ...state.settings.agent, maxConcurrentSubagents: 99 } } }
    const repaired = stateSchema.parse(migrateState(invalid))
    expect(repaired.settings.agent.maxConcurrentSubagents).toBe(8)
    expect(repaired.settings.agent.subagentProfiles).toEqual(state.settings.agent.subagentProfiles)
  })
})

describe('matchesCommandRule', () => {
  it('按命令前缀匹配，不误伤相似命令', () => {
    expect(matchesCommandRule('git push --force origin main', ['git push --force'])).toBe('git push --force')
    expect(matchesCommandRule('git pushx', ['git push'])).toBeUndefined()
    expect(matchesCommandRule('npm test', ['npm test'])).toBe('npm test')
  })

  it('检查组合命令中的每一段并支持通配符', () => {
    expect(matchesCommandRule('npm run build && shutdown /s', ['shutdown'])).toBe('shutdown')
    expect(matchesCommandRule('npm run lint', ['npm run *'])).toBe('npm run *')
    expect(matchesCommandRule('pnpm install', ['npm run *'])).toBeUndefined()
  })
})

describe('sanitizeHistory', () => {
  it('移除空的助手占位、系统消息与没有结果的工具调用', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', time, content: '你好' },
      { id: 'a1', role: 'assistant', time, content: '', toolCalls: [], modelId: 'm' },
      { id: 's1', role: 'system', time, content: '出错了', level: 'error' },
      { id: 'u2', role: 'user', time, content: '再试一次' },
      { id: 'a2', role: 'assistant', time, content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }], modelId: 'm' },
      { id: 'u3', role: 'user', time, content: '继续' },
    ]
    expect(sanitizeHistory(messages).map((item) => item.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('保留成对的工具调用与结果', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', time, content: '读文件' },
      { id: 'a1', role: 'assistant', time, content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }, { id: 'c2', name: 'read_file', args: { path: 'b' } }], modelId: 'm' },
      { id: 't1', role: 'tool', time, results: [{ callId: 'c1', name: 'read_file', ok: true, output: 'x' }] },
    ]
    const out = sanitizeHistory(messages)
    expect(out.map((item) => item.id)).toEqual(['u1', 'a1', 't1'])
    const assistant = out[1]
    expect(assistant.role === 'assistant' && assistant.toolCalls.map((call) => call.id)).toEqual(['c1'])
  })
})

describe('buildSystemPrompt', () => {
  it('根据设置动态拼接规则与环境信息', () => {
    const settings = defaultSettings()
    const prompt = buildSystemPrompt(settings, project, new Date(time))
    expect(prompt).toContain('C:\\demo')
    expect(prompt).toContain(`${settings.agent.maxSteps} 步`)
    expect(prompt).not.toContain('只读模式')
  })

  it('只读模式下提示模型不要修改文件', () => {
    const settings = defaultSettings()
    const prompt = buildSystemPrompt({ ...settings, permissions: { ...settings.permissions, readOnly: true } }, project, new Date(time))
    expect(prompt).toContain('只读模式')
    expect(prompt).not.toContain('运行项目已有的类型检查')
  })
})
