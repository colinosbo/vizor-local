// Update check and one-click update for Vizor Local itself (not for user projects).
//
// Safety rules, kept on purpose:
// - The source is UPSTREAM_URL, overridable only at launch (--update-upstream / VIZOR_UPDATE_UPSTREAM).
//   No HTTP route or request body can read or change it.
// - The check fetches into refs/vizor/upstream with the URL passed directly: no remote is added and
//   the user's git config is never written.
// - Only fast-forwards are applied, only to a clean tree, never while a worker runs, and the server
//   re-checks everything itself. SHAs reach the updater only through the journal file.
// - Every git/npm/launcher command goes through an injectable CommandRunner so tests run without the
//   network, npm or a real restart.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting, type DB } from './db.js';
import { instanceLockHeld } from './instance.js';
import { isAlive, type Runner } from './runner.js';

export const UPSTREAM_URL = 'https://github.com/colinosbo/vizor-local';
/** The package root (dist/src/update.js -> ../../), not the cwd. */
export const INSTALL_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const UPSTREAM_REF = 'refs/vizor/upstream';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_SUBJECTS = 50;
export const KEEP_BACKUPS = 3;
export const JOURNAL_FILE = 'update-state.json';
export const CHECK_SETTING = 'update_check_enabled';

// ---------- commands ----------

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandRunner {
  /** Run to completion. Never throws for a non-zero exit; a spawn failure is reported as code -1. */
  run(cmd: string, args: readonly string[], opts: { cwd: string; timeoutMs?: number }): Promise<CommandResult>;
  /** Start a detached process that outlives this one (the restarted Vizor). May throw if it cannot start. */
  launch(cmd: string, args: readonly string[], opts: { cwd: string; verbatim?: boolean }): void;
}

