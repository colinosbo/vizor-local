// Owner-only "Merge anyway" for a task held because its plan was superseded while it was in flight.
// Only plan_not_approved is relaxed; every other merge check must still pass, and refusals change nothing.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { HeadMovedError, LocalForge, type Forge } from '../src/forge.js';
import { revParse } from '../src/git.js';
import { evaluateMerge } from '../src/merge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan, SUPERSEDED_HOLD } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { setReviewGate } from '../src/review/store.js';
import { Runner } from '../src/runner.js';
import { createTargetRepo, DEMO_PLAN, DEMO_SCENARIO } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { taskMarker, type Check, type FileChange, type PlanBody, type PullRequest } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-anyway-'));
const task = (key: string, writeScope: string[]) => ({ key, title: key, prompt: 'do ' + key, acceptance: 'works', writeScope, deps: [] as string[] });
const body = (key: string, scope: string[]): PlanBody => ({ summary: '', tasks: [task(key, scope)] });
const ID = 'p-v1-a';
const HEAD = 'h1';

const green = (sha: string, id = 1): Check => ({ id, sha, name: 'local-ci', conclusion: 'success', workflow_ref: 'trusted@main', log: '' });
const overrideEvents = (db: DB) => eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === 'owner_override_merge');

/**
 * Plan v1 task `a` (scope src/a/**) has open PR #1 at head h1 with a green check, in scope and fresh.
 * Plan v2 is then force-approved, which holds `a` with the supersession reason.
 * Tests mutate the forge facts (`f`) to produce each refusal.
 */
function held() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers) VALUES ('p','p','/repo/p',6)").run();
  approvePlan(db, draftPlan(db, 'p', body('a', ['src/a/**'])).planId);
  db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=1, head_sha=? WHERE id=?").run(HEAD, ID);
  approvePlan(db, draftPlan(db, 'p', body('x', ['src/x/**'])).planId, { force: true });

  const f = {
    pr: { number: 1, branch: `local/${ID}`, base: 'main', headSha: HEAD, state: 'open', title: 'a', body: taskMarker(ID), mergeSha: null } as PullRequest,
    files: [{ status: 'M', paths: ['src/a/x.js'] }] as FileChange[] | null,
    checks: [green(HEAD)] as Check[],
    fresh: true as boolean | null,
    merges: [] as { n: number; expected: string }[],
    pushes: 0,
    beforeMerge: () => {},
  };
  const forge: Forge = {
    baseSha: () => 'base0', findPrByMarker: () => f.pr, createPr: () => { throw new Error('no'); },
    getPr: () => f.pr, prFiles: () => f.files, isUpToDate: () => f.fresh,
    checksFor: (sha) => f.checks.filter((c) => c.sha === sha),
    notifyPush: () => { f.pushes++; }, triggerCi: () => 99,
    merge: (n, expected) => { // same guard as LocalForge: merge only the expected head
      f.beforeMerge();
      if (f.pr.state !== 'open') throw new Error(`PR #${n} not open`);
      if (f.pr.headSha !== expected) throw new HeadMovedError(`PR #${n} head is ${f.pr.headSha}, expected ${expected}`);
      f.merges.push({ n, expected });
      f.pr = { ...f.pr, state: 'merged', mergeSha: 'm1' };
      return 'm1';
    },
  };
  const r = new Runner(db, forge, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  assert.deepEqual({ status: r.task(ID).status, hold: r.task(ID).hold_reason }, { status: 'blocked', hold: SUPERSEDED_HOLD });
  return { db, r, f, forge };
}

/** Refusal: throws, task row byte-identical, no override event, nothing merged, no base update. */
function assertRefused(s: ReturnType<typeof held>, msg: RegExp) {
  const before = { ...s.r.task(ID) };
  assert.throws(() => s.r.mergeAnyway(ID), msg);
  assert.deepEqual({ ...s.r.task(ID) }, before, 'task unchanged');
  assert.equal(overrideEvents(s.db).length, 0, 'no owner_override_merge event');
  assert.deepEqual(s.f.merges, [], 'nothing merged');
  assert.equal(s.f.pushes, 0, 'no controlled base update');
}

