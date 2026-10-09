import { spawn } from 'node:child_process'

const psQuote = (text: string) => `'${text.replace(/'/g, "''")}'`

// 与用户桌面完全隔离的 Windows 桌面名称；电脑操控的独立桌面模式在这里创建和销毁。
export const ISOLATED_DESKTOP_NAME = 'CubexAgent'

export interface Bounds { x: number; y: number; width: number; height: number }

export interface DesktopAvailability {
  supported: boolean
  reason?: string
}

export interface DesktopWindow {
  handle: string
  title: string
  x: number
  y: number
  width: number
}

// PowerShell 的 Add-Type 对可选字符串指针必须用 [NullString]::Value：直接传 $null 会被当成空字符串，
// 导致 CreateDesktop/CreateProcess 返回 ERROR_INVALID_PARAMETER（实测 87）。
const NULL_DEVICE = '[NullString]::Value'

const PInvokeCore = (name: string) => `
using System;
using System.Runtime.InteropServices;
public static class ${name} {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateDesktop(String desktop, String device, IntPtr devmode, int flags, uint access, IntPtr attrs);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool CloseDesktop(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr OpenDesktop(String desktop, int flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindowsProc cb, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(String cls, String title);
  [DllImport("kernel32.dll")] public static extern uint GetLastError();
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
`

// 截屏需要的 GDI 函数单独声明：gdi32.dll，误放到 user32.dll 会在调用时报入口点不存在。
const PInvokeGdi = (name: string) => `
public static class ${name}Gdi {
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateDC(String driver, String device, String output, IntPtr init);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
}
`

const ps = (script: string, timeoutMs = 60_000): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + script], { windowsHide: true })
  let output = ''
  let settled = false
  const timer = setTimeout(() => { if (settled) return; settled = true; child.kill(); reject(new Error(`PowerShell 超时（${Math.round(timeoutMs / 1000)} 秒）`)) }, timeoutMs)
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.on('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error) })
  child.on('close', (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (code === 0) resolve(output.trim())
    else reject(new Error(output.trim().slice(0, 800) || `PowerShell 退出码 ${code}`))
  })
})

/** 当前桌面是否支持隔离桌面（仅 Windows；无交互桌面的会话不可用） */
export function isolatedDesktopSupported(): DesktopAvailability {
  if (process.platform !== 'win32') return { supported: false, reason: '独立桌面目前仅支持 Windows' }
  if (process.env.SESSIONNAME?.toLowerCase().includes('services')) return { supported: false, reason: '当前会话没有可用交互桌面' }
  return { supported: true }
}

/**
 * 检测用户是否正在使用键鼠（GetLastInputInfo），返回距今秒数；失败返回 0（视作用户空闲）。
 */
