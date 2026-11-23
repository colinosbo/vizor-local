// Per-project auto-approve: policy, settings, halting, migration, and proof the planner cannot approve.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { approvePlan, draftPlan, PlanInFlightError } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { configureProject } from '../src/projects.js';
import { autoApproveDecision, protectedHit, RoadmapService, type AutoApprover, type PhaseRow } from '../src/roadmap.js';
import type { PlanTask } from '../src/types.js';

const task = (i: number, over: Partial<PlanTask> = {}): PlanTask =>
  ({ key: `t${i}`, title: `Task ${i}`, prompt: 'do it', acceptance: 'works', writeScope: [`src/f${i}/**`], deps: [], ...over });
const body = (n: number, over: (i: number) => Partial<PlanTask> = () => ({})) => ({ summary: 's', tasks: Array.from({ length: n }, (_, i) => task(i, over(i))) });

function setup(opts: { phases?: string[]; on?: boolean; approve?: AutoApprover } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const planning = new PlanningService(db, { draft: () => new Promise(() => {}) });
  const rm = new RoadmapService(db, planning, opts.approve);
  rm.add('p', (opts.phases ?? ['A']).map((t) => `${t}\nbody of ${t}`).join('\n---\n'));
  if (opts.on) configureProject(db, 'p', { autoApprove: true });
  return { db, rm, planning };
}
const ph = (rm: RoadmapService, i: number): PhaseRow => rm.phases('p')[i];
const evs = (db: DB, type: string) => eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === type)
  .map((e) => ({ ...e, data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data }));
const planStatus = (db: DB, id: number) => (db.prepare('SELECT status FROM plans WHERE id=?').get(id) as { status: string }).status;

/** Put phase i in review with a freshly drafted plan. */
function review(db: DB, rm: RoadmapService, i: number, b: unknown = body(2)): number {
  const { planId } = draftPlan(db, 'p', b as never);
  db.prepare("UPDATE phases SET status='review', plan_id=? WHERE id=?").run(planId, ph(rm, i).id);
  return planId;
}
/** Mark phase i done with an approved plan whose tasks have the given statuses. */
function done(db: DB, rm: RoadmapService, i: number, statuses: string[] = ['merged']): number {
  const planId = Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', (SELECT COALESCE(MAX(version),0)+1 FROM plans WHERE project_id='p'), 'approved', '{}')").run().lastInsertRowid);
  statuses.forEach((s, k) => addTask(db, planId, `d${planId}-${k}`, s));
  db.prepare("UPDATE phases SET status='done', plan_id=? WHERE id=?").run(planId, ph(rm, i).id);
  return planId;
}
function addTask(db: DB, planId: number, key: string, status: string, pr: number | null = null) {
  db.prepare(`INSERT INTO tasks(id, project_id, plan_id, key, title, prompt, acceptance, write_scope, deps, status, branch, pr_number)
    VALUES (?, 'p', ?, ?, 't', 'p', 'a', '[]', '[]', ?, ?, ?)`).run(`p-${key}`, planId, key, status, `local/p-${key}`, pr);
}

test('default off: a drafted plan stays in review with a needs-you note', () => {
  const { db, rm } = setup();
  assert.equal(ph(rm, 0).approve_mode, 'inherit');
  const planId = review(db, rm, 0);
  rm.tick(); rm.tick();
  assert.equal(ph(rm, 0).status, 'review');
  assert.equal(planStatus(db, planId), 'draft');
  assert.equal(ph(rm, 0).auto_note, 'needs you: auto-approve is off for this project');
  assert.equal(evs(db, 'plan_auto_approved').length, 0);
  assert.equal(evs(db, 'roadmap_updated').filter((e) => (e.data as any).autoNote).length, 1, 'note written once, not every tick');
});

test('on + inherit approves and emits plan_auto_approved naming the setting', () => {
  const { db, rm } = setup({ on: true });
  const planId = review(db, rm, 0);
  rm.tick();
  assert.equal(planStatus(db, planId), 'approved');
  assert.equal(ph(rm, 0).status, 'running');
  assert.equal(ph(rm, 0).auto_note, null);
  const e = evs(db, 'plan_auto_approved');
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].data, { planId, phase: ph(rm, 0).id, setting: 'project.auto_approve', phaseMode: 'inherit' });
  assert.equal(evs(db, 'plan_approved').length, 1);
  assert.equal((evs(db, 'plan_approved')[0].data as any).forced, undefined);
});