// ---------- refusals: hold state ----------
test('refuses a task that is not held', () => {
  const s = held();
  s.db.prepare("UPDATE tasks SET status='waiting_ci', hold_reason=NULL WHERE id=?").run(ID);
  assertRefused(s, /only applies to a task held/);
});

test('refuses a blocked task with a different hold reason', () => {
  const s = held();
  s.db.prepare("UPDATE tasks SET hold_reason='merge held: stale (branch behind main)' WHERE id=?").run(ID);
  assertRefused(s, /only applies to a task held/);
});

test('refuses when the plan is draft rather than superseded', () => {
  const s = held();
  s.db.prepare("UPDATE plans SET status='draft' WHERE version=1").run();
  assertRefused(s, /plan_not_approved/);
});

// ---------- refusals: PR ----------
test('refuses when the PR is closed', () => {
  const s = held();
  s.f.pr = { ...s.f.pr, state: 'closed' };
  assertRefused(s, /pr_not_open \(PR is closed\)/);
});

test('refuses when the PR is already merged', () => {
  const s = held();
  s.f.pr = { ...s.f.pr, state: 'merged' };
  assertRefused(s, /pr_not_open \(PR is merged\)/);
});

test('refuses when the PR head moved away from the task head', () => {
  const s = held();
  s.f.pr = { ...s.f.pr, headSha: 'h2' };
  s.f.checks = [green('h2')]; // even a green check on the new head cannot approve an unverified head
  assertRefused(s, /head_moved/);
});

// ---------- refusals: required check ----------
test('refuses with no check on the head', () => {
  const s = held();
  s.f.checks = [];
  assertRefused(s, /no_check/);
});

test('refuses while the check is pending', () => {
  const s = held();
  s.f.checks = [{ ...green(HEAD), conclusion: 'pending' }];
  assertRefused(s, /check_pending/);
});

test('refuses when the check failed', () => {
  const s = held();
  s.f.checks = [{ ...green(HEAD), conclusion: 'failure' }];
  assertRefused(s, /check_failed/);
});

test('refuses a green check on a different SHA than the head', () => {
  const s = held();
  s.f.checks = [green('h0')];
  assertRefused(s, /no_check/);
});

// ---------- refusals: scope and freshness ----------
test('refuses when a changed file is outside the write scope', () => {
  const s = held();
  s.f.files = [{ status: 'M', paths: ['src/a/x.js'] }, { status: 'A', paths: ['src/other/y.js'] }];
  assertRefused(s, /out_of_scope.*src\/other\/y\.js/);
});

test('refuses a stale branch and does not update it from base', () => {
  const s = held();
  s.f.fresh = false;
  assertRefused(s, /stale/);
});

// ---------- race ----------
test('a head that moves between evaluation and merge fails closed', () => {
  const s = held();
  s.f.beforeMerge = () => { s.f.pr = { ...s.f.pr, headSha: 'h2' }; };
  const before = { ...s.r.task(ID) };
  assert.throws(() => s.r.mergeAnyway(ID), /nothing was merged.*head is h2/);
  assert.deepEqual({ ...s.r.task(ID) }, before, 'task still held');
  assert.deepEqual(s.f.merges, []);
  const failed = eventsAfter(s.db, 0, {}, 10_000).filter((e) => e.type === 'owner_override_merge_failed');
  assert.equal(JSON.parse(failed[0].data).headMoved, true);
  assert.equal(eventsAfter(s.db, 0, {}, 10_000).filter((e) => e.type === 'pr_merged').length, 0);
});

