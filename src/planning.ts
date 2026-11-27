import { randomUUID } from 'node:crypto';
import { tx, type DB } from './db.js';
import { claudeUsageRetryAt } from './usage-limit.js';
import { emit } from './events.js';
import type { Orchestrator } from './orchestrator.js';
import { draftPlan, MALFORMED_TASK, validatePlan, type PlanValidation } from './plan.js';
import type { PlanShape } from './plan-shape.js';
import type { Project } from './types.js';

interface StoredRequest { id: string; project_id: string; text: string; started_at: string; retry_at: number; failures: number }

export function plannerRetryAt(error: string, now: number): number | null {
  return claudeUsageRetryAt(error.replace(/^planner error:\s*/i, ''), now) ??
    (/timed out|rate limit|service unavailable|connection reset|temporarily unavailable/i.test(error) ? now + 30_000 : null);
}

export const MAX_PLANNER_REQUEST = 12_000;

export interface PlanningRequest { requestId: string; projectId: string; text: string; startedAt: string; lastNote: string | null; lineage: string | null }
export type PlanningOutcome =
  | { kind: 'drafted'; requestId: string; planId: number; version: number; validation: PlanValidation; shape: PlanShape; reply: string }
  | { kind: 'declined'; requestId: string; reply: string }
  | { kind: 'failed'; requestId: string; error: string };

/**
 * Runs planner requests in the background and reports them as events, so the dashboard can show a
 * planning screen (plan_requested → plan_progress* → plan_ready | plan_declined | plan_failed).
 * One request per project at a time. In-flight requests are in memory only; a restart drops them.
 */
export class PlanningService {
  private active = new Map<string, PlanningRequest>();
  private work = new Set<Promise<unknown>>();
  constructor(private db: DB, private orch: Orchestrator) {}

  list(): PlanningRequest[] { return [...this.active.values()]; }

  /** Resume durable chat requests after restart or a scheduled retry. */
  recoverChat(now = Date.now()) {
    const queued = this.db.prepare('SELECT * FROM planning_requests WHERE retry_at<=? ORDER BY started_at').all(now) as unknown as StoredRequest[];
    for (const row of queued) {
      if ([...this.active.values()].some((r) => r.projectId === row.project_id)) continue;
      const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as unknown as Project | undefined;
      if (!project) continue;
      const req: PlanningRequest = { requestId: row.id, projectId: row.project_id, text: row.text, startedAt: row.started_at, lastNote: null, lineage: null };
      this.active.set(req.requestId, req);
      const job = this.finish(project, req);
      this.work.add(job);
      void job.finally(() => this.work.delete(job));
    }
  }

  start(project: Project, text: string, onDone?: (o: PlanningOutcome) => void, opts: { lineage?: string | null; phaseId?: number } = {}): PlanningRequest {
    const r = this.begin(project, text, opts.lineage ?? null);
    const p = this.finish(project, r, opts.phaseId).then((o) => { try { onDone?.(o); } catch { /* caller's problem */ } return o; });
    this.work.add(p); p.finally(() => this.work.delete(p));
    return r;
  }

  /** Starts planning and waits for the outcome (CLI demo, tests). */
  async run(project: Project, text: string): Promise<PlanningOutcome> { return this.finish(project, this.begin(project, text)); }

  async idle() { while (this.work.size) await Promise.all([...this.work]); }

  private begin(project: Project, text: string, lineage: string | null = null): PlanningRequest {
    text = text.trim();
    if (text.length > MAX_PLANNER_REQUEST) throw new Error('Request exceeds ' + MAX_PLANNER_REQUEST + ' characters; split it into roadmap phases');
    if (!text) throw new Error('empty request');
    if ([...this.active.values()].some((r) => r.projectId === project.id)) throw new Error('a plan is already being drafted for this project');
    const r: PlanningRequest = { requestId: randomUUID(), projectId: project.id, text, startedAt: new Date().toISOString(), lastNote: null, lineage };
    if (!lineage && this.db.prepare('SELECT 1 FROM planning_requests WHERE project_id=?').get(project.id)) {
      throw new Error('A saved chat request is already pending or scheduled to retry');
    }
    tx(this.db, () => {
      if (!lineage) this.db.prepare('INSERT INTO planning_requests(id,project_id,text,started_at) VALUES (?,?,?,?)')
        .run(r.requestId, r.projectId, r.text, r.startedAt);
      this.db.prepare("INSERT INTO messages(project_id, role, text) VALUES (?, 'user', ?)").run(project.id, text);
      emit(this.db, { projectId: project.id, type: 'chat_user', data: { text } });
      emit(this.db, { projectId: project.id, type: 'plan_requested', data: { requestId: r.requestId } });
    });
    this.active.set(r.requestId, r);
    return r;
  }

