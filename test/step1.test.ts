// Step 1: per-project forges + CI command, background planning, server hardening.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { LocalForge } from '../src/forge.js';
import { ForgeRegistry } from '../src/forges.js';
import { git, revParse } from '../src/git.js';
import { CannedOrchestrator, ClaudeOrchestrator, plannerPrompt, type Orchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { addProject, configureProject } from '../src/projects.js';
import { setReviewGate } from '../src/review/store.js';
import { buildPrompt, Runner } from '../src/runner.js';
import { createTargetRepo, DEMO_PLAN, DEMO_SCENARIO } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import type { PlanBody, Project, TaskRow } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-s1-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const types = (db: DB, after = 0) => eventsAfter(db, after, {}, 10_000).map((e) => e.type);
const proj = (db: DB, id: string) => db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;

test('old database gains forge_origin and ci_command columns', () => {
  const path = join(tmp(), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT 'main',
    max_workers INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO projects(id, name, repo_path) VALUES ('app', 'app', '/x');`);
  old.close();
  const db = openDb(path);
  const p = proj(db, 'app');
  assert.equal(p.ci_command, 'node --test');
  assert.equal(p.forge_origin, null);
  openDb(path).close(); // idempotent
});

test('add --create-origin: plain folder becomes a repo with a local forge origin', () => {
  const root = tmp(), db = openDb(':memory:');
  const folder = join(root, 'my app');
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'src/a.js'), 'export {}\n');
  mkdirSync(join(folder, 'node_modules/x'), { recursive: true });
  writeFileSync(join(folder, 'node_modules/x/i.js'), '');
  assert.throws(() => addProject(db, folder, {}), /not a git checkout/);
  const p = addProject(db, folder, { createOrigin: true, originsDir: join(root, 'origins'), ciCommand: 'npm test' });
  assert.equal(p.ci_command, 'npm test');
  assert.ok(existsSync(join(root, 'origins', 'my-app.git')));
  assert.ok(revParse(join(root, 'origins', 'my-app.git'), 'refs/heads/main'));
  assert.ok(!git(folder, ['ls-files']).includes('node_modules'), 'default .gitignore keeps node_modules out');
  assert.throws(() => addProject(db, folder, { createOrigin: true, originsDir: join(root, 'origins') }), /already registered/);
  assert.throws(() => configureProject(db, p.id, { ciCommand: 'a\nb' }), /one line/);
  assert.equal(configureProject(db, p.id, { ciCommand: 'npm ci && npm test' }).ci_command, 'npm ci && npm test');
});

test('existing repo without origin: --create-origin adds one; a remote URL origin is refused', () => {
  const root = tmp(), db = openDb(':memory:');
  const repo = join(root, 'r'); mkdirSync(repo);
  git(repo, ['init', '--quiet', '-b', 'main']); writeFileSync(join(repo, 'f'), 'x'); git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'c']);
  assert.throws(() => addProject(db, repo, {}), /no origin remote/);
  const p = addProject(db, repo, { createOrigin: true, originsDir: join(root, 'o') });
  assert.equal(git(repo, ['remote', 'get-url', 'origin']), join(root, 'o', 'r.git'));
  assert.throws(() => configureProject(db, p.id, { forgeOrigin: 'https://github.com/a/b.git' }), /GitHub forge adapter is not built/);
});

test('a project with an unusable forge gets no work and one runner_error; others continue', async () => {
  const root = tmp(), db = openDb(':memory:');
  const { checkout } = createTargetRepo(root);
  addProject(db, checkout, { name: 'good' });
  db.prepare("INSERT INTO projects(id, name, repo_path, forge_origin) VALUES ('gh','gh','/nope','https://github.com/a/b.git')").run();
  const one = { summary: '', tasks: [{ ...DEMO_PLAN.tasks[0] }] };
  for (const id of ['good', 'gh']) approvePlan(db, draftPlan(db, id, one).planId);
  const forges = new ForgeRegistry(db, join(root, 'data'));
  const r = new Runner(db, forges.get, new FakeWorkerFactory({ 'history-ui': [{ ...DEMO_SCENARIO['history-ui'][0], sleepMs: 10 }] }), { worktreesDir: join(root, 'wt') });
  await r.tick(); await r.settle();
  assert.equal(r.task('good-v1-history-ui').status, 'waiting_ci');
  const gh = r.task('gh-v1-history-ui');
  assert.equal(gh.status, 'ready');
  assert.match(gh.hold_reason!, /forge unavailable.*GitHub forge adapter/);
  // Force the check path to hit the broken forge twice: one error event, not one per tick.
  db.prepare("UPDATE tasks SET status='waiting_ci', head_sha='abc', pr_number=1 WHERE id='gh-v1-history-ui'").run();
  await r.tick(); await r.tick();
  assert.equal(types(db).filter((t) => t === 'runner_error').length, 1);
  await forges.idle(); forges.close();
});

test('legacy single forge.db is adopted by the project that owns PRs', async () => {
  const root = tmp(), data = join(root, 'data'), db = openDb(':memory:');
  const { bare, checkout } = createTargetRepo(root);
  mkdirSync(data, { recursive: true });
  const legacy = new LocalForge(bare, join(data, 'forge.db'));
  git(checkout, ['push', '--quiet', 'origin', 'main:refs/heads/local/x']);
  legacy.createPr({ branch: 'local/x', base: 'main', title: 't', body: '<!-- local-task:app-v1-a -->' });
  await legacy.idle(); legacy.close();
  const p = addProject(db, checkout, { name: 'app' });
  approvePlan(db, draftPlan(db, p.id, { summary: '', tasks: [{ ...DEMO_PLAN.tasks[0], key: 'a' }] }).planId);
  db.prepare("UPDATE tasks SET pr_number=1").run();
  const reg = new ForgeRegistry(db, data);
  assert.ok(reg.get('app').findPrByMarker('<!-- local-task:app-v1-a -->'), 'existing PR still found');
  assert.ok(!existsSync(join(data, 'forge.db')) && existsSync(join(data, 'forges', 'app.db')));
  reg.close();
});

test('CI runs the project command through the shell, and times out', async () => {
  const root = tmp();
  const { bare } = createTargetRepo(root);
  const sha = revParse(bare, 'refs/heads/main')!;
  const f = new LocalForge(bare, join(root, 'f.db'), 'node -e "process.exit(0)" && npm test');
  f.triggerCi(sha); await f.idle();
  let c = f.checksFor(sha)[0];
  assert.equal(c.conclusion, 'success', c.log);
  assert.match(c.log, /\$ node -e/);
  f.ciCommand = 'node -e "setTimeout(() => {}, 60000)"'; f.ciTimeoutMs = 700;
  const t0 = Date.now();
  f.triggerCi(sha); await f.idle();
  c = f.checksFor(sha)[1];
  assert.equal(c.conclusion, 'failure');
  assert.match(c.log, /timed out/);
  assert.ok(Date.now() - t0 < 10_000);
  f.close();
});

test('worker and planner prompts use the project CI command, not a directory', () => {
  const t = { write_scope: '["src/**"]', title: 't', prompt: 'p', acceptance: 'a', pending_repair: null } as unknown as TaskRow;
  const s = buildPrompt(t, 'initial', 'npm ci && npm test');
  assert.match(s, /run the project's CI command exactly as CI will: npm ci && npm test/);
  assert.match(s, /node --test <dir>` fails/);
  const pp = plannerPrompt({ ci_command: 'npm ci && npm test' } as Project, 'a.js', 'req');
  assert.match(pp, /runs exactly this command in a clean checkout of each PR: npm ci && npm test/);
  assert.match(pp, /empty tasks array/);
});

const dummyProject = (repo: string): Project => ({ id: 'p', name: 'p', repo_path: repo, base_branch: 'main', max_workers: 1, paused: 0, forge_origin: null, ci_command: 'npm test', roadmap_paused: 0 });

test('planning: progress events, declined (no plan row), failed, one at a time', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const p = proj(db, 'p');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Orchestrator = { async draft(_p, _r, on) { on?.('Read src/a.js'); await gate; return { reply: 'ok', plan: DEMO_PLAN }; } };
  const svc = new PlanningService(db, slow);
  const req = svc.start(p, 'build it');
  assert.equal(svc.list().length, 1);
  assert.throws(() => svc.start(p, 'again'), /already being drafted/);
  release(); await svc.idle();
  assert.deepEqual(types(db).filter((t) => t.startsWith('plan_')), ['plan_requested', 'plan_progress', 'plan_drafted', 'plan_ready']);
  assert.equal(svc.list().length, 0);
  assert.ok(req.requestId);

  const empty: PlanBody = { summary: 'n/a', tasks: [] };
  const declined = await new PlanningService(db, new CannedOrchestrator(empty)).run(p, 'wrong repo');
  assert.equal(declined.kind, 'declined');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM plans').get() as { n: number }).n, 1, 'no plan row for a decline');

  const failed = await new PlanningService(db, { draft: async () => { throw new Error('boom'); } }).run(p, 'x');
  assert.equal(failed.kind, 'failed');
  assert.match((db.prepare("SELECT text FROM messages WHERE role='system'").get() as { text: string }).text, /Planning failed: boom/);
});