test('a phase set to off waits; approve-mode accepts only inherit|off', () => {
  const { db, rm } = setup({ on: true });
  const planId = review(db, rm, 0);
  rm.setApproveMode(ph(rm, 0).id, 'off');
  rm.tick();
  assert.equal(planStatus(db, planId), 'draft');
  assert.equal(ph(rm, 0).auto_note, 'needs you: auto-approve is off for this phase');
  for (const bad of ['OFF', 'on', '', 1, true, null, undefined]) assert.throws(() => rm.setApproveMode(ph(rm, 0).id, bad), /mode must be/);
  rm.setApproveMode(ph(rm, 0).id, 'inherit');
  rm.tick();
  assert.equal(planStatus(db, planId), 'approved');
});

test('turning the project off stops approval of a phase already in review', () => {
  const { db, rm } = setup({ on: true });
  const other = Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', 99, 'approved', '{}')").run().lastInsertRowid);
  addTask(db, other, 'busy', 'running');
  const planId = review(db, rm, 0);
  rm.tick();
  assert.match(ph(rm, 0).auto_note!, /still pending or running/);
  configureProject(db, 'p', { autoApprove: false });
  db.prepare("UPDATE tasks SET status='merged'").run(); // the reason it was waiting is gone…
  rm.tick();
  assert.equal(planStatus(db, planId), 'draft', '…but the owner turned auto-approve off, so it still waits');
  assert.equal(ph(rm, 0).auto_note, 'needs you: auto-approve is off for this project');
  assert.throws(() => configureProject(db, 'p', { autoApprove: 'true' as never }), /true or false/);
});

test('a phase added later inherits the project setting', () => {
  const { db, rm } = setup({ on: true });
  done(db, rm, 0);
  rm.add('p', 'Later\nbody');
  rm.insert('p', 3, 'Inserted', 'body');
  assert.deepEqual(rm.phases('p').map((x) => x.approve_mode), ['inherit', 'inherit', 'inherit']);
  const planId = review(db, rm, 1);
  rm.tick();
  assert.equal(planStatus(db, planId), 'approved');
});

test('refused: an earlier phase is not done', () => {
  const { db, rm } = setup({ on: true, phases: ['A', 'B'] });
  db.prepare("UPDATE phases SET status='running' WHERE id=?").run(ph(rm, 0).id);
  const planId = review(db, rm, 1);
  rm.tick();
  assert.equal(planStatus(db, planId), 'draft');
  assert.equal(ph(rm, 1).auto_note, 'needs you: phase 1 is running, not done');
});

test('refused: previous phase tasks not all merged; cancelled allowed only alongside a merged task', () => {
  for (const [statuses, ok] of [[['merged', 'pending'], false], [['cancelled'], false], [['merged', 'cancelled'], true]] as const) {
    const { db, rm } = setup({ on: true, phases: ['A', 'B'] });
    done(db, rm, 0, [...statuses]);
    const planId = review(db, rm, 1);
    rm.tick();
    assert.equal(planStatus(db, planId), ok ? 'approved' : 'draft', statuses.join(','));
    if (!ok) assert.equal(ph(rm, 1).auto_note, "needs you: the previous phase's tasks are not all merged");
  }
});

test('refused: the project has a busy task', () => {
  for (const s of ['pending', 'ready', 'running', 'waiting_ci', 'merging']) {
    const { db, rm } = setup({ on: true });
    const other = Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', 99, 'approved', '{}')").run().lastInsertRowid);
    addTask(db, other, 'x', s);
    const planId = review(db, rm, 0);
    rm.tick();
    assert.equal(planStatus(db, planId), 'draft', s);
    assert.equal(ph(rm, 0).auto_note, 'needs you: 1 task is still pending or running');
  }
});

test('refused: plan validation errors', () => {
  const { db, rm } = setup({ on: true });
  const planId = review(db, rm, 0, body(2, (i) => (i === 1 ? { acceptance: '' } : {})));
  rm.tick();
  assert.equal(planStatus(db, planId), 'draft');
  assert.equal(ph(rm, 0).auto_note, 'needs you: plan is invalid: t1: acceptance criteria required');
});

