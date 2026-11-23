// Phase 9: the launcher installs with npm ci (lockfile only, never rewritten), so the install folder stays clean for updates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const raw = fs.readFileSync(path.join(process.cwd(), 'Start Vizor Local.cmd'), 'utf8');
const commands = raw.split(/\r?\n/).filter((l) => !/^\s*(rem\b|::)/i.test(l) && !/^\s*echo\b/i.test(l));

test('the launcher installs dependencies with npm ci, never npm install', () => {
  assert.ok(commands.some((l) => /^\s*call npm ci \|\| goto fail\s*$/i.test(l)), 'runs npm ci');
  assert.ok(!commands.some((l) => /\bnpm\s+(install|i)\b/i.test(l)), 'no npm install command');
});

test('the README run-by-hand steps use npm ci too', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /^npm ci$/m);
  assert.doesNotMatch(readme, /^npm install$/m);
});

test('the README says the update check contacts GitHub and how to turn it off', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /checks GitHub for a newer version/);
  assert.match(readme, /Turn it off/);
  assert.match(readme, /update_check_enabled/);
});
