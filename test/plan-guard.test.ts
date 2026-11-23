// approvePlan refuses to supersede a plan with in-flight work unless the owner forces it.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan, PlanInFlightError, SUPERSEDED_HOLD } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import type { PlanBody } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const HOLD = 'plan superseded while in flight; owner decision needed';
const tmp = () => mkdtempSync(join(tmpdir(), 'local-guard-'));
const task = (key: string) => ({ key, title: 'T ' + key, prompt: 'do ' + key, acceptance: 'works', writeScope: [`${key}/**`], deps: [] as string[] });
const body = (...keys: string[]): PlanBody => ({ summary: '', tasks: keys.map(task) });

function memProject(db: DB, id = 'p') {
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers) VALUES (?,?,?,6)").run(id, id, '/repo/' + id);
}
const setTask = (db: DB, key: string, status: string, pr: number | null = null) =>
  db.prepare("UPDATE tasks SET status=?, pr_number=? WHERE plan_id=1 AND key=?").run(status, pr, key);
const snapshot = (db: DB) => ({
  plans: db.prepare('SELECT * FROM plans ORDER BY id').all(),
  tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
  events: db.prepare('SELECT * FROM events ORDER BY seq').all(),
});
const task1 = (db: DB, key: string) => ({ ...db.prepare("SELECT status, hold_reason FROM tasks WHERE id=?").get(`p-v1-${key}`) }) as { status: string; hold_reason: string | null };
const lastApproved = (db: DB) => JSON.parse(eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === 'plan_approved').at(-1)!.data);

/** v1 approved with: a running, b waiting_ci (PR #4), c merging (PR #5), d blocked with open PR #6,
 *  e pending, f merged (PR #7), g cancelled (PR #8). Then v2 drafted. */
function inFlightSetup() {
  const db = openDb(':memory:'); memProject(db);
  approvePlan(db, draftPlan(db, 'p', body('a', 'b', 'c', 'd', 'e', 'f', 'g')).planId);
  setTask(db, 'a', 'running');
  setTask(db, 'b', 'waiting_ci', 4);
  setTask(db, 'c', 'merging', 5);
  setTask(db, 'd', 'blocked', 6);
  setTask(db, 'f', 'merged', 7);
  setTask(db, 'g', 'cancelled', 8);
  const v2 = draftPlan(db, 'p', body('x'));
  return { db, v2 };
}

test('refuses approval while the approved plan has in-flight work; nothing changes', () => {
  const { db, v2 } = inFlightSetup();
  assert.equal(SUPERSEDED_HOLD, HOLD);
  const before = snapshot(db);
  let err: unknown;
  assert.throws(() => approvePlan(db, v2.planId), (e) => { err = e; return e instanceof PlanInFlightError; });
  const e = err as PlanInFlightError;
  assert.equal(e.message, 'approved plan v1 still has in-flight tasks: a (running), b (waiting_ci, PR #4), c (merging, PR #5), d (blocked, PR #6)');
  assert.deepEqual(e.tasks, [
    { id: 'p-v1-a', key: 'a', title: 'T a', status: 'running', pr_number: null },
    { id: 'p-v1-b', key: 'b', title: 'T b', status: 'waiting_ci', pr_number: 4 },
    { id: 'p-v1-c', key: 'c', title: 'T c', status: 'merging', pr_number: 5 },
    { id: 'p-v1-d', key: 'd', title: 'T d', status: 'blocked', pr_number: 6 },
  ]);
  assert.deepEqual(snapshot(db), before, 'plans, tasks and events unchanged');
  // Non-boolean force values do not force either.
  assert.throws(() => approvePlan(db, v2.planId, { force: 'true' as unknown as boolean }), PlanInFlightError);
  assert.throws(() => approvePlan(db, v2.planId, { force: false }), PlanInFlightError);
  assert.deepEqual(snapshot(db), before);
});

