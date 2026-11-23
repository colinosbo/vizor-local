// Phase 9 self-update core: check, eligibility, updater (fast-forward, rollback, revert), backups and the lock wait.
// A local bare repo stands in for GitHub and a clone of it for the install. git is real; npm and the restart are faked,
// so nothing touches the network and nothing restarts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getSetting, openDb } from '../src/db.js';
import { instanceLockHeld } from '../src/instance.js';
import {
  backupDatabase, checkForUpdate, hasLocalChanges, isGitInstall, readJournal, resolveUpstream, revertEligibility, runUpdater, systemRunner,
  UPSTREAM_REF, UPSTREAM_URL, UpdateService, updateEligibility, validUpstream, writeJournal, type CommandRunner, type EligibilityFacts, type Journal,
} from '../src/update.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const g = (cwd: string, args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** upstream.git (bare, "GitHub"), seed (pushes to it) and install (a clone, the Vizor folder). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-update-'));
  const bare = join(dir, 'upstream.git'), seed = join(dir, 'seed'), install = join(dir, 'install'), data = join(dir, 'data');
  mkdirSync(data);
  g(dir, ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  g(dir, ['init', '--quiet', '--initial-branch=main', seed]);
  writeFileSync(join(seed, 'a.txt'), 'one\ntwo\nthree\n');
  g(seed, ['add', '-A']); g(seed, ['commit', '--quiet', '-m', 'initial']);
  g(seed, ['push', '--quiet', bare, 'HEAD:refs/heads/main']);
  g(dir, ['clone', '--quiet', bare, install]);
  g(install, ['config', 'core.autocrlf', 'false']); // the test's own clone; keeps line endings exactly as written
  const upstreamCommit = (file: string, text: string, msg: string) => {
    writeFileSync(join(seed, file), text); g(seed, ['add', '-A']); g(seed, ['commit', '--quiet', '-m', msg]);
    g(seed, ['push', '--quiet', bare, 'HEAD:refs/heads/main']);
    return g(seed, ['rev-parse', 'HEAD']);
  };
  const localCommit = (file: string, text: string, msg: string) => {
    writeFileSync(join(install, file), text); g(install, ['add', '-A']); g(install, ['commit', '--quiet', '-m', msg]);
  };
  const head = () => g(install, ['rev-parse', 'HEAD']);
  return { dir, bare, seed, install, data, upstreamCommit, localCommit, head };
}

/** Real git; npm and the launcher are fakes. `failBuild(n)` fails the n-th `npm run build`. */
function fakeRunner(o: { failBuild?: (n: number) => boolean } = {}) {
  const calls: string[] = [], launches: string[][] = [];
  let builds = 0;
  const run: CommandRunner = {
    async run(cmd, args, opts) {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'npm') {
        assert.notEqual(args[0], 'install', 'the updater must never run npm install');
        if (args[0] === 'run' && args[1] === 'build' && o.failBuild?.(++builds)) return { code: 2, stdout: '', stderr: 'src/x.ts(1,1): error TS2322: broken build' };
        return { code: 0, stdout: '', stderr: '' };
      }
      assert.equal(cmd, 'git', `only git and npm run through the runner, got ${cmd}`);
      return systemRunner.run(cmd, args, opts);
    },
    launch(cmd, args) { launches.push([cmd, ...args]); },
  };
  return { run, calls, launches };
}

const pending = (fromSha: string, toSha: string, extra: Partial<Journal> = {}): Journal => ({ kind: 'update', fromSha, toSha, status: 'pending', error: null,
  errorDismissed: false, startedAt: new Date().toISOString(), finishedAt: null, updaterPid: null, revert: null, ...extra });

const facts = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({ gitInstall: true, checkEnabled: true, localChanges: false, workerRunning: false,
  check: { ok: true, checkedAt: '', headSha: 'a'.repeat(40), upstreamSha: 'b'.repeat(40), behind: 2, ahead: 0, subjects: ['x', 'y'] }, ...over });

function service(f: ReturnType<typeof fixture>, run: CommandRunner, over: { workerRunning?: () => boolean } = {}) {
  const db = openDb(join(f.data, 'local.db'));
  const spawned: string[] = []; let exited = 0;
  const svc = new UpdateService({ db, dataDir: f.data, dbPath: join(f.data, 'local.db'), root: f.install, upstream: f.bare, run,
    workerRunning: over.workerRunning ?? (() => false), spawnUpdater: (d, r) => { spawned.push(`${d}|${r}`); }, exit: () => { exited++; } });
  return { db, svc, spawned, exits: () => exited };
}

// ---------- check ----------