  private async finish(project: Project, r: PlanningRequest, phaseId?: number): Promise<PlanningOutcome> {
    const say = (role: 'orchestrator' | 'system', text: string, planId: number | null = null) => {
      this.db.prepare('INSERT INTO messages(project_id, role, text, plan_id) VALUES (?,?,?,?)').run(project.id, role, text, planId);
      emit(this.db, { projectId: project.id, type: role === 'system' ? 'chat_system' : 'chat_orchestrator', data: { text, planId } });
    };
    let lastAt = 0;
    const progress = (note: string) => {
      r.lastNote = note;
      if (Date.now() - lastAt < 750) return; // the screen needs a pulse, not every token
      lastAt = Date.now();
      emit(this.db, { projectId: project.id, type: 'plan_progress', data: { requestId: r.requestId, note } });
    };
    try {
      const { reply, plan, baseSha } = await this.orch.draft(project, r.text, progress);
      if (!plan?.tasks?.length) {
        this.db.prepare('DELETE FROM planning_requests WHERE id=?').run(r.requestId);
        say('orchestrator', reply || 'The planner did not propose any tasks.');
        emit(this.db, { projectId: project.id, type: 'plan_declined', data: { requestId: r.requestId, reply } });
        return { kind: 'declined', requestId: r.requestId, reply };
      }
      if (validatePlan(plan).errors.includes(MALFORMED_TASK)) throw new Error(MALFORMED_TASK);
      const d = draftPlan(this.db, project.id, plan, r.lineage, (planId) => {
        this.db.prepare('DELETE FROM planning_requests WHERE id=?').run(r.requestId);
        if (phaseId !== undefined) this.db.prepare("UPDATE phases SET status='review', plan_id=? WHERE id=? AND status='drafting'").run(planId, phaseId);
      }, baseSha);
      const summary = `${reply}\n\nPlan v${d.version}: ${plan.summary}` +
        (d.validation.errors.length ? `\nErrors: ${d.validation.errors.join('; ')}` : '') +
        (d.validation.warnings.length ? `\nWarnings: ${d.validation.warnings.join('; ')}` : '');
      say('orchestrator', summary, d.planId);
      emit(this.db, { projectId: project.id, type: 'plan_ready', data: { requestId: r.requestId, planId: d.planId, version: d.version, shape: d.shape } });
      return { kind: 'drafted', requestId: r.requestId, ...d, reply: summary };
    } catch (e) {
      const error = String((e as Error).message ?? e).slice(0, 500);
      const retryAt = plannerRetryAt(error, Date.now());
      if (retryAt !== null && this.db.prepare('UPDATE planning_requests SET failures=failures+1,retry_at=? WHERE id=? AND failures<1').run(retryAt, r.requestId).changes) {
        say('system', 'Planning paused. Vizor will retry this request automatically at ' + new Date(retryAt).toISOString());
        emit(this.db, { projectId: project.id, type: 'plan_retry_scheduled', data: { requestId: r.requestId, error, retryAt } });
        return { kind: 'failed', requestId: r.requestId, error };
      }
      this.db.prepare('DELETE FROM planning_requests WHERE id=?').run(r.requestId);
      say('system', `Planning failed: ${error}`);
      emit(this.db, { projectId: project.id, type: 'plan_failed', data: { requestId: r.requestId, error } });
      return { kind: 'failed', requestId: r.requestId, error };
    } finally { this.active.delete(r.requestId); }
  }
}
