// Owner-only "Merge anyway" for a task held on review_blocked (block gate, critical/high findings on the exact
// head SHA). Only review_blocked is relaxed: review_pending, review_failed, a review of another SHA and any
// other hold are refused, and refusals change nothing.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { HeadMovedError, type Forge } from '../src/forge.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { putReview, setReviewGate, type ReviewFinding, type ReviewStatus } from '../src/review/store.js';
import { REVIEW_BLOCKED_HOLD, Runner } from '../src/runner.js';
import { taskMarker, type Check, type FileChange, type PullRequest } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const ID = 'p-v1-a';
const HEAD = 'h1';
const OTHER = 'h0';

const finding = (severity: ReviewFinding['severity'], title: string, line = 1): ReviewFinding =>
  ({ severity, file: 'src/a/x.js', line, title, evidence: 'long evidence text', fix: 'f' });
const HIGH = finding('high', 'Shell command from caller input', 7);
const MEDIUM = finding('medium', 'Noisy log', 9);

const green = (sha: string, id = 1): Check => ({ id, sha, name: 'local-ci', conclusion: 'success', workflow_ref: 'trusted@main', log: '' });
const events = (db: DB, type: string) => eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === type);

/**
 * Approved plan task `a` with open PR #1 at head h1: green, in scope, fresh. Review gate is 'block'.
 * The task is held with `hold`, which defaults to a review_blocked merge hold.
 */
function held(hold = `${REVIEW_BLOCKED_HOLD} (review of h1 blocked with 1 critical/high finding(s); first: ${HIGH.title})`) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers) VALUES ('p','p','/repo/p',6)").run();
  approvePlan(db, draftPlan(db, 'p', { summary: '', tasks: [{ key: 'a', title: 'a', prompt: 'do a', acceptance: 'works', writeScope: ['src/a/**'], deps: [] }] }).planId);
  setReviewGate(db, 'p', 'block');

  const f = {
    pr: { number: 1, branch: `local/${ID}`, base: 'main', headSha: HEAD, state: 'open', title: 'a', body: taskMarker(ID), mergeSha: null } as PullRequest,
    files: [{ status: 'M', paths: ['src/a/x.js'] }] as FileChange[] | null,
    checks: [green(HEAD)] as Check[],
    fresh: true as boolean | null,
    merges: [] as { n: number; expected: string }[],
    pushes: 0,
  };
  const forge: Forge = {
    baseSha: () => 'base0', findPrByMarker: () => f.pr, createPr: () => { throw new Error('no'); },
    getPr: () => f.pr, prFiles: () => f.files, isUpToDate: () => f.fresh,
    checksFor: (sha) => f.checks.filter((c) => c.sha === sha),
    notifyPush: () => { f.pushes++; }, triggerCi: () => 99,
    merge: (n, expected) => {
      if (f.pr.state !== 'open') throw new Error(`PR #${n} not open`);
      if (f.pr.headSha !== expected) throw new HeadMovedError(`PR #${n} head is ${f.pr.headSha}, expected ${expected}`);
      f.merges.push({ n, expected });
      f.pr = { ...f.pr, state: 'merged', mergeSha: 'm1' };
      return 'm1';
    },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'local-anyway-review-'));
  const r = new Runner(db, forge, new FakeWorkerFactory({}), { worktreesDir: tmp });
  db.prepare("UPDATE tasks SET status='blocked', hold_reason=?, pr_number=1, head_sha=? WHERE id=?").run(hold, HEAD, ID);
  const review = (status: ReviewStatus, findings: ReviewFinding[] = [], headSha = HEAD) =>
    putReview(db, { projectId: 'p', taskId: ID, prNumber: 1, headSha, status, findings, model: 'test' });
  return { db, r, f, review };
}

