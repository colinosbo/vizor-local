// Push guard: scans every commit in a push range for secrets, denylisted files and personal
// details before Vizor pushes to GitHub. Self-contained; the integration lives elsewhere.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';

export interface PushFinding {
  id: string;
  kind: 'secret' | 'denylist' | 'personal';
  rule: string;
  file: string;
  commit: string;
  line?: number;
  reason: string;
  excerpt?: string;
}

/** Files that must never be pushed. Glob semantics follow .gitignore. */
export const DENYLIST: string[] = ['.env*', '*.pem', '*.key', '*.db', 'server.json', 'private/'];

/** Example env files are meant to be committed. */
const ENV_ALLOWED = new Set(['.env.example', '.env.sample', '.env.template']);

/** .gitignore lines for DENYLIST, re-allowing the example env file. */
export const DENYLIST_GITIGNORE: string = [...DENYLIST, '!.env.example'].join('\n');

export interface SecretRule { name: string; reason: string; re: RegExp }

/** Named secret patterns. Every regex is global so all matches on a line are found. */
export const SECRET_RULES: readonly SecretRule[] = [
  { name: 'github-token', reason: 'looks like a GitHub token', re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,251}(?![A-Za-z0-9_])/g },
  { name: 'github-pat', reason: 'looks like a GitHub fine-grained token', re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{60,255}/g },
  // sk- legacy (48 chars) and sk-proj-/sk-svcacct-/sk-admin- forms. The 32-char floor and the
  // required digit keep short strings and hyphenated words out.
  { name: 'openai-key', reason: 'looks like an OpenAI API key', re: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,300}/g },
  { name: 'aws-access-key', reason: 'looks like an AWS access key', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { name: 'google-api-key', reason: 'looks like a Google API key', re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { name: 'slack-token', reason: 'looks like a Slack token', re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,250}/g },
  { name: 'slack-webhook', reason: 'looks like a Slack webhook URL', re: /hooks\.slack\.com\/services\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g },
  { name: 'private-key', reason: 'contains a private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
];

/** Usernames too generic to flag as personal. */
const GENERIC_USERS = new Set(['root', 'user', 'admin', 'runner', 'node']);

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const SENTINEL = '\x1eVIZOR-COMMIT ';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function findingId(kind: PushFinding['kind'], rule: string, file: string, matchedText: string): string {
  return sha256(`${kind}|${rule}|${file}|${sha256(matchedText)}`).slice(0, 16);
}

/** First 4 characters then an ellipsis. Never returns the whole match. */
export function redact(matched: string): string {
  return matched.slice(0, 4) + '…';
}

/** Which DENYLIST entry a path hits, or null. Case-insensitive so Windows checkouts cannot dodge it. */
export function denylistMatch(path: string): { rule: string; reason: string } | null {
  const segs = path.split('/').filter(Boolean);
  const base = (segs.at(-1) ?? '').toLowerCase();
  if (base.startsWith('.env') && !ENV_ALLOWED.has(base)) return { rule: '.env*', reason: 'file name matches .env*' };
  for (const ext of ['pem', 'key', 'db']) {
    if (base.endsWith('.' + ext)) return { rule: '*.' + ext, reason: `file name matches *.${ext}` };
  }
  if (base === 'server.json') return { rule: 'server.json', reason: 'file name matches server.json' };
  if (segs.slice(0, -1).some((s) => s.toLowerCase() === 'private')) {
    return { rule: 'private/', reason: 'file is inside a folder named private/' };
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Home path matcher: case-insensitive; accepts \, / and JSON-escaped \\ separators. */
function homePathRe(home: string): RegExp | null {
  const segs = home.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return null;
  const sep = '(?:\\\\{1,2}|/)';
  const lead = /^[\\/]/.test(home) ? sep : '';
  return new RegExp(lead + segs.map(escapeRe).join(sep) + '(?![A-Za-z0-9_-])', 'gi');
}

function usernameRe(name: string): RegExp | null {
  if (name.length < 3 || GENERIC_USERS.has(name.toLowerCase())) return null;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'gi');
}

/** Undo git's C-style path quoting ("a/caf\303\251"). */
function unquote(q: string): string {
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34 };
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = q[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(q.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path from `diff --git a/P b/P`. With --no-renames both sides are the same path. */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    return m ? unquote(m[1]).replace(/^a\//, '') : rest;
  }
  return rest.slice(2, 2 + (rest.length - 5) / 2);
}

interface Ctx {
  commit: string;
  findings: PushFinding[];
  seen: Set<string>;
  home: RegExp | null;
  user: RegExp | null;
}

function add(ctx: Ctx, f: Omit<PushFinding, 'id' | 'commit'>, matched: string) {
  const id = findingId(f.kind, f.rule, f.file, matched);
  if (ctx.seen.has(id)) return;
  ctx.seen.add(id);
  ctx.findings.push({ id, commit: ctx.commit, ...f });
}

function scanLine(ctx: Ctx, file: string, line: number, text: string) {
  for (const r of SECRET_RULES) {
    for (const m of text.matchAll(r.re)) {
      add(ctx, { kind: 'secret', rule: r.name, file, line, reason: r.reason, excerpt: redact(m[0]) }, m[0]);
    }
  }
  let rest = text;
  if (ctx.home) {
    for (const m of text.matchAll(ctx.home)) {
      add(ctx, { kind: 'personal', rule: 'home-path', file, line, reason: 'contains your home folder path', excerpt: redact(m[0]) }, m[0]);
    }
    // Blank out home paths so the username inside them is not reported twice.
    rest = text.replace(ctx.home, (s) => ' '.repeat(s.length));
  }
  if (ctx.user) {
    for (const m of rest.matchAll(ctx.user)) {
      add(ctx, { kind: 'personal', rule: 'username', file, line, reason: 'contains your username', excerpt: redact(m[0]) }, m[0]);
    }
  }
}

/** Parse `git log -p -U0` output and collect findings. Exported for tests. */
export function scanLog(out: string, home: RegExp | null, user: RegExp | null): PushFinding[] {
  const ctx: Ctx = { commit: '', findings: [], seen: new Set(), home, user };
  let file: string | null = null;
  let deleted = false;
  let inHunk = false;
  let lineNo = 0;

  const closeFile = () => {
    if (file !== null && !deleted) {
      const d = denylistMatch(file);
      if (d) add(ctx, { kind: 'denylist', rule: d.rule, file, reason: d.reason }, file);
    }
    file = null;
  };

  for (const raw of out.split('\n')) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l.startsWith(SENTINEL)) {
      closeFile();
      ctx.commit = l.slice(SENTINEL.length).trim();
      inHunk = false;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      closeFile();
      file = headerPath(l.slice('diff --git '.length));
      deleted = false;
      inHunk = false;
      continue;
    }
    if (file === null) continue;
    if (!inHunk) {
      if (l.startsWith('deleted file mode')) deleted = true;
      // Binary files have no hunks: only the path is checked, in closeFile.
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      lineNo = m ? Number(m[1]) : 0;
      inHunk = true;
      continue;
    }
    if (inHunk && l.startsWith('+')) {
      scanLine(ctx, file, lineNo, l.slice(1));
      lineNo++;
    }
  }
  closeFile();
  return ctx.findings;
}

function runGit(repo: string, args: string[], maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { code?: unknown; stderr?: string };
        e.stderr = stderr;
        reject(e);
      } else resolve(stdout);
    });
  });
}

