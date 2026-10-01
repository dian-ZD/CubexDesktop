export const buildSandboxEnv = (root: string, allowNetwork: boolean): NodeJS.ProcessEnv => {
  const src = process.env
  const keep = new Set(['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS'])
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(src)) {
    if (keep.has(key)) env[key] = src[key]
  }
  env.HOME = root
  env.USERPROFILE = root
  env.CUBEX_SANDBOX = '1'
  if (!allowNetwork) {
    env.no_proxy = '*'
    env.NO_PROXY = '*'
    env.http_proxy = 'http://127.0.0.1:9'
    env.https_proxy = 'http://127.0.0.1:9'
    env.HTTP_PROXY = 'http://127.0.0.1:9'
    env.HTTPS_PROXY = 'http://127.0.0.1:9'
    env.npm_config_offline = 'true'
    env.PIP_NO_INDEX = '1'
    env.GIT_TERMINAL_PROMPT = '0'
  }
  return env
}
