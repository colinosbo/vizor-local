// addProject writes a default .gitignore built from the push guard denylist.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { addProject } from '../src/projects.js';
import { DENYLIST, DENYLIST_GITIGNORE } from '../src/push-guard.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'local-gi-'));

test('new projects get node_modules/ and every denylist entry', () => {
  const root = tmp(), db = openDb(':memory:');
  const folder = join(root, 'fresh');
  mkdirSync(folder);
  addProject(db, folder, { createOrigin: true, originsDir: join(root, 'o') });
  const text = readFileSync(join(folder, '.gitignore'), 'utf8');
  const lines = text.split('\n');
  for (const entry of ['node_modules/', '.env*', '*.pem', '*.key', '*.db', 'server.json', 'private/', '!.env.example']) {
    assert.ok(lines.includes(entry), `missing ${entry}`);
  }
  for (const entry of DENYLIST) assert.ok(lines.includes(entry), `missing denylist entry ${entry}`);
  assert.ok(text.startsWith('node_modules/\n' + DENYLIST_GITIGNORE), 'built from the shared DENYLIST_GITIGNORE');
});

test('an existing .gitignore is left untouched', () => {
  const root = tmp(), db = openDb(':memory:');
  const folder = join(root, 'has-ignore');
  mkdirSync(folder);
  writeFileSync(join(folder, '.gitignore'), 'custom/\n');
  addProject(db, folder, { createOrigin: true, originsDir: join(root, 'o') });
  assert.equal(readFileSync(join(folder, '.gitignore'), 'utf8'), 'custom/\n');
});
