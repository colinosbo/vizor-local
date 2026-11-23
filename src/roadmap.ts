import { tx, type DB } from './db.js';
import { emit } from './events.js';
import { approvePlan, validatePlan } from './plan.js';
import type { PlanningService } from './planning.js';
import { inScope } from './scope.js';
import type { PlanBody, Project } from './types.js';

export type PhaseStatus = 'queued' | 'drafting' | 'review' | 'running' | 'done' | 'failed';
export type ApproveMode = 'inherit' | 'off';
export const APPROVE_MODES: ApproveMode[] = ['inherit', 'off'];
export interface PhaseRow {
  id: number; project_id: string; position: number; title: string; prompt: string; status: PhaseStatus; plan_id: number | null; error: string | null;
  approve_mode: ApproveMode;  // 'off' = this phase always waits for the owner
  auto_note: string | null;   // why a phase in review was not auto-approved
}

const MAX_PHASES = 50;

// ---- Auto-approve policy -------------------------------------------------------------------------

export const AUTO_APPROVE_MAX_TASKS = 8;
/** Exact files a plan may not touch without the owner (merge authority, plan approval, scripts, CI). */
const PROTECTED_FILES = ['src/merge.ts', 'src/plan.ts', 'package.json', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml'];
/** Directories whose whole contents are protected. */
const PROTECTED_DIRS = ['.github', '.claude', 'skills', '.circleci'];
/** Sample paths inside protected directories, tested against every scope. */
const PROTECTED_SAMPLES = [
  '.github/workflows/ci.yml', '.github/CODEOWNERS', '.claude/settings.json', '.claude/skills/x/SKILL.md',
  'skills/x/SKILL.md', '.circleci/config.yml', 'a/package.json', 'a/b/package.json',
];
const PROTECTED_PREFIXES = [...PROTECTED_DIRS.map((d) => `${d}/`), ...PROTECTED_FILES];

/**
 * Paths derived from the scope itself, so patterns like `packages/web/package.json`, `apps/*\/*.json` or
 * `*\/x.md` (→ skills/x.md) are caught: wildcards are filled with `x`, then the last segment is swapped for
 * package.json and the first segment for each protected directory. Each probe is still tested against the scope.
 *
 * Nested package.json: a scope counts when its last segment names or pattern-matches package.json. A purely
 * wildcard last segment (`apps/web/**`, `src/ui/*`) does not count on its own; otherwise every directory
 * scope would need the owner. Root-level broad globs ('*', '**') still match the root package.json.
 */
function scopeProbes(scope: string): string[] {
  const segs = scope.split('/');
  const filled = segs.map((s) => (s === '**' ? 'x' : s.replace(/\*+|\?/g, 'x')));
  const last = segs[segs.length - 1];
  const out = /^[*?]+$/.test(last) ? [] : [[...filled.slice(0, -1), 'package.json'].join('/')];
  for (const d of PROTECTED_DIRS) out.push([d, ...filled.slice(1)].join('/'), [d, ...filled].join('/'));
  return out;
}

/** The first protected path a write scope pattern could reach, or null. Broad globs ('**', '*', 'src/**') count. */
export function protectedHit(pattern: string): string | null {
  const g = pattern.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const prefix = PROTECTED_PREFIXES.find((p) => g.startsWith(p));
  if (prefix) return prefix;
  return [...PROTECTED_FILES, ...PROTECTED_SAMPLES, ...scopeProbes(g)].find((p) => inScope(p, [g])) ?? null;
}

export interface AutoApproveInput {
  project: Pick<Project, 'auto_approve' | 'auto_approve_halted'>;
  phase: Pick<PhaseRow, 'approve_mode'>;
  earlier: Pick<PhaseRow, 'status'>[];               // phases before this one, in order
  previousTasks: { status: string }[] | null;        // tasks of the previous phase's plan; null = no previous phase
  busyTasks: number;                                  // project tasks in pending/ready/running/waiting_ci/merging
  body: unknown;                                      // the draft plan body (parsed JSON)
}
export type AutoApproveDecision = { ok: true } | { ok: false; reason: string };

/**
 * Pure policy: may RoadmapService approve this drafted roadmap plan without the owner?
 * Returns the FIRST failing condition as a 'needs you: …' reason. Extra fields in the plan body
 * (e.g. `autoApprove: true` from a planner) are ignored; only owner-set columns are read.
 */
export function autoApproveDecision(i: AutoApproveInput): AutoApproveDecision {
  const no = (why: string): AutoApproveDecision => ({ ok: false, reason: `needs you: ${why}` });
  // 1. Owner settings.
  if (i.project.auto_approve !== 1) return no('auto-approve is off for this project');
  if (i.phase.approve_mode === 'off') return no('auto-approve is off for this phase');
  if (i.project.auto_approve_halted) return no(`auto-approve halted: ${i.project.auto_approve_halted}`);
  // 2. Everything before this phase has finished cleanly and nothing is running.
  const unfinished = i.earlier.findIndex((ph) => ph.status !== 'done');
  if (unfinished !== -1) return no(`phase ${unfinished + 1} is ${i.earlier[unfinished].status}, not done`);
  if (i.previousTasks) {
    const merged = i.previousTasks.filter((t) => t.status === 'merged').length;
    const open = i.previousTasks.filter((t) => t.status !== 'merged' && t.status !== 'cancelled').length;
    if (open > 0 || merged === 0) return no('the previous phase\'s tasks are not all merged');
  }
  if (i.busyTasks > 0) return no(`${i.busyTasks} task${i.busyTasks === 1 ? ' is' : 's are'} still pending or running`);
  // 3. Valid plan.
  const body = i.body as PlanBody;
  const { errors } = validatePlan(body);
  if (errors.length) return no(`plan is invalid: ${errors[0]}`);
  // 4. Small plan.
  if (body.tasks.length > AUTO_APPROVE_MAX_TASKS) return no(`plan has ${body.tasks.length} tasks (max ${AUTO_APPROVE_MAX_TASKS})`);
  // 5. No protected paths.
  for (const t of body.tasks) for (const g of t.writeScope) {
    const hit = protectedHit(g);
    if (hit) return no(`task ${t.key} scope ${g} can touch protected path ${hit}`);
  }
  return { ok: true };
}

/** Approver used by RoadmapService. Two arguments only: there is deliberately no way to pass `force`. */
export type AutoApprover = (db: DB, planId: number) => void;
const APPROVAL_REFUSED = 'needs you: approval refused: ';

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
 * Runs a project's phases in order. It drafts the next plan; the plan then waits for the owner unless the
 * owner turned on per-project auto-approve (projects.auto_approve). Even then RoadmapService approves only
 * when autoApproveDecision passes: the phase is not set to 'off', auto-approve is not halted, every earlier
 * phase is done with its tasks merged, no task is pending or running, the plan validates, has at most 8 tasks
 * and touches no protected path (merge/plan code, package.json, CI config, .github/.claude/skills). It calls
 * approvePlan without `force`; a refusal leaves the phase in review with a 'needs you' note. A failed or
 * blocked task halts auto-approve until the owner resumes it. The planner/orchestrator never approves.
 * queued → drafting → review (plan drafted) → running (approved) → done (all tasks merged).
 * A phase whose plan fails or is declined becomes `failed` and the roadmap stops until the owner retries it.
 *
 * The queue is editable: insert/move/edit work only on `queued` phases, and a new or moved phase must stay
 * after every non-queued phase. remove also works on `failed` and `review` phases (removing a review phase
 * supersedes its draft plan). drafting, running and done phases are read-only. Every mutation runs in a
 * transaction and re-reads status inside it, because tick() may advance phases concurrently; positions are
 * kept contiguous (1..n) and a project holds at most 50 phases.
 */
export class RoadmapService {
  constructor(private db: DB, private planning: PlanningService, private approve: AutoApprover = (d, id) => approvePlan(d, id)) {
    // Drafting is in memory; after a restart those phases are drafted again.
    db.prepare("UPDATE phases SET status='queued', error=NULL WHERE status='drafting'").run();
  }

  phases(projectId: string) { return this.db.prepare('SELECT * FROM phases WHERE project_id=? ORDER BY position, id').all(projectId) as unknown as PhaseRow[]; }
  private set(id: number, f: { status?: PhaseStatus; plan_id?: number | null; error?: string | null; auto_note?: string | null }) {
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

  private get(id: number) { return this.db.prepare('SELECT * FROM phases WHERE id=?').get(id) as unknown as PhaseRow | undefined; }

  /** Make positions 1..n contiguous in the current order. */
  private renumber(projectId: string) {
    const upd = this.db.prepare('UPDATE phases SET position=? WHERE id=?');
    this.phases(projectId).forEach((ph, i) => { if (ph.position !== i + 1) upd.run(i + 1, ph.id); });
  }

  /** 1-based position of the last phase that is not 'queued' (0 when every phase is queued). */
  private lastLocked(rows: PhaseRow[]) {
    let last = 0;
    rows.forEach((ph, i) => { if (ph.status !== 'queued') last = i + 1; });
    return last;
  }

  private static clean(title: unknown, prompt: unknown) {
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t) throw new Error('title is required');
    if (t.length > 120) throw new Error('title must be at most 120 characters');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    if (prompt.length > 4000) throw new Error('prompt must be at most 4000 characters');
    return { title: t, prompt };
  }

  /** Insert a new queued phase at a 1-based position; it must come after every non-queued phase. */
  insert(projectId: string, position: number, title: string, prompt: string): PhaseRow[] {
    const v = RoadmapService.clean(title, prompt);
    return tx(this.db, () => {
      if (!this.project(projectId)) throw new Error(`unknown project ${projectId}`);
      const rows = this.phases(projectId);
      if (rows.length >= MAX_PHASES) throw new Error(`a project can have at most ${MAX_PHASES} phases`);
      if (!Number.isInteger(position) || position < 1 || position > rows.length + 1) throw new Error(`position must be a whole number from 1 to ${rows.length + 1}`);
      const locked = this.lastLocked(rows);
      if (position <= locked) throw new Error(`a new phase cannot go ahead of phases that have already started; the earliest position is ${locked + 1}`);
      this.db.prepare('UPDATE phases SET position=position+1 WHERE project_id=? AND position>=?').run(projectId, position);
      const r = this.db.prepare('INSERT INTO phases(project_id, position, title, prompt) VALUES (?,?,?,?)').run(projectId, position, v.title, v.prompt);
      this.renumber(projectId);
      emit(this.db, { projectId, type: 'roadmap_updated', data: { inserted: Number(r.lastInsertRowid), position, title: v.title } });
      return this.phases(projectId);
    });
  }

  /** Move a queued phase to a 1-based position within the queued block. */
  move(id: number, toPosition: number): PhaseRow[] {
    return tx(this.db, () => {
      const ph = this.get(id);
      if (!ph) throw new Error('unknown phase');
      if (ph.status !== 'queued') throw new Error(`a ${ph.status} phase is read-only; only queued phases can be moved`);
      const rows = this.phases(ph.project_id);
      const locked = this.lastLocked(rows);
      const from = rows.findIndex((r) => r.id === id) + 1;
      if (from <= locked) throw new Error('this phase sits before a phase that has already started and cannot be moved');
      if (!Number.isInteger(toPosition) || toPosition <= locked || toPosition > rows.length) throw new Error(`position must be a whole number from ${locked + 1} to ${rows.length}`);
      if (toPosition !== from) {
        const order = rows.map((r) => r.id);
        order.splice(from - 1, 1);
        order.splice(toPosition - 1, 0, id);
        const upd = this.db.prepare('UPDATE phases SET position=? WHERE id=?');
        order.forEach((pid, i) => upd.run(i + 1, pid));
        emit(this.db, { projectId: ph.project_id, type: 'roadmap_updated', data: { moved: id, from, to: toPosition } });
      }
      return this.phases(ph.project_id);
    });
  }

  /** Edit the title and/or prompt of a queued phase. */
  edit(id: number, fields: { title?: string; prompt?: string }): PhaseRow {
    return tx(this.db, () => {
      const ph = this.get(id);
      if (!ph) throw new Error('unknown phase');
      if (ph.status !== 'queued') throw new Error(`a ${ph.status} phase is read-only; only queued phases can be edited`);
      if (fields.title === undefined && fields.prompt === undefined) throw new Error('nothing to edit: give a title and/or prompt');
      const v = RoadmapService.clean(fields.title ?? ph.title, fields.prompt ?? ph.prompt);
      this.db.prepare("UPDATE phases SET title=?, prompt=?, updated_at=datetime('now') WHERE id=?").run(v.title, v.prompt, id);
      emit(this.db, { projectId: ph.project_id, type: 'roadmap_updated', data: { edited: id, fields: Object.keys(fields).filter((k) => k === 'title' || k === 'prompt') } });
      return this.get(id)!;
    });
  }

  remove(id: number) {
    tx(this.db, () => {
      const ph = this.get(id);
      if (!ph) throw new Error('unknown phase');
      if (!['queued', 'failed', 'review'].includes(ph.status)) throw new Error(`a ${ph.status} phase is read-only; only a queued or failed phase (or a review phase) can be removed`);
      let discarded: number | null = null;
      if (ph.status === 'review' && ph.plan_id) {
        const plan = this.db.prepare('SELECT status FROM plans WHERE id=?').get(ph.plan_id) as { status: string } | undefined;
        if (plan?.status === 'approved') throw new Error('its plan was just approved, so this phase can no longer be removed');
        if (plan?.status === 'draft') { this.db.prepare("UPDATE plans SET status='superseded' WHERE id=?").run(ph.plan_id); discarded = ph.plan_id; }
      }
      this.db.prepare('DELETE FROM phases WHERE id=?').run(id);
      this.renumber(ph.project_id);
      if (discarded !== null) emit(this.db, { projectId: ph.project_id, type: 'plan_discarded', data: { planId: discarded, phase: id } });
      emit(this.db, { projectId: ph.project_id, type: 'roadmap_updated', data: { removed: id } });
    });
  }

  /** Owner-only: 'off' makes this phase wait for the owner even when the project auto-approves. */
  setApproveMode(id: number, mode: unknown): PhaseRow {
    if (typeof mode !== 'string' || !APPROVE_MODES.includes(mode as ApproveMode)) throw new Error(`mode must be one of ${APPROVE_MODES.join(', ')}`);
    const ph = this.get(id);
    if (!ph) throw new Error('unknown phase');
    this.db.prepare("UPDATE phases SET approve_mode=?, auto_note=NULL, updated_at=datetime('now') WHERE id=?").run(mode, id);
    emit(this.db, { projectId: ph.project_id, type: 'roadmap_updated', data: { phase: id, approveMode: mode } });
    return this.get(id)!;
  }

  /** Owner-only: clear a halt. If a task is still failed or blocked, the next tick halts again (fail closed). */
  resumeAutoApprove(projectId: string) {
    if (!this.project(projectId)) throw new Error(`unknown project ${projectId}`);
    tx(this.db, () => {
      this.db.prepare('UPDATE projects SET auto_approve_halted=NULL WHERE id=?').run(projectId);
      this.db.prepare("UPDATE phases SET auto_note=NULL WHERE project_id=? AND status='review'").run(projectId); // lets a refused approval be tried once more
      emit(this.db, { projectId, type: 'auto_approve_resumed' });
    });
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

  /** A failed or blocked task stops auto-approve (once; the owner resumes it). Updates `p` in place. */
  private haltIfBroken(p: Project) {
    if (p.auto_approve !== 1 || p.auto_approve_halted) return;
    const t = this.db.prepare("SELECT id, key, status FROM tasks WHERE project_id=? AND status IN ('failed','blocked') ORDER BY rowid LIMIT 1").get(p.id) as { id: string; key: string; status: string } | undefined;
    if (!t) return;
    const reason = `task ${t.id} is ${t.status}`;
    this.db.prepare('UPDATE projects SET auto_approve_halted=? WHERE id=? AND auto_approve_halted IS NULL').run(reason, p.id);
    p.auto_approve_halted = reason;
    emit(this.db, { projectId: p.id, type: 'auto_approve_halted', data: { reason, taskId: t.id, status: t.status } });
  }

  /** Record why a review phase waits for the owner; writes (and emits) only when the reason changes. */
  private note(ph: PhaseRow, note: string | null) {
    if (ph.auto_note === note) return;
    this.set(ph.id, { auto_note: note });
    ph.auto_note = note;
    emit(this.db, { projectId: ph.project_id, type: 'roadmap_updated', data: { phase: ph.id, autoNote: note } });
  }

  private tryAutoApprove(p: Project, ph: PhaseRow, phases: PhaseRow[]) {
    const plan = this.db.prepare('SELECT status, body FROM plans WHERE id=?').get(ph.plan_id) as { status: string; body: string } | undefined;
    if (plan?.status !== 'draft') return;
    // An approval that approvePlan refused is a 'needs you' outcome, not something to retry every tick.
    // Resume or changing the phase's mode clears the note and allows one more try.
    if (ph.auto_note?.startsWith(APPROVAL_REFUSED) && p.auto_approve === 1 && ph.approve_mode !== 'off' && !p.auto_approve_halted) return;
    const earlier = phases.slice(0, phases.indexOf(ph));
    const prev = earlier.at(-1);
    const previousTasks = prev ? (prev.plan_id ? this.db.prepare('SELECT status FROM tasks WHERE plan_id=?').all(prev.plan_id) as { status: string }[] : []) : null;
    const busyTasks = (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status IN ('pending','ready','running','waiting_ci','merging')`).get(p.id) as { n: number }).n;
    let body: unknown;
    try { body = JSON.parse(plan.body); } catch { body = null; }
    const d = autoApproveDecision({ project: p, phase: ph, earlier, previousTasks, busyTasks, body });
    if (!d.ok) return this.note(ph, d.reason);
    try {
      this.approve(this.db, ph.plan_id!);
    } catch (e) {
      return this.note(ph, `${APPROVAL_REFUSED}${String((e as Error).message ?? e)}`.slice(0, 500));
    }
    emit(this.db, { projectId: p.id, type: 'plan_auto_approved', data: { planId: ph.plan_id, phase: ph.id, setting: 'project.auto_approve', phaseMode: 'inherit' } });
  }

  private advance(pid: string) {
    const p = this.project(pid);
    if (!p) return;
    this.haltIfBroken(p);
    const phases = this.phases(pid);
    for (const ph of phases) {
      if (ph.status === 'review' && ph.plan_id) this.tryAutoApprove(p, ph, phases);
      if (ph.status === 'review' && ph.plan_id) {
        const plan = this.db.prepare('SELECT status FROM plans WHERE id=?').get(ph.plan_id) as { status: string } | undefined;
        if (plan?.status === 'approved') { this.set(ph.id, { status: 'running', auto_note: null }); emit(this.db, { projectId: pid, type: 'phase_running', data: { phase: ph.id, title: ph.title } }); }
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