function tooLarge(maxBytes: number): PushFinding[] {
  const mb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
  return [{
    id: findingId('secret', 'too-large', '', 'too-large'),
    kind: 'secret',
    rule: 'too-large',
    file: '',
    commit: '',
    reason: `the changes are too large to scan (over ${mb} MB), so the push is blocked`,
  }];
}

/**
 * Scan every commit in `range` (history is pushed too, not just the tip).
 * Fails closed: an oversized diff returns a single 'too-large' finding.
 */
export async function scanPush(
  repo: string,
  range: string,
  opts: { homeDir?: string; username?: string; maxBytes?: number } = {},
): Promise<PushFinding[]> {
  if (!range || range.startsWith('-')) throw new Error(`invalid push range: ${JSON.stringify(range)}`);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const home = homePathRe(opts.homeDir ?? homedir());
  const user = usernameRe(opts.username ?? userInfo().username);
  const args = [
    '-c', 'core.quotePath=false',
    'log', '--no-renames', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/',
    `--format=%x1eVIZOR-COMMIT %H`, range, '--',
  ];
  let out: string;
  try {
    // Room above the cap so we can tell "just over" from a truncated read.
    out = await runGit(repo, args, maxBytes + 1024 * 1024);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return tooLarge(maxBytes);
    const err = e as Error & { stderr?: string };
    throw new Error(`push guard: git log ${range} failed: ${err.stderr || err.message}`);
  }
  if (Buffer.byteLength(out, 'utf8') > maxBytes) return tooLarge(maxBytes);
  return scanLog(out, home, user);
}

/** Drop findings the owner has explicitly overridden. */
export function filterOverridden(findings: PushFinding[], overriddenIds: Iterable<string>): PushFinding[] {
  const skip = new Set(overriddenIds);
  return findings.filter((f) => !skip.has(f.id));
}
