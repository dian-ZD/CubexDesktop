import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { GithubPushResult, Settings } from '../shared/schema'
import { killTree, spawnDetached } from './platform/proc'

const API = 'https://api.github.com'

type GitResult = { code: number | null; output: string }

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true, detached: spawnDetached })
    let output = ''
    const push = (chunk: Buffer) => { if (output.length < 20_000) output += chunk.toString('utf8') }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    const kill = () => killTree(child)
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    const finish = (code: number | null, extra = '') => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      resolvePromise({ code, output: output + extra })
    }
    child.on('error', (error) => finish(null, `无法启动 git：${error.message}（请确认已安装 Git 并加入 PATH）`))
    child.on('close', (code) => finish(code))
  })
}

export function repoNameFor(settingsRepo: string, projectPath: string): string {
  const raw = settingsRepo.trim() || basename(projectPath)
  const name = raw.includes('/') ? raw.split('/')[1] : raw
  const cleaned = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
  if (!cleaned) throw new Error('无法从项目目录推断仓库名，请在设置中填写仓库')
  return cleaned
}

async function github<T>(token: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ status: number; data: T }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    signal: signal ?? AbortSignal.timeout(20_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CubexDesktop', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  const data = await response.json().catch(() => ({})) as T
  return { status: response.status, data }
}

export async function verifyGithubToken(token: string): Promise<string> {
  const { status, data } = await github<{ login?: string; message?: string }>(token, '/user')
  if (status === 401) throw new Error('GitHub 令牌无效或已过期')
  if (status !== 200 || !data.login) throw new Error(`GitHub 验证失败（${status}）：${data.message ?? '未知错误'}`)
  return data.login
}

export interface PushOptions {
  token: string
  projectPath: string
  github: Settings['github']
  message?: string
  signal?: AbortSignal
}

export async function pushToGithub(options: PushOptions): Promise<GithubPushResult> {
  const { token, projectPath, github: config, signal } = options
  const log: string[] = []
  const scrub = (text: string) => text.split(token).join('***')
  const login = await verifyGithubToken(token)
  const owner = config.repo.includes('/') ? config.repo.split('/')[0] : login
  const name = repoNameFor(config.repo, projectPath)
  const existing = await github<{ html_url?: string }>(token, `/repos/${owner}/${name}`, {}, signal)
  let htmlUrl = existing.data.html_url ?? `https://github.com/${owner}/${name}`
  if (existing.status === 404) {
    const path = owner === login ? '/user/repos' : `/orgs/${owner}/repos`
    const created = await github<{ html_url?: string; message?: string }>(token, path, { method: 'POST', body: JSON.stringify({ name, private: config.private, auto_init: false }) }, signal)
    if (created.status !== 201) throw new Error(`创建仓库失败（${created.status}）：${created.data.message ?? '未知错误'}`)
    htmlUrl = created.data.html_url ?? htmlUrl
    log.push(`已创建${config.private ? '私有' : '公开'}仓库 ${owner}/${name}`)
  } else if (existing.status !== 200) throw new Error(`查询仓库失败（${existing.status}）`)

  const baseEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const git = async (args: string[], env = baseEnv) => {
    const result = await runGit(projectPath, args, env, signal)
    if (signal?.aborted) throw new Error('已取消')
    return result
  }
  const must = async (args: string[], env = baseEnv) => {
    const result = await git(args, env)
    if (result.code !== 0) throw new Error(`git ${args[0]} 失败：${scrub(result.output).trim().slice(0, 2000)}`)
    return result
  }

  const hasRepo = await stat(join(projectPath, '.git')).then(() => true, () => false)
  if (!hasRepo) {
    await must(['init'])
    await must(['checkout', '-B', config.branch])
    log.push('已初始化本地 Git 仓库')
  }
  const identity = (await git(['config', 'user.email'])).output.trim()
  const commitEnv: NodeJS.ProcessEnv = identity ? baseEnv : {
    ...baseEnv,
    GIT_AUTHOR_NAME: login, GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
    GIT_COMMITTER_NAME: login, GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com`,
  }
  await must(['add', '-A'])
  const status = await must(['status', '--porcelain'])
  if (status.output.trim()) {
    const message = options.message?.trim() || `Cubex 自动提交 ${new Date().toLocaleString('zh-CN')}`
    await must(['commit', '-m', message], commitEnv)
    log.push(`已提交：${message}`)
  } else log.push('没有新的改动需要提交')

  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  const pushEnv: NodeJS.ProcessEnv = { ...baseEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header }
  const pushed = await git(['push', `https://github.com/${owner}/${name}.git`, `HEAD:refs/heads/${config.branch}`], pushEnv)
  if (pushed.code !== 0) throw new Error(`推送失败：${scrub(pushed.output).trim().slice(0, 2000)}`)
  log.push(`已推送到 ${owner}/${name}@${config.branch}`)
  return { repo: `${owner}/${name}`, url: htmlUrl, branch: config.branch, log: scrub(log.join('\n')) }
}