test('approval without in-flight work behaves as before', () => {
  const db = openDb(':memory:'); memProject(db);
  approvePlan(db, draftPlan(db, 'p', body('a', 'b', 'c')).planId);
  setTask(db, 'a', 'merged', 1);
  setTask(db, 'b', 'ready');
  const v2 = draftPlan(db, 'p', body('x'));
  approvePlan(db, v2.planId);
  const plans = db.prepare('SELECT version, status FROM plans ORDER BY version').all();
  assert.deepEqual(plans.map((p) => ({ ...p })), [{ version: 1, status: 'superseded' }, { version: 2, status: 'approved' }]);
  assert.deepEqual(task1(db, 'a'), { status: 'merged', hold_reason: null });
  assert.deepEqual(task1(db, 'b'), { status: 'cancelled', hold_reason: 'superseded by plan v2' });
  assert.deepEqual(task1(db, 'c'), { status: 'cancelled', hold_reason: 'superseded by plan v2' });
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id='p-v2-x'").get() as { status: string }).status, 'pending');
  const ev = lastApproved(db);
  assert.deepEqual(ev, { planId: v2.planId, version: 2, tasks: ['x'] });
});

test('force:true supersedes, holds every in-flight task with the exact reason, records forced/heldTasks', () => {
  const { db, v2 } = inFlightSetup();
  approvePlan(db, v2.planId, { force: true });
  assert.equal((db.prepare('SELECT status FROM plans WHERE version=1').get() as { status: string }).status, 'superseded');
  assert.equal((db.prepare('SELECT status FROM plans WHERE version=2').get() as { status: string }).status, 'approved');
  for (const k of ['a', 'b', 'c', 'd']) assert.deepEqual(task1(db, k), { status: 'blocked', hold_reason: HOLD }, k);
  assert.deepEqual(task1(db, 'e'), { status: 'cancelled', hold_reason: 'superseded by plan v2' });
  assert.equal(task1(db, 'f').status, 'merged');
  assert.equal(task1(db, 'g').status, 'cancelled');
  const ev = lastApproved(db);
  assert.equal(ev.forced, true);
  assert.deepEqual(ev.heldTasks, ['p-v1-a', 'p-v1-b', 'p-v1-c', 'p-v1-d']);
});

test('a pending task with an open PR is held, not cancelled', () => {
  const db = openDb(':memory:'); memProject(db);
  approvePlan(db, draftPlan(db, 'p', body('a')).planId);
  setTask(db, 'a', 'ready', 3);
  const v2 = draftPlan(db, 'p', body('x'));
  assert.throws(() => approvePlan(db, v2.planId), /a \(ready, PR #3\)/);
  approvePlan(db, v2.planId, { force: true });
  assert.deepEqual(task1(db, 'a'), { status: 'blocked', hold_reason: HOLD });
});

function http(port: number, path: string, o: { method?: string; cookie?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: {
      host: `127.0.0.1:${port}`, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (o.body) req.write(JSON.stringify(o.body));
    req.end();
  });
}

test('server: 409 with inFlight list without force; strict boolean; 200 with {force:true}', async () => {
  const { db, v2 } = inFlightSetup();
  const runner = new Runner(db, () => { throw new Error('no forge'); }, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  const planning = new PlanningService(db, new CannedOrchestrator(DEMO_PLAN));
  const s = await startServer(db, runner, planning);
  try {
    const login = await http(s.port, `/?t=${s.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const approve = (b: unknown) => http(s.port, `/api/plans/${v2.planId}/approve`, { method: 'POST', cookie, body: b });
    const before = snapshot(db);

    for (const b of [{}, { force: 'true' }, { force: 1 }, { force: false }]) {
      const r = await approve(b);
      assert.equal(r.status, 409, JSON.stringify(b));
      const j = JSON.parse(r.body);
      assert.match(j.error, /^approved plan v1 still has in-flight tasks: a \(running\)/);
      assert.deepEqual(j.inFlight.map((t: { key: string }) => t.key), ['a', 'b', 'c', 'd']);
      assert.deepEqual(j.inFlight[1], { id: 'p-v1-b', key: 'b', title: 'T b', status: 'waiting_ci', pr_number: 4 });
    }
    assert.deepEqual(snapshot(db), before, 'refused requests change nothing');

    const ok = await approve({ force: true });
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(JSON.parse(ok.body), { ok: true });
    assert.deepEqual(task1(db, 'a'), { status: 'blocked', hold_reason: HOLD });
    assert.equal(lastApproved(db).forced, true);
  } finally { await s.close(); db.close(); }
});
