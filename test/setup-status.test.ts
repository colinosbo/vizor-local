// Read-only per-project setup status: projectSetup() and its `setup` object on GET /api/state.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { resolveLocalOrigin } from '../src/forges.js';
import { git } from '../src/git.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { projectSetup } from '../src/setup.js';
import type { Project } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-setup-'));

/** Same origin shape /api/state computes before calling projectSetup. */
function withOrigin(p: Project) {
  try { return { ...p, origin: resolveLocalOrigin(p), origin_error: null }; }
  catch (e) { return { ...p, origin: null, origin_error: String((e as Error).message ?? e) }; }
}

function freshProject(db: DB, name = 'fresh') {
  const root = tmp();
  const folder = join(root, name);
  const p = addProject(db, folder, { createFolder: true, createOrigin: true, originsDir: join(root, 'origins'), name });
  return { p, folder };
}

test('a brand-new project has a repo and origin but nothing else proven yet', () => {
  const db = openDb(':memory:');
  const { p } = freshProject(db);
  const s = projectSetup(db, withOrigin(p));
  assert.equal(s.gitRepo, true);
  assert.equal(s.origin, true);
  assert.equal(s.testCommand, true, 'default ci_command is non-empty');
  assert.equal(s.githubConnected, false);
  assert.equal(s.planApproved, false);
  assert.equal(s.testsPassOnMain, false);
  assert.equal(s.firstMerge, false);
  assert.equal(s.autoPush, false);
  assert.equal(s.complete, false);
});

test('adding a github remote flips githubConnected', () => {
  const db = openDb(':memory:');
  const { p, folder } = freshProject(db);
  assert.equal(projectSetup(db, withOrigin(p)).githubConnected, false);
  git(folder, ['remote', 'add', 'github', 'https://github.com/example/fresh.git']);
  assert.equal(projectSetup(db, withOrigin(p)).githubConnected, true);
});

test('a project whose folder was deleted reports all git fields false without throwing', () => {
  const db = openDb(':memory:');
  const { p, folder } = freshProject(db);
  rmSync(folder, { recursive: true, force: true });
  const s = projectSetup(db, withOrigin(p));
  assert.equal(s.gitRepo, false);
  assert.equal(s.origin, false);
  assert.equal(s.githubConnected, false);
  assert.equal(s.complete, false);
});

test('GET /api/state includes setup for every project', async () => {
  const db = openDb(':memory:');
  freshProject(db, 'alive');
  const { folder: gone } = freshProject(db, 'gone');
  rmSync(gone, { recursive: true, force: true });
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('ghost','ghost',?)").run(join(tmp(), 'never-existed'));

  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });
  try {
    const login = await http(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const r = await http(srv.port, '/api/state', cookie);
    assert.equal(r.status, 200, r.body);
    const { projects } = JSON.parse(r.body) as { projects: { id: string; name: string; origin_error: string | null; setup: Record<string, boolean> }[] };
    assert.equal(projects.length, 3);
    const keys = ['gitRepo', 'origin', 'testCommand', 'testsPassOnMain', 'githubConnected', 'autoPush', 'planApproved', 'firstMerge', 'complete'];
    for (const p of projects) {
      assert.deepEqual(Object.keys(p.setup).sort(), [...keys].sort(), p.id);
      for (const k of keys) assert.equal(typeof p.setup[k], 'boolean', `${p.id}.${k}`);
      assert.ok('origin_error' in p, 'existing fields unchanged');
    }
    const byName = (n: string) => projects.find((p) => p.name === n)!.setup;
    assert.equal(byName('alive').gitRepo, true);
    assert.equal(byName('alive').origin, true);
    assert.equal(byName('gone').gitRepo, false);
    assert.equal(byName('ghost').gitRepo, false);
    assert.equal(byName('ghost').origin, false);
  } finally { await srv.close(); db.close(); }
});

function http(port: number, path: string, cookie?: string) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}
