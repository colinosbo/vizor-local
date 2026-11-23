// Roadmap queue editing: insert, move, edit, remove.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.js';
import { eventsAfter } from '../src/events.js';
import { PlanningService } from '../src/planning.js';
import { RoadmapService, type PhaseStatus } from '../src/roadmap.js';

function setup(titles: string[], statuses: PhaseStatus[] = []) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, name, repo_path) VALUES ('p','p','/r')").run();
  const planning = new PlanningService(db, { draft: () => new Promise(() => {}) });
  const rm = new RoadmapService(db, planning);
  rm.add('p', titles.map((t) => `${t}\nbody of ${t}`).join('\n---\n'));
  rm.phases('p').forEach((ph, i) => { if (statuses[i]) db.prepare('UPDATE phases SET status=? WHERE id=?').run(statuses[i], ph.id); });
  return { db, rm };
}
const titles = (rm: RoadmapService) => rm.phases('p').map((x) => x.title);
const positions = (rm: RoadmapService) => rm.phases('p').map((x) => x.position);
const idOf = (rm: RoadmapService, title: string) => rm.phases('p').find((x) => x.title === title)!.id;
const evs = (db: DB, type: string) => eventsAfter(db, 0, {}, 10_000).filter((e) => e.type === type);
const plan = (db: DB, status: string) => Number(db.prepare("INSERT INTO plans(project_id, version, status, body) VALUES ('p', (SELECT COALESCE(MAX(version),0)+1 FROM plans), ?, '{}')").run(status).lastInsertRowid);

test('insert: valid position, contiguous renumbering, event', () => {
  const { db, rm } = setup(['A', 'B', 'C']);
  rm.insert('p', 2, '  New  ', 'do it');
  assert.deepEqual(titles(rm), ['A', 'New', 'B', 'C']);
  assert.deepEqual(positions(rm), [1, 2, 3, 4]);
  rm.insert('p', 5, 'Last', 'x');
  assert.deepEqual(titles(rm), ['A', 'New', 'B', 'C', 'Last']);
  assert.equal(evs(db, 'roadmap_updated').filter((e) => JSON.stringify(e.data).includes('inserted')).length, 2);
  assert.throws(() => rm.insert('p', 0, 'x', 'x'), /position/);
  assert.throws(() => rm.insert('p', 7, 'x', 'x'), /position/);
});

test('insert: refused at or ahead of non-queued phases', () => {
  const { rm } = setup(['Done', 'Run', 'Q1'], ['done', 'running']);
  assert.throws(() => rm.insert('p', 1, 'x', 'x'), /already started/);
  assert.throws(() => rm.insert('p', 2, 'x', 'x'), /already started/);
  rm.insert('p', 3, 'Mid', 'x');
  assert.deepEqual(titles(rm), ['Done', 'Run', 'Mid', 'Q1']);
});

test('insert/edit validation and the 50-phase cap', () => {
  const { rm } = setup(['A']);
  assert.throws(() => rm.insert('p', 2, '   ', 'x'), /title/);
  assert.throws(() => rm.insert('p', 2, 'x'.repeat(121), 'x'), /120/);
  assert.throws(() => rm.insert('p', 2, 'x', 'y'.repeat(4001)), /4000/);
  rm.insert('p', 2, 'x'.repeat(120), 'y'.repeat(4000));
  for (let i = 0; i < 48; i++) rm.insert('p', 1 + 1, `n${i}`, 'x');
  assert.equal(rm.phases('p').length, 50);
  assert.throws(() => rm.insert('p', 1, 'over', 'x'), /at most 50/);
});

test('move: reorders queued phases only within the queued block', () => {
  const { db, rm } = setup(['Done', 'Q1', 'Q2', 'Q3'], ['done']);
  rm.move(idOf(rm, 'Q3'), 2);
  assert.deepEqual(titles(rm), ['Done', 'Q3', 'Q1', 'Q2']);
  assert.deepEqual(positions(rm), [1, 2, 3, 4]);
  rm.move(idOf(rm, 'Q3'), 4);
  assert.deepEqual(titles(rm), ['Done', 'Q1', 'Q2', 'Q3']);
  assert.throws(() => rm.move(idOf(rm, 'Q1'), 1), /position/, 'cannot move ahead of a non-queued phase');
  assert.throws(() => rm.move(idOf(rm, 'Q1'), 9), /position/);
  assert.throws(() => rm.move(idOf(rm, 'Done'), 2), /read-only/);
  assert.ok(evs(db, 'roadmap_updated').some((e) => JSON.stringify(e.data).includes('moved')));
  for (const s of ['running', 'drafting', 'review', 'failed'] as const) {
    db.prepare('UPDATE phases SET status=? WHERE id=?').run(s, idOf(rm, 'Done'));
    assert.throws(() => rm.move(idOf(rm, 'Done'), 4), /read-only/);
  }
});

