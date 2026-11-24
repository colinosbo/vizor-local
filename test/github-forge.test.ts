import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HeadMovedError, type Forge } from '../src/forge.js';
import { git, revParse } from '../src/git.js';
import { GitHubForge } from '../src/github/forge.js';
import type { Check } from '../src/types.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Call { method: Method; path: string; body?: unknown }

class GhError extends Error { constructor(public kind: string) { super(kind); } }

/** Fake GhCall: records calls; responder returns a payload or throws. */
function fakeGh(respond: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const gh = (method: Method, path: string, body?: unknown) => {
    const c: Call = { method, path, body };
    calls.push(c);
    return respond(c);
  };
  return { gh, calls };
}

const pull = (o: Partial<{ number: number; state: string; body: string | null; merged_at: string | null; merge_commit_sha: string | null; sha: string }> = {}) => ({
  number: o.number ?? 7, state: o.state ?? 'open', title: 'Add thing', body: o.body === undefined ? 'body' : o.body,
  merged_at: o.merged_at ?? null, merge_commit_sha: o.merge_commit_sha ?? null,
  head: { ref: 'local/task-1', sha: o.sha ?? 'abc123' }, base: { ref: 'main' },
});

const forgeWith = (gh: ReturnType<typeof fakeGh>['gh'], extra: { repoPath?: string; remoteUrl?: string; checksFor?: (sha: string) => Check[] } = {}) =>
  new GitHubForge({ repo: 'acme/widgets', repoPath: extra.repoPath ?? tmpdir(), gh, checksFor: extra.checksFor ?? (() => []), remoteUrl: extra.remoteUrl });

// Type-level proof that GitHubForge satisfies Forge.
const _typecheck: Forge = forgeWith(fakeGh().gh);
void _typecheck;

const tmp = () => mkdtempSync(join(tmpdir(), 'local-ghforge-'));

/** A bare "GitHub" repo seeded with one commit on main, plus a non-bare checkout of an unrelated clone. */
function setupRepos() {
  const bare = tmp();
  git(bare, ['init', '--quiet', '--bare', '--initial-branch=main']);
  const seed = tmp();
  git(seed, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(seed, 'a.txt'), '1');
  git(seed, ['add', '.']);
  git(seed, ['commit', '--quiet', '-m', 'one']);
  git(seed, ['push', '--quiet', bare, 'main']);
  const checkout = tmp();
  git(tmpdir(), ['clone', '--quiet', bare, checkout]);
  return { bare, seed, checkout };
}

test('createPr posts head/base/title/body and maps the response', () => {
  const { gh, calls } = fakeGh(() => pull({ number: 12 }));
  const pr = forgeWith(gh).createPr({ branch: 'local/task-1', base: 'main', title: 'Add thing', body: 'hello' });
  assert.deepEqual(calls, [{ method: 'POST', path: '/repos/acme/widgets/pulls', body: { head: 'local/task-1', base: 'main', title: 'Add thing', body: 'hello' } }]);
  assert.deepEqual(pr, { number: 12, branch: 'local/task-1', base: 'main', headSha: 'abc123', state: 'open', title: 'Add thing', body: 'body', mergeSha: null });
});

test('getPr maps merged, closed and open states, and returns null on not_found', () => {
  const payloads: Record<string, unknown> = {
    '/repos/acme/widgets/pulls/1': pull({ number: 1, state: 'closed', merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: 'm1' }),
    '/repos/acme/widgets/pulls/2': pull({ number: 2, state: 'closed', merge_commit_sha: 'test-merge-sha' }),
    '/repos/acme/widgets/pulls/3': pull({ number: 3, merge_commit_sha: 'test-merge-sha', body: null }),
  };
  const { gh } = fakeGh((c) => { if (c.path in payloads) return payloads[c.path]; throw new GhError('not_found'); });
  const f = forgeWith(gh);
  assert.deepEqual([f.getPr(1)?.state, f.getPr(1)?.mergeSha], ['merged', 'm1']);
  assert.deepEqual([f.getPr(2)?.state, f.getPr(2)?.mergeSha], ['closed', null]);
  assert.deepEqual([f.getPr(3)?.state, f.getPr(3)?.mergeSha, f.getPr(3)?.body], ['open', null, '']);
  assert.equal(f.getPr(99), null);
});

