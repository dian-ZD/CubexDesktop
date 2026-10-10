// 英文词典动态入口：切到 en 时才 import（词典本体在 phrases.ts，约 89KB），
// zh-CN 用户永不加载。注册完成后字典常驻内存，后续切换零开销。
import { registerPhrases } from './i18n'

let loading: Promise<void> | undefined

export function loadEnglishPhrases(): Promise<void> {
  loading ??= import('./phrases').then((mod) => {
    for (const group of mod.phraseGroups) registerPhrases(group)
  })
  return loading
}
