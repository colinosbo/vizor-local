import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { LocalForge } from '../src/forge.js';
import { commitAll, git, revParse } from '../src/git.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { addProject } from '../src/projects.js';
import { setReviewGate } from '../src/review/store.js';
import { Runner } from '../src/runner.js';
import { createTargetRepo } from '../src/sandbox.js';
import { FakeWorkerFactory } from '../src/workers.js';

test('recovery after branch and squash pushes reuses the PR and verifies before releasing dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vizor-recovery-git-'));
  const { bare, checkout } = createTargetRepo(root);
  const dbPath = join(root, 'local.db');
  const forgePath = join(root, 'forge.db');
  let db = openDb(dbPath);
  let forge = new LocalForge(bare, forgePath);
  const p = addProject(db, checkout, { name: 'Recovery', maxWorkers: 1 });
  setReviewGate(db, p.id, 'off');
  approvePlan(db, draftPlan(db, p.id, { summary: 'recover with Git', tasks: [
    { key: 'first', title: 'First', prompt: 'Add x.txt', acceptance: 'x exists', writeScope: ['x.txt'], deps: [] },
    { key: 'dependent', title: 'Dependent', prompt: 'Add y.txt', acceptance: 'y exists', writeScope: ['y.txt'], deps: ['first'] },
  ] }).planId);
  const makeRunner = () => new Runner(db, forge, new FakeWorkerFactory({ first: [{ files: { 'x.txt': 'worker output\n' } }] }),
    { worktreesDir: join(root, 'worktrees') });
  let runner = makeRunner();
  const id = 'recovery-v1-first';
  const dependent = 'recovery-v1-dependent';
  const originalBase = forge.baseSha('main');
  try {
    forge.createPr = () => { throw new Error('interrupted after branch push'); };
    await runner.tick();
    await runner.settle();
    const before = runner.task(id);
    assert.match(before.hold_reason ?? '', /publish failed/);
    const pushed = revParse(bare, 'refs/heads/' + before.branch);
    assert.ok(pushed);
    assert.equal(forge.allPrs().length, 0);

    forge.close();
    db.close();
    db = openDb(dbPath);
    forge = new LocalForge(bare, forgePath);
    runner = makeRunner();
    runner.recover();
    runner.retry(id);
    await runner.settle();
    await forge.idle();
    const published = runner.task(id);
    assert.equal(published.head_sha, pushed);
    assert.equal(forge.allPrs().length, 1);
    assert.equal(forge.checksFor(pushed)[0]?.conclusion, 'success');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(id)?.n, 1);

    const journal = new DatabaseSync(forgePath);
    journal.exec("CREATE TRIGGER interrupted_merge BEFORE UPDATE ON prs WHEN NEW.state='merged' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    let landed: string;
    try {
      runner.processChecks();
      landed = forge.baseSha('main')!;
      assert.notEqual(landed, originalBase);
      assert.equal(runner.task(id).status, 'waiting_ci');
      assert.equal(runner.task(dependent).status, 'pending');
    } finally {
      journal.exec('DROP TRIGGER interrupted_merge');
      journal.close();
    }

    forge.close();
    db.close();
    db = openDb(dbPath);
    forge = new LocalForge(bare, forgePath, 'node -e "process.exit(1)"');
    runner = makeRunner();
    runner.recover();
    runner.processChecks();
    await forge.idle();
    runner.processChecks();
    runner.promote();
    assert.equal(runner.task(id).merge_sha, landed);
    assert.match(runner.task(id).hold_reason ?? '', /post-merge check failure/);
    assert.equal(runner.task(dependent).status, 'pending');

    forge.ciCommand = 'node --test';
    runner.retry(id);
    await forge.idle();
    runner.processChecks();
    runner.promote();
    assert.equal(runner.task(id).status, 'merged');
    assert.equal(runner.task(dependent).status, 'ready');
    assert.equal(forge.allPrs().length, 1);
    assert.equal(forge.getPr(published.pr_number!)?.mergeSha, landed);
    assert.equal(forge.baseSha('main'), landed);
  } finally {
    await forge.idle();
    forge.close();
    db.close();
  }
});

test('Retry republishes only a committed in-scope conflict resolution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vizor-conflict-git-'));
  const { bare, checkout } = createTargetRepo(root);
  const db = openDb(join(root, 'local.db'));
  const forge = new LocalForge(bare, join(root, 'forge.db'));
  try {
    const p = addProject(db, checkout, { name: 'Conflict' });
    setReviewGate(db, p.id, 'off');
    approvePlan(db, draftPlan(db, p.id, { summary: 'same edit', tasks: [
      { key: 'edit', title: 'Edit', prompt: 'Edit README', acceptance: 'README changed', writeScope: ['README.md'], deps: [] },
    ] }).planId);
    const runner = new Runner(db, forge, new FakeWorkerFactory({ edit: [{ files: { 'README.md': 'task change\n' } }] }),
      { worktreesDir: join(root, 'worktrees') });
    await runner.tick();
    await runner.settle();
    await forge.idle();
    const task = runner.task('conflict-v1-edit');
    writeFileSync(join(checkout, 'README.md'), 'main change\n');
    commitAll(checkout, 'Main moved');
    git(checkout, ['push', '--quiet', 'origin', 'main']);
    runner.processChecks();
    assert.match(runner.task(task.id).hold_reason ?? '', /conflict with main/);
    assert.throws(() => runner.retry(task.id), /must contain the current base/);

    const wt = task.worktree!;
    assert.throws(() => git(wt, ['merge', '--no-edit', revParse(bare, 'main')!]), /git merge failed/);
    writeFileSync(join(wt, 'README.md'), 'resolved change\n');
    commitAll(wt, 'Resolve scope conflict');
    writeFileSync(join(wt, 'outside.txt'), 'outside scope\n');
    commitAll(wt, 'Unapproved extra file');
    assert.throws(() => runner.retry(task.id), /outside the approved scope: outside.txt/);
    git(wt, ['rm', 'outside.txt']);
    commitAll(wt, 'Remove extra file');

    runner.retry(task.id);
    runner.processChecks();
    await forge.idle();
    assert.notEqual(runner.task(task.id).head_sha, task.head_sha);
    assert.equal(runner.task(task.id).pr_number, task.pr_number);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.n, 1);
    assert.equal(forge.allPrs().length, 1);
  } finally {
    await forge.idle();
    forge.close();
    db.close();
  }
});
