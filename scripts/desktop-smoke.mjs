import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const entry = resolve('out/main/index.js')

if (!existsSync(entry)) {
  console.error('未找到构建产物 out/main/index.js，请先执行 npm run build')
  process.exit(1)
}

const child = spawn(electron, ['.'], {
  env: { ...process.env, CUBEX_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
const collect = (chunk) => { output += chunk.toString() }
child.stdout.on('data', collect)
child.stderr.on('data', collect)

const timer = setTimeout(() => {
  console.error('冒烟超时：应用未在 45 秒内报告就绪并退出')
  child.kill()
  process.exit(1)
}, 45_000)

child.on('exit', (code) => {
  clearTimeout(timer)
  const ready = output.includes('[cubex] smoke-ready')
  console.log(output.trim())
  if (code === 0 && ready) {
    console.log('桌面冒烟通过：窗口已创建并正常退出')
    process.exit(0)
  }
  console.error(`桌面冒烟失败：exit=${code} ready=${ready}`)
  process.exit(1)
})
