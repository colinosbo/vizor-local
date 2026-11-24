// GET /js/<name>.js serves browser ES modules from public/js/ behind the same Host + launch-cookie checks as GET /.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import type { Forge } from '../src/forge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { PlanningService } from '../src/planning.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { FakeWorkerFactory } from '../src/workers.js';

const jsDir = fileURLToPath(new URL('../../public/js/', import.meta.url));
const fixture = join(jsDir, 'zz-test-fixture.js');
const source = 'export const answer = 42;\n';

function get(port: number, path: string, o: { cookie?: string; host?: string; method?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    // `path` is passed raw: node:http does not normalize `..` or `%2e%2e`.
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}`, ...(o.cookie ? { cookie: o.cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn: (s: { port: number; cookie: string }) => Promise<void>) {
  const createdDir = !existsSync(jsDir);
  if (createdDir) mkdirSync(jsDir, { recursive: true });
  writeFileSync(fixture, source);
  const db = openDb(':memory:');
  const runner = new Runner(db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: mkdtempSync(join(tmpdir(), 'local-static-')) });
  const srv = await startServer(db, runner, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });
  try {
    const login = await get(srv.port, `/?t=${srv.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    await fn({ port: srv.port, cookie });
  } finally {
    await srv.close(); db.close();
    rmSync(fixture, { force: true });
    if (createdDir || readdirSync(jsDir).length === 0) { try { rmdirSync(jsDir); } catch { /* not empty: leave it */ } }
  }
}

test('valid module: 200, text/javascript, body matches the file', () => withServer(async ({ port, cookie }) => {
  const r = await get(port, '/js/zz-test-fixture.js', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.body, source);
}));

test('traversal with ../ and %2F is never served', () => withServer(async ({ port, cookie }) => {
  for (const p of ['/js/../index.html', '/js/..%2Fserver.js']) {
    const r = await get(port, p, { cookie });
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.body.includes('<!doctype') && !r.body.includes('<html') && !r.body.includes('startServer'), p);
  }
}));

test('encoded traversal, uppercase and missing names are 404', () => withServer(async ({ port, cookie }) => {
  for (const p of ['/js/%2e%2e%2fsecret.js', '/js/Core.js', '/js/nope.js', '/js/zz-test-fixture.js/', '/js/a.b.js']) {
    assert.equal((await get(port, p, { cookie })).status, 404, p);
  }
}));

test('non-GET /js/ requests are 404', () => withServer(async ({ port, cookie }) => {
  assert.equal((await get(port, '/js/zz-test-fixture.js', { cookie, method: 'POST' })).status, 404);
}));

test('no launch cookie: 401', () => withServer(async ({ port }) => {
  assert.equal((await get(port, '/js/zz-test-fixture.js')).status, 401);
}));

test('wrong Host: 403', () => withServer(async ({ port, cookie }) => {
  assert.equal((await get(port, '/js/zz-test-fixture.js', { cookie, host: 'evil.example' })).status, 403);
}));
