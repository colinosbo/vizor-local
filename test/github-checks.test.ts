// GitHub check runs -> merge-authority Check mapping: trust, conclusions, SHA pinning, pagination.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChecksFor, mapCheckRun } from '../src/github/checks.js';
import { REQUIRED_CHECK, TRUSTED_WORKFLOW } from '../src/types.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, name: 'ci', head_sha: SHA, status: 'completed', conclusion: 'success',
    app: { slug: 'github-actions' }, html_url: 'https://github.com/o/r/runs/1',
    output: { title: 'CI', summary: 'all good' },
    ...over,
  };
}

type Call = { method: string; path: string };
function fakeGh(pages: unknown[][]): { gh: (m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string) => unknown; calls: Call[] } {
  const calls: Call[] = [];
  const total = pages.reduce((n, p) => n + p.length, 0);
  return {
    calls,
    gh: (method, path) => {
      calls.push({ method, path });
      const page = Number(new URL(path, 'https://x').searchParams.get('page') ?? '1');
      return { total_count: total, check_runs: pages[page - 1] ?? [] };
    },
  };
}

test('trusted success maps to REQUIRED_CHECK + TRUSTED_WORKFLOW', () => {
  const c = mapCheckRun(run(), SHA, 'ci');
  assert.ok(c);
  assert.equal(c.name, REQUIRED_CHECK);
  assert.equal(c.workflow_ref, TRUSTED_WORKFLOW);
  assert.equal(c.conclusion, 'success');
  assert.equal(c.id, 1);
  assert.equal(c.sha, SHA);
  assert.match(c.log, /all good/);
});

test('same name from another app slug is an untrusted REQUIRED_CHECK', () => {
  const c = mapCheckRun(run({ app: { slug: 'evil-app' } }), SHA, 'ci');
  assert.ok(c);
  assert.equal(c.name, REQUIRED_CHECK);
  assert.equal(c.workflow_ref, 'untrusted:evil-app');
  assert.notEqual(c.workflow_ref, TRUSTED_WORKFLOW);
});

test('same name with no app is untrusted, not dropped', () => {
  const c = mapCheckRun(run({ app: null }), SHA, 'ci');
  assert.ok(c);
  assert.equal(c.name, REQUIRED_CHECK);
  assert.match(c.workflow_ref, /^untrusted:/);
});

test('a different name is informational and ignored by merge', () => {
  for (const slug of ['github-actions', 'other']) {
    const c = mapCheckRun(run({ name: 'lint', app: { slug } }), SHA, 'ci');
    assert.ok(c);
    assert.notEqual(c.name, REQUIRED_CHECK);
    assert.equal(c.name, 'github:lint');
    assert.equal(c.workflow_ref, `untrusted:${slug}`);
  }
});

test('checkName is honoured: a run named after the project column is the trusted one', () => {
  assert.equal(mapCheckRun(run({ name: 'build' }), SHA, 'build')?.workflow_ref, TRUSTED_WORKFLOW);
  assert.equal(mapCheckRun(run({ name: 'ci' }), SHA, 'build')?.name, 'github:ci');
});

test('conclusion mapping', () => {
  const cases: [string, string | null, string][] = [
    ['queued', null, 'pending'],
    ['in_progress', null, 'pending'],
    ['waiting', null, 'pending'],
    ['in_progress', 'success', 'pending'],
    ['completed', 'success', 'success'],
    ['completed', 'failure', 'failure'],
    ['completed', 'timed_out', 'failure'],
    ['completed', 'cancelled', 'failure'],
    ['completed', 'action_required', 'failure'],
    ['completed', 'stale', 'infra_error'],
    ['completed', 'startup_failure', 'infra_error'],
    ['completed', null, 'infra_error'],
    ['completed', 'neutral', 'failure'],
    ['completed', 'skipped', 'failure'],
    ['completed', 'something_new', 'failure'],
  ];
  for (const [status, conclusion, want] of cases) {
    assert.equal(mapCheckRun(run({ status, conclusion }), SHA, 'ci')?.conclusion, want, `${status}/${conclusion}`);
  }
});

test('log is capped and redacts tokens', () => {
  const token = 'ghp_' + 'x'.repeat(36);
  const c = mapCheckRun(run({ output: { title: 't', summary: `leak ${token} ` + 'y'.repeat(5000) } }), SHA, 'ci');
  assert.ok(c);
  assert.ok(c.log.length <= 4000);
  assert.ok(!c.log.includes(token));
});

test('malformed runs return null', () => {
  const bad: unknown[] = [
    null, 'run', [], run({ id: '1' }), run({ id: -1 }), run({ name: 5 }), run({ status: undefined }),
    run({ conclusion: 3 }), run({ app: 'github-actions' }), run({ app: { slug: 7 } }), run({ output: 'x' }),
    run({ output: { title: 1 } }), run({ html_url: 9 }), run({ head_sha: undefined }),
  ];
  for (const b of bad) assert.equal(mapCheckRun(b, SHA, 'ci'), null, JSON.stringify(b));
});

test('createChecksFor excludes runs for another head_sha and skips malformed runs', () => {
  const { gh, calls } = fakeGh([[run({ id: 1 }), run({ id: 2, head_sha: OTHER }), { id: 'broken' }, run({ id: 3, name: 'lint' })]]);
  const checks = createChecksFor({ repo: 'o/r', checkName: 'ci', gh })(SHA);
  assert.deepEqual(checks.map((c) => c.id), [1, 3]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, `/repos/o/r/commits/${SHA}/check-runs?per_page=100&page=1`);
});

test('createChecksFor merges two pages', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => run({ id: i + 1, name: `job${i}` }));
  const page2 = [run({ id: 101 }), run({ id: 102, app: { slug: 'impostor' } })];
  const { gh, calls } = fakeGh([page1, page2]);
  const checks = createChecksFor({ repo: 'o/r', checkName: 'ci', gh })(SHA);
  assert.equal(calls.length, 2);
  assert.equal(checks.length, 102);
  const required = checks.filter((c) => c.name === REQUIRED_CHECK);
  assert.deepEqual(required.map((c) => c.workflow_ref), [TRUSTED_WORKFLOW, 'untrusted:impostor']);
});

test('createChecksFor fails closed on bad input or a malformed page', () => {
  const { gh } = fakeGh([[run()]]);
  assert.throws(() => createChecksFor({ repo: 'o/r/../x', checkName: 'ci', gh }));
  assert.throws(() => createChecksFor({ repo: 'o/r', checkName: 'ci', gh })('main'));
  assert.throws(() => createChecksFor({ repo: 'o/r', checkName: 'ci', gh: () => ({ message: 'Not Found' }) })(SHA));
});
