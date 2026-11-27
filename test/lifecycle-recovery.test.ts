import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProject } from '../src/projects.js';
import { openDb } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { githubRepoFromRemote } from '../src/git.js';
import { approvePlan, draftPlan, validatePlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { setReviewGate } from '../src/review/store.js';
import { Runner } from '../src/runner.js';
import { REQUIRED_CHECK, TRUSTED_WORKFLOW, taskMarker, type Check, type PlanBody, type Project, type TaskRow } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const plan: PlanBody = { summary: 'build UI and integrate', tasks: [
  { key: 'first', title: 'First', prompt: 'Build it', acceptance: 'Works', writeScope: ['a.txt'], deps: [] },
  { key: 'second', title: 'Second', prompt: 'Wire it', acceptance: 'Works', writeScope: ['b.txt'], deps: ['first'] },
] };
const check = (id: number, sha: string, conclusion: Check['conclusion']): Check =>
  ({ id, sha, conclusion, name: REQUIRED_CHECK, workflow_ref: TRUSTED_WORKFLOW, log: '' });

function fixture() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id,name,repo_path) VALUES ('p','p','/fixture')").run();
  setReviewGate(db, 'p', 'off');
  approvePlan(db, draftPlan(db, 'p', plan).planId);
  const task = (key: string) => db.prepare('SELECT * FROM tasks WHERE key=?').get(key) as unknown as TaskRow;
  const first = task('first');
  let merged = false;
  const result = new Map<string, Check[]>();
  const triggered: string[] = [];
  const forge: Forge = {
    baseSha: () => 'base', findPrByMarker: () => null, createPr: () => { throw new Error('unexpected PR'); },
    getPr: () => ({ number: 1, branch: first.branch, base: 'main', headSha: 'head', mergeSha: merged ? 'squash' : null,
      state: merged ? 'merged' : 'open', body: taskMarker(first.id), title: 'First' }),
    prFiles: () => [{ status: 'M', paths: ['a.txt'] }], isUpToDate: () => true,
    checksFor: (sha) => result.get(sha) ?? [],
    notifyPush: () => {}, triggerCi: (sha) => { triggered.push(sha); return triggered.length; },
    merge: () => { throw new Error('should reconcile a previous merge'); },
  };
  const runner = new Runner(db, forge, new FakeWorkerFactory({}), { worktreesDir: '.', checkTimeoutMs: 1000 });
  return { db, first, task, forge, runner, result, triggered, landed: () => { merged = true; },
    project: () => db.prepare("SELECT * FROM projects WHERE id='p'").get() as unknown as Project,
    published: () => db.prepare("UPDATE tasks SET status='waiting_ci',pr_number=1,head_sha='head' WHERE id=?").run(first.id) };
}

test('recover a recorded merge intent and rerun verification without reopening the PR', () => {
  const f = fixture();
  f.published(); f.landed();
  f.db.prepare("UPDATE tasks SET merge_intent_sha='head' WHERE id=?").run(f.first.id);
  f.runner.processChecks();
  assert.equal(f.task('first').merge_sha, 'squash');
  assert.deepEqual(f.triggered, ['squash']);
  f.result.set('squash', [check(1, 'squash', 'failure')]);
  f.runner.processChecks(); f.runner.promote();
  assert.equal(f.task('first').status, 'blocked');
  assert.equal(f.task('second').status, 'pending');
  f.runner.retry(f.first.id);
  assert.equal(f.task('first').status, 'merging');
  assert.deepEqual(f.triggered, ['squash', 'squash']);
  f.result.set('squash', [check(1, 'squash', 'failure'), check(2, 'squash', 'success')]);
  f.runner.processChecks(); f.runner.promote();
  assert.equal(f.task('first').status, 'merged');
  assert.equal(f.task('second').status, 'ready');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.n, 0);
});

test('an external merge with no recorded intent requires owner attention', () => {
  const f = fixture();
  f.published(); f.landed();
  f.runner.processChecks();
  assert.equal(f.task('first').status, 'blocked');
  assert.match(f.task('first').hold_reason ?? '', /PR is merged/);
});

