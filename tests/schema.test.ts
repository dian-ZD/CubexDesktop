import { describe, expect, it } from 'vitest'
import { approvalModes, createInitialState, mergeModelParams, providerSchema, settingsSchema, stateSchema } from '../src/shared/schema'

const provider = { id: 'p1', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', hasKey: false } as const
const model = { id: 'm1', providerId: 'p1', name: 'GPT', modelId: 'gpt-4.1' } as const

describe('schema', () => {
  it('模型可携带部分参数覆盖与专属提示词，并按键合并到全局参数', () => {
    const settings = createInitialState().settings
    const withParams = { ...model, params: { temperature: 0.2, retries: 1 }, systemPromptExtra: '简洁' }
    expect(settingsSchema.safeParse({ ...settings, providers: [provider], models: [withParams], defaultModelId: 'm1' }).success).toBe(true)
    expect(settingsSchema.safeParse({ ...settings, providers: [provider], models: [{ ...model, params: { temperature: 5 } }], defaultModelId: 'm1' }).success).toBe(false)
    const merged = mergeModelParams(settings.modelParams, withParams.params)
    expect(merged.temperature).toBe(0.2)
    expect(merged.retries).toBe(1)
    expect(merged.timeoutSec).toBe(settings.modelParams.timeoutSec)
    expect(mergeModelParams(settings.modelParams, undefined)).toEqual(settings.modelParams)
  })

  it('初始状态通过校验', () => {
    expect(stateSchema.safeParse(createInitialState()).success).toBe(true)
  })

  it('提供商端点支持 HTTPS 和本机、局域网及远程 HTTP', () => {
    expect(providerSchema.safeParse({ ...provider, baseUrl: 'https://api.example.com' }).success).toBe(true)
    expect(providerSchema.safeParse({ ...provider, baseUrl: 'http://localhost:11434' }).success).toBe(true)
    expect(providerSchema.safeParse({ ...provider, baseUrl: 'http://api.example.com/v1' }).success).toBe(true)
    expect(providerSchema.safeParse({ ...provider, baseUrl: 'http://192.168.1.100:8000/v1' }).success).toBe(true)
    expect(providerSchema.safeParse({ ...provider, baseUrl: 'http://[::1]:11434' }).success).toBe(true)
  })

  it('提供商端点仍拒绝非 HTTP 协议、凭据、查询参数和片段', () => {
    expect(providerSchema.safeParse({ ...provider, baseUrl: 'https://user:pw@api.example.com' }).success).toBe(false)
    for (const baseUrl of ['http://user:pw@api.example.com', 'http://api.example.com/v1?key=test', 'http://api.example.com/v1#section', 'ftp://api.example.com', 'file:///tmp/model', 'not-a-url']) {
      expect(providerSchema.safeParse({ ...provider, baseUrl }).success).toBe(false)
    }
  })

  it('模型必须引用存在的提供商', () => {
    const settings = createInitialState().settings
    expect(settingsSchema.safeParse({ ...settings, providers: [provider], models: [model] }).success).toBe(true)
    expect(settingsSchema.safeParse({ ...settings, providers: [], models: [model] }).success).toBe(false)
  })

  it('默认模型必须存在', () => {
    const settings = createInitialState().settings
    expect(settingsSchema.safeParse({ ...settings, providers: [provider], models: [model], defaultModelId: 'm1' }).success).toBe(true)
    expect(settingsSchema.safeParse({ ...settings, providers: [provider], models: [model], defaultModelId: 'missing' }).success).toBe(false)
  })

  it('审批模式只允许预设枚举', () => {
    const settings = createInitialState().settings
    for (const mode of approvalModes) {
      expect(settingsSchema.safeParse({ ...settings, approvalMode: mode }).success).toBe(true)
    }
    expect(settingsSchema.safeParse({ ...settings, approvalMode: 'yolo' }).success).toBe(false)
  })
})
