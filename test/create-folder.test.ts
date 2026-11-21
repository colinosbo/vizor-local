// addProject({ createFolder }): the "create a new empty project" flow.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { git, revParse } from '../src/git.js';
import { addProject } from '../src/projects.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-cf-'));

test('createFolder + createOrigin creates a nested folder, repo with a commit, and a registered project', () => {
  const root = tmp(), db = openDb(':memory:');
  const folder = join(root, 'a', 'b', 'fresh');
  assert.ok(!existsSync(folder));
  const p = addProject(db, folder, { createFolder: true, createOrigin: true, originsDir: join(root, 'origins') });
  assert.ok(existsSync(join(folder, '.git')));
  assert.ok(revParse(folder, 'refs/heads/main'), 'first commit exists');
  assert.ok(existsSync(join(root, 'origins', 'fresh.git')));
  assert.equal(git(folder, ['remote', 'get-url', 'origin']), join(root, 'origins', 'fresh.git'));
  assert.equal((db.prepare('SELECT COUNT(*) n FROM projects WHERE id=?').get(p.id) as { n: number }).n, 1);
});

test('without createFolder a missing path still throws', () => {
  const root = tmp(), db = openDb(':memory:');
  const folder = join(root, 'missing');
  assert.throws(() => addProject(db, folder, { createOrigin: true, originsDir: join(root, 'o') }), /does not exist/);
  assert.ok(!existsSync(folder));
});

test('createFolder without createOrigin throws and creates nothing', () => {
  const root = tmp(), db = openDb(':memory:');
  const folder = join(root, 'nope');
  assert.throws(() => addProject(db, folder, { createFolder: true }), /createFolder requires createOrigin/);
  assert.ok(!existsSync(folder));
});

test('existing folder with createFolder behaves as before', () => {
  const root = tmp(), db = openDb(':memory:');
  const folder = join(root, 'existing');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'hi\n');
  const p = addProject(db, folder, { createFolder: true, createOrigin: true, originsDir: join(root, 'o') });
  assert.ok(git(folder, ['ls-files']).includes('a.txt'));
  assert.ok(existsSync(join(root, 'o', 'existing.git')));
  assert.equal(p.name, 'existing');
  assert.throws(() => addProject(db, folder, { createFolder: true, createOrigin: true, originsDir: join(root, 'o') }), /already registered/);
});
