import { describe, expect, it, vi } from 'vitest'
import { ISOLATED_DESKTOP_NAME, isolatedDesktopSupported } from '../src/main/computer'
import { supportsThinkingLevel, thinkingLevels } from '../src/shared/schema'

vi.mock('electron', () => ({ BrowserWindow: class {}, WebContentsView: class {}, shell: { openExternal: () => undefined } }))

describe('电脑操控辅助', () => {
  it('独立桌面仅在 Windows 标记为可用，非 Windows 给出原因', () => {
    const result = isolatedDesktopSupported()
    if (process.platform === 'win32') expect(result.supported).toBe(true)
    else {
      expect(result.supported).toBe(false)
      expect(result.reason).toBeTruthy()
    }
  })

  it('独立桌面名称固定，供镜像与操作共用', () => {
    expect(ISOLATED_DESKTOP_NAME).toBe('CubexAgent')
  })
})

describe('思考强度识别', () => {
  it('已知推理模型按支持，普通模型按不支持', () => {
    for (const id of ['gpt-5-codex', 'o3-mini', 'deepseek-reasoner', 'qwen3-32b', 'glm-4.5', 'claude-sonnet-4-5', 'kimi-k2-thinking']) {
      expect(supportsThinkingLevel(id), id).toBe(true)
    }
    for (const id of ['gpt-4o', 'gpt-4.1', 'deepseek-chat', 'qwen-max', 'llama-3.3-70b', 'kimi-k2']) {
      expect(supportsThinkingLevel(id), id).toBe(false)
    }
  })

  it('无法识别的模型默认按支持处理，空型号按不支持', () => {
    expect(supportsThinkingLevel('some-unknown-model')).toBe(true)
    expect(supportsThinkingLevel('   ')).toBe(false)
  })

  it('四档强度按从低到高排列', () => {
    expect(thinkingLevels).toEqual(['off', 'low', 'medium', 'high'])
  })
})
