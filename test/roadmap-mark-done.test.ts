// Finishing roadmap phases whose tasks were cancelled: tick() auto-finish, owner markDone, and POST /api/phases/:id/mark-done.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import type { Forge } from '../src/forge.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { RoadmapService, type PhaseRow } from '../src/roadmap.js';
import { Runner } from '../src/runner.js';
import { startServer } from '../src/server.js';
import type { PlanBody } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const task = (key: string) => ({ key, title: key, prompt: 'do ' + key, acceptance: 'works', writeScope: [`src/${key}/**`], deps: [] });
const threeTasks: PlanBody = { summary: '', tasks: [task('a'), task('b'), task('c')] };

function setup(phases = ['A', 'B']) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const planning = new PlanningService(db, { draft: () => new Promise(() => {}) }); // canned planner that never finishes
  const rm = new RoadmapService(db, planning);
  rm.add('p', phases.map((t) => `${t}\nbody of ${t}`).join('\n---\n'));
  return { db, rm, planning };
}
const ph = (rm: RoadmapService, i: number): PhaseRow => rm.phases('p')[i];
const evs = (db: DB, type: string) => eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === type)
  .map((e) => ({ ...e, data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data }));

/** Make phase i running on an approved plan whose tasks end up with the given statuses (in key order a, b, c). */
function running(db: DB, rm: RoadmapService, i: number, statuses: string[]): number {
  const { planId } = draftPlan(db, 'p', threeTasks);
  approvePlan(db, planId);
  const ids = (db.prepare('SELECT id FROM tasks WHERE plan_id=? ORDER BY key').all(planId) as { id: string }[]).map((r) => r.id);
  assert.equal(ids.length, statuses.length);
  ids.forEach((id, k) => db.prepare('UPDATE tasks SET status=? WHERE id=?').run(statuses[k], id));
  db.prepare("UPDATE phases SET status='running', plan_id=? WHERE id=?").run(planId, ph(rm, i).id);
  return planId;
}

test('a. a running phase whose tasks are all cancelled finishes with done_note "tasks cancelled"', () => {
  const { db, rm } = setup();
  running(db, rm, 0, ['cancelled', 'cancelled', 'cancelled']);
  rm.tick();
  assert.equal(ph(rm, 0).status, 'done');
  assert.equal(ph(rm, 0).done_note, 'tasks cancelled');
  const done = evs(db, 'phase_done');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.note, 'tasks cancelled');
  assert.equal(done[0].data.phase, ph(rm, 0).id);
});

test('b. a running phase with one open task stays running, and markDone rejects it', () => {
  for (const open of ['pending', 'ready', 'running', 'waiting_ci', 'merging', 'failed', 'blocked']) {
    const { db, rm } = setup();
    running(db, rm, 0, ['cancelled', open, 'cancelled']);
    rm.tick(); rm.tick();
    assert.equal(ph(rm, 0).status, 'running', `open task in ${open}`);
    assert.equal(ph(rm, 0).done_note, null);
    assert.equal(ph(rm, 1).status, 'queued', 'next phase waits');
    assert.throws(() => rm.markDone(ph(rm, 0).id), /open task/);
    assert.equal(ph(rm, 0).status, 'running');
    assert.equal(evs(db, 'phase_done').length, 0);
  }
});

test('c. after an all-cancelled phase finishes, the next queued phase moves on (still needs manual approval)', () => {
  const { db, rm } = setup();
  running(db, rm, 0, ['cancelled', 'cancelled', 'cancelled']);
  rm.tick(); rm.tick();
  assert.equal(ph(rm, 0).status, 'done');
  assert.ok(['drafting', 'review'].includes(ph(rm, 1).status), `next phase is ${ph(rm, 1).status}`);
  assert.equal(evs(db, 'plan_auto_approved').length, 0);
});

test('d. regression: a phase with a merged task and the rest cancelled finishes with done_note NULL', () => {
  const { db, rm } = setup();
  running(db, rm, 0, ['merged', 'cancelled', 'cancelled']);
  rm.tick();
  assert.equal(ph(rm, 0).status, 'done');
  assert.equal(ph(rm, 0).done_note, null);
  const done = evs(db, 'phase_done');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.note, undefined);
});

