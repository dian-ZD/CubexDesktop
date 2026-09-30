import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolCall } from '../src/shared/schema'
import { makeDiff, resolveInside, runTool } from '../src/main/tools'

let root: string
const signal = new AbortController().signal
const call = (name: ToolCall['name'], args: Record<string, unknown>): ToolCall => ({ id: `c-${name}`, name, args })
const run = (name: ToolCall['name'], args: Record<string, unknown>) => runTool(call(name, args), { root, signal })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubex-tools-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'const a = 1\nconst b = 2\nexport { a, b }\n', 'utf8')
})

describe('路径边界', () => {
  it('允许项目内路径与以 .. 开头的普通文件名', async () => {
    await expect(resolveInside(root, 'src/a.ts')).resolves.toBe(join(root, 'src', 'a.ts'))
    await expect(resolveInside(root, '..notes.md')).resolves.toBe(join(root, '..notes.md'))
  })

  it('拒绝越界、绝对路径与凭据文件', async () => {
    await expect(resolveInside(root, '../x.txt')).rejects.toThrow('越出')
    await expect(resolveInside(root, join(tmpdir(), 'x.txt'))).rejects.toThrow('越出')
    await expect(resolveInside(root, '.env')).rejects.toThrow('凭据')
    await expect(resolveInside(root, '')).rejects.toThrow('不能为空')
  })

  it('拒绝通过符号链接越出项目', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cubex-outside-'))
    try {
      await symlink(outside, join(root, 'link'), 'junction')
    } catch {
      return
    }
    await expect(resolveInside(root, 'link/secret.txt')).rejects.toThrow('链接')
  })
})

describe('文件工具', () => {
  it('read_file 返回带行号片段', async () => {
    const result = await run('read_file', { path: 'src/a.ts', start: 2, limit: 1 })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('    2| const b = 2')
    expect(result.output).not.toContain('const a = 1')
  })

  it('list_directory 与 search_files', async () => {
    const list = await run('list_directory', {})
    expect(list.output).toContain('src/a.ts')
    const search = await run('search_files', { pattern: 'const b', glob: '.ts' })
    expect(search.output).toBe('src/a.ts:2: const b = 2')
    const bad = await run('search_files', { pattern: '(' })
    expect(bad.ok).toBe(false)
  })

  it('write_file 创建目录并返回 diff', async () => {
    const result = await run('write_file', { path: 'new/b.txt', content: 'hello' })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('已创建')
    expect(result.diff).toContain('+hello')
    expect(await readFile(join(root, 'new', 'b.txt'), 'utf8')).toBe('hello')
  })

  it('edit_file 只替换唯一片段', async () => {
    const result = await run('edit_file', { path: 'src/a.ts', old_text: 'const b = 2', new_text: 'const b = 3' })
    expect(result.ok).toBe(true)
    expect(result.diff).toContain('-const b = 2')
    expect(result.diff).toContain('+const b = 3')
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toContain('const b = 3')

    const missing = await run('edit_file', { path: 'src/a.ts', old_text: 'nope', new_text: 'x' })
    expect(missing.ok).toBe(false)
    const duplicate = await run('edit_file', { path: 'src/a.ts', old_text: 'const', new_text: 'let' })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.output).toContain('多次')
  })

  it('越界写入失败且不落盘', async () => {
    const result = await run('write_file', { path: '../escape.txt', content: 'x' })
    expect(result.ok).toBe(false)
    await expect(readFile(join(root, '..', 'escape.txt'), 'utf8')).rejects.toThrow()
  })
})

describe('run_command', () => {
  it('在项目根目录执行并返回退出码', async () => {
    const result = await run('run_command', { command: 'node -e "process.stdout.write(process.cwd())"' })
    expect(result.ok).toBe(true)
    expect(result.output.toLowerCase()).toContain(root.toLowerCase())
    expect(result.output).toContain('[退出码 0]')
  }, 20_000)

  it('取消时终止进程', async () => {
    const controller = new AbortController()
    const pending = runTool(call('run_command', { command: 'node -e "setTimeout(() => {}, 30000)"' }), { root, signal: controller.signal })
    setTimeout(() => controller.abort(), 500)
    const result = await pending
    expect(result.output).toContain('用户取消')
  }, 20_000)
})

describe('makeDiff', () => {
  it('只输出变化区域与上下文', () => {
    const diff = makeDiff('f', 'a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\nE\nf\ng\nh')
    expect(diff.split('\n')).toEqual(['--- a/f', '+++ b/f', '@@ -2,7 +2,7 @@', ' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h'])
  })
})
