// Review gate in the merge authority: in block mode nothing is eligible without a passed, non-blocking review
// of the exact PR head SHA. ownerOverride relaxes review_blocked only, never review_pending or review_failed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { evaluateMerge, type MergeOptions } from '../src/merge.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { migrateReviews, putReview, setReviewGate, type ReviewFinding, type ReviewGate, type ReviewStatus } from '../src/review/store.js';
import { taskMarker, type Check, type Project, type PullRequest, type TaskRow } from '../src/types.js';

const HEAD = 'head-new-0001';
const OLD = 'head-old-0000';

const finding = (severity: ReviewFinding['severity'], title: string): ReviewFinding =>
  ({ severity, file: 'src/a/x.js', line: 1, title, evidence: 'e', fix: 'f' });

const stubForge = (o: Partial<Forge> = {}): Forge => ({
  baseSha: () => 'base0', findPrByMarker: () => null, createPr: () => { throw new Error('no'); }, getPr: () => null,
  prFiles: () => [], isUpToDate: () => true, checksFor: () => [], notifyPush: () => {}, triggerCi: () => 0, merge: () => 'm', ...o,
});

/** One approved task with an open, bound, in-scope, green, fresh PR at HEAD: eligible unless the review gate holds. */
function setup(gate?: ReviewGate) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers) VALUES ('p','p','/repo/p',6)").run();
  approvePlan(db, draftPlan(db, 'p', { summary: '', tasks: [{ key: 'a', title: 'a', prompt: 'do a', acceptance: 'works', writeScope: ['src/a/**'], deps: [] }] }).planId);
  db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=1, head_sha=?").run(HEAD);
  migrateReviews(db);
  if (gate) setReviewGate(db, 'p', gate);
  const t = db.prepare('SELECT * FROM tasks').get() as unknown as TaskRow;
  const proj: Project = { id: 'p', name: 'p', repo_path: '/r', base_branch: 'main', max_workers: 1, paused: 0, forge_origin: null, ci_command: 'node --test', roadmap_paused: 0 } as Project;
  const pr: PullRequest = { number: 1, branch: t.branch, base: 'main', headSha: HEAD, state: 'open', title: 'a', body: taskMarker(t.id), mergeSha: null };
  const green: Check = { id: 1, sha: HEAD, name: 'local-ci', conclusion: 'success', workflow_ref: 'trusted@main', log: '' };
  const forge = stubForge({ getPr: () => pr, prFiles: () => [{ status: 'M', paths: ['src/a/x.js'] }], checksFor: (s) => (s === HEAD ? [green] : []) });
  const evaluate = (opts?: MergeOptions) => evaluateMerge(db, forge, t, proj, opts);
  const review = (status: ReviewStatus, findings: ReviewFinding[] = [], headSha = HEAD) =>
    putReview(db, { projectId: 'p', taskId: t.id, prNumber: 1, headSha, status, findings, model: 'test' });
  return { db, evaluate, review };
}

const codes = (d: { holds: { code: string }[] }) => d.holds.map((h) => h.code);

function close(db: DB, fn: () => void) { try { fn(); } finally { db.close(); } }

// ---------- block mode: holds ----------
test('block: no review holds review_pending', () => {
  const s = setup('block');
  close(s.db, () => {
    const d = s.evaluate();
    assert.equal(d.eligible, false);
    assert.deepEqual(codes(d), ['review_pending']);
  });
});

test('block: a passed review for an older SHA does not count for the current head', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('passed', [], OLD);
    assert.deepEqual(codes(s.evaluate()), ['review_pending']);
  });
});

test('block: pending review holds review_pending', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('pending');
    assert.deepEqual(codes(s.evaluate()), ['review_pending']);
  });
});

test('block: failed review holds review_failed', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('failed');
    assert.deepEqual(codes(s.evaluate()), ['review_failed']);
  });
});

test('block: a critical finding holds review_blocked naming the count and first title', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('blocked', [finding('low', 'nit'), finding('critical', 'SQL injection'), finding('high', 'path traversal')]);
    const d = s.evaluate();
    assert.equal(d.eligible, false);
    assert.deepEqual(codes(d), ['review_blocked']);
    assert.match(d.holds[0].detail, /2 critical\/high/);
    assert.match(d.holds[0].detail, /SQL injection/);
    assert.equal(d.overriddenFindings, undefined);
  });
});

test('block: status passed with a high finding still holds review_blocked', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('passed', [finding('high', 'secret logged')]);
    assert.deepEqual(codes(s.evaluate()), ['review_blocked']);
  });
});

test('block: status blocked with no critical/high findings still holds review_blocked', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('blocked', [finding('medium', 'meh')]);
    assert.deepEqual(codes(s.evaluate()), ['review_blocked']);
  });
});

test('block: a missing reviews table fails closed with review_pending', () => {
  const s = setup('block');
  close(s.db, () => {
    s.db.exec('DROP TABLE reviews');
    assert.deepEqual(codes(s.evaluate()), ['review_pending']);
  });
});

// ---------- block mode: eligible ----------
test('block: a passed review on the exact head SHA is eligible', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('passed', [finding('medium', 'consider'), finding('low', 'nit')]);
    const d = s.evaluate();
    assert.ok(d.eligible, JSON.stringify(d.holds));
    assert.equal(d.headSha, HEAD);
    assert.equal(d.overriddenFindings, undefined);
  });
});

// ---------- ownerOverride ----------
test('ownerOverride relaxes review_blocked and records the critical/high findings', () => {
  const s = setup('block');
  close(s.db, () => {
    const crit = finding('critical', 'SQL injection');
    const high = finding('high', 'path traversal');
    s.review('blocked', [finding('low', 'nit'), crit, high]);
    const d = s.evaluate({ ownerOverride: true });
    assert.ok(d.eligible, JSON.stringify(d.holds));
    assert.deepEqual(d.overriddenFindings, [crit, high]);
  });
});

test('ownerOverride never relaxes review_failed', () => {
  const s = setup('block');
  close(s.db, () => {
    s.review('failed');
    assert.deepEqual(codes(s.evaluate({ ownerOverride: true })), ['review_failed']);
  });
});

test('ownerOverride never relaxes review_pending (missing or pending review)', () => {
  const s = setup('block');
  close(s.db, () => {
    assert.deepEqual(codes(s.evaluate({ ownerOverride: true })), ['review_pending'], 'missing');
    s.review('blocked', [finding('critical', 'x')], OLD);
    assert.deepEqual(codes(s.evaluate({ ownerOverride: true })), ['review_pending'], 'blocked review on an old SHA');
    s.review('pending');
    assert.deepEqual(codes(s.evaluate({ ownerOverride: true })), ['review_pending'], 'pending');
  });
});

// ---------- other gates ----------
test('report: a critical finding never holds', () => {
  const s = setup('report');
  close(s.db, () => {
    s.review('blocked', [finding('critical', 'SQL injection')]);
    const d = s.evaluate();
    assert.ok(d.eligible, JSON.stringify(d.holds));
    assert.equal(d.overriddenFindings, undefined);
  });
});

test('off: no review checks at all', () => {
  const s = setup('off');
  close(s.db, () => {
    assert.ok(s.evaluate().eligible);
    s.review('failed');
    assert.ok(s.evaluate().eligible);
  });
});

test('existing holds keep precedence over the review gate', () => {
  const s = setup('block');
  close(s.db, () => {
    s.db.prepare("UPDATE plans SET status='draft'").run();
    assert.deepEqual(codes(s.evaluate()), ['plan_not_approved']);
  });
});
