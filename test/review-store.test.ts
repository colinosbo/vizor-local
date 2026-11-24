import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDb, type DB } from '../src/db.js';
import {
  getReview, getReviewGate, hasBlockingFinding, isReviewGate, latestReview, migrateReviews, putReview, setReviewGate,
  type ReviewFinding,
} from '../src/review/store.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const finding = (severity: ReviewFinding['severity']): ReviewFinding =>
  ({ severity, file: 'src/x.ts', line: 3, title: 't', evidence: 'e', fix: 'f' });

function addProject(db: DB, id: string) {
  db.prepare('INSERT INTO projects(id, name, repo_path) VALUES (?, ?, ?)').run(id, id, `/tmp/${id}`);
}

function freshDb(): DB {
  const db = openDb(':memory:');
  addProject(db, 'p1');
  migrateReviews(db);
  return db;
}

const base = { projectId: 'p1', taskId: 't1', prNumber: 7, model: 'sonnet' } as const;

test('migrateReviews twice is fine', () => {
  const db = freshDb();
  migrateReviews(db);
  putReview(db, { ...base, headSha: SHA_A, status: 'passed', findings: [] });
  migrateReviews(db);
  assert.equal(getReview(db, 't1', SHA_A)?.status, 'passed');
});

test('existing projects default to report', () => {
  const db = openDb(':memory:');
  addProject(db, 'old');
  migrateReviews(db);
  assert.equal(getReviewGate(db, 'old'), 'report');
});

test('set and get gate; unknown project and invalid value fall back to block', () => {
  const db = freshDb();
  for (const g of ['off', 'report', 'block'] as const) {
    setReviewGate(db, 'p1', g);
    assert.equal(getReviewGate(db, 'p1'), g);
  }
  assert.equal(getReviewGate(db, 'missing'), 'block');
  db.prepare("UPDATE projects SET review_gate='bogus' WHERE id='p1'").run();
  assert.equal(getReviewGate(db, 'p1'), 'block');
  assert.throws(() => setReviewGate(db, 'p1', 'nope' as never));
  assert.ok(isReviewGate('off') && !isReviewGate('nope') && !isReviewGate(undefined));
});

test('getReviewGate without migration returns report', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO projects(id) VALUES (?)').run('p1');
  assert.equal(getReviewGate(db, 'p1'), 'report');
  assert.equal(getReviewGate(db, 'missing'), 'report');
});

test('put and get by exact SHA only', () => {
  const db = freshDb();
  const f = [finding('high')];
  const row = putReview(db, { ...base, headSha: SHA_A, status: 'blocked', findings: f });
  assert.deepEqual(getReview(db, 't1', SHA_A), row);
  assert.deepEqual(row.findings, f);
  assert.equal(getReview(db, 't1', SHA_B), undefined);
  assert.equal(getReview(db, 't1', SHA_A.slice(0, 7)), undefined);
  assert.equal(getReview(db, 't2', SHA_A), undefined);
});

test('upsert on the same SHA replaces status, findings, model and pr number', () => {
  const db = freshDb();
  const first = putReview(db, { ...base, headSha: SHA_A, status: 'pending', findings: [] });
  const second = putReview(db, { ...base, prNumber: 9, model: 'opus', headSha: SHA_A, status: 'blocked', findings: [finding('critical')] });
  assert.equal(second.id, first.id);
  assert.equal(second.status, 'blocked');
  assert.equal(second.model, 'opus');
  assert.equal(second.prNumber, 9);
  assert.equal(second.findings.length, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reviews').get() as { n: number }).n, 1);
});

test('latestReview returns the newest row for the task', () => {
  const db = freshDb();
  assert.equal(latestReview(db, 't1'), undefined);
  putReview(db, { ...base, headSha: SHA_A, status: 'passed', findings: [] });
  const b = putReview(db, { ...base, headSha: SHA_B, status: 'blocked', findings: [finding('high')] });
  assert.equal(latestReview(db, 't1')?.id, b.id);
  db.prepare("UPDATE reviews SET created_at='2000-01-01 00:00:00' WHERE head_sha=?").run(SHA_B);
  assert.equal(latestReview(db, 't1')?.headSha, SHA_A);
});

test('corrupt findings_json reads back as failed with no findings', () => {
  const db = freshDb();
  putReview(db, { ...base, headSha: SHA_A, status: 'passed', findings: [] });
  for (const bad of ['{not json', '{"a":1}', '[{"severity":"nope","file":"f","line":1,"title":"t","evidence":"e","fix":"f"}]', '[1]']) {
    db.prepare('UPDATE reviews SET findings_json=? WHERE head_sha=?').run(bad, SHA_A);
    for (const row of [getReview(db, 't1', SHA_A), latestReview(db, 't1')]) {
      assert.equal(row?.status, 'failed');
      assert.deepEqual(row?.findings, []);
    }
  }
});

test('hasBlockingFinding is true only for critical or high', () => {
  assert.equal(hasBlockingFinding([]), false);
  assert.equal(hasBlockingFinding([finding('medium'), finding('low')]), false);
  assert.equal(hasBlockingFinding([finding('low'), finding('high')]), true);
  assert.equal(hasBlockingFinding([finding('critical')]), true);
});
