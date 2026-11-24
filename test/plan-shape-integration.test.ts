// planShape wiring: draftPlan result, plan_drafted / plan_ready events and /api/state. Advisory only.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import type { PlanShape } from '../src/plan-shape.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { startServer, type RunningServer } from '../src/server.js';
import type { PlanBody } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const EMPTY: PlanShape = { waves: [], width: 0, longestChain: 0, chain: [], hotFiles: [] };

function mkTask(key: string, deps: string[], writeScope: string[]): PlanBody['tasks'][number] {
  return { key, title: key, prompt: `do ${key}`, acceptance: 'done', writeScope, deps };
}
function mkPlan(tasks: PlanBody['tasks']): PlanBody { return { summary: 's', tasks } as PlanBody; }

const CHAIN_KEYS = ['t1', 't2', 't3', 't4', 't5'];
const chainPlan = () => mkPlan(CHAIN_KEYS.map((k, i) => mkTask(k, i === 0 ? [] : [CHAIN_KEYS[i - 1]], [`src/${k}.ts`])));
const hotPlan = () => mkPlan(['a', 'b', 'c'].map((k) => mkTask(k, [], ['src/shared.ts'])));

function eventData(db: DB, type: string): Record<string, unknown>[] {
  return (db.prepare('SELECT data FROM events WHERE type=? ORDER BY seq').all(type) as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);
}

function getRaw(port: number, path: string, cookie?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (cookie) headers.cookie = cookie;
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function withEnv(fn: (env: { db: DB; projectId: string; dir: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-shape-int-'));
  const db = openDb(join(dir, 'local.db'));
  try {
    const project = addProject(db, join(dir, 'repo'), { createFolder: true, createOrigin: true, originsDir: join(dir, 'origins') });
    await fn({ db, projectId: project.id, dir });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('draftPlan returns a shape and puts a 5-task chain in plan_drafted', async () => {
  await withEnv(async ({ db, projectId }) => {
    const d = draftPlan(db, projectId, chainPlan());
    assert.equal(d.shape.longestChain, 5);
    assert.deepEqual(d.shape.chain, CHAIN_KEYS);
    assert.equal(d.shape.width, 1);
    assert.deepEqual(d.validation.errors, []);
    const ev = eventData(db, 'plan_drafted').find((e) => e.planId === d.planId);
    assert.ok(ev, 'plan_drafted event exists');
    const shape = ev.shape as PlanShape;
    assert.equal(shape.longestChain, 5);
    assert.deepEqual(shape.chain, CHAIN_KEYS);
  });
});

test('plan_ready carries the shape and the drafted outcome keeps it', async () => {
  await withEnv(async ({ db, projectId }) => {
    const planning = new PlanningService(db, new CannedOrchestrator(chainPlan()));
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as never;
    const out = await planning.run(project, 'build a chain');
    assert.equal(out.kind, 'drafted');
    if (out.kind !== 'drafted') return;
    assert.equal(out.shape.longestChain, 5);
    const ready = eventData(db, 'plan_ready').find((e) => e.planId === out.planId);
    assert.ok(ready, 'plan_ready event exists');
    assert.equal((ready.shape as PlanShape).longestChain, 5);
    assert.deepEqual((ready.shape as PlanShape).chain, CHAIN_KEYS);
    assert.equal(ready.requestId, out.requestId);
    assert.equal(ready.version, out.version);
  });
});

test('a plan with a hot file is still approvable (advisory only)', async () => {
  await withEnv(async ({ db, projectId }) => {
    const d = draftPlan(db, projectId, hotPlan());
    assert.deepEqual(d.shape.hotFiles, [{ glob: 'src/shared.ts', tasks: ['a', 'b', 'c'] }]);
    assert.deepEqual(d.validation.errors, []);
    approvePlan(db, d.planId);
    const row = db.prepare('SELECT status FROM plans WHERE id=?').get(d.planId) as { status: string };
    assert.equal(row.status, 'approved');
  });
});

test('/api/state includes shape on every plan version, empty for a malformed body', { timeout: 30000 }, async () => {
  await withEnv(async ({ db, projectId, dir }) => {
    const v1 = draftPlan(db, projectId, chainPlan());
    approvePlan(db, v1.planId);
    const v2 = draftPlan(db, projectId, hotPlan());
    approvePlan(db, v2.planId); // supersedes v1
    const v3 = draftPlan(db, projectId, chainPlan()); // stays a draft
    const bad = db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES (?,?,'draft',?) RETURNING id").get(projectId, 99, '{not json') as { id: number };

    const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: join(dir, 'worktrees') });
    let srv: RunningServer | undefined;
    try {
      srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(chainPlan())), { port: 0 });
      const login = await getRaw(srv.port, `/?t=${srv.token}`);
      const setCookie = login.headers['set-cookie'] as string[] | undefined;
      assert.ok(setCookie?.length, 'login sets a cookie');
      const res = await getRaw(srv.port, '/api/state', setCookie[0].split(';')[0]);
      assert.equal(res.status, 200);
      const state = JSON.parse(res.body) as { plans: { id: number; status: string; shape?: PlanShape }[] };
      const own = state.plans.filter((p) => [v1.planId, v2.planId, v3.planId, bad.id].includes(p.id));
      assert.equal(own.length, 4);
      assert.ok(state.plans.every((p) => p.shape && Array.isArray(p.shape.waves)), 'every plan has a shape');
      const byId = new Map(own.map((p) => [p.id, p]));
      assert.equal(byId.get(v1.planId)?.status, 'superseded');
      assert.equal(byId.get(v1.planId)?.shape?.longestChain, 5);
      assert.equal(byId.get(v2.planId)?.status, 'approved');
      assert.equal(byId.get(v2.planId)?.shape?.hotFiles.length, 1);
      assert.equal(byId.get(v3.planId)?.status, 'draft');
      assert.equal(byId.get(v3.planId)?.shape?.longestChain, 5);
      assert.deepEqual(byId.get(bad.id)?.shape, EMPTY);
    } finally {
      srv?.close();
      runner.stop();
    }
  });
});