/** Real processes. git never prompts; npm on Windows needs a shell (npm.cmd), with fixed arguments only. */
export const systemRunner: CommandRunner = {
  run(cmd, args, { cwd, timeoutMs = 10 * 60_000 }) {
    return new Promise((resolve) => {
      let stdout = '', stderr = '';
      let child;
      try {
        child = spawn(cmd, [...args], { cwd, windowsHide: true, timeout: timeoutMs, shell: process.platform === 'win32' && cmd === 'npm',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { return resolve({ code: -1, stdout: '', stderr: String((e as Error).message ?? e) }); }
      child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 4e6) stdout = stdout.slice(-2e6); });
      child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 4e6) stderr = stderr.slice(-2e6); });
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e.message) }));
      child.on('close', (code, signal) => resolve({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\nstopped by ${signal}` : stderr }));
    });
  },
  launch(cmd, args, { cwd, verbatim }) {
    spawn(cmd, [...args], { cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim }).unref();
  },
};

/** git flags that stop user config from adding credentials or extra headers to the update fetch. */
const ANONYMOUS = ['-c', 'credential.helper=', '-c', 'http.extraHeader='];

async function git(r: CommandRunner, root: string, args: readonly string[], timeoutMs?: number): Promise<CommandResult> {
  return r.run('git', args, { cwd: root, timeoutMs });
}
async function gitOut(r: CommandRunner, root: string, args: readonly string[]): Promise<string> {
  const res = await git(r, root, args);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim().slice(-500)}`);
  return res.stdout.trim();
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const isSha = (s: unknown): s is string => typeof s === 'string' && SHA.test(s);

/**
 * Accepts the upstream only in a shape git cannot read as an option and that sends nothing extra:
 * https URL without credentials, query or fragment, or a local path / file:// URL (tests).
 */
export function validUpstream(url: string): boolean {
  if (!url || url.startsWith('-') || /[\s?#\0]/.test(url)) return false;
  if (/^https:\/\//i.test(url)) {
    try { const u = new URL(url); return !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
  }
  if (/^file:\/\//i.test(url)) return true;
  return /^(\/|[A-Za-z]:[\\/])/.test(url); // absolute local path
}

/** Launch-time override: --update-upstream flag, else VIZOR_UPDATE_UPSTREAM, else UPSTREAM_URL. */
export function resolveUpstream(flagValue: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const pick = flagValue ?? env.VIZOR_UPDATE_UPSTREAM;
  if (pick === undefined || pick === '') return UPSTREAM_URL;
  if (!validUpstream(pick)) throw new Error(`update upstream must be an https URL without query or credentials, or an absolute path: ${pick}`);
  return pick;
}

// ---------- install facts ----------

/** A git install has a .git directory at the install root (a zip install has none). */
export function isGitInstall(root: string): boolean {
  try { return statSync(join(root, '.git')).isDirectory(); } catch { return false; }
}

const IGNORED_UNTRACKED = ['dist/', 'node_modules/'];

/**
 * Real content changes only. Line-ending-only differences (CRLF checkouts on Windows) do not count,
 * and neither do untracked files under dist/ or node_modules/.
 */
export async function hasLocalChanges(r: CommandRunner, root: string): Promise<boolean> {
  const diff = await git(r, root, ['diff', '--ignore-cr-at-eol', '--quiet', 'HEAD', '--']);
  if (diff.code === 1) return true;
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim().slice(-500)}`);
  const st = await git(r, root, ['status', '--porcelain', '-z', '--untracked-files=normal']);
  if (st.code !== 0) throw new Error(`git status failed: ${st.stderr.trim().slice(-500)}`);
  const tokens = st.stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const xy = t.slice(0, 2), path = t.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the next token is the original path
    if (xy !== '??') continue; // tracked entries were judged by the CR-insensitive diff above
    if (!IGNORED_UNTRACKED.some((d) => path === d || path.startsWith(d))) return true;
  }
  return false;
}

// ---------- check ----------

export type CheckOutcome =
  | { ok: true; checkedAt: string; headSha: string; upstreamSha: string; behind: number; ahead: number; subjects: string[] }
  | { ok: false; checkedAt: string; error: string };

/** Fetch upstream main into refs/vizor/upstream (URL passed directly, no remote) and compare with HEAD. */
export async function checkForUpdate(r: CommandRunner, root: string, upstream: string): Promise<CheckOutcome> {
  const checkedAt = new Date().toISOString();
  try {
    if (!validUpstream(upstream)) throw new Error('invalid update upstream');
    const f = await git(r, root, [...ANONYMOUS, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', upstream, `+refs/heads/main:${UPSTREAM_REF}`], 120_000);
    if (f.code !== 0) throw new Error(`could not fetch updates: ${(f.stderr || f.stdout).trim().slice(-500)}`);
    const headSha = await gitOut(r, root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const upstreamSha = await gitOut(r, root, ['rev-parse', '--verify', `${UPSTREAM_REF}^{commit}`]);
    const [ahead, behind] = (await gitOut(r, root, ['rev-list', '--left-right', '--count', `HEAD...${UPSTREAM_REF}`])).split(/\s+/).map(Number);
    const log = behind > 0 ? await gitOut(r, root, ['log', '--format=%s', '-n', String(MAX_SUBJECTS), `HEAD..${UPSTREAM_REF}`]) : '';
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error('could not count commits');
    return { ok: true, checkedAt, headSha, upstreamSha, behind, ahead, subjects: log ? log.split('\n') : [] };
  } catch (e) {
    return { ok: false, checkedAt, error: String((e as Error).message ?? e) };
  }
}

// ---------- eligibility (pure) ----------

export type IneligibleReason = 'not-a-git-install' | 'local-changes' | 'ahead-of-upstream' | 'diverged' | 'up-to-date'
  | 'check-disabled' | 'worker-running' | 'check-failed';
export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

export interface EligibilityFacts {
  gitInstall: boolean;
  checkEnabled: boolean;
  /** null = no check has run yet. */
  check: CheckOutcome | null;
  localChanges: boolean;
  workerRunning: boolean;
}

/** HEAD must be a strict ancestor of upstream (behind > 0, ahead = 0) on a clean git install with no worker running. */
export function updateEligibility(f: EligibilityFacts): Eligibility {
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason });
  if (!f.gitInstall) return no('not-a-git-install');
  if (!f.checkEnabled) return no('check-disabled');
  if (!f.check || !f.check.ok) return no('check-failed');
  if (f.check.ahead > 0 && f.check.behind > 0) return no('diverged');
  if (f.check.ahead > 0) return no('ahead-of-upstream');
  if (f.check.behind === 0) return no('up-to-date');
  if (f.localChanges) return no('local-changes');
  if (f.workerRunning) return no('worker-running');
  return { eligible: true };
}

export type RevertReason = 'not-a-git-install' | 'local-changes' | 'worker-running' | 'no-revert-recorded' | 'moved-since-update';
export type RevertEligibility = { eligible: true; toSha: string } | { eligible: false; reason: RevertReason };

/** A revert is offered only back to the SHA the updater recorded, and only while HEAD is still the update it made. */
export function revertEligibility(f: { gitInstall: boolean; localChanges: boolean; workerRunning: boolean; headSha: string | null; revert: RevertRecord | null }): RevertEligibility {
  const no = (reason: RevertReason): RevertEligibility => ({ eligible: false, reason });
  if (!f.gitInstall) return no('not-a-git-install');
  if (!f.revert) return no('no-revert-recorded');
  if (f.headSha !== f.revert.updatedSha) return no('moved-since-update');
  if (f.localChanges) return no('local-changes');
  if (f.workerRunning) return no('worker-running');
  return { eligible: true, toSha: f.revert.previousSha };
}

// ---------- journal ----------

export type JournalKind = 'update' | 'revert';
export type JournalStatus = 'pending' | 'running' | 'done' | 'rolled-back' | 'failed';
/** Written by the updater after a successful update: the only SHA a revert may target. */
export interface RevertRecord { previousSha: string; updatedSha: string }
export interface Journal {
  kind: JournalKind;
  fromSha: string;
  toSha: string;
  status: JournalStatus;
  error: string | null;
  errorDismissed: boolean;
  startedAt: string;
  finishedAt: string | null;
  updaterPid: number | null;
  revert: RevertRecord | null;
}

const KINDS: readonly string[] = ['update', 'revert'];
const STATUSES: readonly string[] = ['pending', 'running', 'done', 'rolled-back', 'failed'];
const has = <K extends string>(o: object, k: K): o is Record<K, unknown> => k in o;

export function isRevertRecord(x: unknown): x is RevertRecord {
  return typeof x === 'object' && x !== null && has(x, 'previousSha') && has(x, 'updatedSha') && isSha(x.previousSha) && isSha(x.updatedSha);
}

export function isJournal(x: unknown): x is Journal {
  if (typeof x !== 'object' || x === null) return false;
  if (!has(x, 'kind') || !has(x, 'fromSha') || !has(x, 'toSha') || !has(x, 'status') || !has(x, 'error') || !has(x, 'errorDismissed')
    || !has(x, 'startedAt') || !has(x, 'finishedAt') || !has(x, 'updaterPid') || !has(x, 'revert')) return false;
  return typeof x.kind === 'string' && KINDS.includes(x.kind) && isSha(x.fromSha) && isSha(x.toSha)
    && typeof x.status === 'string' && STATUSES.includes(x.status)
    && (x.error === null || typeof x.error === 'string') && typeof x.errorDismissed === 'boolean'
    && typeof x.startedAt === 'string' && (x.finishedAt === null || typeof x.finishedAt === 'string')
    && (x.updaterPid === null || typeof x.updaterPid === 'number') && (x.revert === null || isRevertRecord(x.revert));
}

/** null if missing or not a valid journal (a hand-edited or corrupt file is never acted on). */
export function readJournal(dataDir: string): Journal | null {
  try { const j: unknown = JSON.parse(readFileSync(join(dataDir, JOURNAL_FILE), 'utf8')); return isJournal(j) ? j : null; } catch { return null; }
}

/** Atomic replace so a crash never leaves half a journal. */
export function writeJournal(dataDir: string, j: Journal) {
  const file = join(dataDir, JOURNAL_FILE), tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------- backups ----------

/** Copy the database (and its -wal/-shm) to <dataDir>/backups/<timestamp>/ and keep the newest KEEP_BACKUPS. */
export function backupDatabase(dataDir: string, dbPath: string, now = new Date()): string {
  const root = join(dataDir, 'backups');
  const dir = join(root, now.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (existsSync(src)) copyFileSync(src, join(dir, (dbPath.split(/[\\/]/).pop() ?? 'local.db') + suffix));
  }
  const stamps = readdirSync(root).filter((n) => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(n)).sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - KEEP_BACKUPS))) rmSync(join(root, old), { recursive: true, force: true });
  return dir;
}

// ---------- updater (runs detached, after the server exits) ----------

export interface UpdaterOpts {
  dataDir: string;
  root: string;
  run: CommandRunner;
  lockTimeoutMs?: number;
  pollMs?: number;
  platform?: NodeJS.Platform;
  /** Restart Vizor. Defaults to the launcher (Windows) or the launcher's node serve command. */
  restart?: (run: CommandRunner, root: string, dataDir: string) => void;
}

/** The same start the launcher performs; on Windows the launcher itself (it also rebuilds and opens the browser). */
export function restartVizor(run: CommandRunner, root: string, dataDir: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') {
    // cmd /s /c ""<path>"": outer quotes are stripped, the inner pair keeps spaces and & in the path literal.
    run.launch('cmd.exe', ['/d', '/s', '/c', `""${join(root, 'Start Vizor Local.cmd')}""`], { cwd: root, verbatim: true });
  } else {
    run.launch(process.execPath, ['--disable-warning=ExperimentalWarning', join('dist', 'src', 'cli.js'), 'serve', '--orchestrator', 'claude',
      '--worker', 'claude', '--open', '--data', dataDir], { cwd: root });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (r: CommandResult) => (r.stderr.trim() || r.stdout.trim()).slice(-2000);

/**
 * The updater core. Reads the pending journal, waits for the server to release its lock, moves the
 * install to toSha (fast-forward for an update, reset for a revert), runs npm ci and the build, and
 * restarts Vizor. Any failure resets to fromSha, rebuilds, restarts the old version and records the error.
 */
export async function runUpdater(o: UpdaterOpts): Promise<Journal | null> {
  const { dataDir, root, run } = o;
  const restart = o.restart ?? ((r: CommandRunner, rt: string, d: string) => restartVizor(r, rt, d, o.platform));
  const j = readJournal(dataDir);
  if (!j || j.status !== 'pending') return j;
  const save = (patch: Partial<Journal>) => { Object.assign(j, patch); writeJournal(dataDir, j); };
  save({ status: 'running', updaterPid: process.pid });

  const deadline = Date.now() + (o.lockTimeoutMs ?? 60_000);
  while (instanceLockHeld(dataDir)) {
    if (Date.now() > deadline) { save({ status: 'failed', error: 'Vizor Local did not stop in time, so nothing was changed.', finishedAt: new Date().toISOString() }); return j; }
    await sleep(o.pollMs ?? 250);
  }

  const step = async (cmd: string, args: string[], what: string) => {
    const r = await run.run(cmd, args, { cwd: root });
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${tail(r)}`);
    return r.stdout.trim();
  };
  const restartSafely = () => { try { restart(run, root, dataDir); return null; } catch (e) { return `restart failed: ${String((e as Error).message ?? e)}`; } };

  // Preconditions: refuse without touching anything, and bring the old version back up.
  const refuse = async (): Promise<string | null> => {
    if (!isGitInstall(root)) return 'not a git install';
    const head = (await git(run, root, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    if (head !== j.fromSha) return `the install moved from ${j.fromSha.slice(0, 8)} to ${head.slice(0, 8) || 'unknown'} since the update was requested`;
    if (await hasLocalChanges(run, root)) return 'the install has local changes';
    if ((await git(run, root, ['cat-file', '-e', `${j.toSha}^{commit}`])).code !== 0) return `commit ${j.toSha.slice(0, 8)} is not available`;
    if (j.kind === 'update' && (await git(run, root, ['merge-base', '--is-ancestor', 'HEAD', j.toSha])).code !== 0) return 'the update is not a fast-forward';
    if (j.kind === 'revert' && j.revert?.previousSha !== j.toSha) return 'the revert target is not the recorded previous version';
    return null;
  };
  let reason: string | null;
  try { reason = await refuse(); } catch (e) { reason = String((e as Error).message ?? e); }
  if (reason) {
    const restartErr = restartSafely();
    save({ status: 'failed', error: `Nothing was changed: ${reason}.${restartErr ? ' ' + restartErr : ''}`, finishedAt: new Date().toISOString() });
    return j;
  }

  try {
    if (j.kind === 'update') await step('git', ['merge', '--ff-only', '--quiet', j.toSha], 'git merge --ff-only');
    else await step('git', ['reset', '--hard', '--quiet', j.toSha], 'git reset');
    await step('npm', ['ci'], 'npm ci');
    await step('npm', ['run', 'build'], 'npm run build');
    const restartErr = restartSafely();
    if (restartErr) throw new Error(restartErr);
    save({ status: 'done', error: null, finishedAt: new Date().toISOString(),
      revert: j.kind === 'update' ? { previousSha: j.fromSha, updatedSha: j.toSha } : null });
    return j;
  } catch (e) {
    const errors = [String((e as Error).message ?? e)];
    for (const [cmd, args, what] of [['git', ['reset', '--hard', '--quiet', j.fromSha], 'rollback git reset'], ['npm', ['ci'], 'rollback npm ci'],
      ['npm', ['run', 'build'], 'rollback npm run build']] as const) {
      try { await step(cmd, [...args], what); } catch (re) { errors.push(String((re as Error).message ?? re)); if (cmd === 'git') break; }
    }
    const restartErr = restartSafely();
    if (restartErr) errors.push(restartErr);
    const rolledBack = errors.length === 1;
    save({ status: rolledBack ? 'rolled-back' : 'failed', error: errors.join('\n'), errorDismissed: false, finishedAt: new Date().toISOString() });
    return j;
  }
}

// ---------- service used by the server ----------

export interface UpdateServiceOpts {
  db: DB;
  dataDir: string;
  dbPath: string;
  root?: string;
  /** Fixed for the life of the process. Set only from the launch flag or env var. */
  upstream?: string;
  run?: CommandRunner;
  /** Any worker attempt running, from the attempts table and the runner's live state. */
  workerRunning: () => boolean;
  /** Start the detached updater. Default: node dist/src/cli.js run-updater --data <dir> --root <root>. */
  spawnUpdater?: (dataDir: string, root: string) => void;
  /** Exit the server so the updater can take over. */
  exit?: () => void;
}

export type ApplyResult = { ok: true; kind: JournalKind; fromSha: string; toSha: string }
  | { ok: false; status: number; reason: string; message: string };

const REASON_TEXT: Record<IneligibleReason | RevertReason | 'busy', string> = {
  'not-a-git-install': 'This copy was not installed with git, so it cannot update itself. Download the new version from the repository.',
  'local-changes': 'The install folder has local changes. Commit or discard them first.',
  'ahead-of-upstream': 'This install has commits that are not upstream, so it will not be updated.',
  diverged: 'This install and upstream have both moved on, so a fast-forward is not possible.',
  'up-to-date': 'Vizor Local is up to date.',
  'check-disabled': 'The update check is turned off.',
  'worker-running': 'A worker is running. Wait for it to finish, then try again.',
  'check-failed': 'Could not check for updates.',
  'no-revert-recorded': 'There is no previous version to go back to.',
  'moved-since-update': 'The install changed since the last update, so it will not be reverted.',
  busy: 'An update is already in progress.',
};

/**
 * A worker counts as running if the attempts table has an active attempt or the runner still holds a
 * live worker handle (it can briefly outlive the row's status change).
 */
export function workersBusy(db: DB, runner: Runner): boolean {
  const n = (db.prepare("SELECT COUNT(*) n FROM attempts WHERE status IN ('claimed','running','exited')").get() as { n: number }).n;
  return n > 0 || runner['handles'].size > 0;
}

export function spawnDetachedUpdater(dataDir: string, root: string) {
  const log = openSync(join(dataDir, 'update.log'), 'a');
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'dist', 'src', 'cli.js'), 'run-updater', '--data', dataDir, '--root', root],
    { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref();
}

export class UpdateService {
  readonly root: string;
  readonly upstream: string;
  private readonly run: CommandRunner;
  private lastCheck: CheckOutcome | null = null;
  private checking: Promise<CheckOutcome | null> | null = null;
  private busy = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly o: UpdateServiceOpts) {
    this.root = o.root ?? INSTALL_ROOT;
    this.upstream = o.upstream ?? UPSTREAM_URL;
    if (!validUpstream(this.upstream)) throw new Error('invalid update upstream');
    this.run = o.run ?? systemRunner;
  }

  checkEnabled(): boolean { return getSetting(this.o.db, CHECK_SETTING) !== '0'; }
  setCheckEnabled(on: boolean) { setSetting(this.o.db, CHECK_SETTING, on ? '1' : '0'); if (!on) this.lastCheck = null; }

  /** Check at startup and every 6 hours. The timer never keeps the process alive. */
  start() {
    void this.check().catch(() => {});
    this.timer = setInterval(() => { void this.check().catch(() => {}); }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** null when the check is turned off or this is not a git install. Concurrent callers share one fetch. */
  async check(): Promise<CheckOutcome | null> {
    if (!this.checkEnabled() || !isGitInstall(this.root)) return null;
    this.checking ??= checkForUpdate(this.run, this.root, this.upstream).then((c) => { this.lastCheck = c; return c; }).finally(() => { this.checking = null; });
    return this.checking;
  }

  /** Marks an updater that died mid-run so its journal does not look pending forever. */
  private journal(): Journal | null {
    const j = readJournal(this.o.dataDir);
    if (j && (j.status === 'pending' || j.status === 'running') && !this.busy && j.updaterPid !== process.pid) {
      const dead = j.status === 'pending' || j.updaterPid === null || !isAlive(j.updaterPid);
      if (dead) { Object.assign(j, { status: 'failed', error: 'The updater stopped before it finished.', errorDismissed: false, finishedAt: new Date().toISOString() }); writeJournal(this.o.dataDir, j); }
    }
    return j;
  }

  async status() {
    const gitInstall = isGitInstall(this.root);
    const checkEnabled = this.checkEnabled();
    const workerRunning = this.o.workerRunning();
    let localChanges = false, headSha: string | null = null, factsError: string | null = null;
    if (gitInstall) {
      try { localChanges = await hasLocalChanges(this.run, this.root); headSha = await gitOut(this.run, this.root, ['rev-parse', '--verify', 'HEAD^{commit}']); }
      catch (e) { factsError = String((e as Error).message ?? e); }
    }
    const check = checkEnabled ? this.lastCheck : null;
    const eligibility = factsError ? { eligible: false as const, reason: 'check-failed' as const }
      : updateEligibility({ gitInstall, checkEnabled, check, localChanges, workerRunning });
    const j = this.journal();
    // If the install could not be inspected, treat it as changed: refuse rather than guess.
    const revert = revertEligibility({ gitInstall, localChanges: localChanges || factsError !== null, workerRunning, headSha, revert: j?.revert ?? null });
    return {
      factsError,
      repositoryUrl: UPSTREAM_URL,
      gitInstall,
      checkEnabled,
      check: !checkEnabled ? { state: 'disabled' as const, message: REASON_TEXT['check-disabled'] }
        : !check ? { state: 'not-checked' as const }
        : check.ok ? { state: 'ok' as const, ...check } : { state: 'failed' as const, ...check },
      eligibility: eligibility.eligible ? eligibility : { ...eligibility, message: REASON_TEXT[eligibility.reason] },
      revert: revert.eligible ? { available: true, toSha: revert.toSha } : { available: false, reason: revert.reason, message: REASON_TEXT[revert.reason] },
      inProgress: this.busy || (j?.status === 'pending' || j?.status === 'running'),
      lastError: j && j.error && !j.errorDismissed && (j.status === 'rolled-back' || j.status === 'failed')
        ? { kind: j.kind, status: j.status, error: j.error, at: j.finishedAt ?? j.startedAt } : null,
      lastResult: j && j.status === 'done' ? { kind: j.kind, fromSha: j.fromSha, toSha: j.toSha, at: j.finishedAt } : null,
    };
  }

  dismissError() {
    const j = readJournal(this.o.dataDir);
    if (j && j.error) { j.errorDismissed = true; writeJournal(this.o.dataDir, j); }
  }

  /** Server-side re-check, backup, journal, detached updater, then exit. Never trusts anything from the client. */
  async apply(kind: JournalKind): Promise<ApplyResult> {
    const no = (status: number, reason: IneligibleReason | RevertReason | 'busy'): ApplyResult => ({ ok: false, status, reason, message: REASON_TEXT[reason] });
    if (this.busy) return no(409, 'busy');
    if (this.o.workerRunning()) return no(409, 'worker-running');
    const prev = this.journal();
    if (prev && (prev.status === 'pending' || prev.status === 'running')) return no(409, 'busy');
    this.busy = true;
    let journalWritten = false, handedOff = false;
    try {
      const gitInstall = isGitInstall(this.root);
      if (!gitInstall) return no(400, 'not-a-git-install');
      const fromSha = await gitOut(this.run, this.root, ['rev-parse', '--verify', 'HEAD^{commit}']);
      let toSha: string;
      if (kind === 'update') {
        if (!this.checkEnabled()) return no(400, 'check-disabled');
        const check = await this.check();
        const localChanges = await hasLocalChanges(this.run, this.root);
        const e = updateEligibility({ gitInstall, checkEnabled: true, check, localChanges, workerRunning: this.o.workerRunning() });
        if (!e.eligible) return no(e.reason === 'worker-running' ? 409 : 400, e.reason);
        if (!check?.ok || check.headSha !== fromSha) return no(400, 'check-failed');
        // Resolve the fetched ref to a SHA now; the updater only ever sees this SHA, via the journal.
        toSha = await gitOut(this.run, this.root, ['rev-parse', '--verify', `${UPSTREAM_REF}^{commit}`]);
        if (toSha !== check.upstreamSha || (await git(this.run, this.root, ['merge-base', '--is-ancestor', fromSha, toSha])).code !== 0) return no(400, 'diverged');
      } else {
        const localChanges = await hasLocalChanges(this.run, this.root);
        const e = revertEligibility({ gitInstall, localChanges, workerRunning: this.o.workerRunning(), headSha: fromSha, revert: prev?.revert ?? null });
        if (!e.eligible) return no(e.reason === 'worker-running' ? 409 : 400, e.reason);
        toSha = e.toSha;
      }
      if (!isSha(fromSha) || !isSha(toSha)) return no(400, 'check-failed');
      if (this.o.workerRunning()) return no(409, 'worker-running');

      try { this.o.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* the -wal copy still holds everything */ }
      backupDatabase(this.o.dataDir, this.o.dbPath);
      const journal: Journal = { kind, fromSha, toSha, status: 'pending', error: null, errorDismissed: false,
        startedAt: new Date().toISOString(), finishedAt: null, updaterPid: null, revert: prev?.revert ?? null };
      writeJournal(this.o.dataDir, journal);
      journalWritten = true;
      (this.o.spawnUpdater ?? spawnDetachedUpdater)(this.o.dataDir, this.root);
      handedOff = true;
      this.stop();
      setTimeout(() => this.o.exit?.(), 200).unref();
      return { ok: true, kind, fromSha, toSha };
    } catch (e) {
      const message = String((e as Error).message ?? e);
      const j = journalWritten ? readJournal(this.o.dataDir) : null;
      if (j && j.status === 'pending') writeJournal(this.o.dataDir, { ...j, status: 'failed', error: `Could not start the updater: ${message}`, finishedAt: new Date().toISOString() });
      return { ok: false, status: 500, reason: 'check-failed', message };
    } finally {
      // Stay busy after a hand-off: the server is about to exit and must not start a second updater.
      if (!handedOff) this.busy = false;
    }
  }
}
