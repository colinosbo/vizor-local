// Phase 9 self-update over HTTP: status, check, apply, revert, dismiss-error and settings, through the real server.
// Upstream is a local bare repo; the updater spawn and the server exit are fakes, so nothing restarts and nothing hits the network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getSetting, openDb, type DB } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { readJournal, systemRunner, UPSTREAM_REF, UPSTREAM_URL, UpdateService, workersBusy, writeJournal } from '../src/update.js';
import { FakeWorkerFactory } from '../src/workers.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const g = (cwd: string, args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare "GitHub" with one commit ahead of the install, plus a second bare an attacker would like us to use. */
function repos() {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-update-http-'));
  const mk = (name: string, file: string) => {
    const bare = join(dir, `${name}.git`), seed = join(dir, `${name}-seed`);
    g(dir, ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    g(dir, ['init', '--quiet', '--initial-branch=main', seed]);
    writeFileSync(join(seed, 'a.txt'), 'one\n'); g(seed, ['add', '-A']); g(seed, ['commit', '--quiet', '-m', 'initial']);
    g(seed, ['push', '--quiet', bare, 'HEAD:refs/heads/main']);
    return { bare, seed, push: (msg: string) => { writeFileSync(join(seed, file), msg); g(seed, ['add', '-A']); g(seed, ['commit', '--quiet', '-m', msg]); g(seed, ['push', '--quiet', bare, 'HEAD:refs/heads/main']); return g(seed, ['rev-parse', 'HEAD']); } };
  };
  const real = mk('upstream', 'b.txt'), evil = mk('evil', 'evil.txt');
  const install = join(dir, 'install'), data = join(dir, 'data');
  g(dir, ['clone', '--quiet', real.bare, install]);
  mkdirSync(data);
  const top = real.push('Add b');
  const evilTop = evil.push('Evil change');
  return { dir, install, data, real, evil, top, evilTop };
}

type Ctx = { db: DB; svc: UpdateService; r: ReturnType<typeof repos>; spawned: string[]; post: (path: string, body?: unknown) => Promise<Res>; get: (path: string) => Promise<Res> };
type Res = { status: number; json: any };

async function withServer(fn: (c: Ctx) => Promise<void>) {
  const r = repos();
  const dbPath = join(r.data, 'local.db');
  const db = openDb(dbPath);
  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: join(r.dir, 'worktrees') });
  const spawned: string[] = [];
  const svc = new UpdateService({ db, dataDir: r.data, dbPath, root: r.install, upstream: r.real.bare, run: systemRunner,
    workerRunning: () => workersBusy(db, runner), spawnUpdater: (d, root) => { spawned.push(`${d}|${root}`); }, exit: () => {} });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0, update: svc });
  try {
    const login = await http(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await http(srv.port, path, { method, cookie, body });
      return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
    };
    await fn({ db, svc, r, spawned, post: (p, b = {}) => call('POST', p, b), get: (p) => call('GET', p) });
  } finally { svc.stop(); await srv.close(); db.close(); }
}

function http(port: number, path: string, o: { method?: string; cookie?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: {
      host: `127.0.0.1:${port}`, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(JSON.stringify(o.body));
    req.end();
  });
}

test('status and check report how far behind the install is, with the repository link', () => withServer(async ({ r, get, post }) => {
  const before = await get('/api/update/status');
  assert.equal(before.status, 200);
  assert.equal(before.json.repositoryUrl, UPSTREAM_URL);
  assert.equal(before.json.check.state, 'not-checked');
  const c = await post('/api/update/check');
  assert.equal(c.status, 200);
  assert.equal(c.json.check.state, 'ok');
  assert.equal(c.json.check.behind, 1);
  assert.deepEqual(c.json.check.subjects, ['Add b']);
  assert.equal(c.json.check.upstreamSha, r.top);
  assert.deepEqual(c.json.eligibility, { eligible: true });
  assert.equal(c.json.revert.available, false);
}));

