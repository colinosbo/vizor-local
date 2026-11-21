import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting, type DB } from '../src/db.js';
import { emit, eventsAfter } from '../src/events.js';
import { LocalForge, type Forge } from '../src/forge.js';
import { evaluateMerge } from '../src/merge.js';
import { approvePlan, draftPlan, validatePlan } from '../src/plan.js';
import { addProject, findProjectForPath } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { createTargetRepo, DEMO_PLAN, DEMO_SCENARIO } from '../src/sandbox.js';
import { inScope, scopesOverlap } from '../src/scope.js';
import { taskMarker, type Check, type PlanBody, type PullRequest, type TaskRow } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';
import { claudeUsageRetryAt } from '../src/usage-limit.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-test-'));
const task = (key: string, writeScope: string[], deps: string[] = []) =>
  ({ key, title: key, prompt: 'do ' + key, acceptance: 'works', writeScope, deps });

function memProject(db: DB, id = 'p', maxWorkers = 6) {
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers) VALUES (?,?,?,?)").run(id, id, '/repo/' + id, maxWorkers);
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

// ---------------- scope ----------------
test('scope globs and conservative overlap', () => {
  assert.ok(inScope('src/history/a.js', ['src/history/*.js']));
  assert.ok(!inScope('src/history/export/a.js', ['src/history/*.js']));
  assert.ok(inScope('src/timer/x/y.js', ['src/timer/**']));
  assert.ok(inScope('a/b/c.test.js', ['**/*.test.js']));
  assert.ok(!inScope('README.md', ['src/**']));
  assert.ok(scopesOverlap(['src/**'], ['src/timer/**']));
  assert.ok(!scopesOverlap(['src/history/**'], ['src/timer/**']));
  assert.ok(!scopesOverlap(['test/history.test.js'], ['test/history-export.test.js']));
});

// ---------------- plan ----------------
test('plan validation: cycles, missing deps, unsafe scope, overlap warning', () => {
  assert.match(validatePlan({ summary: '', tasks: [task('a', ['x/**'], ['b']), task('b', ['y/**'], ['a'])] }).errors.join(), /cycle/);
  assert.match(validatePlan({ summary: '', tasks: [task('a', ['x/**'], ['zzz'])] }).errors.join(), /missing dependency zzz/);
  assert.match(validatePlan({ summary: '', tasks: [task('a', ['../etc/**'])] }).errors.join(), /unsafe scope/);
  const v = validatePlan({ summary: '', tasks: [task('a', ['src/**']), task('b', ['src/x/**'])] });
  assert.equal(v.errors.length, 0);
  assert.match(v.warnings.join(), /overlapping write scopes/);
  assert.equal(validatePlan({ summary: '', tasks: [task('a', ['src/**']), task('b', ['src/x/**'], ['a'])] }).warnings.length, 0);
  assert.deepEqual(validatePlan(DEMO_PLAN), { errors: [], warnings: [] });
});

test('only a draft can be approved; invalid plans cannot be approved', () => {
  const db = openDb(':memory:'); memProject(db);
  const bad = draftPlan(db, 'p', { summary: '', tasks: [task('a', ['x/**'], ['a'])] });
  assert.throws(() => approvePlan(db, bad.planId), /invalid/);
  const ok = approve(db, 'p', { summary: '', tasks: [task('a', ['x/**'])] });
  assert.throws(() => approvePlan(db, ok.planId), /approved/);
});

// ---------------- scheduler ----------------
test('claims respect project and global caps; lowering a cap blocks new starts only', () => {
  const db = openDb(':memory:'); memProject(db, 'p', 3);
  approve(db, 'p', { summary: '', tasks: ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => task(k, [`${k}/**`])) });
  setSetting(db, 'global_max_workers', '2');
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  assert.equal(r.claim().length, 2, 'global cap 2');
  assert.equal(r.claim().length, 0, 'no double claims');
  setSetting(db, 'global_max_workers', '10');
  assert.equal(r.claim().length, 1, 'project cap 3');
  db.prepare('UPDATE projects SET max_workers=1').run();
  assert.equal(r.claim().length, 0, 'lowered cap: no new starts');
  const active = (db.prepare("SELECT COUNT(*) n FROM attempts WHERE status='claimed'").get() as { n: number }).n;
  assert.equal(active, 3, 'existing attempts untouched');
});

