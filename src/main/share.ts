import { BrowserWindow, type NativeImage } from 'electron'
import type { Thread } from '../shared/schema'

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

function renderText(text: string): string {
  const parts = text.split(/```[^\n]*\n?/)
  return parts.map((part, index) => index % 2 === 1
    ? `<pre>${escapeHtml(part.replace(/\n$/, ''))}</pre>`
    : part.trim() ? `<p>${escapeHtml(part.trim()).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')}</p>` : '').join('')
}

export function threadToShareHtml(thread: Thread, projectName: string): string {
  const blocks: string[] = []
  for (const message of thread.messages) {
    if (message.role === 'user') blocks.push(`<section class="user"><div class="who">你</div>${renderText(message.content.slice(0, 6000))}</section>`)
    else if (message.role === 'assistant') {
      const tools = message.toolCalls.map((call) => `<span class="tool">${escapeHtml(call.name)}</span>`).join('')
      if (message.content.trim() || tools) blocks.push(`<section class="ai"><div class="who">Cubex</div>${renderText(message.content.slice(0, 12000))}${tools ? `<div class="tools">${tools}</div>` : ''}</section>`)
    } else if (message.role === 'system' && message.level === 'error') blocks.push(`<section class="err">${escapeHtml(message.content)}</section>`)
  }
  const date = new Date(thread.updatedAt).toLocaleString('zh-CN')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6ee;font:15px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#1f2a1c}
.card{margin:28px;background:#fff;border-radius:18px;box-shadow:0 8px 30px rgba(60,90,40,.12);overflow:hidden}
header{padding:22px 28px;background:linear-gradient(135deg,#7fa35a,#5d8a3a);color:#fff}header h1{margin:0;font-size:20px;font-weight:600}header p{margin:6px 0 0;opacity:.85;font-size:13px}
main{padding:18px 28px 8px}section{margin:0 0 16px;padding:12px 16px;border-radius:12px}.who{font-size:12px;font-weight:600;margin-bottom:4px;letter-spacing:.04em}
.user{background:#eef4e6;margin-left:60px}.user .who{color:#5d8a3a}.ai{background:#fafbf8;border:1px solid #e6ecdf;margin-right:60px}.ai .who{color:#c8453b}
.err{background:#fdecea;color:#a3312a;font-size:13px}p{margin:4px 0;white-space:pre-wrap;word-break:break-word}
pre{background:#1f2a1c;color:#e8f0dc;padding:10px 12px;border-radius:8px;font:12.5px/1.5 Consolas,monospace;white-space:pre-wrap;word-break:break-all;margin:8px 0}
code{background:#eef2e8;padding:1px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:13px}.tools{margin-top:6px}.tool{display:inline-block;font-size:11px;color:#5d8a3a;border:1px solid #cfdcbf;border-radius:999px;padding:1px 8px;margin:2px 4px 0 0}
footer{padding:12px 28px 20px;color:#8a9780;font-size:12px;display:flex;justify-content:space-between}footer b{color:#c8453b}
</style></head><body><div class="card"><header><h1>${escapeHtml(thread.title)}</h1><p>${escapeHtml(projectName)} · ${escapeHtml(date)}</p></header><main>${blocks.join('') || '<p>（空对话）</p>'}</main><footer><span>由 <b>Cubex</b>Desktop 生成</span><span>${thread.messages.length} 条消息</span></footer></div></body></html>`
}

export async function renderShareImage(html: string): Promise<NativeImage> {
  const win = new BrowserWindow({
    width: 860,
    height: 600,
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'cubex-share' },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const height = Number(await win.webContents.executeJavaScript('document.documentElement.scrollHeight')) || 600
    win.setContentSize(860, Math.min(Math.max(height, 200), 8_000))
    await new Promise((resolve) => setTimeout(resolve, 250))
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error('生成图片失败：页面未能渲染')
    return image
  } finally {
    win.destroy()
  }
}
