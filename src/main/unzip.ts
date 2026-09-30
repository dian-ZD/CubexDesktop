import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

function findEndRecord(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

export function unzip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndRecord(buffer)
  if (eocd < 0) throw new Error('无效的 zip 文件')
  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else continue
    if (!name.endsWith('/')) entries.push({ name, data })
  }
  return entries
}
