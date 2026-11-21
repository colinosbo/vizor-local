// Step 3: folder sync after merge, roadmap phases, push to GitHub (fast-forward only), single instance.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { ForgeRegistry } from '../src/forges.js';
import { git, revParse } from '../src/git.js';
import { claimInstance, readRunning } from '../src/instance.js';
import type { Orchestrator } from '../src/orchestrator.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { addProject } from '../src/projects.js';
import { parseRoadmap, RoadmapService } from '../src/roadmap.js';
import { Runner } from '../src/runner.js';
import { createTargetRepo, DEMO_PLAN, DEMO_SCENARIO } from '../src/sandbox.js';
import { pushToGithub, setGithubRemote, shipStatus } from '../src/ship.js';
import { syncCheckout } from '../src/sync.js';
import type { Project } from '../src/types.js';
import { FakeWorkerFactory } from '../src/workers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-s3-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const proj = (db: DB, id: string) => db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
const types = (db: DB) => eventsAfter(db, 0, {}, 10_000).map((e) => e.type);

/** Commit a file straight to the bare origin (as if a merge landed there). */
function landOnOrigin(root: string, bare: string, file: string, body: string) {
  const c = join(root, 'pusher-' + Math.random().toString(36).slice(2));
  git(root, ['clone', '--quiet', bare, c]);
  mkdirSync(join(c, file, '..'), { recursive: true });
  writeFileSync(join(c, file), body);
  git(c, ['add', '-A']); git(c, ['commit', '--quiet', '-m', 'land ' + file]); git(c, ['push', '--quiet', 'origin', 'main']);
}

test('folder sync: fast-forwards a clean folder, never touches uncommitted work, other branches or local commits', () => {
  const root = tmp(), db = openDb(':memory:');
  const { bare, checkout } = createTargetRepo(root);
  const p = addProject(db, checkout, { name: 'demo' });
  assert.deepEqual(syncCheckout(db, p), { synced: false, reason: 'already up to date' });

  landOnOrigin(root, bare, 'src/a.js', 'a\n');
  const r = syncCheckout(db, p);
  assert.equal(r.synced, true);
  assert.ok(existsSync(join(checkout, 'src/a.js')));

  landOnOrigin(root, bare, 'src/b.js', 'b\n');
  writeFileSync(join(checkout, 'README.md'), '# my edit\n');
  assert.match((syncCheckout(db, p) as { reason: string }).reason, /uncommitted changes/);
  assert.ok(!existsSync(join(checkout, 'src/b.js')));
  git(checkout, ['checkout', '--quiet', '--', 'README.md']);

  git(checkout, ['checkout', '--quiet', '-b', 'mine']);
  assert.match((syncCheckout(db, p) as { reason: string }).reason, /on branch mine/);
  git(checkout, ['checkout', '--quiet', 'main']);

  writeFileSync(join(checkout, 'local.txt'), 'x'); git(checkout, ['add', '-A']); git(checkout, ['commit', '--quiet', '-m', 'local']);
  assert.match((syncCheckout(db, p) as { reason: string }).reason, /commits that are not in the origin/);
  assert.ok(types(db).includes('folder_synced') && types(db).includes('folder_sync_skipped'));
});

test('after a merge the runner updates the owner folder', async () => {
  const root = tmp(), db = openDb(join(root, 'l.db'));
  const { checkout } = createTargetRepo(root);
  const p = addProject(db, checkout, { name: 'demo' });
  approvePlan(db, draftPlan(db, p.id, { summary: '', tasks: [DEMO_PLAN.tasks[0]] }).planId);
  const forges = new ForgeRegistry(db, join(root, 'data'));
  const r = new Runner(db, forges.get, new FakeWorkerFactory({ 'history-ui': [{ ...DEMO_SCENARIO['history-ui'][0], sleepMs: 10 }] }),
    { worktreesDir: join(root, 'wt'), afterMerge: (pid) => syncCheckout(db, proj(db, pid)) });
  for (let i = 0; i < 200 && r.task('demo-v1-history-ui').status !== 'merged'; i++) { await r.tick(); await sleep(50); }
  await r.settle(); await forges.idle();
  assert.equal(r.task('demo-v1-history-ui').status, 'merged');
  assert.ok(existsSync(join(checkout, 'src/history/history.js')), 'merged file is in the owner folder without a manual pull');
  forges.close();
});

test('roadmap text parsing', () => {
  const ph = parseRoadmap('Phase 1: Model\nbuild it\n---\n\n## Phase 2: UI\nscreens\n---\n   \n');
  assert.deepEqual(ph.map((x) => x.title), ['Phase 1: Model', 'Phase 2: UI']);
  assert.match(ph[1].prompt, /screens/);
  assert.deepEqual(parseRoadmap('  '), []);
});

