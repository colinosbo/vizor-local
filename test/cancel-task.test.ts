// Owner-initiated cancellation of one task, with dependency rerouting.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planCancel, rerouteDeps } from '../src/cancel.js';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { LocalForge, type Forge } from '../src/forge.js';
import { revParse } from '../src/git.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { addProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { createTargetRepo, DEMO_PLAN, DEMO_SCENARIO } from '../src/sandbox.js';
import { taskMarker, type Check, type PlanBody, type PullRequest, type TaskRow } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-cancel-'));
const task = (key: string, writeScope: string[], deps: string[] = []) =>
  ({ key, title: key, prompt: 'do ' + key, acceptance: 'works', writeScope, deps });
const node = (key: string, deps: string[] = [], status: TaskRow['status'] = 'pending') => ({ key, deps, status });

function memProject(db: DB, id = 'p') {
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers) VALUES (?,?,?,6)").run(id, id, '/repo/' + id);
}
function approve(db: DB, projectId: string, body: PlanBody) {
  const d = draftPlan(db, projectId, body);
  approvePlan(db, d.planId);
  return d;
}
const stubForge = (o: Partial<Forge> = {}): Forge => ({
  baseSha: () => 'base0', findPrByMarker: () => null, createPr: () => { throw new Error('no'); }, getPr: () => null,
  prFiles: () => [], isUpToDate: () => true, checksFor: () => [], notifyPush: () => {}, triggerCi: () => 0, merge: () => 'm', ...o,
});
const deps = (r: Runner, id: string) => JSON.parse(r.task(id).deps) as string[];
const chain = () => ({ summary: '', tasks: [task('a', ['a/**']), task('b', ['b/**'], ['a']), task('c', ['c/**'], ['b'])] });

// ---------------- rerouteDeps (pure) ----------------
test('rerouteDeps: chain A <- B <- C, cancelling B gives C deps [A]', () => {
  assert.deepEqual(rerouteDeps([node('a'), node('b', ['a']), node('c', ['b'])], 'b'), [{ key: 'c', before: ['b'], after: ['a'] }]);
  // Order is kept: the inherited deps take the cancelled dep's place.
  assert.deepEqual(rerouteDeps([node('x'), node('a'), node('b', ['a']), node('c', ['x', 'b', 'z']), node('z')], 'b'),
    [{ key: 'c', before: ['x', 'b', 'z'], after: ['x', 'a', 'z'] }]);
});

test('rerouteDeps: diamond dedupes, never self-depends, skips terminal dependents', () => {
  // Diamond A <- B, A <- C, D <- {B, C, A}. Cancel B: D inherits A once and keeps C.
  const diamond = [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c', 'a'])];
  assert.deepEqual(rerouteDeps(diamond, 'b'), [{ key: 'd', before: ['b', 'c', 'a'], after: ['a', 'c'] }]);
  // Two dependents of B: both rerouted.
  assert.deepEqual(rerouteDeps([node('a'), node('b', ['a']), node('c', ['b']), node('d', ['b', 'a'])], 'b'),
    [{ key: 'c', before: ['b'], after: ['a'] }, { key: 'd', before: ['b', 'a'], after: ['a'] }]);
  // Never adds the task itself (defensive: a dep graph handed in with a back edge).
  assert.deepEqual(rerouteDeps([node('b', ['c']), node('c', ['b'])], 'b'), [{ key: 'c', before: ['b'], after: [] }]);
  // Merged and cancelled dependents are left alone.
  assert.deepEqual(rerouteDeps([node('a'), node('b', ['a']), node('c', ['b'], 'merged'), node('d', ['b'], 'cancelled')], 'b'), []);
});

test('rerouteDeps: no dependents, root task, unknown key', () => {
  assert.deepEqual(rerouteDeps([node('a'), node('b', ['a'])], 'b'), []);
  assert.deepEqual(rerouteDeps([node('a'), node('b', ['a'])], 'a'), [{ key: 'b', before: ['a'], after: [] }]);
  assert.deepEqual(rerouteDeps([node('a')], 'nope'), []);
});

// ---------------- cancelTask: scheduling ----------------
test('cancelling a pending middle task reroutes its dependent, which becomes ready once A merges', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', chain());
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  const seq = eventsAfter(db, 0, {}, 10_000).at(-1)!.seq;
  const res = r.cancelTask('p-v1-b');
  assert.deepEqual(res.dependents, ['c']);
  const b = r.task('p-v1-b');
  assert.equal(b.status, 'cancelled');
  assert.equal(b.hold_reason, 'cancelled by owner');
  assert.equal(b.usage_retry_at, null);
  assert.deepEqual(deps(r, 'p-v1-c'), ['a']);

  const evs = eventsAfter(db, seq, {}, 10_000);
  const rerouted = evs.find((e) => e.type === 'task_deps_rerouted')!;
  assert.equal(rerouted.task_id, 'p-v1-c');
  assert.deepEqual(JSON.parse(rerouted.data), { cancelled: 'b', before: ['b'], after: ['a'] });
  const cancelled = evs.find((e) => e.type === 'task_cancelled')!;
  assert.equal(cancelled.task_id, 'p-v1-b');
  assert.deepEqual(JSON.parse(cancelled.data), { reroute: true, dependents: ['c'], from: 'pending' });

  r.promote();
  assert.equal(r.task('p-v1-c').status, 'pending', 'still waits for the inherited dependency');
  assert.match(r.task('p-v1-c').hold_reason!, /waiting on a/);
  db.prepare("UPDATE tasks SET status='merged' WHERE key='a'").run();
  r.promote();
  assert.equal(r.task('p-v1-c').status, 'ready', 'released without b ever merging');
  assert.equal(r.task('p-v1-b').status, 'cancelled');
});

