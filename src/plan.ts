import type { DB } from './db.js';
import { tx } from './db.js';
import { emit } from './events.js';
import { scopesOverlap } from './scope.js';
import { MODEL_CHOICES, type PlanBody } from './types.js';

export interface PlanValidation { errors: string[]; warnings: string[] }

export function validatePlan(body: PlanBody): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!body || !Array.isArray(body.tasks) || body.tasks.length === 0) return { errors: ['plan has no tasks'], warnings };
  const keys = new Set<string>();
  for (const t of body.tasks) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.key ?? '')) errors.push(`invalid task key: ${JSON.stringify(t.key)}`);
    if (keys.has(t.key)) errors.push(`duplicate task key: ${t.key}`);
    keys.add(t.key);
    if (!t.title || !t.prompt) errors.push(`${t.key}: title and prompt are required`);
    if (!t.acceptance) errors.push(`${t.key}: acceptance criteria required`);
    if (!Array.isArray(t.writeScope) || t.writeScope.length === 0) errors.push(`${t.key}: writeScope required`);
    for (const g of t.writeScope ?? []) if (g.startsWith('/') || g.includes('..') || g === '**') errors.push(`${t.key}: unsafe scope ${g}`);
    if (!Array.isArray(t.deps)) errors.push(`${t.key}: deps must be an array`);
    if (t.model !== undefined && !MODEL_CHOICES.includes(t.model)) errors.push(`${t.key}: model must be one of ${MODEL_CHOICES.join(', ')}`);
  }
  for (const t of body.tasks) for (const d of t.deps ?? []) if (!keys.has(d)) errors.push(`${t.key}: missing dependency ${d}`);

  // Cycle detection (DFS, white/grey/black).
  const deps = new Map(body.tasks.map((t) => [t.key, t.deps ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (k: string, path: string[]): void => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) { errors.push(`dependency cycle: ${[...path, k].join(' -> ')}`); return; }
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) if (deps.has(d)) visit(d, [...path, k]);
    state.set(k, 2);
  };
  for (const k of deps.keys()) visit(k, []);

  // Overlapping write scopes without an ordering: runtime will hold the later task.
  if (errors.length === 0) {
    const reach = (from: string, to: string, seen = new Set<string>()): boolean =>
      (deps.get(from) ?? []).some((d) => d === to || (!seen.has(d) && (seen.add(d), reach(d, to, seen))));
    for (let i = 0; i < body.tasks.length; i++) for (let j = i + 1; j < body.tasks.length; j++) {
      const a = body.tasks[i], b = body.tasks[j];
      if (scopesOverlap(a.writeScope, b.writeScope) && !reach(a.key, b.key) && !reach(b.key, a.key))
        warnings.push(`${a.key} and ${b.key} have overlapping write scopes and no dependency; they will not run at the same time`);
    }
  }
  return { errors, warnings };
}

