// Owner-only POST /api/tasks/:id/cancel: dry-run preview (read-only) and real cancel with dependent rerouting.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import type { Forge } from '../src/forge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import type { PlanBody } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const task = (key: string, deps: string[]) => ({ key, title: key, prompt: 'do ' + key, acceptance: 'works', writeScope: [`src/${key}/**`], deps });
const chain: PlanBody = { summary: '', tasks: [task('a', []), task('b', ['a']), task('c', ['b'])] };
const A = 'p-v1-a', B = 'p-v1-b', C = 'p-v1-c';

async function withServer(fn: (s: { db: DB; port: number; cookie: string; call: (id: string, body?: unknown, o?: { cookie?: string | null; origin?: string; ctype?: string }) => ReturnType<typeof http> }) => Promise<void>) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers) VALUES ('p','p','/repo/p',6)").run();
  approvePlan(db, draftPlan(db, 'p', chain).planId);
  const forge = {} as Forge; // cancelling tasks without PRs never touches the forge
  const runner = new Runner(db, forge, new FakeWorkerFactory({}), { worktreesDir: mkdtempSync(join(tmpdir(), 'local-cancel-')) });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 }); // ephemeral port: test files run in parallel
  try {
    const login = await http(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const call = (id: string, body: unknown = {}, o: { cookie?: string | null; origin?: string; ctype?: string } = {}) =>
      http(srv.port, `/api/tasks/${id}/cancel`, { method: 'POST', cookie: o.cookie === null ? undefined : (o.cookie ?? cookie), origin: o.origin, ctype: o.ctype, body });
    await fn({ db, port: srv.port, cookie, call });
  } finally { await srv.close(); db.close(); }
}

function http(port: number, path: string, o: { method?: string; cookie?: string; origin?: string; ctype?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: {
      host: `127.0.0.1:${port}`, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}),
      ...(o.body !== undefined ? { 'content-type': o.ctype ?? 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}

const snapshot = (db: DB) => ({
  tasks: db.prepare('SELECT id, status, deps, hold_reason, updated_at FROM tasks ORDER BY id').all(),
  events: eventsAfter(db, 0, {}, 10_000).length,
});
const deps = (db: DB, id: string) => JSON.parse((db.prepare('SELECT deps FROM tasks WHERE id=?').get(id) as { deps: string }).deps);
const status = (db: DB, id: string) => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: string }).status;

test('dry-run previews the reroute for A<-B<-C and writes nothing', () => withServer(async ({ db, call }) => {
  const before = snapshot(db);
  const r = await call(B, { dryRun: true });
  assert.equal(r.status, 200, r.body);
  const out = JSON.parse(r.body);
  assert.deepEqual(out.task, { id: B, key: 'b', status: status(db, B) });
  assert.deepEqual({ dryRun: out.dryRun, cancellable: out.cancellable, reroute: out.reroute }, { dryRun: true, cancellable: true, reroute: true });
  assert.deepEqual(out.reroutes, [{ key: 'c', before: ['b'], after: ['a'] }]);
  assert.deepEqual(snapshot(db), before, 'statuses, deps and events unchanged');
}));

test('real cancel sets B cancelled and reroutes C to [A]', () => withServer(async ({ db, call }) => {
  const r = await call(B, {});
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(JSON.parse(r.body), { ok: true, dryRun: false, reroutes: [{ key: 'c', before: ['b'], after: ['a'] }] });
  assert.equal(status(db, B), 'cancelled');
  assert.deepEqual(deps(db, C), ['a']);
}));

test('reroute:false leaves C deps alone', () => withServer(async ({ db, call }) => {
  const r = await call(B, { reroute: false });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(JSON.parse(r.body), { ok: true, dryRun: false, reroutes: [] });
  assert.equal(status(db, B), 'cancelled');
  assert.deepEqual(deps(db, C), ['b']);
}));

test('cancelling a merged task is 409 with a reason; its dry-run is cancellable:false', () => withServer(async ({ db, call }) => {
  db.prepare("UPDATE tasks SET status='merged' WHERE id=?").run(B);
  const dry = JSON.parse((await call(B, { dryRun: true })).body);
  assert.equal(dry.cancellable, false);
  assert.match(dry.reason, /already merged/);
  const before = snapshot(db);
  const r = await call(B, {});
  assert.equal(r.status, 409);
  assert.match(JSON.parse(r.body).error, /cannot cancel: .*merged/);
  assert.deepEqual(snapshot(db), before);
}));

test('unknown id is 404 for real and dry-run', () => withServer(async ({ call }) => {
  assert.equal((await call('nope', {})).status, 404);
  assert.equal((await call('nope', { dryRun: true })).status, 404);
}));

test('auth: no cookie 401, wrong Origin 403, non-JSON content-type 415; nothing changes', () => withServer(async ({ db, port, call }) => {
  const before = snapshot(db);
  assert.equal((await call(B, {}, { cookie: null })).status, 401);
  assert.equal((await call(B, {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call(B, {}, { ctype: 'text/plain' })).status, 415);
  assert.deepEqual(snapshot(db), before);
  assert.equal(status(db, B) === 'cancelled', false);
  void port;
}));
