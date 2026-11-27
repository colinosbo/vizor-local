import type { DB } from './db.js';
import { emit } from './events.js';
import { PushBlockedError, pushNow } from './ship.js';
import type { Project } from './types.js';

/**
 * Opt-in per project: once every task has merged (a plan or roadmap phase is finished), push main to GitHub.
 * Each main SHA is handled once: a failure is recorded and shown, not retried in a loop.
 */
export class AutoPusher {
  private busy = new Set<string>();
  constructor(private db: DB) {}

  tick() {
    for (const p of this.db.prepare("SELECT * FROM projects WHERE auto_push=1 AND forge_kind='local'").all() as unknown as Project[]) {
      if (this.busy.has(p.id)) continue;
      const open = (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status NOT IN ('merged','cancelled')").get(p.id) as { n: number }).n;
      if (open) continue;
      const head = this.db.prepare("SELECT merge_sha FROM tasks WHERE project_id=? AND status='merged' AND merge_sha IS NOT NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(p.id) as { merge_sha: string } | undefined;
      if (!head || head.merge_sha === p.auto_pushed_sha) continue;
      this.busy.add(p.id);
      const done = (error: string | null) => {
        this.db.prepare('UPDATE projects SET auto_pushed_sha=?, auto_push_error=? WHERE id=?').run(head.merge_sha, error, p.id);
        if (error) emit(this.db, { projectId: p.id, type: 'auto_push_failed', data: { error } });
        this.busy.delete(p.id);
      };
      // A guard refusal is always recorded, even if a blocked file name happens to contain "up to date".
      pushNow(this.db, p).then(() => done(null), (e: Error) =>
        done(e instanceof PushBlockedError ? e.message : /up to date/.test(e.message) ? null : e.message));
    }
  }
}
