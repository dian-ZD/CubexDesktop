import { app, nativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'build', 'logo-source.png')
const rendererAsset = join(root, 'src', 'renderer', 'src', 'assets', 'logo.png')
const rendererPublic = join(root, 'src', 'renderer', 'public', 'logo.png')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) {
    console.error(`无法读取源图：${source}`)
    app.exit(1)
    return
  }
  const { width, height } = image.getSize()
  console.log(`源图尺寸：${width}x${height}`)

  await mkdir(join(root, 'build'), { recursive: true })
  await mkdir(dirname(rendererAsset), { recursive: true })
  await mkdir(dirname(rendererPublic), { recursive: true })

  // 应用图标：白色圆角底 + 内边距 logo；PNG（512）+ 多尺寸 ICO
  await writeFile(join(root, 'build', 'icon.png'), roundedIcon(image, 512).toPNG())
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = sizes.map((s) => ({ size: s, buffer: roundedIcon(image, s).toPNG() }))
  await writeFile(join(root, 'build', 'icon.ico'), buildIco(entries))

  // 界面 logo：保留原始透明 logo（应用内是否加白底由 Logo 组件控制）
  await writeFile(rendererAsset, image.resize({ width: 256, height: 256, quality: 'best' }).toPNG())
  await writeFile(rendererPublic, image.resize({ width: 256, height: 256, quality: 'best' }).toPNG())

  console.log('OK: build/icon.png + build/icon.ico（白色圆角底）+ renderer logo.png 已生成')
  app.quit()
})

// 生成尺寸为 size 的方形图标：白色圆角背景 + 居中带内边距的 logo（alpha 合成）
function roundedIcon(image, size) {
  const radius = Math.round(size * 0.22)
  const pad = Math.round(size * 0.14)
  const inner = size - pad * 2

  const bg = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const a = roundedAlpha(x, y, size, size, radius)
      // nativeImage bitmap 为 BGRA
      bg[i] = 255
      bg[i + 1] = 255
      bg[i + 2] = 255
      bg[i + 3] = a
    }
  }

  const logo = image.resize({ width: inner, height: inner, quality: 'best' })
  const logoBmp = logo.toBitmap()
  const ls = logo.getSize()
  const lw = ls.width
  const lh = ls.height
  const offX = Math.round((size - lw) / 2)
  const offY = Math.round((size - lh) / 2)

  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const si = (y * lw + x) * 4
      const dx = offX + x
      const dy = offY + y
      if (dx < 0 || dy < 0 || dx >= size || dy >= size) continue
      const di = (dy * size + dx) * 4
      const sa = logoBmp[si + 3] / 255
      if (sa <= 0) continue
      const da = bg[di + 3] / 255
      const outA = sa + da * (1 - sa)
      for (let c = 0; c < 3; c++) {
        const sc = logoBmp[si + c]
        const dc = bg[di + c]
        bg[di + c] = outA <= 0 ? 0 : Math.round((sc * sa + dc * da * (1 - sa)) / outA)
      }
      bg[di + 3] = Math.round(outA * 255)
    }
  }

  return nativeImage.createFromBitmap(bg, { width: size, height: size })
}

// 圆角矩形覆盖的抗锯齿 alpha（0-255）
function roundedAlpha(x, y, w, h, r) {
  const cx = x + 0.5
  const cy = y + 0.5
  // 位于四条直边区域内：完全不透明
  if ((cx >= r && cx <= w - r) || (cy >= r && cy <= h - r)) return 255
  // 位于四个圆角：按到圆心的距离做抗锯齿
  const nx = cx < r ? r - cx : cx - (w - r)
  const ny = cy < r ? r - cy : cy - (h - r)
  const edge = r - Math.sqrt(nx * nx + ny * ny)
  if (edge >= 0.5) return 255
  if (edge <= -0.5) return 0
  return Math.round((edge + 0.5) * 255)
}

function buildIco(list) {
  const count = list.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const bodies = []
  list.forEach((e, i) => {
    const b = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1)
    dir.writeUInt16LE(1, b + 4)
    dir.writeUInt16LE(32, b + 6)
    dir.writeUInt32LE(e.buffer.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += e.buffer.length
    bodies.push(e.buffer)
  })
  return Buffer.concat([header, dir, ...bodies])
}
