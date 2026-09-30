import { _electron as electron } from '@playwright/test'
import { join } from 'node:path'

const dir = join(process.env.TEMP, 'cubex-repro')
const app = await electron.launch({ args: ['.', `--user-data-dir=${dir}`], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } })
const userData = await app.evaluate(({ app }) => app.getPath('userData'))
console.log('userData', userData)
if (!userData.toLowerCase().includes('cubex-repro')) { console.log('userData 不是副本目录，终止'); await app.close(); process.exit(1) }
const page = await app.firstWindow()
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
await page.waitForSelector('.shell')
await page.waitForTimeout(1500)
console.log('hasBridge', await page.evaluate(() => Boolean(window.cubex)))
const state = await page.evaluate(() => window.cubex.getState())
console.log('state.ok', state.ok, state.ok ? JSON.stringify(state.data.settings.providers) : state.error)
if (state.ok && state.data.settings.models[0]) {
  const m = state.data.settings.models.find((x) => x.id === state.data.settings.defaultModelId) ?? state.data.settings.models[0]
  const p = state.data.settings.providers.find((x) => x.id === m.providerId)
  console.log('testConnection', JSON.stringify(await page.evaluate(({ p, m }) => window.cubex.testConnection({ provider: p, model: m }), { p, m })))
}
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.settings-page')
console.log('settings: sidebar hidden', await page.locator('aside.sidebar').count() === 0, '| nav', (await page.locator('.settings-nav nav').innerText()).replace(/\n/g, ' '))
await page.screenshot({ path: join(dir, 'settings.png') })
await page.keyboard.press('Escape')
await page.waitForSelector('aside.sidebar')
const box = page.getByLabel('消息')
console.log('textarea disabled', await box.isDisabled())
await box.fill('读取 input.txt 并告诉我里面的数字')
console.log('send disabled', await page.getByLabel('发送').isDisabled())
await box.press('Enter')
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000)
  const text = await page.locator('.notifications').innerText().catch(() => '')
  const msgs = await page.locator('.msg').allInnerTexts()
  if (text || msgs.length > 2) console.log(i, 'notice:', text, '| msgs:', msgs.map((m) => m.slice(0, 120).replace(/\n/g, ' ')))
  const s = await page.evaluate(() => window.cubex.getState())
  const t = s.data.threads.at(-1)
  if (t && t.status === 'idle' && t.messages.length > 1) break
}
const final = await page.evaluate(() => window.cubex.getState())
console.log(JSON.stringify(final.data.threads.map((t) => t.messages.map((m) => ({ role: m.role, c: (m.content ?? '').slice(0, 200), tools: m.toolCalls?.map((x) => x.name), r: m.results?.map((x) => x.output.slice(0, 100)) }))), null, 1))
await app.close()
