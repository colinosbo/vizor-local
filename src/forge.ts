import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git, parseNameStatus, revParse } from './git.js';
import { DEFAULT_CI, REQUIRED_CHECK, TRUSTED_WORKFLOW, type Check, type FileChange, type PullRequest } from './types.js';

/**
 * The GitHub-shaped authority Local talks to. The PoC ships LocalForge (a faithful stand-in over a
 * real bare git repo + real CI command). A GitHub implementation via `gh`/REST would implement the
 * same interface; it is NOT built in this PoC.
 */
export interface Forge {
  baseSha(base: string): string | null;
  findPrByMarker(marker: string): PullRequest | null;
  createPr(p: { branch: string; base: string; title: string; body: string }): PullRequest;
  getPr(n: number): PullRequest | null;
  prFiles(n: number): FileChange[] | null;
  isUpToDate(n: number): boolean | null;
  checksFor(sha: string): Check[];
  notifyPush(branch: string): void;
  triggerCi(sha: string): number;
  /** Squash-merge guarded by the exact verified head SHA. */
  merge(n: number, expectedHeadSha: string): string;
}

/** Resolves the forge for a project (one forge per project). Throws if the project has no usable forge. */
export type ForgeProvider = (projectId: string) => Forge;

export class HeadMovedError extends Error {}

/** Kill a process and its children (shell → npm → node …). */
export function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

export class LocalForge implements Forge {
  private db: DatabaseSync;
  public pendingCi = new Set<Promise<void>>();

