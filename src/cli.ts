#!/usr/bin/env node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, type DB } from './db.js';
import { LocalForge } from './forge.js';
import { ForgeRegistry, resolveLocalOrigin } from './forges.js';
import { CannedOrchestrator, ClaudeOrchestrator } from './orchestrator.js';
import { approvePlan } from './plan.js';
import { claimInstance, openBrowser, readRunning } from './instance.js';
import { PlanningService } from './planning.js';
import { RoadmapService } from './roadmap.js';
import { AutoPusher } from './autopush.js';
import { syncCheckout } from './sync.js';
import { addProject, configureProject, findProjectForPath } from './projects.js';
import { DEFAULT_GITHUB_CHECK, isForgeKind, type Project } from './types.js';
import { Runner } from './runner.js';
import { createTargetRepo, DEMO_PLAN, DEMO_SCENARIO } from './sandbox.js';
import { startServer } from './server.js';
import { resolveUpstream, runUpdater, systemRunner, UpdateService, workersBusy } from './update.js';
import { ClaudeCodeWorkerFactory, FakeWorkerFactory } from './workers.js';

const CONFIG_FLAGS = '[--ci "cmd"] [--workers N] [--forge-origin <bare>] [--forge local|github] [--repo owner/name] [--check name]';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const flag = (name: string, def?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = (name: string) => args.includes(`--${name}`);

async function demo() {
  const root = mkdtempSync(join(tmpdir(), 'local-demo-'));
  const { bare, checkout } = createTargetRepo(root);
  const db = openDb(join(root, 'local.db'));
  const forge = new LocalForge(bare, join(root, 'forge.db'));
  const project = addProject(db, checkout, { maxWorkers: 2, name: 'Demo App' });
  const runner = new Runner(db, forge, new FakeWorkerFactory(DEMO_SCENARIO), { worktreesDir: join(root, 'worktrees'), repairLimit: 2 });
  const planning = new PlanningService(db, new CannedOrchestrator(DEMO_PLAN));
  const server = has('serve') ? await startServer(db, runner, planning, { port: Number(flag('port', '4317')) }) : null;
  if (server) console.log('Dashboard: ' + server.url);

  const drafted = await planning.run(project, 'Add activity history with CSV export, and a rest timer.');
  if (drafted.kind !== 'drafted') throw new Error('demo planning failed: ' + JSON.stringify(drafted));
  console.log(drafted.reply);
  if (server) await sleep(Number(flag('approve-delay', '0')));
  approvePlan(db, drafted.planId);
  console.log('Owner approved plan v' + drafted.version + '\n');

  runner.recover();
  let maxConcurrent = 0, dupResult: string | null = null;
  const deadline = Date.now() + 120_000;
  for (;;) {
    await runner.tick();
    const running = (db.prepare("SELECT COUNT(*) n FROM attempts WHERE status IN ('claimed','running','exited')").get() as { n: number }).n;
    maxConcurrent = Math.max(maxConcurrent, running);
    // Simulate webhook redelivery of the first CI failure: must not create a second repair.
    if (!dupResult) {
      const r = db.prepare("SELECT check_id, task_id FROM repairs LIMIT 1").get() as { check_id: number; task_id: string } | undefined;
      if (r) {
        const t = runner.task(r.task_id);
        const check = forge.checksFor((db.prepare('SELECT head_sha FROM repairs WHERE check_id=?').get(r.check_id) as { head_sha: string }).head_sha).find((c) => c.id === r.check_id)!;
        dupResult = runner.handleCheck(t.id, check);
      }
    }
    const open = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('merged','blocked','cancelled')").get() as { n: number }).n;
    if (open === 0) { await runner.settle(); break; }
    if (Date.now() > deadline) { console.error('demo timed out'); break; }
    await sleep(150);
  }
  await forge.idle();

  const tasks = db.prepare('SELECT key, status, hold_reason, pr_number, head_sha, merge_sha, repair_count FROM tasks ORDER BY rowid').all() as any[];
  const attempts = db.prepare('SELECT t.key, a.kind, a.status, a.exit_code, a.base_sha, a.reason FROM attempts a JOIN tasks t ON t.id=a.task_id ORDER BY a.started_at, t.key').all() as any[];
  const prs = forge.allPrs().map((p) => ({ number: p.number, branch: p.branch, state: p.state, mergeSha: p.mergeSha }));
  const repairs = db.prepare('SELECT key FROM repairs').all() as { key: string }[];
  const checkLog = (db.prepare("SELECT data FROM events WHERE type IN ('check_completed','pr_published','branch_updated_from_base','pr_merged','task_merged','worktree_ready') ORDER BY seq").all() as { data: string }[]).length;
  const updated = db.prepare("SELECT t.key, e.data FROM events e JOIN tasks t ON t.id=e.task_id WHERE e.type='branch_updated_from_base'").all() as any[];
  const exportBase = db.prepare("SELECT e.data FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.key='history-export' AND e.type='worktree_ready'").get() as { data: string } | undefined;
  const historyMerge = tasks.find((t) => t.key === 'history-ui')?.merge_sha;

  const evidence = { root, project: project.id, maxWorkers: project.max_workers, maxConcurrentObserved: maxConcurrent, tasks, attempts, prs,
    repairs: repairs.map((r) => r.key), duplicateDeliveryResult: dupResult, branchUpdates: updated.map((u) => ({ task: u.key, ...JSON.parse(u.data) })),
    dependentStartedFrom: exportBase ? JSON.parse(exportBase.data).baseSha : null, historyUiMergeSha: historyMerge, evidenceEvents: checkLog };

  console.log('Tasks:');
  for (const t of tasks) console.log(`  ${t.key.padEnd(15)} ${t.status.padEnd(8)} PR ${t.pr_number ?? '-'}  merge ${t.merge_sha?.slice(0, 8) ?? '-'}  repairs ${t.repair_count}${t.hold_reason ? `  — ${t.hold_reason}` : ''}`);
  console.log('Attempts:');
  for (const a of attempts) console.log(`  ${a.key.padEnd(15)} ${a.kind.padEnd(8)} ${a.status.padEnd(10)} exit ${a.exit_code ?? '-'} base ${a.base_sha?.slice(0, 8)}${a.reason ? ' — ' + a.reason : ''}`);
  console.log(`PRs: ${prs.map((p) => `#${p.number} ${p.state}`).join(', ')}`);
  console.log(`Duplicate CI delivery → ${dupResult}; repairs recorded: ${repairs.length}`);
  console.log(`Branch updates after base advanced: ${updated.length ? updated.map((u) => u.key).join(', ') : 'none this run'}`);
  console.log(`history-export started from ${evidence.dependentStartedFrom?.slice(0, 8)} (history-ui merge ${historyMerge?.slice(0, 8)})`);
  console.log(`Max concurrent attempts: ${maxConcurrent} (limit ${project.max_workers})`);

  const ok = (k: string, s: string) => tasks.find((t) => t.key === k)?.status === s;
  const pass = ok('history-ui', 'merged') && ok('rest-timer', 'merged') && ok('history-export', 'merged') && ok('readme-badge', 'blocked')
    && dupResult === 'duplicate' && repairs.length === 1 && maxConcurrent <= project.max_workers
    && prs.length === 3 && evidence.dependentStartedFrom !== null;
  writeFileSync(join(root, 'evidence.json'), JSON.stringify({ pass, ...evidence }, null, 2));
  if (has('evidence')) writeFileSync(resolve(flag('evidence')!), JSON.stringify({ pass, ...evidence }, null, 2));
  console.log(`\n${pass ? 'PASS' : 'FAIL'} — evidence: ${join(root, 'evidence.json')}`);
  if (server) { console.log('Dashboard still running (Ctrl+C to exit).'); return; }
  db.close();
  process.exit(pass ? 0 : 1);
}

const dataDir = () => { const d = resolve(flag('data', join(homedir(), '.local-poc'))!); mkdirSync(d, { recursive: true }); return d; };
function appDb(): DB { return openDb(join(dataDir(), 'local.db')); }

function describe(p: Project) {
  let forge: string;
  if (p.forge_kind === 'github') forge = `github ${p.github_repo ?? '(no repo)'} (check: ${p.github_check || DEFAULT_GITHUB_CHECK})`;
  else try { forge = resolveLocalOrigin(p); } catch (e) { forge = `UNAVAILABLE — ${(e as Error).message}`; }
  return `${p.id.padEnd(16)} ${p.repo_path}\n${''.padEnd(16)} forge: ${forge}\n${''.padEnd(16)} ci: ${p.ci_command} · workers: ${p.max_workers}${p.paused ? ' · paused' : ''}`;
}

async function serve() {
  const dir = dataDir();
  const already = readRunning(dir);
  if (already) {
    console.log(`Vizor Local is already running (pid ${already.pid}). Opening it: ${already.url}`);
    if (has('open')) openBrowser(already.url);
    return;
  }
  const db = appDb();
  if (flag('forge-origin')) console.log('note: --forge-origin is no longer needed (each project uses its own origin); ignoring it.');
  const forges = new ForgeRegistry(db, dir);
  const workers = flag('worker', 'fake') === 'claude' ? new ClaudeCodeWorkerFactory() : new FakeWorkerFactory(DEMO_SCENARIO);
  const orch = flag('orchestrator', 'canned') === 'claude' ? new ClaudeOrchestrator() : new CannedOrchestrator(DEMO_PLAN);
  const runner = new Runner(db, forges.get, workers, { worktreesDir: join(dir, 'worktrees'),
    afterMerge: (pid) => { const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid) as unknown as Project | undefined; if (p) syncCheckout(db, p); } });
  runner.start(500);
  const planning = new PlanningService(db, orch);
  const roadmap = new RoadmapService(db, planning);
  setInterval(() => { try { roadmap.tick(); } catch (e) { console.error('roadmap:', (e as Error).message); } }, 2000);
  const autoPush = new AutoPusher(db);
  setInterval(() => { try { autoPush.tick(); } catch (e) { console.error('auto-push:', (e as Error).message); } }, 15000);
  const workerRunning = () => workersBusy(db, runner);
  let s: Awaited<ReturnType<typeof startServer>> | undefined;
  const update = new UpdateService({ db, dataDir: dir, dbPath: join(dir, 'local.db'), upstream: resolveUpstream(flag('update-upstream')), workerRunning,
    exit: () => {
      console.log('Updating Vizor Local: this window closes and the updated version starts in a new one.');
      runner.stop();
      void (s?.close() ?? Promise.resolve()).finally(() => { db.close(); process.exit(0); });
    } });
  s = await startServer(db, runner, planning, { port: Number(flag('port', '4317')), originsDir: join(dir, 'origins'), roadmap, update, forges });
  claimInstance(dir, s.url);
  update.start();
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as Project[];
  console.log(`Vizor Local (worker: ${workers.name}, planner: ${flag('orchestrator', 'canned')})`);
  for (const p of projects) console.log('  ' + describe(p).replace(/\n/g, '\n  '));
  console.log(`\nOpen: ${s.url}\n(the link contains this launch's key; keep this window open, Ctrl+C to stop)`);
  if (has('open')) openBrowser(s.url);
}

async function main() {
  const cmd = args[0];
  if (cmd === 'demo') return demo();
  if (cmd === 'serve') return serve();
  if (cmd === 'run-updater') {
    // Started detached by the server. SHAs come only from the journal in --data, never from arguments.
    const root = flag('root');
    if (!root) throw new Error('usage: run-updater --data <dir> --root <installRoot>');
    const j = await runUpdater({ dataDir: dataDir(), root: resolve(root), run: systemRunner });
    console.log(`[${new Date().toISOString()}] updater finished: ${j ? `${j.kind} ${j.status}${j.error ? ' — ' + j.error : ''}` : 'no pending update'}`);
    return;
  }
  if (cmd === 'add') {
    if (!args[1] || args[1].startsWith('--')) throw new Error('usage: add <checkout> [--name N] [--workers N] [--ci "cmd"] [--base main] [--create-origin]');
    const p = addProject(appDb(), args[1], { maxWorkers: Number(flag('workers', '1')), ciCommand: flag('ci'), name: flag('name'),
      baseBranch: flag('base'), createOrigin: has('create-origin'), originsDir: join(dataDir(), 'origins') });
    return console.log('added ' + describe(p));
  }
  if (cmd === 'config') {
    if (!args[1] || args[1].startsWith('--')) throw new Error(`usage: config <project-id> ${CONFIG_FLAGS}`);
    const forge = flag('forge');
    if (forge !== undefined && !isForgeKind(forge)) throw new Error('--forge must be local or github');
    const p = configureProject(appDb(), args[1], { ciCommand: flag('ci'), maxWorkers: flag('workers') ? Number(flag('workers')) : undefined, forgeOrigin: flag('forge-origin'),
      forgeKind: forge, githubRepo: flag('repo'), githubCheck: flag('check') });
    return console.log(describe(p));
  }
  if (cmd === 'projects') {
    const ps = appDb().prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as Project[];
    return console.log(ps.length ? ps.map(describe).join('\n') : 'no projects yet — run: add <checkout>');
  }
  if (cmd === 'open' || cmd === '.' || (cmd && !cmd.startsWith('-'))) {
    const target = cmd === 'open' ? (args[1] ?? '.') : cmd;
    const r = findProjectForPath(appDb(), resolve(target));
    if ('setupNeeded' in r) { console.error(`No project bound to ${r.setupNeeded}. Run: vizor-local add "${r.setupNeeded}"`); process.exit(2); }
    return console.log(`Project ${r.id} — open http://127.0.0.1:${flag('port', '4317')}/#${r.id}`);
  }
  console.log(`vizor-local (PoC)
  demo [--serve] [--port N]       scripted end-to-end run against a disposable repo
  serve [--worker fake|claude] [--orchestrator canned|claude] [--port N] [--open] [--update-upstream <url>]
                                  --update-upstream (or VIZOR_UPDATE_UPSTREAM) changes where updates come from
  add <checkout> [--name N] [--workers N] [--ci "cmd"] [--base main] [--create-origin]
                                  bind a checkout; --create-origin makes a local forge origin (and git init if needed)
  config <project> ${CONFIG_FLAGS}
                                  --forge github --repo owner/name [--check ci] merges through GitHub (needs gh auth login);
                                  --forge local switches back to the local bare-repo forge
  projects                        list projects, their forge and CI command
  open [path] | .                 find the project for a checkout
  (all commands accept --data <dir>; default ~/.local-poc)`);
}

main().catch((e) => { console.error('error:', e.message ?? e); process.exit(1); });
