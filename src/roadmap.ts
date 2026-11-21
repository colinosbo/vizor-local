import type { DB } from './db.js';
import { emit } from './events.js';
import type { PlanningService } from './planning.js';
import type { Project } from './types.js';

export type PhaseStatus = 'queued' | 'drafting' | 'review' | 'running' | 'done' | 'failed';
export interface PhaseRow { id: number; project_id: string; position: number; title: string; prompt: string; status: PhaseStatus; plan_id: number | null; error: string | null }

/**
 * Split pasted roadmap text into phases. Phases are separated by a line containing only `---`;
 * the first non-empty line of each phase is its title (a leading `#`, `Phase N:` etc. is kept as written).
 */
export function parseRoadmap(text: string): { title: string; prompt: string }[] {
  return text.replace(/\r\n/g, '\n').split(/^\s*-{3,}\s*$/m).map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const lines = chunk.split('\n');
    const title = lines[0].replace(/^#+\s*/, '').trim().slice(0, 120);
    const prompt = chunk.slice(0, 4000);
    return { title, prompt };
  });
}

/**
 * Runs a project's phases in order. It only ever DRAFTS the next plan; the owner still approves every plan.
 * queued → drafting → review (plan drafted) → running (owner approved) → done (all tasks merged).
 * A phase whose plan fails or is declined becomes `failed` and the roadmap stops until the owner retries it.
 */
export class RoadmapService {
  constructor(private db: DB, private planning: PlanningService) {
    // Drafting is in memory; after a restart those phases are drafted again.
    db.prepare("UPDATE phases SET status='queued', error=NULL WHERE status='drafting'").run();
  }

  phases(projectId: string) { return this.db.prepare('SELECT * FROM phases WHERE project_id=? ORDER BY position, id').all(projectId) as unknown as PhaseRow[]; }
  private set(id: number, f: { status?: PhaseStatus; plan_id?: number | null; error?: string | null }) {
    const keys = Object.keys(f);
    this.db.prepare(`UPDATE phases SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...(Object.values(f) as (string | number | null)[]), id);
  }
  private project(id: string) { return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project | undefined; }

  add(projectId: string, text: string): PhaseRow[] {
    if (!this.project(projectId)) throw new Error(`unknown project ${projectId}`);
    const parsed = parseRoadmap(text);
    if (!parsed.length) throw new Error('no phases found; separate phases with a line containing only ---');
    if (parsed.length > 20) throw new Error('at most 20 phases at a time');
    const start = (this.db.prepare('SELECT COALESCE(MAX(position),0) AS n FROM phases WHERE project_id=?').get(projectId) as { n: number }).n;
    const ins = this.db.prepare('INSERT INTO phases(project_id, position, title, prompt) VALUES (?,?,?,?)');
    parsed.forEach((ph, i) => ins.run(projectId, start + i + 1, ph.title, ph.prompt));
    emit(this.db, { projectId, type: 'roadmap_updated', data: { added: parsed.length } });
    return this.phases(projectId);
  }

  retry(id: number) {
    const ph = this.db.prepare('SELECT * FROM phases WHERE id=?').get(id) as unknown as PhaseRow | undefined;
    if (!ph || ph.status !== 'failed') throw new Error('only a failed phase can be retried');
    this.set(id, { status: 'queued', error: null, plan_id: null });
    emit(this.db, { projectId: ph.project_id, type: 'roadmap_updated', data: { retried: id } });
  }

  remove(id: number) {
    const ph = this.db.prepare('SELECT * FROM phases WHERE id=?').get(id) as unknown as PhaseRow | undefined;
    if (!ph || !['queued', 'failed'].includes(ph.status)) throw new Error('only a queued or failed phase can be removed');
    this.db.prepare('DELETE FROM phases WHERE id=?').run(id);
    emit(this.db, { projectId: ph.project_id, type: 'roadmap_updated', data: { removed: id } });
  }

  pause(projectId: string, paused: boolean) {
    this.db.prepare('UPDATE projects SET roadmap_paused=? WHERE id=?').run(paused ? 1 : 0, projectId);
    emit(this.db, { projectId, type: paused ? 'roadmap_paused' : 'roadmap_resumed' });
  }

  /** Advance every project's roadmap by at most one step. Safe to call often. */
  tick() {
    const pids = (this.db.prepare("SELECT DISTINCT project_id FROM phases WHERE status NOT IN ('done')").all() as { project_id: string }[]).map((r) => r.project_id);
    for (const pid of pids) this.advance(pid);
  }

  private advance(pid: string) {
    const p = this.project(pid);
    if (!p) return;
    const phases = this.phases(pid);
    for (const ph of phases) {
      if (ph.status === 'review' && ph.plan_id) {
        const plan = this.db.prepare('SELECT status FROM plans WHERE id=?').get(ph.plan_id) as { status: string } | undefined;
        if (plan?.status === 'approved') { this.set(ph.id, { status: 'running' }); emit(this.db, { projectId: pid, type: 'phase_running', data: { phase: ph.id, title: ph.title } }); }
        else if (plan?.status === 'superseded') this.set(ph.id, { status: 'failed', error: 'its plan was replaced by another plan before approval' });
      }
      if (ph.status === 'running' && ph.plan_id) {
        const c = this.db.prepare(`SELECT COUNT(*) AS n, SUM(status='merged') AS merged, SUM(status NOT IN ('merged','cancelled')) AS open FROM tasks WHERE plan_id=?`).get(ph.plan_id) as { n: number; merged: number; open: number };
        const plan = this.db.prepare('SELECT status FROM plans WHERE id=?').get(ph.plan_id) as { status: string } | undefined;
        if (c.n > 0 && (c.open ?? 0) === 0 && (c.merged ?? 0) > 0) { this.set(ph.id, { status: 'done' }); emit(this.db, { projectId: pid, type: 'phase_done', data: { phase: ph.id, title: ph.title } }); }
        else if (plan?.status === 'superseded') this.set(ph.id, { status: 'failed', error: 'its plan was replaced by a newer plan while running' });
      }
    }
    const now = this.phases(pid);
    if (p.roadmap_paused) return;
    if (now.some((ph) => ['drafting', 'review', 'running', 'failed'].includes(ph.status))) return; // one phase at a time; failures stop the roadmap
    const next = now.find((ph) => ph.status === 'queued');
    if (!next) return;
    if (this.planning.list().some((r) => r.projectId === pid)) return; // owner is planning something by hand
    const busy = (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status IN ('pending','ready','running','waiting_ci','merging')`).get(pid) as { n: number }).n;
    if (busy) return; // let current work finish first
    const total = now.length, index = now.indexOf(next) + 1;
    this.set(next.id, { status: 'drafting', error: null });
    emit(this.db, { projectId: pid, type: 'phase_drafting', data: { phase: next.id, title: next.title } });
    try {
      this.planning.start(p, `Roadmap phase ${index} of ${total}: ${next.title}\n\n${next.prompt}`, (o) => {
        if (o.kind === 'drafted') this.set(next.id, { status: 'review', plan_id: o.planId });
        else this.set(next.id, { status: 'failed', error: o.kind === 'failed' ? o.error : `planner declined: ${o.reply}`.slice(0, 500) });
        emit(this.db, { projectId: pid, type: 'roadmap_updated', data: { phase: next.id, outcome: o.kind } });
      });
    } catch (e) {
      this.set(next.id, { status: 'failed', error: String((e as Error).message ?? e) });
    }
  }
}
