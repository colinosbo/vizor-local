import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDb, type DB } from '../src/db.js';
import { migrateReviews, putReview, type ReviewFinding } from '../src/review/store.js';
import { reviewsForState } from '../src/review/state.js';

const sha = (c: string) => c.repeat(40);

function addProject(db: DB, id: string) {
  db.prepare('INSERT INTO projects(id, name, repo_path) VALUES (?, ?, ?)').run(id, id, `/tmp/${id}`);
}

function freshDb(): DB {
  const db = openDb(':memory:');
  addProject(db, 'p1');
  addProject(db, 'p2');
  migrateReviews(db);
  return db;
}

test('newest review per task wins', () => {
  const db = freshDb();
  const base = { projectId: 'p1', prNumber: 1, model: 'sonnet', findings: [] as ReviewFinding[] };
  putReview(db, { ...base, taskId: 't1', headSha: sha('a'), status: 'blocked' });
  putReview(db, { ...base, taskId: 't1', headSha: sha('b'), status: 'passed' }); // same created_at, higher id
  putReview(db, { ...base, taskId: 't2', headSha: sha('c'), status: 'pending' });
  db.prepare("UPDATE reviews SET created_at='2020-01-01 00:00:00' WHERE head_sha=?").run(sha('c'));
  const out = reviewsForState(db);
  assert.equal(out.length, 2);
  const t1 = out.find((r) => r.task_id === 't1');
  assert.equal(t1?.head_sha, sha('b'));
  assert.equal(t1?.status, 'passed');
  assert.equal(out.find((r) => r.task_id === 't2')?.status, 'pending');
});

test('created_at beats id when ordering', () => {
  const db = freshDb();
  const base = { projectId: 'p1', taskId: 't1', prNumber: 1, model: 'm', findings: [] as ReviewFinding[], status: 'passed' as const };
  putReview(db, { ...base, headSha: sha('a') });
  putReview(db, { ...base, headSha: sha('b') });
  db.prepare("UPDATE reviews SET created_at='2030-01-01 00:00:00' WHERE head_sha=?").run(sha('a'));
  const out = reviewsForState(db);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.head_sha, sha('a'));
});

test('bad findings_json reads as failed with []', () => {
  const db = freshDb();
  const ins = db.prepare(
    "INSERT INTO reviews(project_id, task_id, pr_number, head_sha, status, findings_json, model) VALUES ('p1', ?, 1, ?, 'passed', ?, 'm')",
  );
  ins.run('bad-json', sha('a'), '{not json');
  ins.run('bad-shape', sha('b'), JSON.stringify([{ severity: 'nope' }]));
  ins.run('not-array', sha('c'), '{}');
  const out = reviewsForState(db);
  assert.equal(out.length, 3);
  for (const r of out) {
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.findings, []);
  }
});

test('valid findings are returned in snake_case rows', () => {
  const db = freshDb();
  const findings = [{ severity: 'high', file: 'a.ts', line: 2, title: 't', evidence: 'e', fix: 'f' }] as const;
  putReview(db, { projectId: 'p1', taskId: 't1', prNumber: 9, headSha: sha('a'), status: 'blocked', findings: [...findings], model: 'sonnet' });
  const [row] = reviewsForState(db);
  assert.equal(row?.project_id, 'p1');
  assert.equal(row?.pr_number, 9);
  assert.equal(row?.model, 'sonnet');
  assert.deepEqual(row?.findings, findings);
  assert.equal(typeof row?.created_at, 'string');
});

test('missing reviews table returns []', () => {
  assert.deepEqual(reviewsForState(new DatabaseSync(':memory:')), []);
});

test('rows for several projects are all returned', () => {
  const db = freshDb();
  const base = { prNumber: 1, model: 'm', findings: [] as ReviewFinding[], status: 'passed' as const };
  putReview(db, { ...base, projectId: 'p1', taskId: 't1', headSha: sha('a') });
  putReview(db, { ...base, projectId: 'p2', taskId: 't2', headSha: sha('b') });
  const out = reviewsForState(db);
  assert.deepEqual(out.map((r) => r.project_id).sort(), ['p1', 'p2']);
});