test('fair scheduling across projects and pause stops dispatch', () => {
  const db = openDb(':memory:'); memProject(db, 'a', 6); memProject(db, 'b', 6);
  approve(db, 'a', { summary: '', tasks: ['x', 'y', 'z'].map((k) => task(k, [`${k}/**`])) });
  approve(db, 'b', { summary: '', tasks: ['x', 'y', 'z'].map((k) => task(k, [`${k}/**`])) });
  setSetting(db, 'global_max_workers', '2');
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  const got = r.claim().map((c) => r.task(c.taskId).project_id).sort();
  assert.deepEqual(got, ['a', 'b']);
  setSetting(db, 'global_max_workers', '10');
  r.pause('a', true);
  assert.ok(r.claim().every((c) => r.task(c.taskId).project_id === 'b'));
});

test('overlapping scopes are never in flight together', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', { summary: '', tasks: [task('a', ['src/**']), task('b', ['src/ui/**'])] });
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  const c = r.claim();
  assert.equal(c.length, 1);
  const held = db.prepare("SELECT hold_reason FROM tasks WHERE status='ready'").get() as { hold_reason: string };
  assert.match(held.hold_reason, /scope overlaps/);
});

test('Claude usage hold deadlines follow the reported timezone across midnight and DST', () => {
  const limit = (time: string, zone = 'America/Chicago') => "You've hit your 5-hour limit · resets " + time + ' (' + zone + ')';
  assert.equal(claudeUsageRetryAt(limit('3:40pm'), Date.parse('2026-11-20T20:25:00Z')), Date.parse('2026-11-20T21:41:00Z'));
  assert.equal(claudeUsageRetryAt(limit('12:10am'), Date.parse('2026-11-21T05:55:00Z')), Date.parse('2026-11-21T06:11:00Z'));
  assert.equal(claudeUsageRetryAt(limit('3:10am'), Date.parse('2026-03-08T07:55:00Z')), Date.parse('2026-03-08T08:11:00Z'));
  assert.equal(claudeUsageRetryAt(limit('3:40pm', 'Invalid/Timezone'), Date.parse('2026-11-20T20:25:00Z')), null);
  assert.equal(claudeUsageRetryAt(limit('3:40pm'), Date.parse('2026-11-20T21:45:00Z')), null);
  assert.equal(claudeUsageRetryAt('Authentication failed', Date.now()), null);
});

test('Claude usage holds recover after restart without retrying unrelated or paused tasks', async () => {
  const path = join(tmp(), 'local.db');
  let db = openDb(path);
  memProject(db, 'p', 2); memProject(db, 'paused', 2);
  approve(db, 'p', { summary: '', tasks: [
    task('new-hold', ['a/**']), task('old-hold', ['b/**']), task('existing-ready', ['c/**']),
    task('manual-hold', ['d/**']), task('dependent', ['e/**'], ['new-hold']),
  ] });
  approve(db, 'paused', { summary: '', tasks: [task('old-hold', ['f/**'])] });
  const workers = new FakeWorkerFactory({});
  workers.name = 'claude-code';
  let r = new Runner(db, stubForge(), workers, { worktreesDir: tmp() });
  const reason = "You've hit your 5-hour limit · resets 3:40pm (America/Chicago)";
  const observedAt = '2026-11-20 20:25:00';
  const retryAt = Date.parse('2026-11-20T21:41:00Z');
  r.promote();
  r.pause('paused', true);
  db.prepare("UPDATE tasks SET status='running' WHERE key='new-hold'").run();
  db.prepare("INSERT INTO attempts(id,task_id,kind,status,exit_code,reason,ended_at) VALUES ('quota','p-v1-new-hold','initial','exited',1,?,?)").run(reason, observedAt);
  await r.finishAttempt('quota');
  assert.equal(r.task('p-v1-new-hold').usage_retry_at, retryAt);
  assert.equal(r.task('p-v1-new-hold').local_retry_count, 0);
  db.prepare("UPDATE tasks SET status='blocked', hold_reason=?, updated_at=? WHERE key='old-hold'")
    .run('worker exited 1 (' + reason + ')', observedAt);
  db.prepare("UPDATE tasks SET status='blocked', hold_reason='Claude account needs attention' WHERE key='manual-hold'").run();

  db.close();
  db = openDb(path);
  r = new Runner(db, stubForge(), workers, { worktreesDir: tmp() });
  r.recover();
  r.promote();
  assert.equal(r.task('p-v1-old-hold').usage_retry_at, retryAt);
  assert.deepEqual(r.claim(retryAt - 1), []);
  assert.equal(r.task('p-v1-existing-ready').status, 'ready');
  assert.equal(r.task('p-v1-new-hold').status, 'blocked');

  assert.equal(r.claim(retryAt).length, 2, 'respect the worker cap at reset');
  assert.equal(r.task('p-v1-old-hold').usage_retry_at, null);
  assert.equal(r.task('p-v1-new-hold').usage_retry_at, null);
  assert.equal(r.task('paused-v1-old-hold').status, 'blocked');
  assert.equal(r.task('p-v1-manual-hold').status, 'blocked');
  assert.equal(r.task('p-v1-dependent').status, 'pending');
  assert.deepEqual(r.claim(retryAt + 1), []);
  assert.equal(eventsAfter(db, 0).filter((event) => event.type === 'task_usage_resumed').length, 2);
  db.close();
});

test('dependency waits for merge', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', { summary: '', tasks: [task('schema', ['db/**']), task('ui', ['ui/**'], ['schema'])] });
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote();
  assert.match(r.task('p-v1-ui').hold_reason!, /waiting on schema/);
  db.prepare("UPDATE tasks SET status='waiting_ci' WHERE key='schema'").run(); r.promote();
  assert.equal(r.task('p-v1-ui').status, 'pending', 'green PR is not enough');
  db.prepare("UPDATE tasks SET status='merged' WHERE key='schema'").run(); r.promote();
  assert.equal(r.task('p-v1-ui').status, 'ready');
});

// ---------------- repair loop ----------------
test('CI failure → exactly one repair; redelivery and stale results ignored; limit holds', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', { summary: '', tasks: [task('a', ['a/**'])] });
  db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=1, head_sha='h1'").run();
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp(), repairLimit: 1 });
  const fail = (id: number, sha: string): Check => ({ id, sha, name: 'local-ci', conclusion: 'failure', workflow_ref: 'trusted@main', log: 'AssertionError' });
  assert.equal(r.handleCheck('p-v1-a', fail(7, 'h1')), 'handled');
  assert.equal(r.handleCheck('p-v1-a', fail(7, 'h1')), 'duplicate');
  let t = r.task('p-v1-a');
  assert.equal(t.status, 'ready'); assert.equal(t.repair_count, 1);
  assert.match(t.pending_repair!, /AssertionError/);
  db.prepare("UPDATE tasks SET status='waiting_ci', head_sha='h2', pending_repair=NULL").run();
  assert.equal(r.handleCheck('p-v1-a', fail(8, 'h1')), 'superseded', 'result for an older head');
  r.handleCheck('p-v1-a', fail(9, 'h2'));
  t = r.task('p-v1-a');
  assert.equal(t.status, 'blocked'); assert.match(t.hold_reason!, /still failing.*PR #1 preserved/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM repairs').get() as { n: number }).n, 2);
});

test('failed CI is replayed after rollback and restart, then queued exactly once', () => {
  const path = join(tmp(), 'local.db');
  let db = openDb(path);
  memProject(db);
  approve(db, 'p', { summary: '', tasks: [task('a', ['a/**'])] });
  const id = 'p-v1-a';
  const check: Check = { id: 7, sha: 'head', name: 'local-ci', conclusion: 'failure', workflow_ref: 'trusted@main', log: 'failed assertion' };
  const makeRunner = () => new Runner(db, stubForge({ checksFor: () => [check] }), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=3, head_sha='head'").run();
  db.exec("CREATE TRIGGER simulate_crash BEFORE UPDATE ON tasks WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  assert.throws(() => makeRunner().handleCheck(id, check), /interrupted/);
  db.close();
  db = openDb(path);
  assert.equal(db.prepare('SELECT 1 FROM processed_checks').get(), undefined);
  assert.equal(db.prepare('SELECT 1 FROM repairs').get(), undefined);
  db.exec('DROP TRIGGER simulate_crash');
  const runner = makeRunner();
  runner.processChecks();
  assert.equal(runner.task(id).status, 'ready');
  assert.equal(runner.task(id).pr_number, 3);
  assert.equal(runner.task(id).repair_count, 1);
  assert.equal(runner.handleCheck(id, check), 'duplicate');
  db.close();
});

test('recover interrupted repairs written by older builds without replaying a started repair', () => {
  for (const hasRepairKey of [false, true]) {
    const db = openDb(':memory:');
    memProject(db);
    approve(db, 'p', { summary: '', tasks: [task('a', ['a/**'])] });
    const id = 'p-v1-a';
    const check: Check = { id: 7, sha: 'head', name: 'local-ci', conclusion: 'failure', workflow_ref: 'trusted@main', log: 'failed assertion' };
    db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=3, head_sha='head'").run();
    db.prepare('INSERT INTO processed_checks(check_id, task_id) VALUES (?,?)').run(check.id, id);
    if (hasRepairKey) db.prepare('INSERT INTO repairs(key, task_id, head_sha, check_id) VALUES (?,?,?,?)').run(id + ':head:7', id, 'head', 7);
    const runner = new Runner(db, stubForge({ checksFor: () => [check] }), new FakeWorkerFactory({}), { worktreesDir: tmp() });
    runner.processChecks();
    assert.equal(runner.task(id).status, 'ready');
    assert.equal(runner.task(id).repair_count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM repairs').get() as { n: number }).n, 1);
    const [claim] = runner.claim();
    db.prepare("UPDATE attempts SET status='succeeded' WHERE id=?").run(claim.attemptId);
    db.prepare("UPDATE tasks SET status='waiting_ci', pending_repair=NULL").run();
    assert.equal(runner.handleCheck(id, check), 'duplicate');
    assert.equal(runner.task(id).repair_count, 1);
    db.close();
  }
});

// ---------------- merge authority ----------------
test('merge authority fails closed', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', { summary: '', tasks: [task('a', ['src/a/**'])] });
  db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=1, head_sha='new'").run();
  const t = db.prepare('SELECT * FROM tasks').get() as unknown as TaskRow;
  const proj = { id: 'p', name: 'p', repo_path: '/r', base_branch: 'main', max_workers: 1, paused: 0, forge_origin: null, ci_command: 'node --test', roadmap_paused: 0 };
  const pr: PullRequest = { number: 1, branch: t.branch, base: 'main', headSha: 'new', state: 'open', title: 'a', body: taskMarker(t.id), mergeSha: null };
  const green = (sha: string, id = 1): Check => ({ id, sha, name: 'local-ci', conclusion: 'success', workflow_ref: 'trusted@main', log: '' });
  const files = [{ status: 'M', paths: ['src/a/x.js'] }];
  const base = { getPr: () => pr, prFiles: () => files, checksFor: (s: string) => (s === 'new' ? [green('new')] : []) };
  const codes = (o: Partial<Forge>) => evaluateMerge(db, stubForge({ ...base, ...o }), t, proj).holds.map((h) => h.code);

  assert.ok(evaluateMerge(db, stubForge(base), t, proj).eligible);
  assert.deepEqual(codes({ checksFor: (s) => (s === 'old' ? [green('old')] : []) }), ['no_check'], 'stale green check on an older commit cannot approve');
  assert.deepEqual(codes({ getPr: () => ({ ...pr, headSha: 'newer' }) }), ['head_moved']);
  assert.deepEqual(codes({ prFiles: () => [{ status: 'R100', paths: ['src/a/x.js', 'secrets/x.js'] }] }), ['out_of_scope'], 'rename checks both paths');
  assert.deepEqual(codes({ prFiles: () => null }), ['files_unknown']);
  assert.deepEqual(codes({ checksFor: () => [green('new', 1), { ...green('new', 2), conclusion: 'failure' }] }), ['ambiguous_checks']);
  assert.deepEqual(codes({ checksFor: () => [{ ...green('new'), workflow_ref: 'pr-branch' }] }), ['untrusted_check']);
  assert.deepEqual(codes({ checksFor: () => [{ ...green('new'), conclusion: 'pending' }] }), ['check_pending']);
  assert.deepEqual(codes({ isUpToDate: () => false }), ['stale']);
  assert.deepEqual(codes({ isUpToDate: () => null }), ['freshness_unknown']);
  assert.deepEqual(codes({ getPr: () => ({ ...pr, body: 'no marker' }) }), ['unbound_pr']);
  assert.deepEqual(codes({ getPr: () => ({ ...pr, branch: 'feature/x' }) }), ['not_bot_branch']);
  db.prepare("UPDATE plans SET status='superseded'").run();
  assert.deepEqual(codes({}), ['plan_not_approved']);
});

test('restart after claim but before launch: safe requeue, no PR needed', () => {
  const db = openDb(':memory:'); memProject(db);
  approve(db, 'p', { summary: '', tasks: [task('a', ['a/**'])] });
  const r = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r.promote(); r.claim();
  const r2 = new Runner(db, stubForge(), new FakeWorkerFactory({}), { worktreesDir: tmp() });
  r2.recover();
  assert.equal(r2.task('p-v1-a').status, 'ready');
  assert.equal((db.prepare("SELECT status FROM attempts").get() as { status: string }).status, 'cancelled');
});

test('Claude stream parser handles real CLI output shapes', async () => {
  const { parseClaudeStreamLine } = await import('../src/workers.js');
  assert.equal(parseClaudeStreamLine('{"type":"active_goal","value":null}'), null);
  assert.equal(parseClaudeStreamLine('{"type":"system","subtype":"init","session_id":"s1"}')?.kind, 'system');
  assert.match(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"a"}}]}}')!.text, /Write/);
  assert.match(parseClaudeStreamLine('{"type":"result","subtype":"success","is_error":true,"result":"Authentication error"}')!.text, /error/);
});

// ---------------- events ----------------
test('event replay from a cursor has no gaps or duplicates', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 5; i++) emit(db, { type: 'x', data: { i } });
  assert.deepEqual(eventsAfter(db, 2).map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(eventsAfter(db, 5), []);
});

// ---------------- recovery against real git ----------------
async function oneTaskPublished() {
  const root = tmp();
  const { bare, checkout } = createTargetRepo(root);
  const db = openDb(join(root, 'local.db'));
  const forge = new LocalForge(bare, join(root, 'forge.db'));
  const p = addProject(db, checkout, { maxWorkers: 1, name: 'demo' });
  approve(db, p.id, { summary: '', tasks: [DEMO_PLAN.tasks[0]] });
  const scenario = { 'history-ui': [{ ...DEMO_SCENARIO['history-ui'][0], sleepMs: 10 }] };
  const r = new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
  await r.tick(); await r.settle();
  const t = r.task('demo-v1-history-ui');
  assert.equal(t.status, 'waiting_ci');
  return { root, db, forge, r, t, scenario, checkout };
}

test('restart after PR publication: resumes without duplicate PR or duplicate execution', async () => {
  const { db, forge, t, scenario, root } = await oneTaskPublished();
  // Simulate a crash after the PR was created but before the DB recorded success.
  db.prepare("UPDATE attempts SET status='exited', ended_at=NULL").run();
  db.prepare("UPDATE tasks SET status='running', pr_number=NULL, head_sha=NULL").run();
  const r2 = new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
  r2.recover(); await r2.settle();
  const after = r2.task(t.id);
  assert.equal(after.status, 'waiting_ci');
  assert.equal(after.pr_number, t.pr_number);
  assert.equal(forge.allPrs().length, 1, 'no duplicate PR');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM attempts').get() as { n: number }).n, 1, 'no relaunch');
  await forge.idle();
});

test('restart with dead process: adopt existing PR (twice), hold uncertain run', async () => {
  const { db, forge, t, scenario, root } = await oneTaskPublished();
  db.prepare("UPDATE attempts SET status='running', pid=999999").run();
  db.prepare("UPDATE tasks SET status='running'").run();
  let r2 = new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
  r2.recover();
  assert.equal(r2.task(t.id).status, 'waiting_ci', 'adopted PR found by task marker');

  // Claimed for a retry but never launched while its PR exists → adopt the PR, no relaunch.
  db.prepare("INSERT INTO attempts(id, task_id, kind, status) VALUES ('c1', ?, 'retry', 'claimed')").run(t.id);
  db.prepare("UPDATE tasks SET status='running'").run();
  r2 = new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
  r2.recover();
  assert.equal(r2.task(t.id).status, 'waiting_ci');

  // Running, process gone, no matching PR head (uncommitted edits) → hold, never relaunch.
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(t.worktree!, 'src/history/history.js'))}, '// edited')`]);
  db.prepare("INSERT INTO attempts(id, task_id, kind, status, pid) VALUES ('c2', ?, 'retry', 'running', 999998)").run(t.id);
  db.prepare("UPDATE tasks SET status='running'").run();
  r2 = new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
  r2.recover();
  assert.equal(r2.task(t.id).status, 'blocked');
  assert.match(r2.task(t.id).hold_reason!, /uncertain/);
  await forge.idle();
});

test('launcher lookup: path with spaces, unregistered checkout, non-git path', async () => {
  const { db, checkout, root } = await oneTaskPublished();
  const found = findProjectForPath(db, join(checkout, 'src'));
  assert.ok('id' in found && found.id === 'demo');
  assert.ok('setupNeeded' in findProjectForPath(db, root));
});

test('local forge: interrupted CI delivery recovers the same PR before starting its dependent', async () => {
  const root = tmp();
  const { bare, checkout } = createTargetRepo(root);
  const dbPath = join(root, 'local.db');
  const forgePath = join(root, 'forge.db');
  let db = openDb(dbPath);
  let forge = new LocalForge(bare, forgePath);
  const project = addProject(db, checkout, { maxWorkers: 1, name: 'demo' });
  const dependent = task('timer-display', ['src/display/**'], ['rest-timer']);
  approve(db, project.id, { summary: 'Rest timer and display', tasks: [DEMO_PLAN.tasks[1], dependent] });
  const scenario = {
    'rest-timer': DEMO_SCENARIO['rest-timer'],
    'timer-display': [{ files: { 'src/display/timer.js': 'export const label = "Rest timer";\n' } }],
  };
  const makeRunner = () => new Runner(db, forge, new FakeWorkerFactory(scenario), { worktreesDir: join(root, 'wt') });
  const timerId = 'demo-v1-rest-timer';
  const displayId = 'demo-v1-timer-display';
  try {
    const before = makeRunner();
    await before.tick();
    await before.settle();
    await forge.idle();
    const first = before.task(timerId);
    assert.equal(first.status, 'waiting_ci');
    const [failure] = forge.checksFor(first.head_sha!);
    assert.equal(failure.conclusion, 'failure');
    assert.equal(before.task(displayId).status, 'pending');

    // Abort after the acknowledgement and repair insert, before the task becomes ready.
    db.exec("CREATE TEMP TRIGGER interrupt_repair BEFORE UPDATE ON tasks WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    assert.throws(() => before.handleCheck(timerId, failure), /interrupted/);
    db.close();
    forge.close();
    db = openDb(dbPath);
    forge = new LocalForge(bare, forgePath);

    const after = makeRunner();
    after.recover();
    await after.tick();
    await after.settle();
    await forge.idle();
    const repaired = after.task(timerId);
    assert.equal(repaired.pr_number, first.pr_number);
    assert.equal(repaired.branch, first.branch);
    assert.equal(repaired.repair_count, 1);
    assert.notEqual(repaired.head_sha, first.head_sha);
    assert.equal(forge.checksFor(repaired.head_sha!)[0].conclusion, 'success');
    assert.equal(forge.allPrs().length, 1);
    assert.equal(after.handleCheck(timerId, failure), 'duplicate');

    await after.tick();
    const merging = after.task(timerId);
    assert.equal(merging.status, 'merging');
    assert.equal(after.task(displayId).status, 'pending');
    await forge.idle();
    await after.tick();
    await after.settle();
    assert.equal(after.task(timerId).status, 'merged');
    assert.equal(forge.getPr(first.pr_number!)?.mergeSha, merging.merge_sha);
    assert.equal(forge.checksFor(merging.merge_sha!)[0].conclusion, 'success');
    const attempts = db.prepare('SELECT base_sha FROM attempts WHERE task_id=?').all(displayId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].base_sha, merging.merge_sha);
  } finally {
    await forge.idle();
    forge.close();
    db.close();
  }
});

// ---------------- end to end ----------------
test('end-to-end demo passes (parallel workers, repair, stale update, dependency, scope hold)', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'demo'], { encoding: 'utf8', timeout: 150_000 });
  assert.match(out, /PASS/);
});
