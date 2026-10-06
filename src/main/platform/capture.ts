// Wayland 下 desktopCapturer 依赖 ScreenCast portal，实测本机故障（SPEC-001 T7），保守判定为不可用。
export function desktopCaptureSupported(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return true
  if (process.platform === 'linux') return process.env.XDG_SESSION_TYPE === 'x11'
  return false
}