test('edit: queued only, validated, partial updates keep the other field', () => {
  const { db, rm } = setup(['Run', 'Done', 'Q'], ['running', 'done']);
  const q = idOf(rm, 'Q');
  const r = rm.edit(q, { title: '  Renamed ' });
  assert.equal(r.title, 'Renamed');
  assert.match(r.prompt, /body of Q/);
  assert.equal(rm.edit(q, { prompt: 'new prompt' }).prompt, 'new prompt');
  assert.throws(() => rm.edit(q, { title: ' ' }), /title/);
  assert.throws(() => rm.edit(q, { title: 'x'.repeat(121) }), /120/);
  assert.throws(() => rm.edit(q, { prompt: 'x'.repeat(4001) }), /4000/);
  assert.throws(() => rm.edit(q, {}), /nothing to edit/);
  assert.throws(() => rm.edit(idOf(rm, 'Run'), { title: 'x' }), /running phase is read-only/);
  assert.throws(() => rm.edit(idOf(rm, 'Done'), { title: 'x' }), /done phase is read-only/);
  assert.ok(evs(db, 'roadmap_updated').some((e) => JSON.stringify(e.data).includes('edited')));
});

test('remove: queued and failed phases; positions stay contiguous', () => {
  const { rm } = setup(['A', 'B', 'C', 'D'], ['done', 'failed']);
  rm.remove(idOf(rm, 'B'));
  assert.deepEqual(titles(rm), ['A', 'C', 'D']);
  assert.deepEqual(positions(rm), [1, 2, 3]);
  rm.remove(idOf(rm, 'C'));
  assert.deepEqual(positions(rm), [1, 2]);
});

test('remove: a review phase supersedes its draft plan and emits plan_discarded', () => {
  const { db, rm } = setup(['A', 'B'], ['review']);
  const pid = plan(db, 'draft');
  const a = idOf(rm, 'A');
  db.prepare('UPDATE phases SET plan_id=? WHERE id=?').run(pid, a);
  rm.remove(a);
  assert.equal((db.prepare('SELECT status FROM plans WHERE id=?').get(pid) as { status: string }).status, 'superseded');
  assert.deepEqual(titles(rm), ['B']);
  assert.deepEqual(positions(rm), [1]);
  const ev = evs(db, 'plan_discarded');
  assert.equal(ev.length, 1);
  const data = typeof ev[0].data === 'string' ? JSON.parse(ev[0].data) : ev[0].data;
  assert.deepEqual(data, { planId: pid, phase: a });
});

test('remove: a review phase whose plan was just approved is refused and left intact', () => {
  const { db, rm } = setup(['A'], ['review']);
  const pid = plan(db, 'approved');
  const a = idOf(rm, 'A');
  db.prepare('UPDATE phases SET plan_id=? WHERE id=?').run(pid, a);
  assert.throws(() => rm.remove(a), /approved/);
  assert.equal(rm.phases('p').length, 1);
  assert.equal((db.prepare('SELECT status FROM plans WHERE id=?').get(pid) as { status: string }).status, 'approved');
});

test('remove: running, done and drafting phases are read-only', () => {
  const { rm } = setup(['R', 'D', 'G'], ['running', 'done', 'drafting']);
  assert.throws(() => rm.remove(idOf(rm, 'R')), /running phase is read-only/);
  assert.throws(() => rm.remove(idOf(rm, 'D')), /done phase is read-only/);
  assert.throws(() => rm.remove(idOf(rm, 'G')), /drafting phase is read-only/);
  assert.equal(rm.phases('p').length, 3);
});

test('the next tick drafts the new first queued phase', () => {
  const { rm } = setup(['A', 'B', 'C']);
  rm.insert('p', 1, 'First', 'first prompt');
  rm.tick();
  assert.deepEqual(rm.phases('p').map((x) => x.status), ['drafting', 'queued', 'queued', 'queued']);
  assert.equal(rm.phases('p')[0].title, 'First');
  const { rm: rm2 } = setup(['A', 'B', 'C']);
  rm2.move(idOf(rm2, 'C'), 1);
  rm2.tick();
  assert.equal(rm2.phases('p').find((x) => x.status === 'drafting')!.title, 'C');
});
