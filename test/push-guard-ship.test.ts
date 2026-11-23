// Push guard enforcement: ship (pushToGithub / pushNow), AutoPusher and the HTTP endpoints all refuse
// pushes with secrets, denylisted files or the owner's home path; one explicit override lets one finding through.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AutoPusher } from '../src/autopush.js';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter, emit } from '../src/events.js';
import type { Forge } from '../src/forge.js';
import { git, revParse } from '../src/git.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { addProject, configureProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { createTargetRepo, DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { clearOverride, overrideFinding, PushBlockedError, pushNow, pushToGithub, setPushGuardScanOptions, shipStatus } from '../src/ship.js';
import type { Project } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

// Built at runtime so no real-looking secret or real home path sits in source.
const FAKE_USER = 'zq' + 'guardowner';
const FAKE_HOME = ['', 'home', FAKE_USER].join('/');
const FAKE_TOKEN = 'gh' + 'p_' + 'a1B2'.repeat(9);

setPushGuardScanOptions({ homeDir: FAKE_HOME, username: FAKE_USER });
after(() => setPushGuardScanOptions());

const tmp = () => mkdtempSync(join(tmpdir(), 'local-pg-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const proj = (db: DB, id: string) => db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
const events = (db: DB, type: string) => eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === type);

/** Commit files straight to a bare repo (as if a merge landed there). */
function land(root: string, bare: string, files: Record<string, string>, msg = 'land') {
  const c = join(root, 'pusher-' + Math.random().toString(36).slice(2));
  git(root, ['clone', '--quiet', bare, c]);
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(c, f, '..'), { recursive: true }); writeFileSync(join(c, f), body); }
  git(c, ['add', '-A']); git(c, ['commit', '--quiet', '-m', msg]); git(c, ['push', '--quiet', 'origin', 'main']);
}

/** A project whose `origin` is Local's bare repo and whose `github` remote is another local bare repo. */
function setup() {
  const root = tmp(), db = openDb(':memory:');
  const { bare, checkout } = createTargetRepo(root);
  const p = addProject(db, checkout, { name: 'demo' });
  const github = join(root, 'github.git');
  git(root, ['clone', '--quiet', '--bare', bare, github]);
  git(checkout, ['remote', 'add', 'github', github]);
  const before = revParse(github, 'refs/heads/main');
  return { root, db, p, bare, github, before, ghHead: () => revParse(github, 'refs/heads/main') };
}

async function refusal(promise: Promise<unknown>): Promise<PushBlockedError> {
  try { await promise; } catch (e) { assert.ok(e instanceof PushBlockedError, `expected PushBlockedError, got ${e}`); return e; }
  throw new assert.AssertionError({ message: 'push was not refused' });
}

test('a commit adding a GitHub token is refused, naming file and reason; GitHub is unchanged', async () => {
  const s0 = setup();
  land(s0.root, s0.bare, { 'src/config.ts': `export const a = 1;\nexport const t = '${FAKE_TOKEN}';\n` });
  const s = await shipStatus(s0.p, { db: s0.db });
  const e = await refusal(pushToGithub(s0.db, s0.p, s.local!));
  assert.match(e.message, /^push refused: src\/config\.ts:2 \(looks like a GitHub token\)$/);
  assert.ok(!e.message.includes(FAKE_TOKEN), 'the secret is never echoed');
  assert.equal(e.findings.length, 1);
  assert.equal(s0.ghHead(), s0.before, 'bare GitHub repo unchanged');
  assert.equal(git(s0.github, ['tag', '--list']), '', 'no tag pushed');
});

test('a commit adding a .env file is refused by pushToGithub and pushNow', async () => {
  const s0 = setup();
  land(s0.root, s0.bare, { '.env': 'PORT=3000\n' });
  const s = await shipStatus(s0.p, { db: s0.db });
  assert.match((await refusal(pushToGithub(s0.db, s0.p, s.local!))).message, /\.env \(file name matches \.env\*\)/);
  assert.match((await refusal(pushNow(s0.db, s0.p))).message, /\.env \(file name matches \.env\*\)/);
  assert.equal(s0.ghHead(), s0.before);
});

