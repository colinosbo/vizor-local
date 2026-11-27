import type { DB } from './db.js';
import { emit } from './events.js';
import { executionRemote, fetchBase, git, revParse } from './git.js';
import type { Project } from './types.js';

export type SyncResult = { synced: true; from: string; to: string } | { synced: false; reason: string };

/**
 * Bring the owner's own folder up to date with the local origin after a merge.
 * Fast-forward only, and only when that cannot touch the owner's work: right branch, no uncommitted
 * changes to tracked files, and no local commits the origin lacks. Otherwise it reports why and does nothing.
 */
export function syncCheckout(db: DB, p: Project, opts: { quiet?: boolean } = {}): SyncResult {
  const repo = p.repo_path, base = p.base_branch;
  const skip = (reason: string): SyncResult => {
    if (!opts.quiet) emit(db, { projectId: p.id, type: 'folder_sync_skipped', data: { reason } });
    return { synced: false, reason };
  };
  try {
    const target = fetchBase(repo, base, executionRemote(p));
    const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
    if (branch !== base) return skip(`your folder is on branch ${branch || '(none)'}, not ${base}`);
    if (git(repo, ['status', '--porcelain', '--untracked-files=no'])) return skip('your folder has uncommitted changes');
    const head = revParse(repo, 'HEAD');
    if (!head || !target) return skip(`origin/${base} not found`);
    if (head === target) return { synced: false, reason: 'already up to date' };
    if (git(repo, ['merge-base', 'HEAD', target], { allowFail: true }) !== head) return skip('your folder has commits that are not in the origin');
    git(repo, ['merge', '--ff-only', '--quiet', target]);
    emit(db, { projectId: p.id, type: 'folder_synced', data: { from: head, to: target } });
    return { synced: true, from: head, to: target };
  } catch (e) {
    return skip('update failed: ' + String((e as Error).message ?? e).slice(0, 300));
  }
}

/** Read-only view of the folder for the Ship screen. */
export function folderStatus(p: Project) {
  const repo = p.repo_path, base = p.base_branch;
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  const dirty = !!git(repo, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true });
  const head = revParse(repo, 'HEAD');
  const remote = executionRemote(p);
  const ref = (remote === 'origin' ? 'refs/remotes/origin/' : 'refs/remotes/vizor-base/') + base;
  const origin = revParse(repo, ref);
  const behind = head && origin ? Number(git(repo, ['rev-list', '--count', 'HEAD..' + ref], { allowFail: true }) || 0) : 0;
  const ahead = head && origin ? Number(git(repo, ['rev-list', '--count', ref + '..HEAD'], { allowFail: true }) || 0) : 0;
  return { branch, dirty, head, origin, behind, ahead };
}
