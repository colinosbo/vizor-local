// Worker isolation wired end to end: allowlisted env, per-attempt deny settings outside the worktree,
// post-attempt security audit stored on the attempt, emitted as worker_security and served by /api/state.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { LocalForge } from '../src/forge.js';
import { git } from '../src/git.js';
import { SIGN_IN_ALLOWLIST } from '../src/isolation/env.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { createTargetRepo, DEMO_PLAN } from '../src/sandbox.js';
import { parseSecurity, startServer } from '../src/server.js';
import type { AttemptRow } from '../src/types.js';
import { buildClaudeArgs, FakeWorkerFactory, type FakeScenario, type WorkerContext, type WorkerHandle } from '../src/workers.js';

const FAKE_SECRETS = { GH_TOKEN: 'ghp_fake', AWS_SECRET_ACCESS_KEY: 'aws_fake', MY_API_KEY: 'key_fake' } as const;
const SECRET_WORDS = ['TOKEN', 'SECRET', 'PASSWORD', 'KEY'];
const OTHER_PROJECT = join(tmpdir(), 'vizor-other-project-for-isolation-test');
const TASK = 'demo-v1-history-ui';

/** Records what the runner handed to the worker, and what was on disk at that moment. */
class SpyFactory extends FakeWorkerFactory {
  seen: { ctx: WorkerContext; settingsExisted: boolean; settings: string }[] = [];
  override start(ctx: WorkerContext): WorkerHandle {
    const exists = !!ctx.settingsPath && existsSync(ctx.settingsPath);
    this.seen.push({ ctx, settingsExisted: exists, settings: exists ? readFileSync(ctx.settingsPath!, 'utf8') : '' });
    return super.start(ctx);
  }
}

function withFakeSecrets<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(FAKE_SECRETS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, FAKE_SECRETS);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

/** One real repo, one task, one more project registered so otherProjectPaths is not empty. */
async function runOne(scenario: FakeScenario, prep: (dataDir: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'local-iso-'));
  const db = openDb(':memory:');
  const { bare, checkout } = createTargetRepo(root);
  const p = addProject(db, checkout, { name: 'demo' });
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('other','other',?)").run(OTHER_PROJECT);
  approvePlan(db, draftPlan(db, p.id, { summary: '', tasks: [DEMO_PLAN.tasks[0]] }).planId);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  prep(dataDir);
  const workers = new SpyFactory(scenario);
  const r = new Runner(db, new LocalForge(bare, join(root, 'forge.db')), workers, { worktreesDir: join(dataDir, 'worktrees'), localRetryLimit: 0 });
  r.promote();
  await r.tick();
  await r.settle();
  const attempts = db.prepare('SELECT * FROM attempts WHERE task_id=?').all(TASK) as unknown as AttemptRow[];
  assert.equal(attempts.length, 1);
  return { db, r, root, dataDir, workers, attempt: attempts[0]!, worktree: join(dataDir, 'worktrees', TASK) };
}

const evs = (db: DB, attemptId: string, type: string) =>
  eventsAfter(db, 0, {}, 10_000).filter((e) => e.attempt_id === attemptId && e.type === type).map((e) => JSON.parse(e.data));

function assertSecurityShape(s: unknown) {
  assert.ok(s && typeof s === 'object', 'security is an object');
  const o = s as Record<string, unknown>;
  assert.equal(typeof o.deniedAttempts, 'number');
  assert.equal(typeof o.networkCommands, 'number');
  assert.ok(Array.isArray(o.events));
  for (const e of o.events as Record<string, unknown>[]) for (const k of ['tool', 'command', 'reason']) assert.equal(typeof e[k], 'string');
}

/** After every attempt: stored JSON, a worker_security event, settings gone, nothing written into the worktree. */
function assertAudited(s: Awaited<ReturnType<typeof runOne>>) {
  const { db, attempt, workers, worktree } = s;
  assert.ok(attempt.security, 'attempts.security is set');
  const stored = JSON.parse(attempt.security!);
  assertSecurityShape(stored);
  const sec = evs(db, attempt.id, 'worker_security');
  assert.equal(sec.length, 1, 'exactly one worker_security event');
  assert.deepEqual(sec[0], stored);

  const [{ ctx }] = workers.seen;
  assert.ok(ctx.settingsPath, 'worker was given a settings path');
  const rel = relative(worktree, ctx.settingsPath!);
  assert.ok(rel.startsWith('..'), `settings file ${ctx.settingsPath} is outside the worktree`);
  assert.equal(ctx.settingsPath, join(s.dataDir, 'isolation', attempt.id, 'settings.json'));
  assert.ok(!existsSync(ctx.settingsPath!), 'settings file removed after the attempt');
  assert.ok(!existsSync(join(worktree, 'settings.json')));
  assert.equal(git(worktree, ['status', '--porcelain']), '', 'worktree stays clean');
}

