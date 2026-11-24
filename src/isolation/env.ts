// Allowlisted environment for worker processes.
//
// Workers get only the variables named here, not a copy of process.env with a
// few prefixes stripped. A clean environment reduces accidental leaks of
// tokens and keys into a worker, but it is NOT a security boundary: the worker
// still runs under the same OS account and can read any file that account can
// read (credential stores, ~/.config, .env files, and so on).

/** OS basics that Node, git and shells need to run, on Windows and POSIX. */
export const BASE_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ComSpec',
  'PATHEXT',
  'SystemDrive',
  'windir',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
]);

/**
 * Variables Claude Code reads to sign in or find its config. All four were
 * checked against the environment variable reference at
 * https://code.claude.com/docs/en/env-vars (2026-11-24); `claude --help` also
 * names ANTHROPIC_API_KEY. These are the only names that pass the secret screen.
 * AWS_ / Bedrock / Vertex variables are deliberately left out.
 */
export const SIGN_IN_ALLOWLIST: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
]);

const SIGN_IN_UPPER: ReadonlySet<string> = new Set(SIGN_IN_ALLOWLIST.map((n) => n.toUpperCase()));
const SECRET_SUBSTRINGS: readonly string[] = ['TOKEN', 'SECRET', 'PASSWORD', 'KEY'];
const SECRET_PREFIXES: readonly string[] = ['GH_', 'GITHUB_', 'AWS_', 'AZURE_', 'LOCAL_PUBLISH'];
const SECRET_EXACT: readonly string[] = ['OPENAI_API_KEY'];

/**
 * True when a variable name looks like it holds a credential and must not reach
 * a worker. Case-insensitive. Names in SIGN_IN_ALLOWLIST are never secret here.
 */
export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SIGN_IN_UPPER.has(upper)) return false;
  return (
    SECRET_EXACT.includes(upper) ||
    SECRET_PREFIXES.some((p) => upper.startsWith(p)) ||
    SECRET_SUBSTRINGS.some((s) => upper.includes(s))
  );
}

/**
 * Build the environment for a worker process from `source`.
 *
 * Copies a variable only if its name (compared case-insensitively, since
 * Windows reports PATH as Path) is in BASE_ENV_ALLOWLIST, SIGN_IN_ALLOWLIST or
 * `extraAllow`, its value is defined, and it passes the secret screen. The
 * name keeps the casing it has in `source`. `source` is never mutated.
 */
export function buildWorkerEnv(
  source: Record<string, string | undefined> = process.env,
  extraAllow: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set(
    [...BASE_ENV_ALLOWLIST, ...SIGN_IN_ALLOWLIST, ...extraAllow].map((n) => n.toUpperCase()),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allowed.has(name.toUpperCase())) continue;
    if (isSecretName(name)) continue;
    env[name] = value;
  }
  return env;
}