export async function userIdleSeconds(): Promise<number> {
  if (process.platform !== 'win32') return 0
  const script = `
$sig = '[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }'
Add-Type -MemberDefinition $sig -Name Idle -Namespace Cubex -ErrorAction SilentlyContinue
$info = New-Object Cubex.Idle+LASTINPUTINFO
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
if ([Cubex.Idle]::GetLastInputInfo([ref]$info)) { Write-Output ([int](([Environment]::TickCount - $info.dwTime) / 1000)) } else { Write-Output 0 }
`
  try {
    const value = Number(await ps(script, 15_000))
    return Number.isFinite(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/** 等待用户空闲；返回实际等待的秒数。idleWaitSec 为 0 表示不等。 */
export async function waitForUserIdle(idleWaitSec: number): Promise<number> {
  if (idleWaitSec <= 0) return 0
  let waited = 0
  while (waited < idleWaitSec) {
    const idle = await userIdleSeconds()
    if (idle >= 0.6) return waited
    await new Promise((resolve) => setTimeout(resolve, 600))
    waited += 0.6
  }
  return waited
}

const desktopScript = (name: string) => `
$sig = @'
${PInvokeCore('Desk')}${PInvokeGdi('Desk')}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing,System.Windows.Forms -ErrorAction Stop
$name = ${psQuote(name)}
$handle = [Desk]::CreateDesktop($name, ${NULL_DEVICE}, [IntPtr]::Zero, 0, [uint32]0x02000000, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::Zero) { throw ("CreateDesktop failed: " + [Desk]::GetLastError()) }
$dc = [DeskGdi]::CreateDC("DISPLAY", ${NULL_DEVICE}, ${NULL_DEVICE}, [IntPtr]::Zero)
$w = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
$h = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
$mem = [DeskGdi]::CreateCompatibleDC($dc)
$bmp = [DeskGdi]::CreateCompatibleBitmap($dc, $w, $h)
$old = [DeskGdi]::SelectObject($mem, $bmp)
[DeskGdi]::BitBlt($mem, 0, 0, $w, $h, $dc, 0, 0, 0x00CC0020) | Out-Null
[DeskGdi]::SelectObject($mem, $old)
$image = [System.Drawing.Image]::FromHbitmap($bmp)
$png = Join-Path $env:TEMP ("cubex-desktop-" + [Guid]::NewGuid().ToString("N") + ".png")
$image.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$image.Dispose()
[DeskGdi]::DeleteObject($bmp) | Out-Null
[DeskGdi]::DeleteDC($mem) | Out-Null
[Desk]::ReleaseDC([IntPtr]::Zero, $dc) | Out-Null
[Desk]::CloseDesktop($handle) | Out-Null
$windows = @()
$script:found = @()
$cb = [Desk+EnumWindowsProc]{ param($hwnd, $param) $script:found += $hwnd; return $true }
$handle = [Desk]::CreateDesktop($name, ${NULL_DEVICE}, [IntPtr]::Zero, 0, [uint32]0x02000000, [IntPtr]::Zero)
[Desk]::EnumDesktopWindows($handle, $cb, [IntPtr]::Zero) | Out-Null
foreach ($hwnd in $script:found) {
  if (-not [Desk]::IsWindowVisible($hwnd)) { continue }
  $title = New-Object System.Text.StringBuilder 512
  [void][Desk]::GetWindowText($hwnd, $title, 512)
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($title.ToString()))
  $rect = New-Object Desk+RECT
  if ([Desk]::GetWindowRect($hwnd, [ref]$rect)) {
    $windows += ("{0}|{1}|{2}|{3}|{4}" -f $hwnd.ToInt64(), $encoded, $rect.Left, $rect.Top, ($rect.Right - $rect.Left))
  }
}
[Desk]::CloseDesktop($handle) | Out-Null
ConvertTo-Json @{ png = $png; width = $w; height = $h; windows = $windows }
`

/** 创建独立桌面并截取画面，返回 PNG 路径、尺寸与该桌面上的窗口列表 */
export async function captureIsolatedDesktop(name = ISOLATED_DESKTOP_NAME): Promise<{ png: string; width: number; height: number; windows: DesktopWindow[] }> {
  const output = await ps(desktopScript(name), 45_000)
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('无法读取独立桌面画面')
  const parsed = JSON.parse(output.slice(start, end + 1)) as { png?: string; width?: number; height?: number; windows?: string[] }
  const windows = (parsed.windows ?? []).map((line) => {
    const [handle, encoded, x, y, width] = String(line).split('|')
    return { handle, title: Buffer.from(encoded ?? '', 'base64').toString('utf8'), x: Number(x), y: Number(y), width: Number(width) }
  })
  return { png: parsed.png ?? '', width: Number(parsed.width ?? 0), height: Number(parsed.height ?? 0), windows }
}

const launchScript = (name: string, commandLine: string) => `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Launch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
$si = New-Object Launch+STARTUPINFO
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpDesktop = ${psQuote(name)}
$pi = New-Object Launch+PROCESS_INFORMATION
$cmd = ${psQuote(commandLine)}
if (-not [Launch]::CreateProcess(${NULL_DEVICE}, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, ${NULL_DEVICE}, [ref]$si, [ref]$pi)) { throw ("Launch failed: " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
Write-Output $pi.dwProcessId
`

/** 在独立桌面上启动程序（例如浏览器、记事本），返回进程 ID */
export async function launchOnIsolatedDesktop(command: string, args = '', name = ISOLATED_DESKTOP_NAME): Promise<number> {
  const cleaned = args.replace(/"/g, '').trim()
  const commandLine = cleaned ? `${command} "${cleaned}"` : command
  const output = await ps(launchScript(name, commandLine), 30_000)
  return Number(output.trim().split('\n').pop()) || 0
}

const KEY_CODES: Record<string, number> = { enter: 13, tab: 9, esc: 27, escape: 27, backspace: 8, delete: 46, space: 32, left: 37, up: 38, right: 39, down: 40, home: 36, end: 35, pageup: 33, pagedown: 34, f5: 116 }

const keyCodesPs = () => `@{ ${Object.entries(KEY_CODES).map(([key, code]) => `${psQuote(key)} = ${code}`).join('; ')} }`

const inputScript = (name: string, kind: 'pointer' | 'text' | 'key', payload: Record<string, unknown>) => `
$sig = @'
${PInvokeCore('Ptr')}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
$handle = [Ptr]::CreateDesktop(${psQuote(name)}, ${NULL_DEVICE}, [IntPtr]::Zero, 0, [uint32]0x02000000, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::Zero) { throw ("CreateDesktop failed: " + [Ptr]::GetLastError()) }
$wanted = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(${psQuote(String(payload.title ?? ''))}))
$script:found = [IntPtr]::Zero
$cb = [Ptr+EnumWindowsProc]{ param($hwnd, $param)
  $builder = New-Object System.Text.StringBuilder 512
  [void][Ptr]::GetWindowText($hwnd, $builder, 512)
  if ([Ptr]::IsWindowVisible($hwnd)) {
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($builder.ToString()))
    if ($encoded -eq $wanted -and $script:found -eq [IntPtr]::Zero) { $script:found = $hwnd }
  }
  return $true
}
[void][Ptr]::EnumDesktopWindows($handle, $cb, [IntPtr]::Zero)
$hwnd = $script:found
if ($hwnd -eq [IntPtr]::Zero) { [void][Ptr]::CloseDesktop($handle); throw "在独立桌面上找不到标题匹配的窗口，请先用 screenshot 确认窗口标题" }
$rect = New-Object Ptr+RECT
[void][Ptr]::GetWindowRect($hwnd, [ref]$rect)
${kind === 'pointer' ? `
$x = ${Number(payload.x ?? 0)}; $y = ${Number(payload.y ?? 0)}
$lParam = [IntPtr]((($y - $rect.Top) -shl 16) -bor (($x - $rect.Left) -band 0xFFFF))
$down = ${payload.right === true ? '0x0008' : '0x0002'}
$up = ${payload.right === true ? '0x0010' : '0x0004'}
$count = ${Math.max(1, Math.min(3, Number(payload.clicks ?? 1)))}
for ($index = 0; $index -lt $count; $index++) {
  [void][Ptr]::PostMessage($hwnd, 0x0201, [IntPtr]1, $lParam)
  Start-Sleep -Milliseconds ${Math.max(0, Math.min(10_000, Number(payload.hold ?? 0)))}
  [void][Ptr]::PostMessage($hwnd, 0x0202, [IntPtr]0, $lParam)
  if ($count -gt 1) { Start-Sleep -Milliseconds 80 }
}
` : kind === 'text' ? `
$text = ${psQuote(String(payload.text ?? ''))}
foreach ($character in $text.ToCharArray()) {
  [void][Ptr]::PostMessage($hwnd, 0x0102, [IntPtr][int]$character, [IntPtr]1)
}
` : `
$KEY_CODES = ${keyCodesPs()}
$keys = ${psQuote(String(payload.keys ?? ''))}
$parts = $keys -split '[+ ]+' | Where-Object { $_ -ne '' }
$codes = @()
foreach ($part in $parts) {
  $key = $part.Trim().ToLower()
  if ($KEY_CODES.ContainsKey($key)) { $codes += $KEY_CODES[$key] }
  elseif ($part.Length -eq 1) { $codes += [int][char]$part.ToUpper() }
  else { throw ("unsupported key: " + $part) }
}
foreach ($code in $codes) { [void][Ptr]::PostMessage($hwnd, 0x0100, [IntPtr]$code, [IntPtr]0) }
foreach ($code in ($codes[$($codes.Count - 1)..0])) { [void][Ptr]::PostMessage($hwnd, 0x0101, [IntPtr]$code, [IntPtr]0) }
`}
[void][Ptr]::CloseDesktop($handle)
Write-Output ok
`

/** 在独立桌面内对标题匹配的窗口执行点击；坐标为截屏坐标系（屏幕坐标） */
export async function clickIsolatedDesktop(title: string, x: number, y: number, options: { holdMs?: number; right?: boolean; double?: boolean } = {}, name = ISOLATED_DESKTOP_NAME): Promise<void> {
  await ps(inputScript(name, 'pointer', { title, x, y, hold: options.holdMs ?? 0, right: options.right === true, clicks: options.double ? 2 : 1 }), 20_000)
}

/** 在独立桌面内把文本输入到标题匹配的窗口（逐字符 WM_CHAR） */
export async function typeIsolatedDesktop(title: string, text: string, name = ISOLATED_DESKTOP_NAME): Promise<void> {
  await ps(inputScript(name, 'text', { title, text }), 20_000)
}

/** 在独立桌面内向标题匹配的窗口发送按键，支持 ctrl+a 这类组合 */
export async function keyIsolatedDesktop(title: string, keys: string, name = ISOLATED_DESKTOP_NAME): Promise<void> {
  await ps(inputScript(name, 'key', { title, keys }), 20_000)
}

/** 关闭（销毁）独立桌面；桌面不存在时静默返回 */
export async function closeIsolatedDesktop(name = ISOLATED_DESKTOP_NAME): Promise<void> {
  const script = `
$sig = '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr OpenDesktop(String d, int f, bool i, uint a); [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);'
Add-Type -MemberDefinition $sig -Name D -Namespace Cubex -ErrorAction SilentlyContinue
$handle = [Cubex.D]::OpenDesktop(${psQuote(name)}, 0, $false, [uint32]0x02000000)
if ($handle -ne [IntPtr]::Zero) { [void][Cubex.D]::CloseDesktop($handle); Write-Output ok } else { Write-Output none }
`
  await ps(script, 15_000).catch(() => undefined)
}