/** `lineage`: null for a chat plan, 'roadmap:<id>' for a roadmap phase. See approvePlan. */
export function draftPlan(db: DB, projectId: string, body: PlanBody, lineage: string | null = null): { planId: number; version: number; validation: PlanValidation } {
  const validation = validatePlan(body);
  return tx(db, () => {
    const v = (db.prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM plans WHERE project_id=?').get(projectId) as { v: number }).v;
    const r = db.prepare("INSERT INTO plans(project_id, version, status, body, lineage) VALUES (?,?,'draft',?,?) RETURNING id").get(projectId, v, JSON.stringify(body), lineage) as { id: number };
    emit(db, { projectId, type: 'plan_drafted', data: { planId: r.id, version: v, validation } });
    return { planId: r.id, version: v, validation };
  });
}

export interface InFlightTask { id: string; key: string; title: string; status: string; pr_number: number | null }

/** Thrown by approvePlan when the currently approved plan still has in-flight work and force was not given. */
export class PlanInFlightError extends Error {
  constructor(readonly version: number, readonly tasks: InFlightTask[]) {
    super(`approved plan v${version} still has in-flight tasks: ` +
      tasks.map((t) => `${t.key} (${t.status}${t.pr_number != null ? `, PR #${t.pr_number}` : ''})`).join(', '));
    this.name = 'PlanInFlightError';
  }
}

/** Owner-only: throw away a draft nobody will approve. Roadmap drafts are handled from their phase instead. */
export function discardPlan(db: DB, planId: number): void {
  tx(db, () => {
    const plan = db.prepare('SELECT id, project_id, version, status FROM plans WHERE id=?').get(planId) as { id: number; project_id: string; version: number; status: string } | undefined;
    if (!plan) throw new Error('plan not found');
    if (plan.status !== 'draft') throw new Error(`plan is ${plan.status}; only a draft can be discarded`);
    const phase = db.prepare("SELECT title FROM phases WHERE plan_id=? AND status='review'").get(planId) as { title: string } | undefined;
    if (phase) throw new Error(`this draft belongs to roadmap phase "${phase.title}"; remove that phase in the roadmap instead`);
    db.prepare("UPDATE plans SET status='superseded' WHERE id=?").run(planId);
    emit(db, { projectId: plan.project_id, type: 'plan_discarded', data: { planId, version: plan.version } });
  });
}

export const SUPERSEDED_HOLD = 'plan superseded while in flight; owner decision needed';

/** In flight: running, waiting on CI or merging — or holding an open PR (any non-terminal status with a pr_number). */
const IN_FLIGHT_SQL = `(status IN ('running','waiting_ci','merging') OR (pr_number IS NOT NULL AND status NOT IN ('merged','cancelled')))`;

/**
 * Owner-only. The orchestrator has no code path to this function, and `force` is only reachable from
 * the owner's authenticated HTTP route (POST /api/plans/:id/approve with `{"force": true}`); the CLI never passes it.
 *
 * Approving a new version supersedes the previous approved plan of the same lineage only: chat plans replace
 * chat plans, and a roadmap's phase plans replace that roadmap's earlier phase plans. Plans of other lineages
 * keep running; the runner never starts two tasks with overlapping write scopes at the same time. If the approved plan still has in-flight work
 * (running/waiting_ci/merging, or an open PR) approval is refused with PlanInFlightError and nothing changes.
 * With `force: true`, unstarted tasks are cancelled and every in-flight task is held for an owner decision (fail closed).
 */
export function approvePlan(db: DB, planId: number, opts: { force?: boolean } = {}): void {
  tx(db, () => {
    const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(planId) as { id: number; project_id: string; version: number; status: string; body: string; lineage: string | null } | undefined;
    if (!plan) throw new Error('plan not found');
    if (plan.status !== 'draft') throw new Error(`plan is ${plan.status}`);
    const body = JSON.parse(plan.body) as PlanBody;
    const { errors } = validatePlan(body);
    if (errors.length) throw new Error('plan invalid: ' + errors.join('; '));

    const old = db.prepare("SELECT id, version FROM plans WHERE project_id=? AND status='approved' AND COALESCE(lineage,'')=? ORDER BY version")
      .all(plan.project_id, plan.lineage ?? '') as { id: number; version: number }[];
    const inFlightQ = db.prepare(`SELECT id, key, title, status, pr_number FROM tasks WHERE plan_id=? AND ${IN_FLIGHT_SQL} ORDER BY id`);
    const inFlight = old.flatMap((o) => (inFlightQ.all(o.id) as unknown as InFlightTask[]).map((t) => ({ ...t, version: o.version })));
    const forced = opts.force === true; // strict: only a real boolean true forces
    if (inFlight.length > 0 && !forced) {
      throw new PlanInFlightError(inFlight[0].version, inFlight.map(({ version: _v, ...t }) => t));
    }

    for (const o of old) {
      db.prepare("UPDATE plans SET status='superseded' WHERE id=?").run(o.id);
      // Hold first so a pending/ready task with an open PR is held, not cancelled.
      db.prepare(`UPDATE tasks SET status='blocked', hold_reason=?, updated_at=datetime('now') WHERE plan_id=? AND ${IN_FLIGHT_SQL}`).run(SUPERSEDED_HOLD, o.id);
      db.prepare("UPDATE tasks SET status='cancelled', hold_reason=?, updated_at=datetime('now') WHERE plan_id=? AND status IN ('pending','ready')").run(`superseded by plan v${plan.version}`, o.id);
    }
    db.prepare("UPDATE plans SET status='approved', approved_at=datetime('now') WHERE id=?").run(planId);
    const ins = db.prepare(`INSERT INTO tasks(id, project_id, plan_id, key, title, prompt, acceptance, write_scope, deps, status, branch, model, model_why)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?)`);
    for (const t of body.tasks) {
      const id = `${plan.project_id}-v${plan.version}-${t.key}`;
      ins.run(id, plan.project_id, planId, t.key, t.title, t.prompt, t.acceptance, JSON.stringify(t.writeScope), JSON.stringify(t.deps), `local/${id}`, t.model ?? null, t.modelWhy ? String(t.modelWhy).slice(0, 200) : null);
    }
    emit(db, { projectId: plan.project_id, type: 'plan_approved', data: {
      planId, version: plan.version, tasks: body.tasks.map((t) => t.key),
      ...(forced ? { forced: true, heldTasks: inFlight.map((t) => t.id) } : {}),
    } });
  });
}
