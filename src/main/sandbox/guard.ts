const SANDBOX_ESCAPE = [
  /(^|\s)sudo(\s|$)/i,
  /(^|\s)su(\s|$)/i,
  /(^|\s)runas(\s|$)/i,
  /(^|\s)chmod\s+[0-7]*7{2,}/i,
  /\/etc\/(passwd|shadow|sudoers)/i,
  /\bnet\s+user\b/i,
  /\bnew-localuser\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bsc\s+(create|config|delete)\b/i,
  /\bsetx\b/i,
]

export function findEscape(command: string): RegExp | undefined {
  return SANDBOX_ESCAPE.find((pattern) => pattern.test(command))
}
