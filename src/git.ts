import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileChange } from './types.js';

const BOT = ['-c', 'user.name=local-bot', '-c', 'user.email=local-bot@localhost', '-c', 'commit.gpgsign=false'];

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', [...BOT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${err.stderr || err.message}`);
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
export function ensureWorktree(repo: string, path: string, branch: string, base: string): { created: boolean; baseSha: string } {
  git(repo, ['fetch', '--quiet', 'origin']);
  const baseSha = revParse(repo, `origin/${base}`);
  if (!baseSha) throw new Error(`origin/${base} not found`);
  if (existsSync(path) && revParse(path, 'HEAD')) {
    const cur = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur !== branch) throw new Error(`worktree ${path} is on ${cur}, expected ${branch}`);
    return { created: false, baseSha };
  }
  mkdirSync(dirname(path), { recursive: true });
  git(repo, ['worktree', 'prune']);
  if (revParse(repo, `refs/heads/${branch}`)) git(repo, ['worktree', 'add', path, branch]);
  else if (revParse(repo, `refs/remotes/origin/${branch}`)) git(repo, ['worktree', 'add', '-b', branch, path, `origin/${branch}`]);
  else git(repo, ['worktree', 'add', '-b', branch, path, baseSha]);
  return { created: true, baseSha };
}

export function hasUncommitted(wt: string): boolean {
  return git(wt, ['status', '--porcelain']).length > 0;
}

export function commitAll(wt: string, message: string): boolean {
  git(wt, ['add', '-A']);
  if (!git(wt, ['diff', '--cached', '--name-only'])) return false;
  git(wt, ['commit', '--quiet', '-m', message]);
  return true;
}

/** Changes the task introduced relative to the merge-base with current origin/base. */
export function taskChanges(wt: string, base: string): FileChange[] {
  git(wt, ['fetch', '--quiet', 'origin']);
  return parseNameStatus(git(wt, ['diff', '--name-status', '-M', `origin/${base}...HEAD`]));
}

export function push(wt: string, branch: string): void {
  git(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
}

/** Controlled update: merge current base into the task branch (no force-push needed). */
export function updateFromBase(wt: string, base: string): { ok: true } | { ok: false; conflicts: string[] } {
  git(wt, ['fetch', '--quiet', 'origin']);
  try {
    execFileSync('git', [...BOT, 'merge', '--no-edit', '--quiet', `origin/${base}`], { cwd: wt, stdio: 'pipe' });
    return { ok: true };
  } catch {
    const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean);
    git(wt, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflicts };
  }
}