test('refused: more than 8 tasks; exactly 8 is fine', () => {
  const { db, rm } = setup({ on: true });
  const planId = review(db, rm, 0, body(9));
  rm.tick();
  assert.equal(planStatus(db, planId), 'draft');
  assert.equal(ph(rm, 0).auto_note, 'needs you: plan has 9 tasks (max 8)');
  const r2 = setup({ on: true });
  const p8 = review(r2.db, r2.rm, 0, body(8));
  r2.rm.tick();
  assert.equal(planStatus(r2.db, p8), 'approved');
});

test('refused: every protected path, nested package.json and broad globs', () => {
  const protectedScopes = [
    'src/merge.ts', 'src/plan.ts', 'src/*.ts', 'src/**', '*', '**', '*.json', '*.yml',
    '.github/workflows/ci.yml', '.github/**', './.github/x', '.claude/settings.json', '.claude/**', 'skills/foo/SKILL.md', 'skills/**', '*/x.md', '**/README.md',
    'package.json', 'packages/web/package.json', 'packages/*/package.json', '**/package.json', 'apps/web/*.json',
    '.gitlab-ci.yml', '.circleci/config.yml', '.circleci/**', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml',
  ];
  for (const g of protectedScopes) assert.ok(protectedHit(g), `${g} should be protected`);
  for (const g of ['src/history/**', 'src/ui/*.ts', 'test/foo.test.ts', 'docs/guide.md', 'public/index.html', 'src/roadmap.ts'])
    assert.equal(protectedHit(g), null, `${g} should be allowed`);

  for (const g of protectedScopes) {
    const { db, rm } = setup({ on: true });
    const planId = review(db, rm, 0, body(2, (i) => (i === 1 ? { writeScope: [g] } : {})));
    rm.tick();
    assert.equal(planStatus(db, planId), 'draft', g);
    // '**' is already rejected by validatePlan ('unsafe scope'); every other one by the protected-path rule.
    assert.match(ph(rm, 0).auto_note!, g === '**' ? /unsafe scope \*\*/ : /protected path/, g);
  }
});

test('autoApproveDecision is pure and reports the first failing reason', () => {
  const base = { project: { auto_approve: 1, auto_approve_halted: null }, phase: { approve_mode: 'inherit' as const }, earlier: [], previousTasks: null, busyTasks: 0, body: body(1) };
  assert.deepEqual(autoApproveDecision(base), { ok: true });
  assert.deepEqual(autoApproveDecision({ ...base, project: { auto_approve: 0, auto_approve_halted: 'x' }, busyTasks: 3 }), { ok: false, reason: 'needs you: auto-approve is off for this project' });
  assert.deepEqual(autoApproveDecision({ ...base, body: { ...body(1), autoApprove: true }, project: { auto_approve: 0, auto_approve_halted: null } }).ok, false);
  assert.deepEqual(autoApproveDecision({ ...base, busyTasks: 2 }), { ok: false, reason: 'needs you: 2 tasks are still pending or running' });
  assert.equal(autoApproveDecision({ ...base, body: null }).ok, false);
});

test('a failed or blocked task halts auto-approve (once) until the owner resumes', () => {
  for (const s of ['blocked', 'failed']) {
    const { db, rm } = setup({ on: true });
    const other = Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', 99, 'superseded', '{}')").run().lastInsertRowid);
    addTask(db, other, 'bad', s);
    const planId = review(db, rm, 0);
    rm.tick(); rm.tick(); rm.tick();
    const halted = (db.prepare("SELECT auto_approve_halted AS h FROM projects WHERE id='p'").get() as { h: string | null }).h;
    assert.equal(halted, `task p-bad is ${s}`);
    assert.equal(evs(db, 'auto_approve_halted').length, 1, 'emitted once');
    assert.equal(planStatus(db, planId), 'draft');
    assert.equal(ph(rm, 0).auto_note, `needs you: auto-approve halted: task p-bad is ${s}`);

    db.prepare("UPDATE tasks SET status='cancelled' WHERE key='bad'").run(); // the owner deals with it…
    rm.tick();
    assert.equal(planStatus(db, planId), 'draft', '…and it stays halted until they resume');
    rm.resumeAutoApprove('p');
    rm.tick();
    assert.equal(planStatus(db, planId), 'approved');
    assert.equal(evs(db, 'auto_approve_resumed').length, 1);
  }
});

test('resume while a task is still blocked halts again (fail closed)', () => {
  const { db, rm } = setup({ on: true });
  const other = Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', 99, 'superseded', '{}')").run().lastInsertRowid);
  addTask(db, other, 'bad', 'blocked');
  const planId = review(db, rm, 0);
  rm.tick();
  rm.resumeAutoApprove('p');
  rm.tick();
  assert.equal(planStatus(db, planId), 'draft');
  assert.equal(evs(db, 'auto_approve_halted').length, 2);
});