test('fake worker with printEnv sees no secret-like variables; attempt is audited and served by /api/state', { timeout: 60_000 }, () => withFakeSecrets(async () => {
  const s = await runOne({ 'history-ui': [{ printEnv: true, sleepMs: 10, files: { 'src/history/history.js': 'export {}\n' } }] });
  const { db, r, attempt, workers } = s;
  try {
    assert.equal(attempt.status, 'succeeded', attempt.reason ?? '');

    // Environment: the line printed by the fake worker is the name list.
    const names = evs(db, attempt.id, 'worker_output')
      .filter((e) => e.kind === 'text' && String(e.text).startsWith('['))
      .map((e) => JSON.parse(e.text) as string[]);
    assert.equal(names.length, 1, 'printEnv emitted one env line');
    const env = names[0]!;
    assert.ok(env.some((n) => n.toUpperCase() === 'PATH'), 'PATH still reaches the worker');
    const allowed = new Set(SIGN_IN_ALLOWLIST.map((n) => n.toUpperCase()));
    for (const k of Object.keys(FAKE_SECRETS)) assert.ok(!env.includes(k), `${k} must not reach the worker`);
    const leaked = env.filter((n) => !allowed.has(n.toUpperCase()) && SECRET_WORDS.some((w) => n.toUpperCase().includes(w)));
    assert.deepEqual(leaked, []);

    // Settings existed while the worker ran, and deny the other project.
    const [seen] = workers.seen;
    assert.ok(seen!.settingsExisted, 'settings written before the worker started');
    const deny = (JSON.parse(seen!.settings) as { permissions: { deny: string[] } }).permissions.deny;
    const otherRule = OTHER_PROJECT.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => '/' + d.toLowerCase());
    assert.ok(deny.some((d) => d.includes(otherRule)), 'other project path is denied');

    assertAudited(s);

    // /api/state serves the parsed object, not the column string.
    const srv = await startServer(db, r, new PlanningService(db, new CannedOrchestrator(DEMO_PLAN)), { port: 0 });
    try {
      const login = await http(srv.port, `/?t=${srv.token}`);
      const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
      const res = await http(srv.port, '/api/state', cookie);
      assert.equal(res.status, 200);
      const state = JSON.parse(res.body) as { attempts: { id: string; security: unknown }[] };
      const a = state.attempts.find((x) => x.id === attempt.id)!;
      assertSecurityShape(a.security);
      assert.deepEqual(a.security, JSON.parse(attempt.security!));
    } finally { await srv.close(); }
  } finally { db.close(); }
}));

test('a failed attempt is audited too, and its uncommitted worktree holds no settings file', { timeout: 60_000 }, async () => {
  // No files and a non-zero exit: nothing is committed, so `git status` shows anything Local wrote there.
  const s = await runOne({ 'history-ui': [{ exitCode: 1, sleepMs: 10, files: {} }] });
  try {
    assert.equal(s.attempt.status, 'failed');
    assert.equal(s.r.task(TASK).status, 'blocked');
    assertAudited(s);
  } finally { s.db.close(); }
});

test('a settings write error never fails the attempt: runner_error, then the worker runs without --settings', { timeout: 60_000 }, async () => {
  // A plain file where the isolation folder belongs makes writeAttemptSettings throw.
  const s = await runOne({ 'history-ui': [{ sleepMs: 10, files: { 'src/history/history.js': 'export {}\n' } }] },
    (dataDir) => writeFileSync(join(dataDir, 'isolation'), 'not a folder'));
  try {
    assert.equal(s.attempt.status, 'succeeded', s.attempt.reason ?? '');
    assert.equal(s.workers.seen[0]!.ctx.settingsPath, undefined);
    const errs = evs(s.db, s.attempt.id, 'runner_error');
    assert.ok(errs.some((e) => /isolation settings not written/.test(e.error)), JSON.stringify(errs));
    assertSecurityShape(JSON.parse(s.attempt.security!));
    assert.equal(evs(s.db, s.attempt.id, 'worker_security').length, 1);
  } finally { s.db.close(); }
});

test('buildClaudeArgs adds --settings <path> only when a settings path is given', () => {
  const base = { prompt: 'do it', sessionId: 's1', model: 'sonnet' as const };
  const withSettings = buildClaudeArgs({ ...base, settingsPath: '/data/isolation/a1/settings.json' }, ['Read']);
  const i = withSettings.indexOf('--settings');
  assert.ok(i > 0);
  assert.equal(withSettings[i + 1], '/data/isolation/a1/settings.json');
  assert.ok(!buildClaudeArgs(base, ['Read']).includes('--settings'));
  // The rest of the argv is unchanged.
  assert.deepEqual(buildClaudeArgs(base, ['Read', 'Edit']),
    ['-p', 'do it', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', '--model', 'sonnet', '--session-id', 's1']);
  assert.deepEqual(buildClaudeArgs({ ...base, resumeSessionId: 'old' }, []).slice(-2), ['--resume', 'old']);
});

test('parseSecurity: null for empty, invalid JSON or the wrong shape', () => {
  for (const raw of [null, undefined, '', '{', '[]', '{"deniedAttempts":1}', '{"deniedAttempts":0,"networkCommands":0,"events":[{"tool":1}]}'])
    assert.equal(parseSecurity(raw), null, String(raw));
  const ok = { deniedAttempts: 1, networkCommands: 2, events: [{ tool: 'Bash', command: 'git push', reason: 'network: git push' }] };
  assert.deepEqual(parseSecurity(JSON.stringify(ok)), ok);
});

function http(port: number, path: string, cookie?: string) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}
