import { spawnSync } from 'node:child_process';

/**
 * Synchronous wrapper around the GitHub CLI (`gh api`).
 *
 * It is synchronous on purpose: the Forge interface is synchronous and the
 * runner calls it without await.
 *
 * Status detection: we parse gh's stderr for `HTTP <code>` rather than using
 * `--include`. On any non-2xx response gh writes `gh: <message> (HTTP <code>)`
 * to stderr and exits non-zero, while on success stdout stays pure JSON.
 * `--include` would prepend response headers to stdout and force us to split
 * headers from the body on every successful call.
 *
 * Security: stderr lines containing "token" (any case) are dropped before they
 * reach an error message, and messages are capped at 500 characters.
 */

export type GhErrorKind = 'not_authenticated' | 'not_found' | 'rate_limited' | 'conflict' | 'failed' | 'timeout';

export class GhError extends Error {
  constructor(public kind: GhErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'GhError';
  }
}

export interface GhOptions { bin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }

export type GhCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => unknown;

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_MESSAGE = 500;
const MAX_BUFFER = 64 * 1024 * 1024;

function scrub(text: string): string {
  const kept = text.split(/\r?\n/).filter((line) => !/token/i.test(line)).join('\n').trim();
  return kept.length > MAX_MESSAGE ? kept.slice(0, MAX_MESSAGE) : kept;
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

function run(opts: GhOptions, args: string[], input?: string) {
  const bin = opts.bin ?? 'gh';
  const [cmd, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
  return spawnSync(cmd, argv, {
    shell: false,
    encoding: 'utf8',
    input,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: opts.env ?? process.env,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
}

type RunResult = ReturnType<typeof run>;

function timedOut(r: RunResult): boolean {
  return (isErrnoException(r.error) && r.error.code === 'ETIMEDOUT') || r.signal !== null;
}

function classify(stderr: string): GhError {
  const match = /HTTP (\d{3})/.exec(stderr);
  const status = match ? Number(match[1]) : undefined;
  const message = scrub(stderr) || (status ? `gh api failed with HTTP ${status}` : 'gh api failed');
  const rateLimit = /rate limit/i.test(stderr);
  let kind: GhErrorKind = 'failed';
  if (status === 401) kind = 'not_authenticated';
  else if (status === 429 || (status === 403 && rateLimit)) kind = 'rate_limited';
  else if (/gh auth login|authentication/i.test(stderr)) kind = 'not_authenticated';
  else if (status === 404) kind = 'not_found';
  else if (status === 409) kind = 'conflict';
  else if (rateLimit && status === undefined) kind = 'rate_limited';
  return new GhError(kind, message, status);
}

export function createGh(opts: GhOptions = {}): GhCall {
  return (method, path, body) => {
    const args = ['api', '--method', method, path, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) args.push('--input', '-');
    const r = run(opts, args, body !== undefined ? JSON.stringify(body) : undefined);
    if (timedOut(r)) throw new GhError('timeout', `gh api ${method} timed out`);
    if (r.error) {
      const missing = isErrnoException(r.error) && r.error.code === 'ENOENT';
      throw new GhError('failed', missing ? 'gh executable not found' : scrub(r.error.message));
    }
    if (r.status !== 0) throw classify(r.stderr ?? '');
    const out = (r.stdout ?? '').trim();
    if (out === '') return null;
    try {
      return JSON.parse(out) as unknown;
    } catch {
      throw new GhError('failed', 'gh api returned invalid JSON');
    }
  };
}

export function ghAuthStatus(opts: GhOptions = {}): { ok: true } | { ok: false; problem: string } {
  const r = run(opts, ['auth', 'status']);
  if (r.error || timedOut(r) || r.status !== 0) {
    return { ok: false, problem: 'forge unavailable: run gh auth login' };
  }
  return { ok: true };
}