test('ClaudeOrchestrator parses a streamed planner (fake CLI): progress + structured_output, tool fallback, errors', async () => {
  const root = tmp();
  const { checkout } = createTargetRepo(root);
  const fake = (lines: unknown[], code = 0) => {
    const f = join(root, `fake-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(f, `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l); process.exit(${code});`);
    return new ClaudeOrchestrator(process.execPath, [f]);
  };
  const payload = { reply: 'two tasks', plan: DEMO_PLAN };
  const notes: string[] = [];
  const r1 = await fake([
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: payload },
  ]).draft(dummyProject(checkout), 'req', (n) => notes.push(n));
  assert.equal(r1.plan.tasks.length, 4);
  assert.deepEqual(notes, ['Planner started', 'Read src/app.js']);
  const r2 = await fake([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: payload }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
  ]).draft(dummyProject(checkout), 'req');
  assert.equal(r2.reply, 'two tasks');
  await assert.rejects(fake([{ type: 'result', subtype: 'success', is_error: true, result: 'Authentication error' }], 1).draft(dummyProject(checkout), 'x'), /Authentication error/);
  await assert.rejects(fake([{ type: 'result', subtype: 'success', is_error: false, result: 'no json' }]).draft(dummyProject(checkout), 'x'), /no structured plan/);
});

function http(port: number, path: string, o: { method?: string; host?: string; cookie?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: {
      host: o.host ?? `127.0.0.1:${port}`, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (o.body) req.write(JSON.stringify(o.body));
    req.end();
  });
}

test('server: falls back to a free port, requires the launch key, checks Host, chat returns 202', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const blocker = createServer(); await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  const taken = (blocker.address() as { port: number }).port;
  const runner = new Runner(db, () => { throw new Error('no forge'); }, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  const planning = new PlanningService(db, new CannedOrchestrator(DEMO_PLAN));
  const s = await startServer(db, runner, planning, { port: taken });
  try {
    assert.notEqual(s.port, taken);
    assert.equal((await http(s.port, '/api/state')).status, 401);
    assert.equal((await http(s.port, '/?t=wrong')).status, 401);
    const login = await http(s.port, `/?t=${s.token}`);
    assert.equal(login.status, 302);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    assert.match(String(login.headers['set-cookie'][0]), /HttpOnly; SameSite=Strict/);
    assert.equal((await http(s.port, '/api/state', { cookie })).status, 200);
    assert.equal((await http(s.port, '/api/state', { cookie, host: `evil.example:${s.port}` })).status, 403, 'DNS rebinding');
    const chat = await http(s.port, '/api/projects/p/chat', { method: 'POST', cookie, body: { text: 'add history' } });
    assert.equal(chat.status, 202);
    assert.ok(JSON.parse(chat.body).requestId);
    await planning.idle();
    const st = JSON.parse((await http(s.port, '/api/state', { cookie })).body);
    assert.equal(st.plans.length, 1); assert.deepEqual(st.planning, []);
    assert.equal((await http(s.port, '/api/projects/p/chat', { method: 'POST', cookie, body: { text: '' } })).status, 400);
  } finally { await s.close(); blocker.close(); }
});

test('clearing one project chat preserves other chats, plans, and task history', async () => {
  const db = openDb(':memory:');
  db.exec("INSERT INTO projects(id, name, repo_path) VALUES ('p','Alpha','/alpha'), ('q','Dashboard','/dashboard')");
  const runner = new Runner(db, () => { throw new Error('no forge'); }, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  let finishPlan!: () => void;
  const planning = new PlanningService(db, {
    async draft() {
      await new Promise<void>((resolve) => { finishPlan = resolve; });
      return { reply: 'Plan ready', plan: DEMO_PLAN };
    },
  });
  const s = await startServer(db, runner, planning);
  try {
    const login = await http(s.port, `/?t=${s.token}`);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const clear = (id: string) => http(s.port, `/api/projects/${id}/clear-chat`, { method: 'POST', body: {}, cookie });
    const state = async () => JSON.parse((await http(s.port, '/api/state', { cookie })).body);
    db.exec("INSERT INTO messages(project_id, role, text) VALUES ('q','user','Keep this')");
    const chat = await http(s.port, '/api/projects/p/chat', { method: 'POST', body: { text: 'Add history' }, cookie });
    assert.equal(chat.status, 202);
    assert.equal((await clear('p')).status, 409);
    finishPlan();
    await planning.idle();

    const beforeApproval = await state();
    approvePlan(db, beforeApproval.plans[0].id);
    const before = await state();
    assert.ok(before.tasks.length > 0);
    assert.equal((await clear('p')).status, 200);
    assert.equal((await clear('p')).status, 200);
    const after = await state();
    assert.deepEqual(after.messages, before.messages.filter((m: { project_id: string }) => m.project_id === 'q'));
    assert.deepEqual(after.plans, before.plans);
    assert.deepEqual(after.tasks, before.tasks);
    assert.equal(types(db).filter((type) => type === 'chat_cleared').length, 1);
  } finally {
    finishPlan?.();
    await planning.idle();
    await s.close();
    db.close();
  }
});

test('two projects, two forges, two CI commands: both plans merge independently', async () => {
  const root = tmp(), data = join(root, 'data');
  const db = openDb(join(root, 'local.db'));
  const a = createTargetRepo(join(root, 'a')), b = createTargetRepo(join(root, 'b'));
  addProject(db, a.checkout, { name: 'alpha', maxWorkers: 1 });
  setReviewGate(db, 'alpha', 'report');
  addProject(db, b.checkout, { name: 'beta', maxWorkers: 1, ciCommand: 'npm test' });
  setReviewGate(db, 'beta', 'report');
  approvePlan(db, draftPlan(db, 'alpha', { summary: '', tasks: [DEMO_PLAN.tasks[0]] }).planId);
  approvePlan(db, draftPlan(db, 'beta', { summary: '', tasks: [DEMO_PLAN.tasks[1]] }).planId); // fails CI once, then repaired
  const forges = new ForgeRegistry(db, data);
  const scenario = { 'history-ui': [{ ...DEMO_SCENARIO['history-ui'][0], sleepMs: 10 }], 'rest-timer': DEMO_SCENARIO['rest-timer'] };
  const r = new Runner(db, forges.get, new FakeWorkerFactory(scenario), { worktreesDir: join(data, 'worktrees') });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await r.tick();
    const open = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('merged','blocked','cancelled')").get() as { n: number }).n;
    if (!open) break;
    await sleep(100);
  }
  await r.settle(); await forges.idle();
  assert.equal(r.task('alpha-v1-history-ui').status, 'merged', r.task('alpha-v1-history-ui').hold_reason ?? '');
  assert.equal(r.task('beta-v1-rest-timer').status, 'merged', r.task('beta-v1-rest-timer').hold_reason ?? '');
  assert.equal(r.task('beta-v1-rest-timer').repair_count, 1);
  // Each merge landed in its own origin only.
  assert.ok(git(a.bare, ['ls-tree', '-r', '--name-only', 'main']).includes('src/history/history.js'));
  assert.ok(!git(a.bare, ['ls-tree', '-r', '--name-only', 'main']).includes('src/timer/timer.js'));
  assert.ok(git(b.bare, ['ls-tree', '-r', '--name-only', 'main']).includes('src/timer/timer.js'));
  const betaLogs = (forges.get('beta') as LocalForge).allPrs().length;
  assert.equal(betaLogs, 1);
  assert.ok(existsSync(join(data, 'forges', 'alpha.db')) && existsSync(join(data, 'forges', 'beta.db')));
  forges.close();
});