test('the upstream URL cannot be changed through the API', () => withServer(async ({ r, svc, db, post, spawned }) => {
  const remotes = g(r.install, ['remote', '-v']);
  for (const [path, body] of [
    ['/api/settings/global', { upstream: r.evil.bare, globalMaxWorkers: 3 }],
    ['/api/settings/global', { update_upstream: r.evil.bare }],
    ['/api/update/settings', { checkEnabled: true, upstream: r.evil.bare }],
    ['/api/update/check', { upstream: r.evil.bare }],
    ['/api/update/apply', { updateUpstream: r.evil.bare }],
    ['/api/update/revert', { UPSTREAM: r.evil.bare }],
  ] as const) {
    const res = await post(path, body);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(body)} -> ${res.status}`);
    assert.match(res.json.error, /only be set when Vizor Local starts/);
  }
  assert.equal(getSetting(db, 'global_max_workers'), '4', 'the rejected settings write changed nothing');
  assert.equal(svc.upstream, r.real.bare);
  assert.equal(spawned.length, 0);
  const c = await post('/api/update/check');
  assert.equal(c.json.check.upstreamSha, r.top, 'still fetches the launch-time upstream');
  assert.notEqual(g(r.install, ['rev-parse', UPSTREAM_REF]), r.evilTop);
  assert.equal(g(r.install, ['remote', '-v']), remotes, 'no remote added');
}));

test('update_check_enabled=0 turns the check off over the API', () => withServer(async ({ r, db, post, get }) => {
  const off = await post('/api/update/settings', { checkEnabled: false });
  assert.equal(off.status, 200);
  assert.equal(getSetting(db, 'update_check_enabled'), '0');
  assert.equal(off.json.check.state, 'disabled');
  const c = await post('/api/update/check');
  assert.equal(c.status, 409);
  assert.equal(c.json.reason, 'check-disabled');
  assert.equal(g(r.install, ['for-each-ref', UPSTREAM_REF]), '', 'nothing was fetched');
  const s = await get('/api/update/status');
  assert.equal(s.json.eligibility.reason, 'check-disabled');
  const a = await post('/api/update/apply');
  assert.equal(a.json.reason, 'check-disabled');
  assert.equal((await post('/api/update/settings', { checkEnabled: 'yes' })).status, 400, 'only a JSON boolean');
  assert.equal((await post('/api/update/settings', { checkEnabled: true })).json.checkEnabled, true);
}));

test('a running worker attempt makes apply answer 409 worker-running', () => withServer(async ({ db, post, spawned, r }) => {
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/repo/p')").run();
  approvePlan(db, draftPlan(db, 'p', { summary: '', tasks: [{ key: 'a', title: 'a', prompt: 'a', acceptance: 'a', writeScope: ['src/**'], deps: [] }] }).planId);
  const taskId = (db.prepare('SELECT id FROM tasks LIMIT 1').get() as { id: string }).id;
  db.prepare("INSERT INTO attempts(id, task_id, kind, status) VALUES ('att1', ?, 'initial', 'running')").run(taskId);
  for (const path of ['/api/update/apply', '/api/update/revert']) {
    const res = await post(path);
    assert.equal(res.status, 409, path);
    assert.equal(res.json.reason, 'worker-running');
  }
  assert.equal(spawned.length, 0);
  assert.equal(readJournal(r.data), null);
  db.prepare("UPDATE attempts SET status='succeeded' WHERE id='att1'").run();
  const ok = await post('/api/update/apply');
  assert.equal(ok.status, 202, JSON.stringify(ok.json));
}));

test('apply ignores any SHA in the body and uses the fetched one', () => withServer(async ({ r, post, spawned }) => {
  const from = g(r.install, ['rev-parse', 'HEAD']);
  const res = await post('/api/update/apply', { sha: r.evilTop, toSha: r.evilTop });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.toSha, r.top);
  assert.equal(spawned.length, 1);
  const j = readJournal(r.data)!;
  assert.deepEqual([j.kind, j.status, j.fromSha, j.toSha], ['update', 'pending', from, r.top]);
  assert.equal(g(r.install, ['rev-parse', 'HEAD']), from, 'the server itself never moves the install');
}));

test('revert refuses without a recorded SHA, whatever the body says', () => withServer(async ({ r, post, spawned }) => {
  const res = await post('/api/update/revert', { sha: r.evilTop, toSha: r.evilTop });
  assert.equal(res.status, 400);
  assert.equal(res.json.reason, 'no-revert-recorded');
  assert.equal(spawned.length, 0);
  assert.equal(readJournal(r.data), null);
}));

test('revert is offered after an update and targets only the recorded SHA', () => withServer(async ({ r, get, post, spawned }) => {
  const previous = g(r.install, ['rev-parse', 'HEAD']);
  g(r.install, ['fetch', '--quiet', r.real.bare, `+refs/heads/main:${UPSTREAM_REF}`]);
  g(r.install, ['merge', '--ff-only', '--quiet', r.top]);
  writeJournal(r.data, { kind: 'update', fromSha: previous, toSha: r.top, status: 'done', error: null, errorDismissed: false,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), updaterPid: null, revert: { previousSha: previous, updatedSha: r.top } });
  const s = await get('/api/update/status');
  assert.deepEqual(s.json.revert, { available: true, toSha: previous });
  const res = await post('/api/update/revert', { sha: r.evilTop });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.toSha, previous);
  const j = readJournal(r.data)!;
  assert.deepEqual([j.kind, j.fromSha, j.toSha], ['revert', r.top, previous]);
  assert.equal(spawned.length, 1);
}));

test('a rolled-back update reports its error until it is dismissed', () => withServer(async ({ r, get, post }) => {
  const sha = g(r.install, ['rev-parse', 'HEAD']);
  writeJournal(r.data, { kind: 'update', fromSha: sha, toSha: r.top, status: 'rolled-back', error: 'npm run build failed (exit 2): TS2322',
    errorDismissed: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), updaterPid: null, revert: null });
  const s = await get('/api/update/status');
  assert.equal(s.json.lastError.status, 'rolled-back');
  assert.match(s.json.lastError.error, /TS2322/);
  assert.equal((await post('/api/update/dismiss-error')).status, 200);
  assert.equal((await get('/api/update/status')).json.lastError, null);
}));

test('a local content change makes the update ineligible over the API', () => withServer(async ({ r, post }) => {
  writeFileSync(join(r.install, 'a.txt'), 'changed\n');
  const c = await post('/api/update/check');
  assert.equal(c.json.check.behind, 1);
  assert.equal(c.json.eligibility.reason, 'local-changes');
  const a = await post('/api/update/apply');
  assert.equal(a.status, 400);
  assert.equal(a.json.reason, 'local-changes');
}));
