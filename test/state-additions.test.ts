// /api/state additions: every plan version (superseded and empty included) with task count, and the uncommitted file count.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { emit } from '../src/events.js';
import type { Forge } from '../src/forge.js';
import { git } from '../src/git.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { FakeWorkerFactory } from '../src/workers.js';

function get(port: number, path: string, cookie?: string) {
  return new Promise<{ headers: Record<string, any>; json: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ headers: res.headers, json: b && b.startsWith('{') ? JSON.parse(b) : null }));
    });
    req.on('error', reject); req.end();
  });
}

test('/api/state lists every plan version with task count, phase link and created_at, and the uncommitted file count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-state-add-'));
  const db = openDb(join(dir, 'local.db'));
  const repo = join(dir, 'repo');
  const project = addProject(db, repo, { createFolder: true, createOrigin: true, originsDir: join(dir, 'origins') });
  writeFileSync(join(repo, 'a.txt'), 'a\n'); writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'two files']);
  writeFileSync(join(repo, 'a.txt'), 'a changed\n'); writeFileSync(join(repo, 'b.txt'), 'b changed\n');

  // v1 superseded with one task, v2 approved with two, v3 draft with none.
  const plan = (version: number, status: string) => {
    const r = db.prepare('INSERT INTO plans(project_id, version, status, body) VALUES (?,?,?,?) RETURNING id').get(project.id, version, status, '{}') as { id: number };
    emit(db, { projectId: project.id, type: 'plan_drafted', data: { planId: r.id, version } });
    return r.id;
  };
  const [p1, p2, p3] = [plan(1, 'superseded'), plan(2, 'approved'), plan(3, 'draft')];
  const task = (planId: number, key: string) => db.prepare(
    `INSERT INTO tasks(id, project_id, plan_id, key, title, prompt, acceptance, write_scope, deps, status, branch)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`${project.id}-${planId}-${key}`, project.id, planId, key, key, 'p', 'a', '[]', '[]', 'pending', `b-${planId}-${key}`);
  task(p1, 't1'); task(p2, 't1'); task(p2, 't2');
  db.prepare("INSERT INTO phases(project_id, position, title, prompt, status, plan_id) VALUES (?,?,?,?,?,?)").run(project.id, 1, 'P', 'p', 'review', p2);

  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: join(dir, 'worktrees') });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });
  try {
    const login = await get(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const state = (await get(srv.port, '/api/state', cookie)).json;

    const plans = state.plans.filter((p: any) => p.project_id === project.id);
    assert.deepEqual(plans.map((p: any) => [p.version, p.status, p.task_count]), [[1, 'superseded', 1], [2, 'approved', 2], [3, 'draft', 0]]);
    assert.deepEqual(plans.map((p: any) => p.phase_id !== null), [false, true, false]);
    for (const p of plans) assert.ok(p.created_at, `plan v${p.version} has created_at`);
    assert.ok(p3 > p1);

    const proj = state.projects.find((p: any) => p.id === project.id);
    assert.equal(proj.uncommitted_files, 2);
  } finally { await srv.close(); db.close(); }
});