test('a commit containing the home folder path is refused', async () => {
  const s0 = setup();
  land(s0.root, s0.bare, { 'notes.md': `data lives in ${FAKE_HOME}/projects/x\n` });
  const e = await refusal(pushNow(s0.db, s0.p));
  assert.match(e.message, /notes\.md:1 \(contains your home folder path\)/);
  assert.ok(!e.message.includes(FAKE_HOME));
  assert.equal(s0.ghHead(), s0.before);
});

test('shipStatus reports findings; one explicit override lets that finding through', async () => {
  const s0 = setup();
  land(s0.root, s0.bare, { 'src/config.ts': `export const t = '${FAKE_TOKEN}';\n` });
  let s = await shipStatus(s0.p, { db: s0.db });
  assert.equal(s.canPush, false);
  assert.equal(s.findings.length, 1); assert.equal(s.overridden, 0);
  assert.deepEqual({ file: s.findings[0].file, rule: s.findings[0].rule }, { file: 'src/config.ts', rule: 'github-token' });

  await assert.rejects(overrideFinding(s0.db, s0.p, 'not-a-real-id'), /unknown finding/);
  assert.equal(s0.db.prepare('SELECT COUNT(*) n FROM push_overrides').get()!.n, 0);

  const id = s.findings[0].id;
  await overrideFinding(s0.db, s0.p, id);
  const ev = events(s0.db, 'push_guard_override');
  assert.equal(ev.length, 1);
  assert.deepEqual(JSON.parse(ev[0].data), { findingId: id, file: 'src/config.ts', rule: 'github-token' });
  assert.ok(!JSON.stringify(ev[0]).includes(FAKE_TOKEN), 'event never carries the secret');
  s = await shipStatus(s0.p, { db: s0.db });
  assert.deepEqual([s.findings.length, s.overridden, s.canPush], [0, 1, true]);

  clearOverride(s0.db, s0.p, id);
  assert.equal((await shipStatus(s0.p, { db: s0.db })).canPush, false, 'cleared override blocks again');
  await refusal(pushToGithub(s0.db, s0.p, s.local!));

  await overrideFinding(s0.db, s0.p, id);
  const r = await pushToGithub(s0.db, s0.p, s.local!);
  assert.equal(r.sha, s.local);
  assert.equal(s0.ghHead(), s.local, 'push went through after the override');
});

test('overriding one of two findings still refuses, naming the other', async () => {
  const s0 = setup();
  land(s0.root, s0.bare, { '.env': 'PORT=3000\n', 'src/a.ts': `const t = '${FAKE_TOKEN}';\n` });
  const s = await shipStatus(s0.p, { db: s0.db });
  assert.equal(s.findings.length, 2);
  await overrideFinding(s0.db, s0.p, s.findings.find((f) => f.file === '.env')!.id);
  const e = await refusal(pushToGithub(s0.db, s0.p, s.local!));
  assert.equal(e.message, 'push refused: src/a.ts:1 (looks like a GitHub token)');
  assert.equal((await shipStatus(s0.p, { db: s0.db })).overridden, 1);
  assert.equal(s0.ghHead(), s0.before);
});

test('the refusal message lists at most 5 findings, then +N more', () => {
  const f = (i: number) => ({ id: String(i), kind: 'denylist' as const, rule: '*.key', file: `k${i}.key`, commit: 'c', reason: 'file name matches *.key' });
  const e = new PushBlockedError([1, 2, 3, 4, 5, 6, 7].map(f));
  assert.equal(e.message.split('; ').length, 6);
  assert.match(e.message, /k5\.key \(file name matches \*\.key\); \+2 more$/);
});