test('getPr re-throws errors other than not_found', () => {
  const { gh } = fakeGh(() => { throw new GhError('rate_limited'); });
  assert.throws(() => forgeWith(gh).getPr(1), /rate_limited/);
});

test('findPrByMarker pages until a short page and returns the lowest-numbered match', () => {
  const marker = '<!-- local-task:t1 -->';
  const page1 = Array.from({ length: 100 }, (_, i) => pull({ number: 200 - i, body: i === 3 ? `x ${marker}` : 'nope' }));
  const page2 = [pull({ number: 50, body: `${marker} y` }), pull({ number: 40, body: null })];
  const { gh, calls } = fakeGh((c) => (c.path.endsWith('page=1') ? page1 : c.path.endsWith('page=2') ? page2 : []));
  const pr = forgeWith(gh).findPrByMarker(marker);
  assert.equal(pr?.number, 50);
  assert.deepEqual(calls.map((c) => c.path), [
    '/repos/acme/widgets/pulls?state=all&per_page=100&page=1',
    '/repos/acme/widgets/pulls?state=all&per_page=100&page=2',
  ]);
  assert.equal(forgeWith(fakeGh(() => []).gh).findPrByMarker(marker), null);
});

test('prFiles maps statuses to name-status letters, keeping both paths for renames', () => {
  const files = [
    { filename: 'new.ts', status: 'added' },
    { filename: 'gone.ts', status: 'removed' },
    { filename: 'edit.ts', status: 'modified' },
    { filename: 'b.ts', status: 'renamed', previous_filename: 'a.ts' },
    { filename: 'c.ts', status: 'copied', previous_filename: 'x.ts' },
  ];
  const { gh, calls } = fakeGh(() => files);
  assert.deepEqual(forgeWith(gh).prFiles(4), [
    { status: 'A', paths: ['new.ts'] },
    { status: 'D', paths: ['gone.ts'] },
    { status: 'M', paths: ['edit.ts'] },
    { status: 'R', paths: ['a.ts', 'b.ts'] },
    { status: 'M', paths: ['c.ts'] },
  ]);
  assert.match(calls[0].path, /^\/repos\/acme\/widgets\/pulls\/4\/files\?per_page=100/);
  assert.equal(forgeWith(fakeGh(() => { throw new GhError('failed'); }).gh).prFiles(4), null);
});

test('prFiles follows pagination', () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified' }));
  const { gh, calls } = fakeGh((c) => (c.path.endsWith('page=1') ? full : [{ filename: 'last.ts', status: 'added' }]));
  const files = forgeWith(gh).prFiles(4);
  assert.equal(files?.length, 101);
  assert.equal(calls.length, 2);
});

test('isUpToDate compares base...headSha and checks behind_by', () => {
  for (const [behind, expected] of [[0, true], [3, false]] as const) {
    const { gh, calls } = fakeGh((c) => (c.path.includes('/compare/') ? { behind_by: behind, ahead_by: 1 } : pull({ sha: 'head9' })));
    assert.equal(forgeWith(gh).isUpToDate(7), expected);
    assert.equal(calls[1].path, '/repos/acme/widgets/compare/main...head9');
  }
  assert.equal(forgeWith(fakeGh(() => { throw new GhError('failed'); }).gh).isUpToDate(7), null);
});

test('merge squashes with the exact expected head sha and returns the merge sha', () => {
  const { gh, calls } = fakeGh(() => ({ sha: 'merge42', merged: true, message: 'ok' }));
  assert.equal(forgeWith(gh).merge(7, 'head-exact'), 'merge42');
  assert.deepEqual(calls, [{ method: 'PUT', path: '/repos/acme/widgets/pulls/7/merge', body: { merge_method: 'squash', sha: 'head-exact' } }]);
});

