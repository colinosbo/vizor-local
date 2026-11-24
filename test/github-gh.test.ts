import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { createGh, ghAuthStatus, GhError, type GhErrorKind, type GhOptions } from '../src/github/gh.js';

// Fake gh: mode comes from FAKE_GH_MODE; argv + stdin are recorded to FAKE_GH_LOG.
const FAKE = `
const fs = require('node:fs');
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
if (process.env.FAKE_GH_LOG) fs.writeFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, stdin }));
const mode = process.env.FAKE_GH_MODE || 'json';
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
if (argv[0] === 'auth') { if (mode === 'authfail') fail('You are not logged in'); process.exit(0); }
switch (mode) {
  case 'json': process.stdout.write(JSON.stringify({ id: 7, name: 'x' })); break;
  case 'empty': break;
  case 'badjson': process.stdout.write('<html>'); break;
  case '404': fail('gh: Not Found (HTTP 404)');
  case '409': fail('gh: Merge conflict (HTTP 409)');
  case '401': fail('gh: Bad credentials (HTTP 401)');
  case 'login': fail('To get started with GitHub CLI, please run:  gh auth login');
  case 'rate': fail('gh: API rate limit exceeded (HTTP 403)');
  case '429': fail('gh: Too many requests (HTTP 429)');
  case '403': fail('gh: Forbidden (HTTP 403)');
  case '500': fail('gh: Server Error (HTTP 500)');
  case 'token': fail('gh: Bad thing (HTTP 500)\\nusing token ghp_SECRET123456\\nGH_TOKEN=abc');
  case 'long': fail('x'.repeat(2000));
  case 'sleep': setTimeout(() => {}, 20000); break;
}
`;

let dir: string;
let bin: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  bin = join(dir, 'fake-gh.js');
  writeFileSync(bin, FAKE);
});

function opts(mode: string, extra: Partial<GhOptions> = {}, log?: string): GhOptions {
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_GH_MODE: mode };
  if (log) env.FAKE_GH_LOG = log;
  return { bin, env, timeoutMs: 10000, ...extra };
}

function errorOf(fn: () => unknown): GhError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GhError);
    return e;
  }
  return assert.fail('expected GhError');
}

test('GET parses JSON and builds the expected argv', () => {
  const log = join(dir, 'get.json');
  const out = createGh(opts('json', {}, log))('GET', '/repos/o/r/pulls/1');
  assert.deepEqual(out, { id: 7, name: 'x' });
  const rec = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; stdin: string };
  assert.deepEqual(rec.argv, ['api', '--method', 'GET', '/repos/o/r/pulls/1', '-H', 'Accept: application/vnd.github+json']);
  assert.equal(rec.stdin, '');
});

test('POST body arrives on stdin intact', () => {
  const log = join(dir, 'post.json');
  const body = { title: 'héllo "quoted"', nested: { a: [1, 2, 3] }, nl: 'a\nb' };
  createGh(opts('json', {}, log))('POST', '/repos/o/r/pulls', body);
  const rec = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; stdin: string };
  assert.deepEqual(rec.argv.slice(-2), ['--input', '-']);
  assert.deepEqual(JSON.parse(rec.stdin), body);
});

test('empty stdout returns null', () => {
  assert.equal(createGh(opts('empty'))('DELETE', '/x'), null);
});

test('invalid JSON is a failed error', () => {
  assert.equal(errorOf(() => createGh(opts('badjson'))('GET', '/x')).kind, 'failed');
});

const cases: [string, GhErrorKind, number | undefined][] = [
  ['404', 'not_found', 404],
  ['409', 'conflict', 409],
  ['401', 'not_authenticated', 401],
  ['login', 'not_authenticated', undefined],
  ['rate', 'rate_limited', 403],
  ['429', 'rate_limited', 429],
  ['403', 'failed', 403],
  ['500', 'failed', 500],
];
for (const [mode, kind, status] of cases) {
  test(`error mode ${mode} maps to ${kind}`, () => {
    const e = errorOf(() => createGh(opts(mode))('GET', '/x'));
    assert.equal(e.kind, kind);
    assert.equal(e.status, status);
  });
}

test('timeout maps to timeout', () => {
  const e = errorOf(() => createGh(opts('sleep', { timeoutMs: 500 }))('GET', '/x'));
  assert.equal(e.kind, 'timeout');
});

test('missing binary is a failed error', () => {
  const e = errorOf(() => createGh({ bin: join(dir, 'nope') })('GET', '/x'));
  assert.equal(e.kind, 'failed');
});

test('token-looking lines are scrubbed from error messages', () => {
  const e = errorOf(() => createGh(opts('token'))('GET', '/x'));
  assert.equal(e.kind, 'failed');
  assert.ok(!/token|ghp_|SECRET|abc/i.test(e.message), e.message);
  assert.match(e.message, /Bad thing/);
});

test('messages are capped at 500 characters', () => {
  const e = errorOf(() => createGh(opts('long'))('GET', '/x'));
  assert.equal(e.message.length, 500);
});

test('ghAuthStatus ok', () => {
  assert.deepEqual(ghAuthStatus(opts('json')), { ok: true });
});

test('ghAuthStatus failing, missing and timing out', () => {
  const problem = 'forge unavailable: run gh auth login';
  assert.deepEqual(ghAuthStatus(opts('authfail')), { ok: false, problem });
  assert.deepEqual(ghAuthStatus({ bin: join(dir, 'nope') }), { ok: false, problem });
  const slowBin = join(dir, 'slow.js');
  writeFileSync(slowBin, 'setTimeout(() => {}, 20000);');
  assert.deepEqual(ghAuthStatus({ bin: slowBin, timeoutMs: 500 }), { ok: false, problem });
});
