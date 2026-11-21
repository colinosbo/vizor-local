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

export function draftPlan(db: DB, projectId: string, body: PlanBody): { planId: number; version: number; validation: PlanValidation } {
  const validation = validatePlan(body);
  return tx(db, () => {
    const v = (db.prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM plans WHERE project_id=?').get(projectId) as { v: number }).v;
    const r = db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES (?,?,'draft',?) RETURNING id").get(projectId, v, JSON.stringify(body)) as { id: number };
    emit(db, { projectId, type: 'plan_drafted', data: { planId: r.id, version: v, validation } });
    return { planId: r.id, version: v, validation };
  });
}

/**
 * Owner-only. The orchestrator has no code path to this function.
 * Approving a new version supersedes the previous one; unstarted tasks are cancelled,
 * in-flight tasks are held for an owner decision (fail closed).
 */
export function approvePlan(db: DB, planId: number): void {
  tx(db, () => {
    const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(planId) as { id: number; project_id: string; version: number; status: string; body: string } | undefined;
    if (!plan) throw new Error('plan not found');
    if (plan.status !== 'draft') throw new Error(`plan is ${plan.status}`);
    const body = JSON.parse(plan.body) as PlanBody;
    const { errors } = validatePlan(body);
    if (errors.length) throw new Error('plan invalid: ' + errors.join('; '));

    const old = db.prepare("SELECT id FROM plans WHERE project_id=? AND status='approved'").all(plan.project_id) as { id: number }[];
    for (const o of old) {
      db.prepare("UPDATE plans SET status='superseded' WHERE id=?").run(o.id);
      db.prepare("UPDATE tasks SET status='cancelled', hold_reason='superseded by plan v'||?, updated_at=datetime('now') WHERE plan_id=? AND status IN ('pending','ready')").run(plan.version, o.id);
      db.prepare("UPDATE tasks SET status='blocked', hold_reason='plan superseded while in flight; owner decision needed', updated_at=datetime('now') WHERE plan_id=? AND status IN ('running','waiting_ci')").run(o.id);
    }
    db.prepare("UPDATE plans SET status='approved', approved_at=datetime('now') WHERE id=?").run(planId);
    const ins = db.prepare(`INSERT INTO tasks(id, project_id, plan_id, key, title, prompt, acceptance, write_scope, deps, status, branch, model, model_why)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?)`);
    for (const t of body.tasks) {
      const id = `${plan.project_id}-v${plan.version}-${t.key}`;
      ins.run(id, plan.project_id, planId, t.key, t.title, t.prompt, t.acceptance, JSON.stringify(t.writeScope), JSON.stringify(t.deps), `local/${id}`, t.model ?? null, t.modelWhy ? String(t.modelWhy).slice(0, 200) : null);
    }
    emit(db, { projectId: plan.project_id, type: 'plan_approved', data: { planId, version: plan.version, tasks: body.tasks.map((t) => t.key) } });
  });
}
