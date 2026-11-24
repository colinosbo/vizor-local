import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { approvePlan, draftPlan } from '../src/plan.js';
import { PlanningService } from '../src/planning.js';
import { RoadmapService, MAX_ACTIVE_ROADMAPS, lineageOf } from '../src/roadmap.js';

const plan = (key: string) => ({ summary: key, tasks: [{ key, title: key, prompt: 'p', acceptance: 'a', writeScope: [`src/${key}/**`], deps: [] }] });

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  let n = 0;
  const planning = new PlanningService(db, { draft: async () => ({ reply: 'ok', plan: plan(`t${++n}`) }) });
  const rm = new RoadmapService(db, planning);
  return { db, rm, planning };
}
const status = (db: DB, id: number) => (db.prepare('SELECT status FROM plans WHERE id=?').get(id) as { status: string }).status;
const step = async (rm: RoadmapService, planning: PlanningService) => { rm.tick(); await planning.idle(); rm.tick(); };

test('two roadmaps run side by side: each drafts and is approved without superseding the other', async () => {
  const { db, rm, planning } = setup();
  rm.add('p', 'Phase 1: Alpha\nbuild alpha', { newRoadmap: true });
  rm.add('p', 'Phase 1: Beta\nbuild beta', { newRoadmap: true, title: 'Second' });
  const [a, b] = rm.roadmaps('p');
  assert.equal(a.title, 'Alpha', 'title defaults to the first phase without its "Phase n:" prefix');
  assert.equal(b.title, 'Second');
  await step(rm, planning);
  await step(rm, planning);
  const pa = rm.phasesOf(a.id)[0], pb = rm.phasesOf(b.id)[0];
  assert.equal(pa.status, 'review');
  assert.equal(pb.status, 'review', 'the second roadmap drafts once the planner is free');
  approvePlan(db, pa.plan_id!);
  approvePlan(db, pb.plan_id!);
  assert.equal(status(db, pa.plan_id!), 'approved', 'approving roadmap B does not supersede roadmap A');
  assert.equal(status(db, pb.plan_id!), 'approved');
  rm.tick();
  assert.deepEqual([rm.phasesOf(a.id)[0].status, rm.phasesOf(b.id)[0].status], ['running', 'running']);
});

test('a chat plan and a roadmap plan do not supersede each other; chat plans still replace chat plans', () => {
  const { db, rm } = setup();
  rm.add('p', 'A\nbody');
  const r = rm.roadmaps('p')[0];
  const road = draftPlan(db, 'p', plan('road'), lineageOf(r.id)).planId;
  const chat1 = draftPlan(db, 'p', plan('c1')).planId;
  const chat2 = draftPlan(db, 'p', plan('c2')).planId;
  approvePlan(db, road);
  approvePlan(db, chat1);
  assert.equal(status(db, road), 'approved');
  approvePlan(db, chat2);
  assert.equal(status(db, chat1), 'superseded');
  assert.equal(status(db, road), 'approved');
});

test('a finished roadmap is marked done and never receives new phases', () => {
  const { db, rm } = setup();
  rm.add('p', 'A\nbody');
  const first = rm.roadmaps('p')[0];
  db.prepare("UPDATE phases SET status='done'").run();
  rm.tick();
  assert.equal(rm.roadmap(first.id)!.status, 'done');
  assert.ok(rm.roadmap(first.id)!.finished_at);
  rm.add('p', 'B\nbody');
  const all = rm.roadmaps('p');
  assert.equal(all.length, 2, 'adding after a finished roadmap starts a new one');
  assert.equal(rm.phasesOf(first.id).length, 1);
  assert.throws(() => rm.add('p', 'C\nbody', { roadmapId: first.id }), /done; start a new roadmap/);
  assert.throws(() => rm.insert('p', 2, 'X', 'y', first.id), /done; start a new roadmap/);
});

test('archive: refused while a phase is live, allowed once nothing is drafting, waiting or running', () => {
  const { db, rm } = setup();
  rm.add('p', 'A\nbody');
  const r = rm.roadmaps('p')[0];
  db.prepare("UPDATE phases SET status='running'").run();
  assert.throws(() => rm.archive(r.id), /is running/);
  db.prepare("UPDATE phases SET status='failed'").run();
  rm.archive(r.id);
  assert.equal(rm.roadmap(r.id)!.status, 'archived');
  rm.tick();
  assert.equal(rm.phasesOf(r.id)[0].status, 'failed', 'an archived roadmap does not advance');
});