/** Refusal: throws, task row unchanged, no override events, nothing merged, no base update. */
function assertRefused(s: ReturnType<typeof held>, msg: RegExp) {
  const before = { ...s.r.task(ID) };
  assert.throws(() => s.r.mergeAnyway(ID), msg);
  assert.deepEqual({ ...s.r.task(ID) }, before, 'task unchanged');
  assert.equal(events(s.db, 'owner_override_merge').length, 0, 'no owner_override_merge event');
  assert.equal(events(s.db, 'review_findings_overridden').length, 0, 'no review_findings_overridden event');
  assert.deepEqual(s.f.merges, [], 'nothing merged');
  assert.equal(s.f.pushes, 0, 'no controlled base update');
}

// ---------- override ----------
test('review_blocked with a high finding is merged and returns overriddenFindings', () => {
  const s = held();
  try {
    s.review('blocked', [HIGH, MEDIUM]);
    const res = s.r.mergeAnyway(ID);
    assert.deepEqual(res, { mergeSha: 'm1', overriddenFindings: [HIGH] });
    assert.deepEqual(s.f.merges, [{ n: 1, expected: HEAD }]);
    assert.equal(s.r.task(ID).status, 'merging');

    const [ev] = events(s.db, 'owner_override_merge');
    const data = JSON.parse(ev.data);
    assert.equal(data.holdCode, 'review_blocked');
    assert.equal(data.headSha, HEAD);
    assert.deepEqual(data.overriddenFindings, {
      count: 1, items: [{ severity: 'high', file: 'src/a/x.js', line: 7, title: HIGH.title }],
    });
    assert.ok(!ev.data.includes('long evidence text'), 'evidence is not copied into the event');
    assert.ok(ev.seq < events(s.db, 'pr_merged')[0].seq, 'override recorded before the merge');
  } finally { s.db.close(); }
});

// ---------- refusals: review state ----------
test('review_pending (no review) is refused', () => {
  const s = held();
  try { assertRefused(s, /refused: review_pending/); } finally { s.db.close(); }
});

test('review_pending (review still running) is refused', () => {
  const s = held();
  try {
    s.review('pending');
    assertRefused(s, /refused: review_pending/);
  } finally { s.db.close(); }
});

test('review_failed is refused even when the hold says review_blocked', () => {
  const s = held();
  try {
    s.review('failed');
    assertRefused(s, /refused: review_failed/);
  } finally { s.db.close(); }
});

test('a task held on review_failed is refused before evaluation', () => {
  const s = held('merge held: review_failed (review of h1 failed)');
  try {
    s.review('failed');
    assertRefused(s, /only applies to a task held/);
  } finally { s.db.close(); }
});

test('a task held on review_pending whose detail mentions review_blocked is refused', () => {
  const s = held('merge held: review_pending (no completed review for h1; was review_blocked)');
  try {
    s.review('blocked', [HIGH]);
    assertRefused(s, /only applies to a task held/);
  } finally { s.db.close(); }
});

test('a blocked review for a different head SHA is refused', () => {
  const s = held();
  try {
    s.review('blocked', [HIGH], OTHER);
    assertRefused(s, /refused: review_pending/);
  } finally { s.db.close(); }
});

// ---------- refusals: other holds ----------
test('a task with an unrelated hold is refused', () => {
  const s = held('merge held: stale (branch behind main)');
  try {
    s.review('blocked', [HIGH]);
    assertRefused(s, /only applies to a task held/);
  } finally { s.db.close(); }
});

test('review_blocked hold with another merge check failing is refused', () => {
  const s = held();
  try {
    s.review('blocked', [HIGH]);
    s.f.fresh = false;
    assertRefused(s, /refused: stale/);
  } finally { s.db.close(); }
});

test('a task that is not blocked is refused', () => {
  const s = held();
  try {
    s.review('blocked', [HIGH]);
    s.db.prepare("UPDATE tasks SET status='waiting_ci' WHERE id=?").run(ID);
    assertRefused(s, /only applies to a task held/);
  } finally { s.db.close(); }
});