test('AutoPusher has no bypass: the refusal lands in auto_push_error and emits auto_push_failed', async () => {
  const s0 = setup();
  approvePlan(s0.db, draftPlan(s0.db, s0.p.id, { summary: 'x', tasks: [DEMO_PLAN.tasks[0]] }).planId);
  // A blocked file name containing "up to date" must not be swallowed by the up-to-date check.
  land(s0.root, s0.bare, { 'docs/up to date.key': 'X=1\n' });
  const sha = revParse(s0.bare, 'refs/heads/main')!;
  const [t1] = s0.db.prepare('SELECT id FROM tasks WHERE project_id=?').all(s0.p.id) as { id: string }[];
  s0.db.prepare("UPDATE tasks SET status='merged', merge_sha=? WHERE id=?").run(sha, t1.id);
  emit(s0.db, { projectId: s0.p.id, taskId: t1.id, type: 'task_merged' });
  configureProject(s0.db, s0.p.id, { autoPush: true });
  const ap = new AutoPusher(s0.db);
  ap.tick();
  for (let i = 0; i < 200 && (ap as any).busy.size; i++) await sleep(25);
  assert.equal(proj(s0.db, s0.p.id).auto_push_error, 'push refused: docs/up to date.key (file name matches *.key)');
  assert.equal(events(s0.db, 'auto_push_failed').length, 1);
  assert.equal(s0.ghHead(), s0.before);
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

test('HTTP: ship lists findings, push and push-now answer 409 with findings, override endpoints work', async () => {
  const s0 = setup();
  land(s0.root, s0.bare, { '.env': 'PORT=3000\n', 'src/a.ts': `const t = '${FAKE_TOKEN}';\n` });
  const runner = new Runner(s0.db, {} as Forge, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  const srv = await startServer(s0.db, runner, new PlanningService(s0.db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });
  try {
    const cookie = String((await http(srv.port, `/?t=${srv.token}`)).headers['set-cookie'][0]).split(';')[0];
    const post = (action: string, body: unknown) => http(srv.port, `/api/projects/${s0.p.id}/${action}`, { method: 'POST', cookie, body });
    const ship = async () => JSON.parse((await http(srv.port, `/api/projects/${s0.p.id}/ship`, { cookie })).body);

    let s = await ship();
    assert.equal(s.canPush, false); assert.equal(s.findings.length, 2);

    for (const [action, body] of [['push', { sha: s.local }], ['push-now', {}]] as const) {
      const r = await post(action, body);
      assert.equal(r.status, 409, r.body);
      const out = JSON.parse(r.body);
      assert.match(out.error, /^push refused: .*\.env \(file name matches \.env\*\)/);
      assert.equal(out.findings.length, 2);
      assert.ok(!r.body.includes(FAKE_TOKEN));
    }
    assert.equal(s0.ghHead(), s0.before);

    assert.equal((await post('push-override', { findingId: 'nope' })).status, 400);
    const envId = s.findings.find((f: { file: string }) => f.file === '.env').id;
    const tokId = s.findings.find((f: { file: string }) => f.file === 'src/a.ts').id;
    assert.equal((await post('push-override', { findingId: envId })).status, 200);
    s = await ship();
    assert.deepEqual([s.findings.length, s.overridden], [1, 1]);
    const r = await post('push', { sha: s.local });
    assert.equal(r.status, 409);
    assert.deepEqual(JSON.parse(r.body).findings.map((f: { file: string }) => f.file), ['src/a.ts']);

    assert.equal((await post('push-override-clear', { findingId: envId })).status, 200);
    assert.equal((await ship()).findings.length, 2);

    await post('push-override', { findingId: envId });
    await post('push-override', { findingId: tokId });
    const ok = await post('push', { sha: s.local });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(s0.ghHead(), s.local);
  } finally { await srv.close(); s0.db.close(); }
});
