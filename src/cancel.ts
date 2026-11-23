import type { DB } from './db.js';
import { TERMINAL, type TaskRow, type TaskStatus } from './types.js';

export interface DepNode { key: string; deps: string[]; status: TaskStatus }
export interface Reroute { key: string; before: string[]; after: string[] }

/** Statuses an owner may not cancel: already final, or a merge is already under way. */
const NOT_CANCELLABLE: TaskStatus[] = ['merged', 'merging', 'cancelled'];

/**
 * Pure. For every live task (not merged/cancelled) that depends on cancelledKey, replace that
 * dependency with the cancelled task's own deps, keeping order, dropping duplicates, and never
 * making a task depend on itself. `tasks` is expected to be one plan's tasks.
 */
export function rerouteDeps(tasks: DepNode[], cancelledKey: string): Reroute[] {
  const inherited = tasks.find((t) => t.key === cancelledKey)?.deps ?? [];
  const out: Reroute[] = [];
  for (const t of tasks) {
    if (t.key === cancelledKey || TERMINAL.includes(t.status) || !t.deps.includes(cancelledKey)) continue;
    const after: string[] = [];
    for (const d of t.deps) {
      for (const k of d === cancelledKey ? inherited : [d]) {
        if (k !== t.key && k !== cancelledKey && !after.includes(k)) after.push(k);
      }
    }
    out.push({ key: t.key, before: [...t.deps], after });
  }
  return out;
}

export interface CancelPlan { task: TaskRow; cancellable: boolean; reason?: string; reroutes: Reroute[] }

/** Read-only preview of cancelTask: what would be refused and which dependents would be rerouted. */
export function planCancel(db: DB, taskId: string): CancelPlan {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as TaskRow | undefined;
  if (!task) throw new Error(`task ${taskId} not found`);
  const siblings = (db.prepare('SELECT key, deps, status FROM tasks WHERE plan_id=?').all(task.plan_id) as { key: string; deps: string; status: TaskStatus }[])
    .map((r) => ({ key: r.key, deps: JSON.parse(r.deps) as string[], status: r.status }));
  const reroutes = rerouteDeps(siblings, task.key);
  if (NOT_CANCELLABLE.includes(task.status)) {
    const reason = task.status === 'merging'
      ? `task ${task.key} is merging; its PR has already been merged and is being verified`
      : `task ${task.key} is already ${task.status}`;
    return { task, cancellable: false, reason, reroutes };
  }
  return { task, cancellable: true, reroutes };
}
