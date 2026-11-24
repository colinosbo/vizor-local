// /api/state additions: every plan version (superseded and empty included) with task count, and the uncommitted file count.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { emit } from '../src/events.js';
import type { Forge } from '../src/forge.js';
import { git } from '../src/git.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer, type RunningServer } from '../src/server.js';
import { FakeWorkerFactory } from '../src/workers.js';

const REQUEST_TIMEOUT_MS = 5000;
const BODY_SNIPPET_CHARS = 500;

interface HttpResponse { status: number; headers: IncomingHttpHeaders; body: string }
interface GetOptions {
  cookie?: string;
  /** Exact status to accept. Without it, any 2xx is accepted. */
  expectStatus?: number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** GET a path. Rejects with method, path, status and a body snippet on an unexpected status, a socket error or a timeout. */
function get(port: number, path: string, opts: GetOptions = {}): Promise<HttpResponse> {
  const what = `GET ${path}`;
  return new Promise<HttpResponse>((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (opts.cookie) headers.cookie = opts.cookie;
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('error', (e) => reject(new Error(`${what} response stream failed: ${errorMessage(e)}`, { cause: e })));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const ok = opts.expectStatus === undefined ? status >= 200 && status < 300 : status === opts.expectStatus;
        if (!ok) {
          const expected = opts.expectStatus === undefined ? '2xx' : String(opts.expectStatus);
          reject(new Error(`${what} returned status ${status} (expected ${expected}); body: ${body.slice(0, BODY_SNIPPET_CHARS)}`));
          return;
        }
        resolve({ status, headers: res.headers, body });
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`${what} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', (e) => reject(e.message.startsWith(what) ? e : new Error(`${what} failed: ${e.message}`, { cause: e })));
    req.end();
  });
}

/** GET a path that must answer 2xx with a JSON body. Never resolves with a silent null. */
async function getJson(port: number, path: string, cookie: string): Promise<unknown> {
  const res = await get(port, path, { cookie });
  try {
    return JSON.parse(res.body) as unknown;
  } catch (e) {
    throw new Error(`GET ${path} returned status ${res.status} with invalid JSON (${errorMessage(e)}); body: ${res.body.slice(0, BODY_SNIPPET_CHARS)}`, { cause: e });
  }
}

// ---------- type guards for the /api/state shape this test reads ----------
type JsonRecord = Record<string, unknown>;
interface PlanRow { project_id: string; version: number; status: string; task_count: number; phase_id: number | null; created_at: unknown }
interface ProjectRow { id: string; uncommitted_files: number }
interface StateBody { plans: unknown[]; projects: unknown[] }

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStateBody(v: unknown): v is StateBody {
  return isRecord(v) && Array.isArray(v.plans) && Array.isArray(v.projects);
}
function isPlanRow(v: unknown): v is PlanRow {
  return isRecord(v) && typeof v.project_id === 'string' && typeof v.version === 'number' && typeof v.status === 'string'
    && typeof v.task_count === 'number' && (v.phase_id === null || typeof v.phase_id === 'number');
}
function isProjectRow(v: unknown): v is ProjectRow {
  return isRecord(v) && typeof v.id === 'string' && typeof v.uncommitted_files === 'number';
}

/** Run a setup step; a thrown error (git's includes stderr) is rethrown with the step name. */
function step<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new Error(`setup step "${name}" failed: ${errorMessage(e)}`, { cause: e });
  }
}

/** Run every cleanup step even if earlier ones throw; return the errors instead of throwing. */
async function runCleanup(steps: ReadonlyArray<readonly [string, () => unknown]>): Promise<Error[]> {
  const errors: Error[] = [];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      errors.push(new Error(`cleanup "${name}" failed: ${errorMessage(e)}`, { cause: e }));
    }
  }
  return errors;
}

test('/api/state lists every plan version with task count, phase link and created_at, and the uncommitted file count', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-state-add-'));
  let db: DB | undefined;
  let runner: Runner | undefined;
  let srv: RunningServer | undefined;
  let bodyFailed = false;
  try {
    const openedDb = openDb(join(dir, 'local.db'));
    db = openedDb;
    const repo = join(dir, 'repo');
    const project = step('addProject', () => addProject(openedDb, repo, { createFolder: true, createOrigin: true, originsDir: join(dir, 'origins') }));
    step('git config user.name', () => git(repo, ['config', 'user.name', 'local-test']));
    step('git config user.email', () => git(repo, ['config', 'user.email', 'local-test@localhost']));
    step('git config commit.gpgsign', () => git(repo, ['config', 'commit.gpgsign', 'false']));
    writeFileSync(join(repo, 'a.txt'), 'a\n'); writeFileSync(join(repo, 'b.txt'), 'b\n');
    step('git add', () => git(repo, ['add', '-A']));
    step('git commit', () => git(repo, ['commit', '--quiet', '-m', 'two files']));
    writeFileSync(join(repo, 'a.txt'), 'a changed\n'); writeFileSync(join(repo, 'b.txt'), 'b changed\n');

    // v1 superseded with one task, v2 approved with two, v3 draft with none.
    const plan = (version: number, status: string) => {
      const r = openedDb.prepare('INSERT INTO plans(project_id, version, status, body) VALUES (?,?,?,?) RETURNING id').get(project.id, version, status, '{}') as { id: number };
      emit(openedDb, { projectId: project.id, type: 'plan_drafted', data: { planId: r.id, version } });
      return r.id;
    };
    const [p1, p2, p3] = [plan(1, 'superseded'), plan(2, 'approved'), plan(3, 'draft')];
    const task = (planId: number, key: string) => openedDb.prepare(
      `INSERT INTO tasks(id, project_id, plan_id, key, title, prompt, acceptance, write_scope, deps, status, branch)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`${project.id}-${planId}-${key}`, project.id, planId, key, key, 'p', 'a', '[]', '[]', 'pending', `b-${planId}-${key}`);
    task(p1, 't1'); task(p2, 't1'); task(p2, 't2');
    openedDb.prepare("INSERT INTO phases(project_id, position, title, prompt, status, plan_id) VALUES (?,?,?,?,?,?)").run(project.id, 1, 'P', 'p', 'review', p2);

    runner = new Runner(openedDb, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: join(dir, 'worktrees') });
    srv = await startServer(openedDb, runner, new PlanningService(openedDb, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });

    const login = await get(srv.port, `/?t=${srv.token}`, { expectStatus: 302 });
    const setCookie = login.headers['set-cookie'];
    assert.ok(setCookie && setCookie.length > 0, `login (status ${login.status}) sent no set-cookie; headers: ${JSON.stringify(login.headers)}`);
    const cookie = setCookie[0].split(';')[0];

    const state = await getJson(srv.port, '/api/state', cookie);
    assert.ok(isStateBody(state), `/api/state has no plans/projects arrays: ${JSON.stringify(state).slice(0, BODY_SNIPPET_CHARS)}`);

    const ownPlans = state.plans.filter((p) => isRecord(p) && p.project_id === project.id);
    assert.ok(ownPlans.every(isPlanRow), `plan rows have an unexpected shape: ${JSON.stringify(ownPlans)}`);
    const plans: PlanRow[] = ownPlans;
    const summary = plans.map((p) => [p.version, p.status, p.task_count]);
    assert.deepEqual(summary, [[1, 'superseded', 1], [2, 'approved', 2], [3, 'draft', 0]], `plan versions/status/task_count: ${JSON.stringify(summary)}`);
    const phaseLinks = plans.map((p) => p.phase_id !== null);
    assert.deepEqual(phaseLinks, [false, true, false], `phase links: ${JSON.stringify(plans.map((p) => p.phase_id))}`);
    for (const p of plans) assert.ok(p.created_at, `plan v${p.version} has created_at, got ${JSON.stringify(p.created_at)}`);
    assert.ok(p3 > p1, `plan ids increase: p1=${p1}, p3=${p3}`);

    const proj = state.projects.find((p) => isRecord(p) && p.id === project.id);
    assert.ok(isProjectRow(proj), `project ${project.id} missing or malformed in /api/state: ${JSON.stringify(proj)}`);
    assert.equal(proj.uncommitted_files, 2, `uncommitted_files: ${JSON.stringify(proj.uncommitted_files)}`);
  } catch (e) {
    bodyFailed = true;
    throw e;
  } finally {
    // In order: server, runner, db, then the temp dir (Windows may hold handles briefly, hence the retries).
    const errors = await runCleanup([
      ['srv.close', () => srv?.close()],
      ['runner.stop', () => runner?.stop()],
      ['db.close', () => db?.close()],
      ['rm temp dir', () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })],
    ]);
    // A cleanup error must not hide the test's own failure.
    if (!bodyFailed && errors.length > 0) {
      throw new AggregateError(errors, `cleanup failed: ${errors.map((e) => e.message).join('; ')}`);
    }
  }
});