test('merge turns a conflict (409) into HeadMovedError and re-throws other errors', () => {
  const conflict = forgeWith(fakeGh(() => { throw new GhError('conflict'); }).gh);
  assert.throws(() => conflict.merge(7, 'old'), HeadMovedError);
  const other = forgeWith(fakeGh(() => { throw new GhError('failed'); }).gh);
  assert.throws(() => other.merge(7, 'old'), (e) => !(e instanceof HeadMovedError) && (e as GhError).kind === 'failed');
});

test('triggerCi is a no-op that makes no gh call', () => {
  const { gh, calls } = fakeGh();
  assert.equal(forgeWith(gh).triggerCi('abc'), 0);
  assert.equal(calls.length, 0);
});

test('closePr patches state closed', () => {
  const { gh, calls } = fakeGh();
  forgeWith(gh).closePr(7);
  assert.deepEqual(calls, [{ method: 'PATCH', path: '/repos/acme/widgets/pulls/7', body: { state: 'closed' } }]);
});

test('checksFor delegates to the injected function; idle and close are harmless', async () => {
  const check: Check = { id: 1, sha: 's', name: 'ci', conclusion: 'success', workflow_ref: 'w', log: '' };
  const seen: string[] = [];
  const f = forgeWith(fakeGh().gh, { checksFor: (sha) => { seen.push(sha); return [check]; } });
  assert.deepEqual(f.checksFor('s'), [check]);
  assert.deepEqual(seen, ['s']);
  await f.idle();
  f.close();
});

test('baseSha fetches the remote before resolving, so it tracks the remote as it advances', () => {
  const { bare, seed, checkout } = setupRepos();
  const f = forgeWith(fakeGh().gh, { repoPath: checkout, remoteUrl: bare });
  assert.equal(f.baseSha('main'), revParse(bare, 'refs/heads/main'));

  writeFileSync(join(seed, 'a.txt'), '2');
  git(seed, ['commit', '--quiet', '-am', 'two']);
  git(seed, ['push', '--quiet', bare, 'main']);
  const advanced = revParse(bare, 'refs/heads/main');
  assert.notEqual(revParse(checkout, 'refs/remotes/origin/main'), advanced, 'checkout has not fetched on its own');
  assert.equal(f.baseSha('main'), advanced);
  assert.equal(revParse(checkout, 'refs/remotes/vizor-github/main'), advanced);

  assert.equal(f.baseSha('no-such-branch'), null);
  assert.equal(forgeWith(fakeGh().gh, { repoPath: checkout, remoteUrl: join(tmp(), 'missing') }).baseSha('main'), null);
});

test('notifyPush pushes the branch to the remote and makes no gh call', () => {
  const { bare, checkout } = setupRepos();
  git(checkout, ['checkout', '--quiet', '-b', 'local/task-1']);
  writeFileSync(join(checkout, 'b.txt'), 'x');
  git(checkout, ['add', '.']);
  git(checkout, ['commit', '--quiet', '-m', 'task']);
  const { gh, calls } = fakeGh();
  const f = forgeWith(gh, { repoPath: checkout, remoteUrl: bare });
  f.notifyPush('local/task-1');
  assert.equal(revParse(bare, 'refs/heads/local/task-1'), revParse(checkout, 'HEAD'));
  assert.equal(calls.length, 0);

  // Force-push: a rewritten branch replaces the remote one.
  git(checkout, ['commit', '--quiet', '--amend', '-m', 'task v2']);
  f.notifyPush('local/task-1');
  assert.equal(revParse(bare, 'refs/heads/local/task-1'), revParse(checkout, 'HEAD'));
});

test('notifyPush throws without echoing credentials from the remote URL', () => {
  const { checkout } = setupRepos();
  const f = forgeWith(fakeGh().gh, { repoPath: checkout, remoteUrl: 'https://user:s3cr3t-token@127.0.0.1:1/acme/widgets.git' });
  assert.throws(() => f.notifyPush('main'), (e) => e instanceof Error && !e.message.includes('s3cr3t-token'));
});
