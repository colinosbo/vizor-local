import type { DB } from './db.js';

export interface EventRow {
  seq: number; project_id: string | null; task_id: string | null; attempt_id: string | null;
  type: string; data: string; ts: string;
}

type Listener = (e: EventRow) => void;
const listeners = new Set<Listener>();

/** Append a numbered event, then notify live subscribers (SSE). Storage first, stream second. */
export function emit(db: DB, e: { projectId?: string | null; taskId?: string | null; attemptId?: string | null; type: string; data?: unknown }): number {
  const r = db.prepare('INSERT INTO events(project_id, task_id, attempt_id, type, data) VALUES (?,?,?,?,?) RETURNING *')
    .get(e.projectId ?? null, e.taskId ?? null, e.attemptId ?? null, e.type, JSON.stringify(e.data ?? {})) as unknown as EventRow;
  for (const l of listeners) { try { l(r); } catch { /* listener errors never affect runtime */ } }
  return r.seq;
}

/** Replay from a cursor: strictly greater than `after`, ordered, so reconnects have no gaps or duplicates. */
export function eventsAfter(db: DB, after: number, filter: { projectId?: string; taskId?: string } = {}, limit = 500): EventRow[] {
  const where: string[] = ['seq > ?'];
  const args: (string | number)[] = [after];
  if (filter.projectId) { where.push('project_id = ?'); args.push(filter.projectId); }
  if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId); }
  return db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, limit) as unknown as EventRow[];
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
