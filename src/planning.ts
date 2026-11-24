import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { emit } from './events.js';
import type { Orchestrator } from './orchestrator.js';
import { draftPlan, type PlanValidation } from './plan.js';
import type { Project } from './types.js';

export interface PlanningRequest { requestId: string; projectId: string; text: string; startedAt: string; lastNote: string | null; lineage: string | null }
export type PlanningOutcome =
  | { kind: 'drafted'; requestId: string; planId: number; version: number; validation: PlanValidation; reply: string }
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

  /** Starts planning and returns at once. */
  start(project: Project, text: string, onDone?: (o: PlanningOutcome) => void, opts: { lineage?: string | null } = {}): PlanningRequest {
    const r = this.begin(project, text, opts.lineage ?? null);
    const p = this.finish(project, r).then((o) => { try { onDone?.(o); } catch { /* caller's problem */ } return o; });
    this.work.add(p); p.finally(() => this.work.delete(p));
    return r;
  }

  /** Starts planning and waits for the outcome (CLI demo, tests). */
  async run(project: Project, text: string): Promise<PlanningOutcome> { return this.finish(project, this.begin(project, text)); }

  async idle() { while (this.work.size) await Promise.all([...this.work]); }

  private begin(project: Project, text: string, lineage: string | null = null): PlanningRequest {
    text = text.trim().slice(0, 4000);
    if (!text) throw new Error('empty request');
    if ([...this.active.values()].some((r) => r.projectId === project.id)) throw new Error('a plan is already being drafted for this project');
    const r: PlanningRequest = { requestId: randomUUID(), projectId: project.id, text, startedAt: new Date().toISOString(), lastNote: null, lineage };
    this.active.set(r.requestId, r);
    this.db.prepare("INSERT INTO messages(project_id, role, text) VALUES (?, 'user', ?)").run(project.id, text);
    emit(this.db, { projectId: project.id, type: 'chat_user', data: { text } });
    emit(this.db, { projectId: project.id, type: 'plan_requested', data: { requestId: r.requestId } });
    return r;
  }

  private async finish(project: Project, r: PlanningRequest): Promise<PlanningOutcome> {
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
      const { reply, plan } = await this.orch.draft(project, r.text, progress);
      if (!plan?.tasks?.length) {
        say('orchestrator', reply || 'The planner did not propose any tasks.');
        emit(this.db, { projectId: project.id, type: 'plan_declined', data: { requestId: r.requestId, reply } });
        return { kind: 'declined', requestId: r.requestId, reply };
      }
      const d = draftPlan(this.db, project.id, plan, r.lineage);
      const summary = `${reply}\n\nPlan v${d.version}: ${plan.summary}` +
        (d.validation.errors.length ? `\nErrors: ${d.validation.errors.join('; ')}` : '') +
        (d.validation.warnings.length ? `\nWarnings: ${d.validation.warnings.join('; ')}` : '');
      say('orchestrator', summary, d.planId);
      emit(this.db, { projectId: project.id, type: 'plan_ready', data: { requestId: r.requestId, planId: d.planId, version: d.version } });
      return { kind: 'drafted', requestId: r.requestId, ...d, reply: summary };
    } catch (e) {
      const error = String((e as Error).message ?? e).slice(0, 500);
      say('system', `Planning failed: ${error}`);
      emit(this.db, { projectId: project.id, type: 'plan_failed', data: { requestId: r.requestId, error } });
      return { kind: 'failed', requestId: r.requestId, error };
    } finally { this.active.delete(r.requestId); }
  }
}