test('behind is detected with counts and the subjects of the missing commits', async () => {
  const f = fixture();
  f.upstreamCommit('b.txt', 'b\n', 'Add b');
  const top = f.upstreamCommit('c.txt', 'c\n', 'Add c');
  const c = await checkForUpdate(systemRunner, f.install, f.bare);
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.behind, 2); assert.equal(c.ahead, 0);
  assert.deepEqual(c.subjects, ['Add c', 'Add b']);
  assert.equal(c.upstreamSha, top);
  assert.equal(g(f.install, ['rev-parse', UPSTREAM_REF]), top, 'fetched into the private ref');
  assert.deepEqual(updateEligibility({ ...facts(), check: c }), { eligible: true });
  assert.equal(f.head(), c.headSha, 'checking never moves HEAD');
});

test('ahead of upstream refuses', async () => {
  const f = fixture();
  f.localCommit('mine.txt', 'mine\n', 'local work');
  const c = await checkForUpdate(systemRunner, f.install, f.bare);
  assert.ok(c.ok && c.ahead === 1 && c.behind === 0);
  assert.deepEqual(updateEligibility({ ...facts(), check: c }), { eligible: false, reason: 'ahead-of-upstream' });
});

test('diverged refuses', async () => {
  const f = fixture();
  f.upstreamCommit('b.txt', 'b\n', 'upstream work');
  f.localCommit('mine.txt', 'mine\n', 'local work');
  const c = await checkForUpdate(systemRunner, f.install, f.bare);
  assert.ok(c.ok && c.ahead === 1 && c.behind === 1);
  assert.deepEqual(updateEligibility({ ...facts(), check: c }), { eligible: false, reason: 'diverged' });
});

test('up to date is not eligible', async () => {
  const f = fixture();
  const c = await checkForUpdate(systemRunner, f.install, f.bare);
  assert.ok(c.ok && c.behind === 0 && c.ahead === 0);
  assert.deepEqual(updateEligibility({ ...facts(), check: c }), { eligible: false, reason: 'up-to-date' });
});

test('a failed fetch reports check-failed', async () => {
  const f = fixture();
  const c = await checkForUpdate(systemRunner, f.install, join(f.dir, 'no-such-repo.git'));
  assert.equal(c.ok, false);
  assert.deepEqual(updateEligibility({ ...facts(), check: c }), { eligible: false, reason: 'check-failed' });
  assert.deepEqual(updateEligibility({ ...facts(), check: null }), { eligible: false, reason: 'check-failed' });
});

test('eligibility covers every reason, in a fixed order', () => {
  assert.deepEqual(updateEligibility(facts({ gitInstall: false, checkEnabled: false })), { eligible: false, reason: 'not-a-git-install' });
  assert.deepEqual(updateEligibility(facts({ checkEnabled: false })), { eligible: false, reason: 'check-disabled' });
  assert.deepEqual(updateEligibility(facts({ localChanges: true })), { eligible: false, reason: 'local-changes' });
  assert.deepEqual(updateEligibility(facts({ workerRunning: true })), { eligible: false, reason: 'worker-running' });
  assert.deepEqual(updateEligibility(facts()), { eligible: true });
});

// ---------- working tree ----------

