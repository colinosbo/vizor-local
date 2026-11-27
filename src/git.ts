import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FileChange, Project } from './types.js';

const BOT = ['-c', 'user.name=local-bot', '-c', 'user.email=local-bot@localhost', '-c', 'commit.gpgsign=false'];

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', [...BOT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    const err = e as { stderr?: string; message: string };
    const message = (err.stderr || err.message).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
    throw new Error('git ' + args[0] + ' failed in ' + cwd + ': ' + message);
  }
}

export function revParse(cwd: string, ref: string): string | null {
  const out = git(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { allowFail: true });
  return out || null;
}

/** Parse `git diff --name-status -M`, keeping BOTH paths for renames/copies. */
export function parseNameStatus(out: string): FileChange[] {
  return out.split('\n').filter(Boolean).map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status, paths };
  });
}

export function allPaths(changes: FileChange[]): string[] {
  return [...new Set(changes.flatMap((c) => c.paths))];
}

/**
 * One stable worktree + branch per task. Reuses an existing worktree/branch (recovery, repair)
 * and only creates the branch from the verified base when it does not exist yet.
 */
export function executionRemote(p: Pick<Project, 'repo_path' | 'forge_kind' | 'github_repo' | 'forge_origin'>): string {
  if (p.forge_kind === 'github') {
    if (!p.github_repo) throw new Error('GitHub repository is not configured');
    const origin = git(p.repo_path, ['config', '--get', 'remote.origin.url'], { allowFail: true });
    if (githubRepoFromRemote(origin)?.toLowerCase() === p.github_repo.toLowerCase()) return origin;
    return 'https://github.com/' + p.github_repo + '.git';
  }
  return p.forge_origin ? resolve(p.repo_path, p.forge_origin) : 'origin';
}

export function githubRepoFromRemote(remote: string): string | null {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote)?.[1] ?? null;
}

export function fetchBase(repo: string, base: string, remote = 'origin'): string {
  const ref = remote === 'origin' ? 'refs/remotes/origin/' + base : 'refs/remotes/vizor-base/' + base;
  git(repo, ['fetch', '--quiet', '--no-tags', '--', remote, '+refs/heads/' + base + ':' + ref]);
  const sha = revParse(repo, ref);
  if (!sha) throw new Error('base branch ' + base + ' not found');
  return sha;
}

export function ensureWorktree(repo: string, path: string, branch: string, base: string, remote = 'origin'): { created: boolean; baseSha: string } {
  const baseSha = fetchBase(repo, base, remote);
  if (existsSync(path) && revParse(path, 'HEAD')) {
    const cur = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur !== branch) throw new Error(`worktree ${path} is on ${cur}, expected ${branch}`);
    return { created: false, baseSha };
  }
  mkdirSync(dirname(path), { recursive: true });
  git(repo, ['worktree', 'prune']);
  if (revParse(repo, `refs/heads/${branch}`)) git(repo, ['worktree', 'add', path, branch]);
  else if (remote === 'origin' && revParse(repo, `refs/remotes/origin/${branch}`)) git(repo, ['worktree', 'add', '-b', branch, path, `origin/${branch}`]);
  else git(repo, ['worktree', 'add', '-b', branch, path, baseSha]);
  return { created: true, baseSha };
}

export function hasUncommitted(wt: string): boolean {
  return git(wt, ['status', '--porcelain']).length > 0;
}

/** Number of changed tracked files (same view as the folder `dirty` flag: untracked files are not counted). */
export function countUncommitted(cwd: string): number {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true }).split('\n').filter((l) => l.trim()).length;
}

export function commitAll(wt: string, message: string): boolean {
  git(wt, ['add', '-A']);
  if (!git(wt, ['diff', '--cached', '--name-only'])) return false;
  git(wt, ['commit', '--quiet', '-m', message]);
  return true;
}

/** Changes the task introduced relative to the merge-base with current origin/base. */
export function taskChanges(wt: string, base: string, remote = 'origin'): FileChange[] {
  const sha = fetchBase(wt, base, remote);
  return parseNameStatus(git(wt, ['diff', '--name-status', '-M', sha + '...HEAD']));
}

export function push(wt: string, branch: string, remote = 'origin'): void {
  git(wt, ['push', '--quiet', '--', remote, 'HEAD:refs/heads/' + branch]);
}

/** Merge the current base into the task branch, preserving working changes on a failed update. */
export function updateFromBase(wt: string, base: string, remote = 'origin'): { ok: true } | { ok: false; conflicts: string[] } {
  const sha = fetchBase(wt, base, remote);
  try {
    git(wt, ['merge', '--no-edit', '--quiet', sha]);
    return { ok: true };
  } catch (e) {
    const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    if (!conflicts.length) throw e;
    git(wt, ['merge', '--abort']);
    return { ok: false, conflicts };
  }
}
