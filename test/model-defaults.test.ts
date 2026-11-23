// Per-project planner/worker model defaults and the model recorded on each attempt.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { CannedOrchestrator, plannerArgs } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { configureProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { isModelDefault, type ModelChoice, type ModelDefault } from '../src/types.js';
import { FakeWorkerFactory, modelFor } from '../src/workers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-model-'));
const columns = (db: DatabaseSync, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[];

test('migration adds planner_model/worker_model (default auto) and a nullable attempts.model', () => {
  const fresh = openDb(':memory:');
  const cols = columns(fresh, 'projects');
  for (const name of ['planner_model', 'worker_model']) {
    const c = cols.find((x) => x.name === name);
    assert.ok(c, `${name} exists`);
    assert.equal(c.notnull, 1);
    assert.equal(c.dflt_value, "'auto'");
  }
  const model = columns(fresh, 'attempts').find((x) => x.name === 'model');
  assert.ok(model, 'attempts.model exists');
  assert.equal(model.notnull, 0, 'attempts.model is nullable');
  fresh.close();

  // A database from an older build: rows that already exist pick up the defaults.
  const path = join(tmp(), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE,
      base_branch TEXT NOT NULL DEFAULT 'main', max_workers INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO projects(id, name, repo_path) VALUES ('old','old','/old');
    INSERT INTO attempts(id, task_id, kind, status) VALUES ('a1','t1','initial','succeeded');`);
  old.close();
  const db = openDb(path);
  assert.deepEqual({ ...db.prepare('SELECT planner_model, worker_model FROM projects').get() }, { planner_model: 'auto', worker_model: 'auto' });
  assert.equal((db.prepare('SELECT model FROM attempts').get() as { model: string | null }).model, null);
  db.close();
});

test('isModelDefault accepts auto/sonnet/opus only', () => {
  for (const v of ['auto', 'sonnet', 'opus']) assert.equal(isModelDefault(v), true, v);
  for (const v of ['haiku', 'Auto', '', null, undefined, 1, {}, ['opus']]) assert.equal(isModelDefault(v), false, String(v));
});

test('modelFor: every project default × task model', () => {
  const cases: [ModelDefault, ModelChoice | null, ModelChoice][] = [
    ['auto', null, 'sonnet'], ['auto', 'sonnet', 'sonnet'], ['auto', 'opus', 'opus'],
    ['sonnet', null, 'sonnet'], ['sonnet', 'sonnet', 'sonnet'], ['sonnet', 'opus', 'sonnet'],
    ['opus', null, 'opus'], ['opus', 'sonnet', 'opus'], ['opus', 'opus', 'opus'],
  ];
  for (const [projectDefault, model, want] of cases) {
    assert.equal(modelFor({ model }, 'initial', projectDefault), want, `initial project=${projectDefault} task=${model}`);
    assert.equal(modelFor({ model }, 'retry', projectDefault), want, `retry project=${projectDefault} task=${model}`);
    assert.equal(modelFor({ model }, 'repair', projectDefault), 'opus', `repair still escalates (project=${projectDefault})`);
  }
  // The two-argument form keeps working for existing callers.
  assert.equal(modelFor({ model: null }, 'initial'), 'sonnet');
  assert.equal(modelFor({ model: 'opus' }, 'initial'), 'opus');
});

test('planner args carry --model only when the project default is not auto', () => {
  const flag = (args: string[]) => { const i = args.indexOf('--model'); return i === -1 ? null : args[i + 1]; };
  assert.equal(flag(plannerArgs({ planner_model: 'auto' }, 'p')), null);
  assert.equal(flag(plannerArgs({}, 'p')), null, 'absent behaves like auto');
  assert.equal(flag(plannerArgs({ planner_model: 'sonnet' }, 'p')), 'sonnet');
  assert.equal(flag(plannerArgs({ planner_model: 'opus' }, 'p', ['pre.js'])), 'opus');
  assert.equal(plannerArgs({ planner_model: 'opus' }, 'p', ['pre.js'])[0], 'pre.js', 'preArgs stay first');
});

test('configureProject validates and stores model defaults', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const p = configureProject(db, 'p', { plannerModel: 'opus', workerModel: 'sonnet' });
  assert.equal(p.planner_model, 'opus');
  assert.equal(p.worker_model, 'sonnet');
  assert.throws(() => configureProject(db, 'p', { plannerModel: 'auto', workerModel: 'gpt' as never }), /worker_model must be one of/);
  assert.equal(configureProject(db, 'p', {}).planner_model, 'opus', 'a rejected update writes nothing');
  db.close();
});

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

test('config endpoint validates model defaults; /api/state returns them and attempts[].model', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  approvePlan(db, draftPlan(db, 'p', { summary: '', tasks: [{ key: 'a', title: 'a', prompt: 'do a', acceptance: 'works', writeScope: ['src/a/**'], deps: [] }] }).planId);
  db.prepare("INSERT INTO attempts(id, task_id, kind, status, model) VALUES ('a1','p-v1-a','initial','succeeded','opus')").run();
  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });
  try {
    const login = await http(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const config = (body: unknown) => http(srv.port, '/api/projects/p/config', { method: 'POST', cookie, body });

    for (const bad of [{ planner_model: 'haiku' }, { worker_model: 'OPUS' }, { worker_model: 1 }, { planner_model: null }]) {
      const r = await config(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(JSON.parse(r.body).error, /must be one of auto, opus, sonnet/);
    }
    const before = JSON.parse((await http(srv.port, '/api/state', { cookie })).body);
    assert.equal(before.projects[0].planner_model, 'auto');
    assert.equal(before.projects[0].worker_model, 'auto');

    const ok = await config({ planner_model: 'opus', worker_model: 'sonnet' });
    assert.equal(ok.status, 200);

    const state = JSON.parse((await http(srv.port, '/api/state', { cookie })).body);
    assert.equal(state.projects[0].planner_model, 'opus');
    assert.equal(state.projects[0].worker_model, 'sonnet');
    assert.equal(state.attempts[0].model, 'opus');
  } finally { await srv.close(); db.close(); }
});