test('reroute:false leaves dependents unchanged (and waiting)', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', chain());
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  r.cancelTask('p-v1-b', { reroute: false });
  assert.equal(r.task('p-v1-b').status, 'cancelled');
  assert.deepEqual(deps(r, 'p-v1-c'), ['b']);
  assert.equal(eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === 'task_deps_rerouted').length, 0);
  db.prepare("UPDATE tasks SET status='merged' WHERE key='a'").run();
  r.promote();
  assert.equal(r.task('p-v1-c').status, 'pending');
});

test('ready and blocked tasks can be cancelled; merged, merging and cancelled ones are refused', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', { summary: '', tasks: ['a', 'b', 'c', 'd'].map((k) => task(k, [`${k}/**`])) });
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  r.cancelTask('p-v1-a');
  assert.equal(r.task('p-v1-a').status, 'cancelled', 'ready');
  db.prepare("UPDATE tasks SET status='blocked', hold_reason='x', usage_retry_at=? WHERE key='b'").run(Date.now() + 60_000);
  r.cancelTask('p-v1-b');
  assert.equal(r.task('p-v1-b').status, 'cancelled', 'blocked');
  assert.equal(r.task('p-v1-b').usage_retry_at, null);

  db.prepare("UPDATE tasks SET status='merged' WHERE key='c'").run();
  db.prepare("UPDATE tasks SET status='merging', merge_sha='m1' WHERE key='d'").run();
  assert.throws(() => r.cancelTask('p-v1-c'), /cannot cancel.*merged/);
  assert.throws(() => r.cancelTask('p-v1-d'), /cannot cancel.*merging/);
  assert.throws(() => r.cancelTask('p-v1-a'), /cannot cancel.*cancelled/);
  assert.throws(() => r.cancelTask('nope'), /not found/);
  assert.equal(r.task('p-v1-c').status, 'merged');
  assert.equal(r.task('p-v1-d').status, 'merging');
});

test('planCancel previews without writing anything', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', chain());
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  const snapshot = () => ({
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    events: db.prepare('SELECT COUNT(*) n FROM events').get(),
    attempts: db.prepare('SELECT * FROM attempts ORDER BY id').all(),
    changes: db.prepare('SELECT total_changes() AS n').get(),
  });
  const before = snapshot();
  const p = planCancel(db, 'p-v1-b');
  assert.equal(p.cancellable, true);
  assert.equal(p.task.id, 'p-v1-b');
  assert.deepEqual(p.reroutes, [{ key: 'c', before: ['b'], after: ['a'] }]);
  db.prepare("UPDATE tasks SET status='merged' WHERE key='a'").run();
  const before2 = snapshot();
  const refused = planCancel(db, 'p-v1-a');
  assert.equal(refused.cancellable, false);
  assert.match(refused.reason!, /merged/);
  assert.deepEqual(snapshot(), before2);
  assert.notDeepEqual(before, before2, 'sanity: the snapshot does see writes');
});