test(`at most ${MAX_ACTIVE_ROADMAPS} active roadmaps per project`, () => {
  const { rm } = setup();
  for (let i = 0; i < MAX_ACTIVE_ROADMAPS; i++) rm.add('p', `R${i}\nbody`, { newRoadmap: true });
  assert.throws(() => rm.add('p', 'one more\nbody', { newRoadmap: true }), /at most 3 roadmaps/);
});

test('positions are per roadmap; insert and move stay inside their roadmap', () => {
  const { rm } = setup();
  rm.add('p', 'A1\na\n---\nA2\na', { newRoadmap: true });
  rm.add('p', 'B1\nb\n---\nB2\nb', { newRoadmap: true });
  const [a, b] = rm.roadmaps('p');
  rm.insert('p', 1, 'B0', 'b', b.id);
  assert.deepEqual(rm.phasesOf(b.id).map((x) => [x.position, x.title]), [[1, 'B0'], [2, 'B1'], [3, 'B2']]);
  assert.deepEqual(rm.phasesOf(a.id).map((x) => [x.position, x.title]), [[1, 'A1'], [2, 'A2']]);
  rm.move(rm.phasesOf(a.id)[1].id, 1);
  assert.deepEqual(rm.phasesOf(a.id).map((x) => x.title), ['A2', 'A1']);
  rm.remove(rm.phasesOf(b.id)[0].id);
  assert.deepEqual(rm.phasesOf(b.id).map((x) => x.position), [1, 2]);
});

test("a roadmap waits for its own and chat work, not for another roadmap's", async () => {
  const { db, rm, planning } = setup();
  rm.add('p', 'A\nbody', { newRoadmap: true });
  const a = rm.roadmaps('p')[0];
  const busy = draftPlan(db, 'p', plan('x'), lineageOf(a.id)).planId;
  approvePlan(db, busy); // a pending task in roadmap A's lineage
  rm.add('p', 'B\nbody', { newRoadmap: true });
  const b = rm.roadmaps('p')[1];
  db.prepare("UPDATE phases SET status='running', plan_id=? WHERE roadmap_id=?").run(busy, a.id);
  await step(rm, planning);
  assert.equal(rm.phasesOf(b.id)[0].status, 'review', "B drafts while A's task is pending");

  rm.add('p', 'C\nbody', { newRoadmap: true });
  const c = rm.roadmaps('p')[2];
  approvePlan(db, draftPlan(db, 'p', plan('chat')).planId); // pending chat work
  await step(rm, planning);
  assert.equal(rm.phasesOf(c.id)[0].status, 'queued', 'C waits for chat work');
});

test('migration: phases from an older build become one roadmap and their plans join its lineage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-mig-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, base_branch TEXT NOT NULL DEFAULT 'main', max_workers INTEGER NOT NULL DEFAULT 2, paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE plans (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, approved_at TEXT, UNIQUE (project_id, version));
    CREATE TABLE phases (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', plan_id INTEGER, error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r'), ('q','q','/r');
    INSERT INTO plans(project_id, version, status, body) VALUES ('p', 1, 'approved', '{}');
    INSERT INTO phases(project_id, position, title, prompt, status, plan_id) VALUES ('p', 1, 'Done one', 'x', 'done', 1);
    INSERT INTO phases(project_id, position, title, prompt, status) VALUES ('q', 1, 'Open one', 'x', 'queued');`);
  old.close();
  const db = openDb(path);
  const rms = db.prepare('SELECT project_id, status FROM roadmaps ORDER BY project_id').all() as { project_id: string; status: string }[];
  assert.deepEqual(rms.map((r) => [r.project_id, r.status]), [['p', 'done'], ['q', 'active']]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM phases WHERE roadmap_id IS NULL').get() as { n: number }).n, 0);
  assert.match((db.prepare('SELECT lineage FROM plans WHERE id=1').get() as { lineage: string }).lineage, /^roadmap:\d+$/);
  db.close();
});

test('discard: a chat draft can be thrown away; approved plans and roadmap review drafts cannot', async () => {
  const { discardPlan } = await import('../src/plan.js');
  const { db, rm } = setup();
  const d = draftPlan(db, 'p', plan('c')).planId;
  discardPlan(db, d);
  assert.equal(status(db, d), 'superseded');
  assert.throws(() => discardPlan(db, d), /only a draft/);
  rm.add('p', 'A\nbody');
  const r = rm.roadmaps('p')[0];
  const road = draftPlan(db, 'p', plan('r'), lineageOf(r.id)).planId;
  db.prepare("UPDATE phases SET status='review', plan_id=? WHERE roadmap_id=?").run(road, r.id);
  assert.throws(() => discardPlan(db, road), /remove that phase/);
});