test('missing CI expires and a check source mismatch holds immediately', () => {
  const f = fixture();
  f.published();
  f.runner.processChecks(100);
  assert.match(f.task('first').hold_reason ?? '', /waiting for local-ci/);
  f.runner.processChecks(1200);
  assert.match(f.task('first').hold_reason ?? '', /check wait expired/);
  f.runner.retry(f.first.id);
  f.result.set('head', [{ ...check(1, 'head', 'success'), workflow_ref: 'different app' }]);
  f.runner.processChecks(1300);
  assert.match(f.task('first').hold_reason ?? '', /check source mismatch/);
});

test('a missing base consumes no worker slot', () => {
  const f = fixture();
  f.forge.baseSha = () => null;
  f.runner.promote();
  assert.deepEqual(f.runner.claim(), []);
  assert.match(f.task('first').hold_reason ?? '', /base branch main could not be resolved/);
});

test('chat planner retries a saved request across restart once and binds one draft', async () => {
  const f = fixture();
  const old = new PlanningService(f.db, { draft: async () => { throw new Error('planner timed out'); } });
  const started = old.start(f.project(), 'preserve this request');
  await old.idle();
  const resumed: string[] = [];
  const service = new PlanningService(f.db, { draft: async (_p, text) => { resumed.push(text); return { reply: 'ok', plan }; } });
  service.recoverChat(Date.now() + 60_000);
  await service.idle();
  service.recoverChat(Date.now() + 60_000);
  assert.deepEqual(resumed, ['preserve this request']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM plans').get()?.n, 2);
  assert.equal(f.db.prepare('SELECT 1 FROM planning_requests WHERE id=?').get(started.requestId), undefined);
  assert.throws(() => service.start(f.project(), 'x'.repeat(13_000)), /exceeds/);
});

test('GitHub URL normalization and malformed plan validation', () => {
  assert.equal(githubRepoFromRemote('https://github.com/team/app.git'), 'team/app');
  assert.equal(githubRepoFromRemote('git@github.com:team/app.git'), 'team/app');
  assert.equal(githubRepoFromRemote('https://github.com.example.com/team/app'), null);
  assert.equal(githubRepoFromRemote('https://name:token@github.com/team/app'), null);
  assert.match(validatePlan({ tasks: [null] } as unknown as PlanBody).errors[0], /Every task/);
});


test('GitHub onboarding clones or links shared history, preserving local edits and remotes', () => {
  const root = mkdtempSync(join(tmpdir(), 'vizor-link-'));
  const existing = join(root, 'linked');
  mkdirSync(existing);
  writeFileSync(join(existing, 'draft.txt'), 'my working changes');
  const cloned = join(root, 'cloned');
  const remote = 'https://github.com/team/app.git';
  const db = openDb(':memory:');
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const original = cp.execFileSync;
  const calls: string[][] = [];
  (cp as { execFileSync: unknown }).execFileSync = (_bin: string, args: string[], opts: { cwd: string }) => {
    const operation = args.slice(6);
    calls.push(operation);
    switch (operation[0]) {
      case 'rev-parse':
        if (operation.includes('--show-toplevel')) return opts.cwd;
        return 'a'.repeat(40);
      case 'ls-remote': return 'ref: refs/heads/trunk\tHEAD';
      case 'symbolic-ref': return 'origin/trunk';
      case 'merge-base': return 'a'.repeat(40);
      case 'config': return opts.cwd === cloned ? remote : 'C:/local-forge.git';
      case 'fetch': return '';
      case 'clone': mkdirSync(operation.at(-1)!); return '';
      default: throw new Error('unexpected Git operation ' + operation.join(' '));
    }
  };
  syncBuiltinESMExports();
  try {
    const linked = addProject(db, existing, { githubRepo: 'team/app', githubCheck: 'build' });
    const copy = addProject(db, cloned, { githubRepo: remote });
    assert.equal(linked.github_check, 'build');
    assert.equal(copy.forge_kind, 'github');
    assert.equal(linked.base_branch, 'trunk');
    assert.equal(copy.base_branch, 'trunk');
    assert.equal(readFileSync(join(existing, 'draft.txt'), 'utf8'), 'my working changes');
    assert.equal(calls.filter(([name]) => name === 'clone').length, 1);
    assert.equal(calls.filter(([name]) => name === 'remote').length, 0);
    assert.ok(calls.some(([name, ...args]) => name === 'fetch' && args.includes(remote)));
  } finally {
    cp.execFileSync = original;
    syncBuiltinESMExports();
    db.close();
  }
});
