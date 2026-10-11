import { execFile } from 'node:child_process'

// Windows 11 DWM 原生圆角：frameless 窗口默认没有系统圆角（Electron 的 roundedCorners 选项仅 macOS 有效），
// 通过 DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2) 开启。
// 对不透明窗口也生效，不影响 shell 对全屏/任务栏的判定；Win10 上调用失败静默忽略。
const DWM_SCRIPT = [
  "Add-Type -Namespace Cubex -Name Dwm -MemberDefinition '[DllImport(\"dwmapi.dll\")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);'",
  '[void][Cubex.Dwm]::DwmSetWindowAttribute([IntPtr]::new(%HWND%), 33, [ref]2, 4)',
].join('; ')

export function applyNativeRoundedCorners(win: { getNativeWindowHandle: () => Buffer } | null | undefined): void {
  if (process.platform !== 'win32' || !win) return
  try {
    const buffer = win.getNativeWindowHandle()
    const hwnd = process.arch === 'x64' || process.arch === 'arm64' ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))
    if (!hwnd) return
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DWM_SCRIPT.replace('%HWND%', hwnd.toString())], { windowsHide: true, timeout: 15_000 }, () => { /* 失败（如 Win10）保持方角 */ })
  } catch { /* 忽略 */ }
}
