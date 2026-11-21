import { execFile } from 'node:child_process';
import type { DB } from './db.js';
import { emit } from './events.js';
import type { Project } from './types.js';

/** Async git for network operations, so a slow fetch/push never blocks the server or scheduler. */
function gitA(cwd: string, args: string[], timeout = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) =>
      e ? reject(new Error(String(err || e.message).trim().slice(0, 500) || 'git failed')) : resolve(String(out).trim()));
  });
}
const tryGit = (cwd: string, args: string[]) => gitA(cwd, args).catch(() => null);

export const GITHUB_URL = /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?|git@github\.com:[\w.-]+\/[\w.-]+?(\.git)?)$/;

export interface ShipStatus {
  remote: string | null;        // the project's `github` remote URL
  base: string;
  local: string | null;         // origin/<base>: what Local has merged
  github: string | null;        // github/<base> after fetch
  ahead: { sha: string; subject: string }[]; // on Local's main, not on GitHub (newest first, max 50)
  aheadCount: number;
  behind: number;               // on GitHub, not on Local's main → push refused
  fetchError: string | null;
  canPush: boolean;
}

/** What a push would send. Fetches from GitHub using the owner's own git credentials (none stored by Local). */
export async function shipStatus(p: Project, opts: { fetch?: boolean } = {}): Promise<ShipStatus> {
  const repo = p.repo_path, base = p.base_branch;
  const remote = await tryGit(repo, ['remote', 'get-url', 'github']);
  await gitA(repo, ['fetch', '--quiet', 'origin']);
  const local = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
  const empty: ShipStatus = { remote, base, local, github: null, ahead: [], aheadCount: 0, behind: 0, fetchError: null, canPush: false };
  if (!remote || !local) return empty;
  let fetchError: string | null = null;
  if (opts.fetch !== false) await gitA(repo, ['fetch', '--quiet', 'github']).catch((e) => { fetchError = String(e.message); });
  const github = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/github/${base}`]);
  const range = github ? `${github}..${local}` : local;
  const log = (await tryGit(repo, ['log', '--format=%H%x09%s', '-n', '50', range])) ?? '';
  const ahead = log.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
  const aheadCount = Number((await tryGit(repo, ['rev-list', '--count', range])) ?? ahead.length);
  const behind = github ? Number((await tryGit(repo, ['rev-list', '--count', `${local}..${github}`])) ?? 0) : 0;
  return { ...empty, github, ahead, aheadCount, behind, fetchError, canPush: !fetchError && aheadCount > 0 && behind === 0 };
}

/**
 * Owner-initiated push of exactly the commit they reviewed. Fast-forward only: never forces,
 * refuses if GitHub has commits Local has not seen, refuses if Local's main moved since review.
 */
export async function pushToGithub(db: DB, p: Project, expectedSha: string): Promise<{ pushed: number; sha: string; tag: string }> {
  const s = await shipStatus(p, { fetch: true });
  if (!s.remote) throw new Error('no GitHub repo connected for this project');
  if (s.fetchError) throw new Error('could not reach GitHub: ' + s.fetchError);
  if (!expectedSha || s.local !== expectedSha) throw new Error('main changed since you reviewed it; check again before pushing');
  if (s.behind > 0) throw new Error(`GitHub has ${s.behind} commit(s) Local does not have; not pushing (fast-forward only)`);
  if (s.aheadCount === 0) throw new Error('nothing to push; GitHub is up to date');
  // An annotated tag carries what this push contains (plan summaries and merged tasks), so GitHub shows what was done.
  const tag = 'vizor-' + new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  await gitA(p.repo_path, ['-c', 'user.name=Vizor Local', '-c', 'user.email=vizor-local@localhost', 'tag', '-a', tag, expectedSha, '-m', releaseNote(db, p)]);
  await gitA(p.repo_path, ['push', '--quiet', 'github', `${expectedSha}:refs/heads/${p.base_branch}`, `refs/tags/${tag}`], 180_000);
  emit(db, { projectId: p.id, type: 'pushed_to_github', data: { sha: expectedSha, commits: s.aheadCount, remote: s.remote, tag } });
  return { pushed: s.aheadCount, sha: expectedSha, tag };
}

/** One-click push of everything merged so far. Same fast-forward-only rules as a reviewed push. */
export async function pushNow(db: DB, p: Project) {
  const s = await shipStatus(p, { fetch: true });
  if (!s.remote) throw new Error('no GitHub repo connected for this project; connect one in Ship');
  if (!s.local) throw new Error('nothing merged yet');
  return pushToGithub(db, p, s.local);
}

/** What changed since the last push, from Vizor's own records: plan summaries and merged task titles. */
export function releaseNote(db: DB, p: Project): string {
  const last = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE project_id=? AND type='pushed_to_github'").get(p.id) as { s: number }).s;
  const rows = db.prepare("SELECT t.title, t.pr_number, pl.version, pl.body FROM events e JOIN tasks t ON t.id=e.task_id JOIN plans pl ON pl.id=t.plan_id " +
    "WHERE e.project_id=? AND e.type='task_merged' AND e.seq>? ORDER BY e.seq").all(p.id, last) as { title: string; pr_number: number | null; version: number; body: string }[];
  const plans = new Map<number, { summary: string; items: string[] }>();
  for (const r of rows) {
    let g = plans.get(r.version);
    if (!g) { let summary = ''; try { summary = JSON.parse(r.body).summary ?? ''; } catch { /* none */ } plans.set(r.version, (g = { summary, items: [] })); }
    g.items.push(`- ${r.title}${r.pr_number ? ` (PR #${r.pr_number})` : ''}`);
  }
  return ['Pushed by Vizor Local', ...[...plans].map(([v, g]) => `\nPlan v${v}: ${g.summary}\n${g.items.join('\n')}`)].join('\n').slice(0, 8000);
}

export async function setGithubRemote(db: DB, p: Project, url: string) {
  url = url.trim();
  if (!GITHUB_URL.test(url)) throw new Error('use a GitHub repo URL like https://github.com/you/repo.git');
  const has = await tryGit(p.repo_path, ['remote', 'get-url', 'github']);
  await gitA(p.repo_path, has ? ['remote', 'set-url', 'github', url] : ['remote', 'add', 'github', url]);
  emit(db, { projectId: p.id, type: 'github_connected', data: { url } });
}
