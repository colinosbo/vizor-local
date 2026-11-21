import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

test('last view is stored per project', () => {
  assert.match(html, /'vizor\.lastView\.'\s*\+\s*pid/);
  assert.match(html, /const lastViewKey = /);
});

test('save and restore helpers exist', () => {
  assert.match(html, /function saveLastView\(/);
  assert.match(html, /function restoreLastView\(/);
  assert.match(html, /JSON\.stringify\(\{ view, selTask \}\)/);
});

test('go() saves, and restore requires the task to still exist', () => {
  assert.match(html, /saveLastView\(current\); writeHash\(\); render\(\)/);
  assert.match(html, /state\?\.tasks\?\.some\(\(t\) => t\.id === v\.selTask/);
});
