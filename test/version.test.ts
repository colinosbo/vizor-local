import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import type { CommandResult, CommandRunner } from '../src/update.js';
import { readVersion, resetVersionCache } from '../src/version.js';

beforeEach(() => resetVersionCache());

const DATE = '2026-11-24T08:00:00+00:00';

function install(git: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-version-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  if (git) mkdirSync(join(dir, '.git'));
  return dir;
}

function fakeRunner(handler: (args: readonly string[]) => Promise<CommandResult>): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (_cmd, args) => { calls.push([...args]); return handler(args); },
    launch: () => { throw new Error('unexpected launch'); },
  };
}

const okRunner = () => fakeRunner(async (args) => ({ code: 0, stderr: '', stdout: args[0] === 'rev-parse' ? 'abc1234\n' : `${DATE}\n` }));

test('git install reads sha and date', async () => {
  const info = await readVersion(install(true), okRunner());
  assert.equal(info.label, 'v0.2.0 · abc1234');
  assert.equal(info.sha, 'abc1234');
  assert.equal(info.date, DATE);
});

test('zip install never runs git', async () => {
  const runner = okRunner();
  const info = await readVersion(install(false), runner);
  assert.equal(info.sha, null);
  assert.equal(info.date, null);
  assert.equal(info.label, 'v0.2.0');
  assert.equal(runner.calls.length, 0);
});

test('missing git gives null sha and date without throwing', async () => {
  const thrower = fakeRunner(() => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); });
  const a = await readVersion(install(true), thrower);
  assert.equal(a.sha, null);
  assert.equal(a.date, null);
  assert.equal(a.label, 'v0.2.0');

  const rejecter = fakeRunner(() => Promise.reject(new Error('ENOENT')));
  const b = await readVersion(install(true), rejecter);
  assert.equal(b.sha, null);
  assert.equal(b.date, null);

  const failing = fakeRunner(async () => ({ code: 128, stderr: 'fatal', stdout: '' }));
  const c = await readVersion(install(true), failing);
  assert.equal(c.sha, null);
  assert.equal(c.date, null);
});

test('second call is cached', async () => {
  const runner = okRunner();
  const root = install(true);
  const first = await readVersion(root, runner);
  const count = runner.calls.length;
  assert.ok(count > 0);
  const second = await readVersion(root, runner);
  assert.equal(second, first);
  assert.equal(runner.calls.length, count);
});
