import { _electron as electron } from '@playwright/test'
import { cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = join(tmpdir(), 'cubex-repro')
const dir = join(tmpdir(), 'cubex-ui')
await rm(dir, { recursive: true, force: true })
await cp(source, dir, { recursive: true })
const app = await electron.launch({ args: ['.', `--user-data-dir=${dir}`] })
const userData = await app.evaluate(({ app }) => app.getPath('userData'))
if (!userData.toLowerCase().includes('cubex-ui')) { console.log('userData 不是副本目录，终止'); await app.close(); process.exit(1) }
const page = await app.firstWindow()
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
await page.waitForSelector('.shell')
await page.waitForTimeout(800)
const state = async () => (await page.evaluate(() => window.cubex.getState())).data
const log = (...args) => console.log(...args)

log('frame 控制按钮', await page.locator('.window-controls button').count())
await page.screenshot({ path: join(dir, '1-home.png') })

const first = await state()
log('项目数', first.projects.length, '任务数', first.threads.length)
const projectRow = page.locator('.project-row').first()
await projectRow.hover()
await projectRow.getByLabel(/中新建任务/).click().catch(() => log('项目新建任务按钮不可用'))
await page.getByLabel('消息').fill('# 标题\n\n- 列表')
log('输入区可用')

const thread = first.threads[0]
if (thread) {
  await page.locator('.thread-item').first().click({ button: 'right' })
  await page.waitForSelector('.menu')
  log('任务菜单', (await page.locator('.menu').innerText()).replace(/\n/g, ' | '))
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, '2-thread-menu.png') })
  await page.getByRole('menuitem', { name: /置顶/ }).click()
  await page.waitForTimeout(300)
  log('置顶任务数', (await state()).threads.filter((t) => t.pinned).length)

  await page.locator('.thread-item').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await page.locator('.dialog-input').fill('改名测试')
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, '3-rename.png') })
  await page.locator('.dialog-input').press('Enter')
  await page.waitForTimeout(300)
  log('重命名成功', (await state()).threads.some((t) => t.title === '改名测试'))

  await page.locator('.thread-item').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '删除任务' }).click()
  if (await page.locator('.dialog').count()) {
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, '4-confirm.png') })
    await page.locator('.dialog-actions .btn-danger').click()
  }
  await page.waitForTimeout(400)
  log('删除后任务数', (await state()).threads.length, '原', first.threads.length)
  log('toast', await page.locator('.toast-stack').innerText().catch(() => ''))
}

const project = (await state()).projects[0]
if (project) {
  await page.locator('.project-row').first().click({ button: 'right' })
  await page.waitForSelector('.menu')
  log('项目菜单', (await page.locator('.menu').innerText()).replace(/\n/g, ' | '))
  await page.getByRole('menuitem', { name: '归档' }).click()
  await page.waitForTimeout(400)
  log('归档后', (await state()).projects.find((p) => p.id === project.id)?.archived)
  await page.screenshot({ path: join(dir, '5-archived.png') })
}

const remaining = (await state()).projects.filter((p) => !p.archived)
if (remaining[0]) {
  await page.locator('.project-row').first().click({ button: 'right' })
  await page.waitForSelector('.menu')
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: '移除项目' }).click()
  if (await page.locator('.dialog').count()) await page.locator('.dialog-actions .btn-danger').click()
  await page.waitForTimeout(400)
  log('移除后项目仍存在', (await state()).projects.some((p) => p.id === remaining[0].id))
}

await page.getByLabel('最大化').click().catch(() => log('无最大化按钮'))
await page.waitForTimeout(400)
log('已最大化', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
await app.close()