// ---------------- cancelTask: waiting_ci never merges ----------------
test('a cancelled waiting_ci task is never merged, even with a green check', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', { summary: '', tasks: [task('a', ['src/a/**'])] });
  db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=1, head_sha='h1'").run();
  const t = db.prepare('SELECT * FROM tasks').get() as unknown as TaskRow;
  let pr: PullRequest = { number: 1, branch: t.branch, base: 'main', headSha: 'h1', state: 'open', title: 'a', body: taskMarker(t.id), mergeSha: null };
  const green: Check = { id: 1, sha: 'h1', name: 'local-ci', conclusion: 'success', workflow_ref: 'trusted@main', log: '' };
  let merges = 0;
  const closed: number[] = [];
  const forge = stubForge({
    getPr: () => pr, prFiles: () => [{ status: 'M', paths: ['src/a/x.js'] }], checksFor: (s) => (s === 'h1' ? [green] : []),
    merge: () => { merges++; return 'm'; }, closePr: (n) => { closed.push(n); pr = { ...pr, state: 'closed' }; },
  });
  const r = new Runner(db, forge, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.cancelTask(t.id);
  assert.deepEqual(closed, [1]);
  r.processChecks(); r.processChecks();
  assert.equal(merges, 0);
  assert.equal(r.task(t.id).status, 'cancelled');
  assert.equal(r.handleCheck(t.id, { ...green, id: 2 }), 'superseded', 'late CI result is ignored');
  assert.equal(r.task(t.id).status, 'cancelled');
});

// ---------------- against real git: running worker, real forge ----------------
async function realSetup(sleepMs: number) {
  const root = tmp();
  const { bare, checkout } = createTargetRepo(root);
  const db = openDb(join(root, 'local.db'));
  const forge = new LocalForge(bare, join(root, 'forge.db'));
  const p = addProject(db, checkout, { maxWorkers: 1, name: 'demo' });
  approve(db, p.id, { summary: '', tasks: [DEMO_PLAN.tasks[0], DEMO_PLAN.tasks[2]] }); // history-export depends on history-ui
  const scenario = { 'history-ui': [{ ...DEMO_SCENARIO['history-ui'][0], sleepMs }] };
  const r = new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
  return { db, forge, r, bare };
}

test('cancelling a running task kills the attempt; the task ends cancelled, not blocked', async () => {
  const { db, forge, r } = await realSetup(30_000);
  try {
    await r.tick();
    const id = 'demo-v1-history-ui';
    assert.equal(r.task(id).status, 'running');
    const att = () => db.prepare('SELECT * FROM attempts WHERE task_id=?').get(id) as { status: string; reason: string };
    assert.equal(att().status, 'running');
    const t0 = Date.now();
    const res = r.cancelTask(id);
    assert.deepEqual(res.dependents, ['history-export']);
    await r.settle();
    assert.ok(Date.now() - t0 < 20_000, 'worker was killed, not waited out');
    assert.equal(r.task(id).status, 'cancelled');
    assert.equal(r.task(id).hold_reason, 'cancelled by owner');
    assert.equal(att().status, 'cancelled');
    assert.match(att().reason, /cancelled by owner/);
    assert.ok(r.task(id).worktree, 'worktree kept');
    assert.deepEqual(deps(r, 'demo-v1-history-export'), []);
    assert.equal(eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === 'task_blocked').length, 0);
    await r.tick();
    assert.equal(r.task('demo-v1-history-export').status, 'running', 'dependent released without its dep merging');
    r.cancelTask('demo-v1-history-export');
    await r.settle();
  } finally { await forge.idle(); forge.close(); }
});

test('a published task cancelled in waiting_ci gets its PR closed and is never merged', async () => {
  const { forge, r, bare } = await realSetup(10);
  try {
    await r.tick(); await r.settle();
    const id = 'demo-v1-history-ui';
    const t = r.task(id);
    assert.equal(t.status, 'waiting_ci');
    const base = revParse(bare, 'refs/heads/main');
    r.cancelTask(id, { reroute: false }); // keep the dependent parked so only this task's fate is observed
    assert.equal(forge.getPr(t.pr_number!)!.state, 'closed');
    await forge.idle(); // CI finishes green after the cancellation
    for (let i = 0; i < 3; i++) { await r.tick(); await r.settle(); }
    assert.equal(r.task(id).status, 'cancelled');
    assert.equal(revParse(bare, 'refs/heads/main'), base, 'nothing merged to main');
    assert.ok(revParse(bare, `refs/heads/${t.branch}`), 'branch kept');
  } finally { await forge.idle(); forge.close(); }
});
