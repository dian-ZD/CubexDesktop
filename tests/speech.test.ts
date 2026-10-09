import { describe, expect, it } from 'vitest'
import { prepareAudio, stripHallucination } from '../src/renderer/src/speech'

const tone = (rate: number, seconds: number, amplitude: number, frequency = 220): Float32Array => {
  const samples = new Float32Array(Math.round(rate * seconds))
  for (let index = 0; index < samples.length; index++) samples[index] = Math.sin((index / rate) * frequency * Math.PI * 2) * amplitude
  return samples
}

const rms = (samples: Float32Array) => {
  let sum = 0
  for (const value of samples) sum += value * value
  return Math.sqrt(sum / Math.max(1, samples.length))
}

describe('语音输入预处理', () => {
  it('去掉首尾静音并把电平归一化到约 -3 dBFS', () => {
    const rate = 16_000
    const audio = new Float32Array(rate * 4)
    audio.set(tone(rate, 1.2, 0.05), Math.round(rate * 1.4))
    const prepared = prepareAudio(audio, rate)
    expect(prepared.samples.length).toBeGreaterThan(Math.round(rate * 1.0))
    expect(prepared.samples.length).toBeLessThan(Math.round(rate * 2.0))
    expect(Math.max(...prepared.samples)).toBeLessThanOrEqual(1)
    expect(Math.max(...prepared.samples)).toBeGreaterThanOrEqual(0.19)
    expect(rms(prepared.samples)).toBeGreaterThan(rms(audio) * 3)
  })

  it('接近静音的录音返回空样本，由上层提示没有识别到内容', () => {
    const quiet = prepareAudio(tone(16_000, 2, 1e-6), 16_000)
    expect(quiet.samples.length).toBe(0)
    expect(prepareAudio(new Float32Array(16_000 * 0.05), 16_000).samples.length).toBe(0)
  })

  it('极短的有效语音也返回样本', () => {
    const prepared = prepareAudio(tone(16_000, 0.6, 0.2), 16_000)
    expect(prepared.samples.length).toBeGreaterThan(16_000 * 0.4)
  })
})

describe('语音幻觉过滤', () => {
  it('整段是幻觉短语时返回空', () => {
    for (const text of ['（音乐）', '(音乐)', '音乐', '谢谢观看', 'Thanks for watching', '  （音乐）  ']) {
      expect(stripHallucination(text), text).toBe('')
    }
  })

  it('真实识别文本原样保留', () => {
    expect(stripHallucination('  今天天气不错，我们出去走走吧  ')).toBe('今天天气不错，我们出去走走吧')
    expect(stripHallucination('')).toBe('')
  })
})