test('e. markDone finishes a running phase with no open tasks; queued, done and unknown phases are rejected', () => {
  const { db, rm } = setup(['A', 'B', 'C']);
  running(db, rm, 0, ['merged', 'cancelled', 'merged']);
  rm.markDone(ph(rm, 0).id);
  assert.equal(ph(rm, 0).status, 'done');
  assert.equal(ph(rm, 0).done_note, 'marked done by owner');
  assert.equal(evs(db, 'phase_done').at(-1)!.data.note, 'marked done by owner');

  assert.throws(() => rm.markDone(ph(rm, 0).id), /done phase cannot be marked done/);
  assert.throws(() => rm.markDone(ph(rm, 1).id), /queued phase cannot be marked done/);
  assert.throws(() => rm.markDone(99_999), /unknown phase/);
  assert.equal(ph(rm, 1).status, 'queued');

  // Nothing merged → the note says so.
  running(db, rm, 1, ['cancelled', 'cancelled', 'cancelled']);
  rm.markDone(ph(rm, 1).id);
  assert.equal(ph(rm, 1).done_note, 'tasks cancelled');

  // A plan with zero tasks counts as having no open task.
  const empty = Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', 99, 'approved', '{}')").run().lastInsertRowid);
  db.prepare("UPDATE phases SET status='running', plan_id=? WHERE id=?").run(empty, ph(rm, 2).id);
  rm.markDone(ph(rm, 2).id);
  assert.equal(ph(rm, 2).status, 'done');
  assert.equal(ph(rm, 2).done_note, 'tasks cancelled');
});

test('migration: an old phases table gains done_note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-done-note-'));
  const file = join(dir, 'old.db');
  const old = openDb(file);
  old.exec('ALTER TABLE phases DROP COLUMN done_note');
  old.close();
  const db = openDb(file);
  const cols = (db.prepare('PRAGMA table_info(phases)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('done_note'));
  db.close();
});

// ---- HTTP ----------------------------------------------------------------------------------------

function http(port: number, path: string, o: { method?: string; cookie?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: {
      host: `127.0.0.1:${port}`, ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(JSON.stringify(o.body));
    req.end();
  });
}

async function withServer(fn: (s: { db: DB; rm: RoadmapService; port: number; cookie: string }) => Promise<void>) {
  const { db, rm, planning } = setup();
  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: mkdtempSync(join(tmpdir(), 'local-mark-done-')) });
  const srv = await startServer(db, runner, planning, { port: 0, roadmap: rm }); // ephemeral port
  try {
    const login = await http(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    await fn({ db, rm, port: srv.port, cookie });
  } finally { await srv.close(); db.close(); }
}

test('f. POST /api/phases/:id/mark-done works with the owner cookie', () => withServer(async ({ db, rm, port, cookie }) => {
  running(db, rm, 0, ['cancelled', 'merged', 'cancelled']);
  const r = await http(port, `/api/phases/${ph(rm, 0).id}/mark-done`, { method: 'POST', cookie, body: {} });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal(ph(rm, 0).status, 'done');
  assert.equal(ph(rm, 0).done_note, 'marked done by owner');
}));

test('f. POST /api/phases/:id/mark-done without the cookie is rejected and changes nothing', () => withServer(async ({ db, rm, port }) => {
  running(db, rm, 0, ['cancelled', 'cancelled', 'cancelled']);
  const r = await http(port, `/api/phases/${ph(rm, 0).id}/mark-done`, { method: 'POST', body: {} });
  assert.notEqual(r.status, 200);
  assert.equal(ph(rm, 0).status, 'running');
  assert.equal(ph(rm, 0).done_note, null);
  assert.equal(evs(db, 'phase_done').length, 0);
}));

test('f. POST /api/phases/:id/mark-done on a phase with an open task returns a 4xx JSON error', () => withServer(async ({ db, rm, port, cookie }) => {
  running(db, rm, 0, ['cancelled', 'ready', 'cancelled']);
  const r = await http(port, `/api/phases/${ph(rm, 0).id}/mark-done`, { method: 'POST', cookie, body: {} });
  assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
  assert.match(JSON.parse(r.body).error, /open task/);
  assert.equal(ph(rm, 0).status, 'running');
}));
