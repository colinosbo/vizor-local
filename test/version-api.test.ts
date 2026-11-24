// The running version is reported by /api/state and /api/update/status, through the real server.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { PlanningService } from '../src/planning.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer, type ServerOpts } from '../src/server.js';
import { systemRunner, UpdateService, workersBusy } from '../src/update.js';
import { FakeWorkerFactory } from '../src/workers.js';

const FIXED = { version: '0.2.0', sha: 'abc1234', date: '2026-11-01T00:00:00Z', label: 'v0.2.0 · abc1234' };

function http(port: number, path: string, cookie?: string) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(extra: (c: { update: UpdateService }) => Partial<ServerOpts>, fn: (get: (path: string) => Promise<any>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'vizor-version-api-'));
  const dbPath = join(dir, 'local.db');
  const db = openDb(dbPath);
  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: join(dir, 'worktrees') });
  const update = new UpdateService({ db, dataDir: dir, dbPath, root: process.cwd(), upstream: process.cwd(), run: systemRunner,
    workerRunning: () => workersBusy(db, runner), spawnUpdater: () => {}, exit: () => {} });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0, update, ...extra({ update }) });
  try {
    const login = await http(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    await fn(async (path) => JSON.parse((await http(srv.port, path, cookie)).body));
  } finally { update.stop(); await srv.close(); db.close(); }
}

test('/api/state and /api/update/status carry the injected version', () => withServer(() => ({ version: FIXED }), async (get) => {
  const state = await get('/api/state');
  assert.deepEqual(state.version, FIXED);
  assert.ok(Array.isArray(state.projects), 'existing fields are kept');
  const status = await get('/api/update/status');
  assert.deepEqual(status.version, FIXED);
  assert.ok('check' in status && 'eligibility' in status && 'revert' in status, 'usual status fields are kept');
}));

test('without an injected version, /api/state reports one read from the install', () => withServer(() => ({}), async (get) => {
  const { version } = await get('/api/state');
  assert.equal(typeof version.label, 'string');
  assert.ok(version.label.startsWith('v'), version.label);
}));