test('roadmap: drafts phase 1, waits for approval and merge, then drafts phase 2; failures stop it until retried', async () => {
  const root = tmp(), db = openDb(join(root, 'l.db'));
  const { checkout } = createTargetRepo(root);
  const p = addProject(db, checkout, { name: 'demo', maxWorkers: 2 });
  let fail = false;
  const orch: Orchestrator = { async draft(_p, req) {
    if (fail) throw new Error('planner down');
    const t = req.includes('phase 1 of') ? DEMO_PLAN.tasks[0] : DEMO_PLAN.tasks[1];
    return { reply: 'ok', plan: { summary: req.split('\n')[0], tasks: [t] } };
  } };
  const planning = new PlanningService(db, orch);
  const rm = new RoadmapService(db, planning);
  rm.add(p.id, 'Model\nhistory model\n---\nTimer\nrest timer\n---\nThird\nlater');
  const forges = new ForgeRegistry(db, join(root, 'data'));
  const scen = { 'history-ui': [{ ...DEMO_SCENARIO['history-ui'][0], sleepMs: 10 }], 'rest-timer': [DEMO_SCENARIO['rest-timer'][1] && { ...DEMO_SCENARIO['rest-timer'][0], files: { ...DEMO_SCENARIO['rest-timer'][0].files, 'src/timer/timer.js': DEMO_SCENARIO['rest-timer'][1].files['src/timer/timer.js']! } }] };
  const r = new Runner(db, forges.get, new FakeWorkerFactory(scen), { worktreesDir: join(root, 'wt') });
  const status = () => rm.phases(p.id).map((x) => x.status).join(',');
  const until = async (cond: () => boolean, label: string) => {
    for (let i = 0; i < 300 && !cond(); i++) { rm.tick(); await r.tick(); await planning.idle(); await sleep(40); }
    assert.ok(cond(), `timed out waiting for ${label}; phases=${status()}`);
  };

  await until(() => status().startsWith('review'), 'phase 1 drafted');
  assert.equal(status(), 'review,queued,queued');
  for (let i = 0; i < 5; i++) { rm.tick(); await r.tick(); }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks").get()!.n, 0, 'nothing runs before the owner approves');
  approvePlan(db, rm.phases(p.id)[0].plan_id!);
  await until(() => status().startsWith('done,review'), 'phase 1 merged and phase 2 drafted');
  assert.match(rm.phases(p.id)[1].prompt, /rest timer/);
  const planText = (db.prepare('SELECT body FROM plans WHERE id=?').get(rm.phases(p.id)[1].plan_id!) as { body: string }).body;
  assert.match(planText, /Roadmap phase 2 of 3: Timer/);
  approvePlan(db, rm.phases(p.id)[1].plan_id!);
  fail = true;
  await until(() => status() === 'done,done,failed', 'phase 3 failed');
  assert.match(rm.phases(p.id)[2].error!, /planner down/);
  for (let i = 0; i < 5; i++) rm.tick();
  assert.equal(status(), 'done,done,failed', 'a failure stops the roadmap');
  fail = false;
  rm.retry(rm.phases(p.id)[2].id);
  await until(() => status() === 'done,done,review', 'phase 3 retried');
  await r.settle(); await forges.idle(); forges.close();
});

test('roadmap pause, remove, and a restart during drafting re-queues the phase', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const planning = new PlanningService(db, { draft: () => new Promise(() => {}) });
  let rm = new RoadmapService(db, planning);
  rm.add('p', 'A\na\n---\nB\nb');
  rm.pause('p', true); rm.tick();
  assert.deepEqual(rm.phases('p').map((x) => x.status), ['queued', 'queued']);
  rm.pause('p', false); rm.tick();
  assert.deepEqual(rm.phases('p').map((x) => x.status), ['drafting', 'queued']);
  assert.throws(() => rm.remove(rm.phases('p')[0].id), /queued or failed/);
  rm.remove(rm.phases('p')[1].id);
  rm = new RoadmapService(db, new PlanningService(db, { draft: () => new Promise(() => {}) })); // restart
  assert.deepEqual(rm.phases('p').map((x) => x.status), ['queued']);
});

test('push to GitHub: shows what is ahead, pushes the reviewed SHA fast-forward only, refuses when GitHub moved', async () => {
  const root = tmp(), db = openDb(':memory:');
  const { bare, checkout } = createTargetRepo(root);
  const p = addProject(db, checkout, { name: 'demo' });
  const github = join(root, 'github.git');
  git(root, ['clone', '--quiet', '--bare', bare, github]);
  await assert.rejects(setGithubRemote(db, p, 'https://evil.example/x.git'), /GitHub repo URL/);
  git(checkout, ['remote', 'add', 'github', github]); // tests use a local bare repo standing in for GitHub

  let s = await shipStatus(p);
  assert.equal(s.aheadCount, 0); assert.equal(s.canPush, false);
  landOnOrigin(root, bare, 'src/a.js', 'a\n');
  landOnOrigin(root, bare, 'src/b.js', 'b\n');
  s = await shipStatus(p);
  assert.equal(s.aheadCount, 2); assert.equal(s.behind, 0); assert.equal(s.canPush, true);
  assert.deepEqual(s.ahead.map((c) => c.subject), ['land src/b.js', 'land src/a.js']);

  await assert.rejects(pushToGithub(db, p, 'deadbeef'), /changed since you reviewed/);
  const r = await pushToGithub(db, p, s.local!);
  assert.equal(r.pushed, 2);
  assert.equal(revParse(github, 'refs/heads/main'), s.local);
  await assert.rejects(pushToGithub(db, p, s.local!), /nothing to push/);

  landOnOrigin(root, github, 'README.md', '# edited on github\n'); // someone changed GitHub
  landOnOrigin(root, bare, 'src/c.js', 'c\n');
  s = await shipStatus(p);
  assert.equal(s.behind, 1); assert.equal(s.canPush, false);
  await assert.rejects(pushToGithub(db, p, s.local!), /GitHub has 1 commit/);
  assert.notEqual(revParse(github, 'refs/heads/main'), s.local, 'GitHub was not overwritten');
});

test('single instance: a second launch finds the running server', () => {
  const dir = tmp();
  assert.equal(readRunning(dir), null);
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid: 999999, url: 'http://x' }));
  assert.equal(readRunning(dir), null, 'stale file from a dead process is ignored');
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid: process.ppid, url: 'http://127.0.0.1:4317/?t=k' }));
  assert.equal(readRunning(dir)?.url, 'http://127.0.0.1:4317/?t=k');
  claimInstance(dir, 'http://mine');
  assert.equal(readRunning(dir), null, 'our own file does not count as another instance');
});