test('force is never used: an approval refused over in-flight work is a needs-you note, not a retry loop', () => {
  // Real approvePlan refuses when the approved plan has in-flight work. The busy/halt checks normally stop
  // earlier, so route through a spy that records its arguments and calls the real function.
  const calls: unknown[][] = [];
  const spy: AutoApprover = (...args: unknown[]) => { calls.push(args); (approvePlan as (...a: unknown[]) => void)(...args); };
  const { db, rm } = setup({ on: true, approve: spy });
  const old = Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', 99, 'approved', '{}')").run().lastInsertRowid);
  addTask(db, old, 'inflight', 'merged', 7);
  const planId = review(db, rm, 0);
  // Let the busy/halt checks pass while approvePlan still sees in-flight work: a status the policy does not
  // count as busy or broken, but IN_FLIGHT_SQL does (a non-terminal task holding an open PR).
  db.prepare("UPDATE tasks SET status='held' WHERE key='inflight'").run();
  rm.tick(); rm.tick(); rm.tick();
  assert.equal(calls.length, 1, 'tried once, not every tick');
  assert.equal(calls[0].length, 2, 'called with (db, planId) only, no options object');
  assert.equal(calls[0][1], planId);
  assert.equal(planStatus(db, planId), 'draft');
  assert.equal(ph(rm, 0).status, 'review');
  assert.match(ph(rm, 0).auto_note!, /^needs you: approval refused: approved plan v99 still has in-flight tasks/);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE key='inflight'").get() as { status: string }).status, 'held', 'nothing was forced or held');
  assert.equal(evs(db, 'plan_auto_approved').length, 0);
  assert.throws(() => approvePlan(db, planId), PlanInFlightError);

  // Source check: roadmap.ts never passes options to approvePlan.
  const src = readFileSync(fileURLToPath(new URL('../../src/roadmap.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /approvePlan\([^)]*,[^)]*,/);
  assert.doesNotMatch(src, /force\s*:\s*true/);
});

test('planner cannot approve: orchestrator.ts and planning.ts never reference approvePlan or RoadmapService', () => {
  for (const f of ['orchestrator.ts', 'planning.ts']) {
    const src = readFileSync(fileURLToPath(new URL(`../../src/${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /approvePlan/, f);
    assert.doesNotMatch(src, /RoadmapService|from '\.\/roadmap\.js'/, f);
  }
});

test('planner cannot approve: a drafted plan claiming autoApprove:true stays in review when the setting is off', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const planning = new PlanningService(db, { draft: async () => ({ reply: 'here', plan: { ...body(1), autoApprove: true, approve: true } as never }) });
  const rm = new RoadmapService(db, planning);
  rm.add('p', 'A\nbody');
  rm.tick();
  await planning.idle();
  const phase = rm.phases('p')[0];
  assert.equal(phase.status, 'review');
  rm.tick(); rm.tick();
  assert.equal(rm.phases('p')[0].status, 'review');
  assert.equal(planStatus(db, phase.plan_id!), 'draft');
  assert.equal(evs(db, 'plan_approved').length, 0);
  assert.equal(rm.phases('p')[0].auto_note, 'needs you: auto-approve is off for this project');
});

test('migration: an old-schema database gains the new columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-mig-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT 'main',
        max_workers INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE phases (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), position INTEGER NOT NULL,
        title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', plan_id INTEGER, error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r');
      INSERT INTO phases(project_id, position, title, prompt) VALUES ('p', 1, 'Old', 'x');`);
    old.close();
    const db = openDb(path);
    const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    for (const c of ['auto_approve', 'auto_approve_halted']) assert.ok(cols('projects').has(c), c);
    for (const c of ['approve_mode', 'auto_note']) assert.ok(cols('phases').has(c), c);
    assert.deepEqual({ ...db.prepare("SELECT auto_approve, auto_approve_halted FROM projects WHERE id='p'").get() }, { auto_approve: 0, auto_approve_halted: null });
    assert.deepEqual({ ...db.prepare('SELECT approve_mode, auto_note FROM phases').get() }, { approve_mode: 'inherit', auto_note: null });
    db.close();
    openDb(path).close(); // idempotent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