// ---------- happy path (stub forge) ----------
test('eligible held task: override event, SHA-guarded merge, then merged by the post-merge check', () => {
  const s = held();
  // Without the option the same task still holds on the plan.
  assert.deepEqual(evaluateMerge(s.db, s.forge, s.r.task(ID), s.r.project('p')).holds.map((h) => h.code), ['plan_not_approved']);
  assert.ok(evaluateMerge(s.db, s.forge, s.r.task(ID), s.r.project('p'), { ownerOverride: true }).eligible);

  assert.deepEqual(s.r.mergeAnyway(ID), { mergeSha: 'm1' });
  assert.deepEqual(s.f.merges, [{ n: 1, expected: HEAD }]);
  const t = s.r.task(ID);
  assert.equal(t.status, 'merging');
  assert.equal(t.merge_sha, 'm1');
  const [ev] = overrideEvents(s.db);
  assert.deepEqual(JSON.parse(ev.data), { taskId: ID, planId: t.plan_id, headSha: HEAD, prNumber: 1, holdCode: 'plan_not_approved' });
  assert.equal(s.r.handleCheck(ID, green('m1', 50)), 'handled');
  assert.equal(s.r.task(ID).status, 'merged');
});

// ---------- HTTP route ----------
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

test('server: POST /api/tasks/:id/merge-anyway returns 400 with the refusal, then 200 once eligible', async () => {
  const s = held();
  s.f.fresh = false;
  const srv = await startServer(s.db, s.r, new PlanningService(s.db, new CannedOrchestrator(DEMO_PLAN)));
  try {
    const login = await http(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const call = () => http(srv.port, `/api/tasks/${ID}/merge-anyway`, { method: 'POST', cookie, body: {} });
    const refused = await call();
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, /stale/);
    assert.equal(s.r.task(ID).status, 'blocked');
    s.f.fresh = true;
    const ok = await call();
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, mergeSha: 'm1' });
    assert.equal(s.r.task(ID).status, 'merging');
  } finally { await srv.close(); s.db.close(); }
});

// ---------- happy path against real git ----------
test('real forge: held task is squash-merged at its exact head and reaches merged', async () => {
  const root = tmp();
  const { bare, checkout } = createTargetRepo(root);
  const db = openDb(join(root, 'local.db'));
  const forge = new LocalForge(bare, join(root, 'forge.db'));
  try {
    const p = addProject(db, checkout, { maxWorkers: 1, name: 'demo' });
    setReviewGate(db, p.id, 'report');
    approvePlan(db, draftPlan(db, p.id, { summary: '', tasks: [DEMO_PLAN.tasks[0]] }).planId);
    const scenario = { 'history-ui': [{ ...DEMO_SCENARIO['history-ui'][0], sleepMs: 10 }] };
    const r = new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
    await r.tick(); await r.settle();
    const id = 'demo-v1-history-ui';
    const published = r.task(id);
    assert.equal(published.status, 'waiting_ci');

    approvePlan(db, draftPlan(db, p.id, { summary: '', tasks: [DEMO_PLAN.tasks[3]] }).planId, { force: true });
    await forge.idle(); // CI finishes green on the published head
    const t = r.task(id);
    assert.deepEqual({ status: t.status, hold: t.hold_reason }, { status: 'blocked', hold: SUPERSEDED_HOLD });
    assert.equal(forge.checksFor(t.head_sha!).at(-1)!.conclusion, 'success');
    assert.deepEqual(evaluateMerge(db, forge, t, r.project(p.id)).holds.map((h) => h.code), ['plan_not_approved'], 'unchanged without the option');

    const { mergeSha } = r.mergeAnyway(id);
    assert.equal(revParse(bare, 'refs/heads/main'), mergeSha);
    assert.equal(forge.getPr(t.pr_number!)!.state, 'merged');
    assert.equal(r.task(id).status, 'merging');
    const types = eventsAfter(db, 0, {}, 10_000).filter((e) => e.task_id === id).map((e) => e.type);
    assert.ok(types.indexOf('owner_override_merge') < types.indexOf('pr_merged'), 'override recorded before the merge');

    await forge.idle(); // post-merge CI on the merged commit
    r.processChecks();
    assert.equal(r.task(id).status, 'merged');
    assert.equal(eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === 'task_merged' && e.task_id === id).length, 1);
  } finally { await forge.idle(); forge.close(); db.close(); }
});