test('CRLF-only changes do not block', async () => {
  const f = fixture();
  writeFileSync(join(f.install, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
  assert.match(g(f.install, ['status', '--porcelain']), /a\.txt/, 'precondition: git itself reports the file as modified');
  assert.equal(await hasLocalChanges(systemRunner, f.install), false);
  mkdirSync(join(f.install, 'dist', 'src'), { recursive: true });
  writeFileSync(join(f.install, 'dist', 'src', 'cli.js'), '// built');
  mkdirSync(join(f.install, 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(join(f.install, 'node_modules', 'typescript', 'index.js'), '');
  assert.equal(await hasLocalChanges(systemRunner, f.install), false, 'untracked dist/ and node_modules/ do not count');
});

test('a real content change blocks, staged or not, and so does an untracked file elsewhere', async () => {
  const f = fixture();
  writeFileSync(join(f.install, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
  assert.equal(await hasLocalChanges(systemRunner, f.install), true, 'CRLF does not hide a real edit');
  g(f.install, ['checkout', '--', 'a.txt']);
  assert.equal(await hasLocalChanges(systemRunner, f.install), false);
  writeFileSync(join(f.install, 'notes.txt'), 'x');
  assert.equal(await hasLocalChanges(systemRunner, f.install), true, 'untracked file outside dist/ and node_modules/');
  g(f.install, ['add', 'notes.txt']);
  assert.equal(await hasLocalChanges(systemRunner, f.install), true, 'staged new file');
  assert.deepEqual(updateEligibility(facts({ localChanges: true })), { eligible: false, reason: 'local-changes' });
});

test('a folder without .git is not a git install', () => {
  const zip = mkdtempSync(join(tmpdir(), 'vizor-zip-'));
  writeFileSync(join(zip, 'package.json'), '{}');
  assert.equal(isGitInstall(zip), false);
  assert.deepEqual(updateEligibility(facts({ gitInstall: false })), { eligible: false, reason: 'not-a-git-install' });
});

// ---------- updater ----------

test('the updater fast-forwards, runs npm ci and the build, restarts and records the revert target', async () => {
  const f = fixture();
  const from = f.head();
  const to = f.upstreamCommit('b.txt', 'b\n', 'Add b');
  await checkForUpdate(systemRunner, f.install, f.bare);
  writeJournal(f.data, pending(from, to));
  const { run, calls, launches } = fakeRunner();
  const j = await runUpdater({ dataDir: f.data, root: f.install, run, lockTimeoutMs: 2000, pollMs: 20 });
  assert.equal(j?.status, 'done', j?.error ?? '');
  assert.equal(f.head(), to);
  assert.ok(calls.includes(`git merge --ff-only --quiet ${to}`), calls.join('\n'));
  const npm = calls.filter((c) => c.startsWith('npm'));
  assert.deepEqual(npm, ['npm ci', 'npm run build']);
  assert.equal(launches.length, 1, 'restarted once');
  assert.deepEqual(readJournal(f.data)?.revert, { previousSha: from, updatedSha: to });
});

test('a failed build resets to the previous SHA, rebuilds, restarts the old version and records the error', async () => {
  const f = fixture();
  const from = f.head();
  const to = f.upstreamCommit('b.txt', 'b\n', 'Add b');
  await checkForUpdate(systemRunner, f.install, f.bare);
  writeJournal(f.data, pending(from, to));
  const { run, calls, launches } = fakeRunner({ failBuild: (n) => n === 1 });
  const j = await runUpdater({ dataDir: f.data, root: f.install, run, lockTimeoutMs: 2000, pollMs: 20 });
  assert.equal(f.head(), from, 'back on the previous SHA');
  assert.equal(j?.status, 'rolled-back');
  const saved = readJournal(f.data)!;
  assert.equal(saved.status, 'rolled-back');
  assert.match(saved.error ?? '', /npm run build failed.*broken build/s);
  assert.ok(calls.includes(`git reset --hard --quiet ${from}`), calls.join('\n'));
  assert.deepEqual(calls.filter((c) => c.startsWith('npm')), ['npm ci', 'npm run build', 'npm ci', 'npm run build']);
  assert.equal(launches.length, 1, 'the old version is restarted');
  assert.equal(saved.revert, null, 'a failed update records no revert target');
});

test('the updater refuses, unchanged, when the install moved after the request', async () => {
  const f = fixture();
  const from = f.head();
  const to = f.upstreamCommit('b.txt', 'b\n', 'Add b');
  await checkForUpdate(systemRunner, f.install, f.bare);
  writeJournal(f.data, pending(from, to));
  f.localCommit('mine.txt', 'mine\n', 'sneaked in');
  const moved = f.head();
  const { run, calls, launches } = fakeRunner();
  const j = await runUpdater({ dataDir: f.data, root: f.install, run, lockTimeoutMs: 2000, pollMs: 20 });
  assert.equal(j?.status, 'failed');
  assert.match(j?.error ?? '', /Nothing was changed/);
  assert.equal(f.head(), moved);
  assert.ok(!calls.some((c) => c.startsWith('npm') || c.includes('merge --ff-only') || c.includes('reset --hard')));
  assert.equal(launches.length, 1, 'the server already exited, so the old version is started again');
});

test('the updater waits for the instance lock and gives up without changing anything', async () => {
  const f = fixture();
  const from = f.head();
  const to = f.upstreamCommit('b.txt', 'b\n', 'Add b');
  await checkForUpdate(systemRunner, f.install, f.bare);
  writeJournal(f.data, pending(from, to));
  writeFileSync(join(f.data, 'server.json'), JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1/' }));
  assert.equal(instanceLockHeld(f.data), true);
  const { run, calls, launches } = fakeRunner();
  const j = await runUpdater({ dataDir: f.data, root: f.install, run, lockTimeoutMs: 150, pollMs: 20 });
  assert.equal(j?.status, 'failed');
  assert.match(j?.error ?? '', /did not stop in time/);
  assert.equal(f.head(), from);
  assert.deepEqual(calls, []);
  assert.equal(launches.length, 0, 'the running server is left alone');
  writeFileSync(join(f.data, 'server.json'), JSON.stringify({ pid: 2 ** 22 + 12345, url: '' }));
  assert.equal(instanceLockHeld(f.data), false, 'a dead pid does not hold the lock');
});

// ---------- revert ----------

test('revert only targets the SHA the updater recorded', async () => {
  const f = fixture();
  const from = f.head();
  const to = f.upstreamCommit('b.txt', 'b\n', 'Add b');
  await checkForUpdate(systemRunner, f.install, f.bare);
  writeJournal(f.data, pending(from, to));
  const { run } = fakeRunner();
  await runUpdater({ dataDir: f.data, root: f.install, run, lockTimeoutMs: 2000, pollMs: 20 });
  assert.equal(f.head(), to);

  // The service picks the target from the record, never from a caller.
  const { svc, spawned, db } = service(f, run);
  const r = await svc.apply('revert');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.toSha, from);
  assert.equal(spawned.length, 1);
  const j = readJournal(f.data)!;
  assert.deepEqual([j.kind, j.status, j.fromSha, j.toSha], ['revert', 'pending', to, from]);
  db.close();

  const back = await runUpdater({ dataDir: f.data, root: f.install, run, lockTimeoutMs: 2000, pollMs: 20 });
  assert.equal(back?.status, 'done', back?.error ?? '');
  assert.equal(f.head(), from);
  assert.equal(readJournal(f.data)?.revert, null, 'a revert can be done once');

  // A journal edited to point anywhere else is refused by the updater.
  const other = f.upstreamCommit('c.txt', 'c\n', 'Add c');
  await checkForUpdate(systemRunner, f.install, f.bare);
  writeJournal(f.data, pending(from, other, { kind: 'revert', revert: { previousSha: to, updatedSha: from } }));
  const tampered = await runUpdater({ dataDir: f.data, root: f.install, run, lockTimeoutMs: 2000, pollMs: 20 });
  assert.equal(tampered?.status, 'failed');
  assert.match(tampered?.error ?? '', /not the recorded previous version/);
  assert.equal(f.head(), from);
});

test('revert is unavailable without a record or once HEAD moved on', () => {
  const rec = { previousSha: 'a'.repeat(40), updatedSha: 'b'.repeat(40) };
  const base = { gitInstall: true, localChanges: false, workerRunning: false, headSha: 'b'.repeat(40), revert: rec };
  assert.deepEqual(revertEligibility(base), { eligible: true, toSha: 'a'.repeat(40) });
  assert.deepEqual(revertEligibility({ ...base, revert: null }), { eligible: false, reason: 'no-revert-recorded' });
  assert.deepEqual(revertEligibility({ ...base, headSha: 'c'.repeat(40) }), { eligible: false, reason: 'moved-since-update' });
  assert.deepEqual(revertEligibility({ ...base, workerRunning: true }), { eligible: false, reason: 'worker-running' });
});

// ---------- remotes, service, settings ----------

test('no git remote is added and the git config is unchanged', async () => {
  const f = fixture();
  const remotes = g(f.install, ['remote', '-v']), config = g(f.install, ['config', '--local', '--list']);
  const from = f.head();
  const to = f.upstreamCommit('b.txt', 'b\n', 'Add b');
  await checkForUpdate(systemRunner, f.install, f.bare);
  writeJournal(f.data, pending(from, to));
  await runUpdater({ dataDir: f.data, root: f.install, run: fakeRunner().run, lockTimeoutMs: 2000, pollMs: 20 });
  assert.equal(f.head(), to);
  assert.equal(g(f.install, ['remote', '-v']), remotes);
  assert.equal(g(f.install, ['config', '--local', '--list']), config);
});

test('the check fetches with the URL passed directly and nothing identifying', async () => {
  const f = fixture();
  const { run, calls } = fakeRunner();
  await checkForUpdate(run, f.install, f.bare);
  const fetch = calls.find((c) => c.includes(' fetch '));
  assert.ok(fetch, calls.join('\n'));
  assert.ok(fetch.includes(`${f.bare} +refs/heads/main:${UPSTREAM_REF}`));
  assert.ok(fetch.includes('--no-tags'));
  assert.ok(fetch.includes('credential.helper=') && fetch.includes('http.extraHeader='), 'user credential helpers and extra headers are cleared');
  assert.ok(!calls.some((c) => /\bremote\b|\bconfig\b/.test(c)), 'never runs git remote or git config');
});

test('a running worker blocks apply, and nothing is written', async () => {
  const f = fixture();
  f.upstreamCommit('b.txt', 'b\n', 'Add b');
  const { svc, spawned, db } = service(f, fakeRunner().run, { workerRunning: () => true });
  await svc.check();
  const r = await svc.apply('update');
  assert.deepEqual(r.ok ? null : [r.status, r.reason], [409, 'worker-running']);
  assert.equal(readJournal(f.data), null);
  assert.equal(spawned.length, 0);
  assert.ok(!existsSync(join(f.data, 'backups')));
  assert.deepEqual((await svc.status()).eligibility.eligible, false);
  db.close();
});

test('apply backs up the database, writes the journal with the fetched SHA, starts the updater and exits', async () => {
  const f = fixture();
  const from = f.head();
  const to = f.upstreamCommit('b.txt', 'b\n', 'Add b');
  const { svc, spawned, db, exits } = service(f, fakeRunner().run);
  db.prepare("INSERT INTO settings(key,value) VALUES ('marker','kept')").run();
  const r = await svc.apply('update');
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.fromSha, r.toSha], [from, to]);
  assert.deepEqual(spawned, [`${f.data}|${f.install}`]);
  const j = readJournal(f.data)!;
  assert.deepEqual([j.kind, j.status, j.fromSha, j.toSha], ['update', 'pending', from, to]);
  const backups = readdirSync(join(f.data, 'backups'));
  assert.equal(backups.length, 1);
  const copy = openDb(join(f.data, 'backups', backups[0], 'local.db'));
  assert.equal(getSetting(copy, 'marker'), 'kept', 'the backup is a usable copy');
  copy.close();
  const again = await svc.apply('update');
  assert.deepEqual(again.ok ? null : again.reason, 'busy', 'a second apply is refused');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(exits(), 1);
  db.close();
});

test('backups keep only the last 3', () => {
  const data = mkdtempSync(join(tmpdir(), 'vizor-backup-'));
  const dbPath = join(data, 'local.db');
  writeFileSync(dbPath, 'db'); writeFileSync(dbPath + '-wal', 'wal');
  for (let i = 0; i < 5; i++) backupDatabase(data, dbPath, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  const kept = readdirSync(join(data, 'backups')).sort();
  assert.equal(kept.length, 3);
  assert.equal(kept[0], '2026-01-01T00-00-02-000Z');
  assert.deepEqual(readdirSync(join(data, 'backups', kept[2])).sort(), ['local.db', 'local.db-wal']);
  assert.equal(readFileSync(join(data, 'backups', kept[2], 'local.db-wal'), 'utf8'), 'wal');
});

test('update_check_enabled=0 disables checking, automatic and manual', async () => {
  const f = fixture();
  f.upstreamCommit('b.txt', 'b\n', 'Add b');
  const { run, calls } = fakeRunner();
  const { svc, db } = service(f, run);
  assert.equal(getSetting(db, 'update_check_enabled'), '1', 'on by default');
  svc.setCheckEnabled(false);
  assert.equal(getSetting(db, 'update_check_enabled'), '0');
  assert.equal(await svc.check(), null);
  svc.start(); svc.stop();
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!calls.some((c) => c.includes(' fetch ')), 'no fetch while disabled');
  assert.equal(g(f.install, ['for-each-ref', UPSTREAM_REF]), '', 'nothing fetched');
  const s = await svc.status();
  assert.equal(s.check.state, 'disabled');
  assert.deepEqual(s.eligibility.eligible ? null : s.eligibility.reason, 'check-disabled');
  const r = await svc.apply('update');
  assert.deepEqual(r.ok ? null : r.reason, 'check-disabled');
  db.close();
});

test('the upstream is fixed unless overridden at launch, and only in a safe shape', () => {
  assert.equal(UPSTREAM_URL, 'https://github.com/colinosbo/vizor-local');
  assert.equal(resolveUpstream(undefined, {}), UPSTREAM_URL);
  assert.equal(resolveUpstream(undefined, { VIZOR_UPDATE_UPSTREAM: 'https://example.com/a/b' }), 'https://example.com/a/b');
  assert.equal(resolveUpstream('https://example.com/flag', { VIZOR_UPDATE_UPSTREAM: 'https://example.com/env' }), 'https://example.com/flag');
  for (const bad of ['--upload-pack=evil', 'https://x.com/r?id=me', 'https://me:pw@x.com/r', 'https://x.com/r#frag', 'relative/path', 'ext::sh -c id'])
    assert.equal(validUpstream(bad), false, bad);
  assert.throws(() => resolveUpstream('--upload-pack=evil', {}));
});