  /**
   * ciCommand is a shell command line (e.g. "npm ci && npm test") run in a clean checkout of the exact SHA.
   * It comes from the owner's project config, never from the repo or a worker.
   */
  constructor(public bare: string, dbPath: string, public ciCommand: string = DEFAULT_CI, public ciTimeoutMs = 15 * 60_000) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS prs (number INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT, base TEXT, title TEXT, body TEXT,
        state TEXT DEFAULT 'open', merge_sha TEXT);
      CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT, name TEXT, conclusion TEXT,
        workflow_ref TEXT, log TEXT DEFAULT '');`);
    // A check still 'pending' from an earlier process can never finish: report it as an infra error so the runner re-runs it.
    this.db.prepare("UPDATE checks SET conclusion='infra_error', log='CI interrupted (Local stopped while it was running)' WHERE conclusion='pending'").run();
  }

  baseSha(base: string) { return revParse(this.bare, `refs/heads/${base}`); }

  private row(r: Record<string, unknown> | undefined): PullRequest | null {
    if (!r) return null;
    const headSha = r.state === 'open' ? revParse(this.bare, `refs/heads/${r.branch}`) : (revParse(this.bare, `refs/heads/${r.branch}`) ?? '');
    return { number: r.number as number, branch: r.branch as string, base: r.base as string, headSha: headSha ?? '',
      state: r.state as PullRequest['state'], title: r.title as string, body: r.body as string, mergeSha: (r.merge_sha as string) ?? null };
  }

  findPrByMarker(marker: string) {
    return this.row(this.db.prepare("SELECT * FROM prs WHERE instr(body, ?) > 0 ORDER BY number LIMIT 1").get(marker) as Record<string, unknown> | undefined);
  }

  createPr(p: { branch: string; base: string; title: string; body: string }) {
    if (!revParse(this.bare, `refs/heads/${p.branch}`)) throw new Error(`branch ${p.branch} not pushed`);
    const r = this.db.prepare('INSERT INTO prs(branch, base, title, body) VALUES (?,?,?,?) RETURNING *').get(p.branch, p.base, p.title, p.body) as Record<string, unknown>;
    const pr = this.row(r)!;
    this.triggerCi(pr.headSha);
    return pr;
  }

  getPr(n: number) { return this.row(this.db.prepare('SELECT * FROM prs WHERE number=?').get(n) as Record<string, unknown> | undefined); }

  prFiles(n: number) {
    const pr = this.getPr(n);
    if (!pr || !pr.headSha) return null;
    try { return parseNameStatus(git(this.bare, ['diff', '--name-status', '-M', `${pr.base}...${pr.headSha}`])); } catch { return null; }
  }

  isUpToDate(n: number) {
    const pr = this.getPr(n);
    const base = pr && this.baseSha(pr.base);
    if (!pr || !base || !pr.headSha) return null;
    return git(this.bare, ['merge-base', pr.headSha, base]) === base;
  }

  checksFor(sha: string): Check[] {
    return this.db.prepare('SELECT * FROM checks WHERE sha=? ORDER BY id').all(sha) as unknown as Check[];
  }

  notifyPush(branch: string) {
    const pr = this.db.prepare("SELECT number FROM prs WHERE branch=? AND state='open'").get(branch) as { number: number } | undefined;
    if (pr) this.triggerCi(this.getPr(pr.number)!.headSha);
  }

  /** Trusted CI workflow: checkout the exact SHA in a clean temp dir and run the test command. */
  triggerCi(sha: string): number {
    const { id } = this.db.prepare("INSERT INTO checks(sha, name, conclusion, workflow_ref) VALUES (?,?, 'pending', ?) RETURNING id")
      .get(sha, REQUIRED_CHECK, TRUSTED_WORKFLOW) as { id: number };
    const p = new Promise<void>((resolve) => {
      const dir = mkdtempSync(join(tmpdir(), 'local-ci-'));
      const finish = (conclusion: Check['conclusion'], log: string) => {
        // Forge closed meanwhile (origin reconfigured, shutdown): the next forge on this db marks it infra_error.
        if (this.db.isOpen) this.db.prepare('UPDATE checks SET conclusion=?, log=? WHERE id=?').run(conclusion, log.slice(-6000), id);
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows file locks: leave temp dir */ }
        resolve();
      };
      try {
        git(tmpdir(), ['clone', '--quiet', '--no-checkout', this.bare, dir]);
        git(dir, ['checkout', '--quiet', sha]);
      } catch (e) { return finish('infra_error', String(e)); }
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
      delete env.NODE_TEST_CONTEXT; // CI must not inherit the host's test runner context
      const child = spawn(this.ciCommand, { cwd: dir, env, shell: true, detached: process.platform !== 'win32' });
      let log = `$ ${this.ciCommand}\n`, done = false, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, this.ciTimeoutMs);
      const end = (c: Check['conclusion'], l: string) => { if (done) return; done = true; clearTimeout(timer); finish(c, l); };
      child.stdout!.on('data', (d) => (log = (log + d).slice(-20000)));
      child.stderr!.on('data', (d) => (log = (log + d).slice(-20000)));
      child.on('error', (e) => end('infra_error', String(e)));
      // A timeout is reported as a failure (with the reason in the log) so the repair worker sees it.
      child.on('close', (code) => end(timedOut ? 'failure' : code === 0 ? 'success' : 'failure',
        timedOut ? log + `\nCI timed out after ${Math.round(this.ciTimeoutMs / 1000)}s` : log));
    });
    this.pendingCi.add(p);
    p.finally(() => this.pendingCi.delete(p));
    return id;
  }

  merge(n: number, expectedHeadSha: string): string {
    const pr = this.getPr(n);
    if (!pr || pr.state !== 'open') throw new Error(`PR #${n} not open`);
    if (pr.headSha !== expectedHeadSha) throw new HeadMovedError(`PR #${n} head is ${pr.headSha}, expected ${expectedHeadSha}`);
    const dir = mkdtempSync(join(tmpdir(), 'local-merge-'));
    try {
      git(tmpdir(), ['clone', '--quiet', '--branch', pr.base, this.bare, dir]);
      git(dir, ['merge', '--squash', '--quiet', expectedHeadSha]); // guard: merge the SHA, not the branch name
      git(dir, ['commit', '--quiet', '-m', `${pr.title} (#${n})`]);
      git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${pr.base}`]); // rejected if base moved (non-fast-forward)
      const sha = git(dir, ['rev-parse', 'HEAD']);
      this.db.prepare("UPDATE prs SET state='merged', merge_sha=? WHERE number=?").run(sha, n);
      return sha;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  close() { this.db.close(); }

  async idle() { while (this.pendingCi.size) await Promise.all([...this.pendingCi]); }

  /** Test hook: list everything, as if a webhook redelivered all events. */
  allPrs(): PullRequest[] {
    return (this.db.prepare('SELECT * FROM prs ORDER BY number').all() as Record<string, unknown>[]).map((r) => this.row(r)!);
  }
}
