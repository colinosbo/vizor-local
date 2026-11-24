// GitHub forge wiring: additive migration, `config --forge github`, the forge registry, per-project
// isolation of a gh auth failure in /api/state and the runner, the merge gate on the exact head SHA,
// and the worker environment never carrying GH_* / GITHUB_* variables.
import assert from 'node:assert/strict';
import { execFileSync, type SpawnOptions } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { LocalForge } from '../src/forge.js';
import { ForgeRegistry, GH_AUTH_PROBLEM } from '../src/forges.js';
import { createChecksFor } from '../src/github/checks.js';
import { GitHubForge } from '../src/github/forge.js';
import type { GhCall } from '../src/github/gh.js';
import { evaluateMerge } from '../src/merge.js';
import { CannedOrchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { addProject, configureProject } from '../src/projects.js';
import { Runner } from '../src/runner.js';
import { DEMO_PLAN } from '../src/sandbox.js';
import { startServer } from '../src/server.js';
import { taskMarker, type ForgeStatus, type PlanBody, type Project, type TaskRow } from '../src/types.js';
import type { VersionInfo } from '../src/version.js';
import { ClaudeCodeWorkerFactory, FakeWorkerFactory, type WorkerEvent } from '../src/workers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'vizor-gh-int-'));
const VERSION: VersionInfo = { version: '0.0.0-test', sha: null, date: null, label: 'test' };

/** A fake `gh` as a .js script (createGh/ghAuthStatus run .js bins through node). Logs every call. */
function fakeGh(dir: string, authExit: 0 | 1): { bin: string; calls: () => string[] } {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `gh-auth-${authExit}.js`);
  const log = join(dir, `gh-auth-${authExit}.log`);
  writeFileSync(bin, [
    "const { appendFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] === 'auth') {",
    `  if (${authExit} !== 0) { process.stderr.write('You are not logged into any GitHub hosts. Run gh auth login to authenticate.\\n'); process.exit(${authExit}); }`,
    '  process.exit(0);',
    '}',
    "process.stdout.write('{}');",
  ].join('\n'));
  // The scripts are CommonJS; keep them out of the package's "type": "module".
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

const proj = (db: DB, id: string) => db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
const tasksOf = (db: DB, projectId: string) => db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY rowid').all(projectId) as unknown as TaskRow[];
const plan = (key: string, scope: string[]): PlanBody => ({ summary: '', tasks: [{ key, title: key, prompt: 'do ' + key, acceptance: 'works', writeScope: scope, deps: [] }] });

/** Two real local projects (bare-repo origins) in one db; `gh` is reconfigured to the GitHub forge. */
function twoProjects() {
  const dir = tmp();
  const db = openDb(join(dir, 'local.db'));
  const origins = join(dir, 'origins');
  const local = addProject(db, join(dir, 'local-app'), { name: 'local-app', createFolder: true, createOrigin: true, originsDir: origins });
  const gh = addProject(db, join(dir, 'gh-app'), { name: 'gh-app', createFolder: true, createOrigin: true, originsDir: origins });
  configureProject(db, gh.id, { forgeKind: 'github', githubRepo: 'octo/app' });
  return { dir, db, local: proj(db, local.id), gh: proj(db, gh.id) };
}

// ---------- migration ----------
test('migration adds forge_kind, github_repo and github_check to an existing projects table; old rows stay local', () => {
  const dir = tmp();
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE,
    base_branch TEXT NOT NULL DEFAULT 'main', max_workers INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  old.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('old','old','/repo/old')").run();
  old.close();

  const db = openDb(path);
  const cols = new Map((db.prepare('PRAGMA table_info(projects)').all() as { name: string; type: string; notnull: number; dflt_value: string | null }[])
    .map((c) => [c.name, { type: c.type, notnull: c.notnull, dflt: c.dflt_value }]));
  assert.deepEqual(cols.get('forge_kind'), { type: 'TEXT', notnull: 1, dflt: "'local'" });
  assert.deepEqual(cols.get('github_repo'), { type: 'TEXT', notnull: 0, dflt: null });
  assert.deepEqual(cols.get('github_check'), { type: 'TEXT', notnull: 1, dflt: "'ci'" });
  const p = proj(db, 'old');
  assert.deepEqual({ kind: p.forge_kind, repo: p.github_repo, check: p.github_check }, { kind: 'local', repo: null, check: 'ci' });
  db.close();
  // Re-opening is a no-op (additive, idempotent).
  openDb(path).close();
});

// ---------- configureProject + CLI ----------
test('configureProject validates repo, needs a repo for github, persists, and switches back to local', () => {
  const { db, local } = twoProjects();
  assert.throws(() => configureProject(db, local.id, { forgeKind: 'github' }), /needs a repo/);
  for (const bad of ['octo', 'octo/app/x', 'octo/ap p', '../x', 'https://github.com/octo/app'])
    assert.throws(() => configureProject(db, local.id, { forgeKind: 'github', githubRepo: bad }), /owner\/name/, bad);
  assert.throws(() => configureProject(db, local.id, { forgeKind: 'gitlab' as never, githubRepo: 'a/b' }), /forge must be/);
  assert.throws(() => configureProject(db, local.id, { forgeKind: 'github', githubRepo: 'a/b', githubCheck: ' ' }), /check/);
  assert.equal(proj(db, local.id).forge_kind, 'local', 'refused updates write nothing');

  const p = configureProject(db, local.id, { forgeKind: 'github', githubRepo: 'Octo-Org/my.app_1', githubCheck: 'build' });
  assert.deepEqual([p.forge_kind, p.github_repo, p.github_check], ['github', 'Octo-Org/my.app_1', 'build']);
  // The stored repo satisfies a later --forge github without --repo.
  configureProject(db, local.id, { forgeKind: 'local' });
  assert.equal(proj(db, local.id).forge_kind, 'local');
  assert.deepEqual([proj(db, local.id).forge_kind, proj(db, local.id).github_repo], ['local', 'Octo-Org/my.app_1']);
  configureProject(db, local.id, { forgeKind: 'github' });
  assert.equal(proj(db, local.id).forge_kind, 'github');
});

test('CLI: config --forge github --repo validates and persists; projects lists the github forge', () => {
  const data = tmp();
  const db = openDb(join(data, 'local.db'));
  const p = addProject(db, join(data, 'app'), { name: 'app', createFolder: true, createOrigin: true, originsDir: join(data, 'origins') });
  db.close();
  const cli = (...a: string[]) => execFileSync(process.execPath, [CLI, ...a, '--data', data], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const fails = (a: string[], re: RegExp) => assert.throws(() => cli(...a), (e: { stderr?: string }) => re.test(String(e.stderr)), a.join(' '));

  fails(['config', p.id, '--forge', 'github'], /needs a repo/);
  fails(['config', p.id, '--forge', 'github', '--repo', 'not a repo'], /owner\/name/);
  fails(['config', p.id, '--forge', 'svn', '--repo', 'a/b'], /--forge must be local or github/);
  const out = cli('config', p.id, '--forge', 'github', '--repo', 'octo/app', '--check', 'ci');
  assert.match(out, /forge: github octo\/app \(check: ci\)/);
  assert.match(cli('projects'), /forge: github octo\/app \(check: ci\)/);
  const check = openDb(join(data, 'local.db'));
  assert.deepEqual([proj(check, p.id).forge_kind, proj(check, p.id).github_repo, proj(check, p.id).github_check], ['github', 'octo/app', 'ci']);
  check.close();

  assert.doesNotMatch(cli('config', p.id, '--forge', 'local'), /forge: github/);
  assert.match(cli(), /--forge local\|github/, 'usage text documents the flags');
});

// ---------- registry ----------
test('registry: GitHubForge for a github project, LocalForge for a local one; rebuilt when github settings change', () => {
  const { dir, db, local, gh } = twoProjects();
  const okGh = fakeGh(join(dir, 'ok'), 0);
  const reg = new ForgeRegistry(db, join(dir, 'data'), { gh: { bin: okGh.bin } });

  const g1 = reg.get(gh.id);
  assert.ok(g1 instanceof GitHubForge);
  assert.ok(reg.get(local.id) instanceof LocalForge);
  assert.equal(reg.get(gh.id), g1, 'cached');
  assert.deepEqual(reg.forgeStatus(gh.id), { kind: 'github', repo: 'octo/app', check: 'ci', ready: true, problem: null });
  assert.deepEqual(reg.forgeStatus(local.id), { kind: 'local', repo: null, check: 'ci', ready: true, problem: null });

  configureProject(db, gh.id, { githubCheck: 'build' });
  const g2 = reg.get(gh.id);
  assert.ok(g2 instanceof GitHubForge && g2 !== g1, 'check change rebuilds');
  configureProject(db, gh.id, { githubRepo: 'octo/other' });
  const g3 = reg.get(gh.id);
  assert.ok(g3 !== g2, 'repo change rebuilds');
  configureProject(db, gh.id, { forgeKind: 'local' });
  assert.ok(reg.get(gh.id) instanceof LocalForge, 'kind change rebuilds');

  // gh auth status ran once for all of the above: it is cached per registry.
  assert.equal(okGh.calls().filter((c) => c === 'auth status').length, 1);
  reg.close();
});

test('registry: a local project with a remote-URL origin is still refused', () => {
  const { dir, db, local } = twoProjects();
  db.prepare('UPDATE projects SET forge_origin=? WHERE id=?').run('https://github.com/octo/app.git', local.id);
  const reg = new ForgeRegistry(db, join(dir, 'data'));
  assert.throws(() => reg.get(local.id), /remote URL/);
  const s = reg.forgeStatus(local.id);
  assert.equal(s.ready, false);
  assert.match(s.problem ?? '', /remote URL/);
  assert.deepEqual(reg.forgeStatus('nope'), { kind: 'local', repo: null, check: 'ci', ready: false, problem: 'unknown project nope' });
});

// ---------- isolation of a gh auth failure ----------
function getState(port: number, token: string): Promise<{ projects: (Record<string, unknown> & { id: string; forge: ForgeStatus })[] }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `127.0.0.1:${port}`, cookie: `local_token_${port}=${token}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GET /api/state ${res.statusCode}: ${body.slice(0, 300)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('gh auth failure: github project is ready:false in /api/state, the local project stays ready and keeps getting work', { timeout: 60_000 }, async () => {
  const { dir, db, local, gh } = twoProjects();
  const failGh = fakeGh(join(dir, 'fail'), 1);
  const forges = new ForgeRegistry(db, join(dir, 'data'), { gh: { bin: failGh.bin } });
  assert.throws(() => forges.get(gh.id), { message: GH_AUTH_PROBLEM });
  assert.ok(forges.get(local.id) instanceof LocalForge, 'the same registry still serves the local project');

  // One approved task in each project.
  approvePlan(db, draftPlan(db, local.id, plan('l', ['src/l/**'])).planId);
  approvePlan(db, draftPlan(db, gh.id, plan('g', ['src/g/**'])).planId);
  const runner = new Runner(db, forges.get, new FakeWorkerFactory({}), { worktreesDir: join(dir, 'worktrees') });
  runner.promote();
  runner.claim();
  const [lt] = tasksOf(db, local.id);
  const [gt] = tasksOf(db, gh.id);
  assert.equal(lt.status, 'running', 'local task claimed despite the github project failing');
  assert.equal(gt.status, 'ready', 'github task gets no new work');
  assert.equal(gt.hold_reason, GH_AUTH_PROBLEM);

  const token = 'tok-' + Date.now();
  const planning = new PlanningService(db, new CannedOrchestrator(DEMO_PLAN));
  const srv = await startServer(db, runner, planning, { port: 0, token, version: VERSION, forges });
  try {
    const state = await getState(srv.port, token);
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    assert.deepEqual(byId.get(gh.id)?.forge, { kind: 'github', repo: 'octo/app', check: 'ci', ready: false, problem: GH_AUTH_PROBLEM });
    assert.deepEqual(byId.get(local.id)?.forge, { kind: 'local', repo: null, check: 'ci', ready: true, problem: null });
    assert.equal(tasksOf(db, local.id)[0].status, 'running', 'local task unaffected');
    // Nothing token-shaped leaks into the state payload.
    assert.doesNotMatch(JSON.stringify(state), /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/);
  } finally {
    await srv.close();
    forges.close();
  }
});

// ---------- merge gate on the exact head SHA ----------
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface Run { name: string; sha: string; conclusion: string | null; status?: string; slug?: string }

/** A GitHub project with task `a` waiting on CI for PR #1 at HEAD, behind a stub `gh api`. */
function githubTask(runs: Run[]) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path, max_workers, forge_kind, github_repo) VALUES ('p','p','/repo/p',6,'github','octo/app')").run();
  approvePlan(db, draftPlan(db, 'p', plan('a', ['src/a/**'])).planId);
  const t = tasksOf(db, 'p')[0];
  db.prepare("UPDATE tasks SET status='waiting_ci', pr_number=1, head_sha=? WHERE id=?").run(HEAD, t.id);
  const merges: unknown[] = [];
  const gh: GhCall = (method, path, body) => {
    if (method === 'PUT' && path === '/repos/octo/app/pulls/1/merge') { merges.push(body); return { sha: 'c'.repeat(40) }; }
    if (method !== 'GET') throw new Error(`unexpected ${method} ${path}`);
    if (path === '/repos/octo/app/pulls/1') return { number: 1, state: 'open', title: 'a', body: taskMarker(t.id), merged_at: null, merge_commit_sha: null, head: { ref: t.branch, sha: HEAD }, base: { ref: 'main' } };
    if (path.startsWith('/repos/octo/app/pulls/1/files')) return [{ filename: 'src/a/x.js', status: 'modified' }];
    if (path.startsWith(`/repos/octo/app/compare/`)) return { behind_by: 0 };
    const m = /^\/repos\/octo\/app\/commits\/([0-9a-f]{40})\/check-runs/.exec(path);
    if (m) {
      const mine = runs.filter((r) => r.sha === m[1]);
      return { total_count: mine.length, check_runs: mine.map((r, i) => ({ id: i + 1, name: r.name, head_sha: r.sha, status: r.status ?? 'completed', conclusion: r.conclusion, app: { slug: r.slug ?? 'github-actions' }, output: { title: r.name, summary: '' } })) };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  const forge = new GitHubForge({ repo: 'octo/app', repoPath: '/repo/p', gh, checksFor: createChecksFor({ repo: 'octo/app', checkName: 'ci', gh }) });
  const runner = new Runner(db, forge, new FakeWorkerFactory({}), { worktreesDir: tmp() });
  return { db, forge, runner, merges, task: () => runner.task(t.id), project: proj(db, 'p') };
}

test('merge gate: a trusted passing check on the exact head SHA merges (control)', () => {
  const s = githubTask([{ name: 'ci', sha: HEAD, conclusion: 'success' }]);
  assert.equal(evaluateMerge(s.db, s.forge, s.task(), s.project).eligible, true);
  s.runner.processChecks();
  assert.equal(s.merges.length, 1);
  assert.equal((s.merges[0] as { sha: string }).sha, HEAD, 'merge pinned to the exact head');
  assert.equal(s.task().status, 'merging');
});

const refusals: [string, Run[], string][] = [
  ['failing check', [{ name: 'ci', sha: HEAD, conclusion: 'failure' }], 'check_failed'],
  ['untrusted app posting the required check', [{ name: 'ci', sha: HEAD, conclusion: 'success', slug: 'evil-bot' }], 'untrusted_check'],
  ['trusted pass next to an impostor', [{ name: 'ci', sha: HEAD, conclusion: 'success' }, { name: 'ci', sha: HEAD, conclusion: 'success', slug: 'evil-bot' }], 'untrusted_check'],
  ['green check only on another SHA', [{ name: 'ci', sha: OTHER, conclusion: 'success' }], 'no_check'],
  ['only a differently named check', [{ name: 'lint', sha: HEAD, conclusion: 'success' }], 'no_check'],
  ['check still running', [{ name: 'ci', sha: HEAD, conclusion: null, status: 'in_progress' }], 'check_pending'],
];

for (const [name, runs, code] of refusals) {
  test(`merge gate: no merge with ${name}`, () => {
    const s = githubTask(runs);
    const d = evaluateMerge(s.db, s.forge, s.task(), s.project);
    assert.equal(d.eligible, false);
    assert.equal(d.holds[0]?.code, code);
    s.runner.processChecks();
    assert.deepEqual(s.merges, [], 'the runner never asked GitHub to merge');
    assert.notEqual(s.task().status, 'merging');
    assert.notEqual(s.task().status, 'merged');
  });
}

// ---------- worker environment ----------
test('worker env strips GH_* and GITHUB_* (GH_TOKEN, GITHUB_TOKEN never reach a worker)', { timeout: 30_000 }, async () => {
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN };
  process.env.GH_TOKEN = 'ghp_' + 'x'.repeat(36);
  process.env.GITHUB_TOKEN = 'ghs_' + 'y'.repeat(36);
  process.env.GH_ENTERPRISE_TOKEN = 'secret';
  // The factory passes claude's argv, which node itself would reject. Swap child_process.spawn (synced into
  // workers.ts's ESM import) for one that runs a real node probe with exactly the options the factory built.
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const realSpawn = cp.spawn;
  const spawned: string[] = [];
  const probe = "console.log('ENV:' + JSON.stringify({ seen: Object.keys(process.env).filter((k) => /^(GH_|GITHUB_)/i.test(k)), path: Boolean(process.env.PATH || process.env.Path) }))";
  (cp as { spawn: unknown }).spawn = (bin: string, _args: string[], opts: SpawnOptions) => {
    spawned.push(bin);
    return realSpawn(process.execPath, ['-e', probe], opts);
  };
  syncBuiltinESMExports();
  try {
    const factory = new ClaudeCodeWorkerFactory('claude-probe');
    const handle = factory.start({
      task: {} as TaskRow, attemptId: 'a1', attemptNumber: 1, kind: 'initial', worktree: tmp(), prompt: 'probe', sessionId: 's1', timeoutMs: 20_000,
    });
    assert.deepEqual(spawned, ['claude-probe'], 'the factory spawned through the intercepted spawn');
    const events: WorkerEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const result = await handle.done;
    const line = events.map((e) => e.text).find((t) => t.startsWith('ENV:'));
    assert.ok(line, `probe output missing (exit ${result.exitCode}): ${events.map((e) => e.text).join(' | ').slice(0, 500)}`);
    assert.deepEqual(JSON.parse(line.slice(4)), { seen: [], path: true });
  } finally {
    (cp as { spawn: unknown }).spawn = realSpawn;
    syncBuiltinESMExports();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
