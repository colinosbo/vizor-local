// /api/state reviews, and the review gate and forge fields accepted by POST /api/projects/:id/config.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { putReview } from '../src/review/store.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { FakeWorkerFactory } from '../src/workers.js';

type Rec = Record<string, unknown>;

function call(port: number, method: 'GET' | 'POST', path: string, cookie: string, body?: unknown): Promise<{ status: number; headers: Rec; json: Rec }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, cookie };
    if (payload !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { s += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, headers: res.headers as Rec, json: s ? JSON.parse(s) as Rec : {} }); }
        catch (e) { reject(new Error(`${method} ${path} returned non-JSON (${res.statusCode}): ${s.slice(0, 300)}`, { cause: e })); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    req.end(payload);
  });
}

test('/api/state carries reviews; config accepts and rejects reviewGate and forge fields', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-state-trusted-'));
  const db = openDb(join(dir, 'local.db'));
  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: join(dir, 'worktrees') });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });
  try {
    const project = addProject(db, join(dir, 'repo'), { createFolder: true, createOrigin: true, originsDir: join(dir, 'origins') });
    const plan = db.prepare('INSERT INTO plans(project_id, version, status, body) VALUES (?,?,?,?) RETURNING id').get(project.id, 1, 'approved', '{}') as { id: number };
    const taskId = `${project.id}-t1`;
    db.prepare(`INSERT INTO tasks(id, project_id, plan_id, key, title, prompt, acceptance, write_scope, deps, status, branch)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, project.id, plan.id, 't1', 't1', 'p', 'a', '[]', '[]', 'pending', 'b-t1');
    putReview(db, { projectId: project.id, taskId, prNumber: 7, headSha: 'abc123', status: 'passed', findings: [], model: 'sonnet' });

    const raw = await new Promise<string[]>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: srv.port, path: `/?t=${srv.token}`, headers: { host: `127.0.0.1:${srv.port}` } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'] ?? []));
      });
      r.on('error', reject); r.end();
    });
    assert.ok(raw.length > 0, 'login sent no set-cookie');
    const cookie = raw[0].split(';')[0];

    const projectRow = async () => {
      const s = (await call(srv.port, 'GET', '/api/state', cookie)).json;
      return (s.projects as Rec[]).find((p) => p.id === project.id) as Rec;
    };
    const config = (body: Rec) => call(srv.port, 'POST', `/api/projects/${project.id}/config`, cookie, body);

    const state = (await call(srv.port, 'GET', '/api/state', cookie)).json;
    assert.ok(Array.isArray(state.reviews), 'state.reviews is an array');
    const stored = (state.reviews as Rec[]).find((r) => r.task_id === taskId);
    assert.ok(stored, `stored review missing: ${JSON.stringify(state.reviews)}`);
    assert.equal(stored.pr_number, 7);
    assert.equal(stored.head_sha, 'abc123');
    assert.equal(stored.status, 'passed');

    const ok = await config({ reviewGate: 'block' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await projectRow()).review_gate, 'block');

    const bad = await config({ reviewGate: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'reviewGate must be off, report or block');
    assert.equal((await projectRow()).review_gate, 'block', 'a rejected gate changes nothing');

    const forge = await config({ forgeKind: 'github', githubRepo: 'a/b' });
    assert.equal(forge.status, 200, JSON.stringify(forge.json));
    const row = await projectRow();
    assert.equal(row.forge_kind, 'github');
    assert.equal(row.github_repo, 'a/b');

    const badRepo = await config({ githubRepo: '../x' });
    assert.equal(badRepo.status, 400);
    assert.equal(typeof badRepo.json.error, 'string');
    assert.equal((await projectRow()).github_repo, 'a/b', 'a rejected repo changes nothing');
  } finally {
    await srv.close();
    runner.stop();
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
