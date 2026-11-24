import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();

test('Mark done button posts to the mark-done endpoint and refreshes', () => {
  assert.match(html, /'data-mark-done': ''/);
  assert.match(html, /post\(`\/api\/phases\/\$\{ph\.id\}\/mark-done`\)/);
  assert.match(html, /\(await post\(`\/api\/phases\/\$\{ph\.id\}\/mark-done`\)\) \{ toast\([^)]*\); refresh\(\); \}/);
  assert.match(html, /'Mark done'/);
});

test('it renders only for running phases with no open tasks', () => {
  assert.match(html, /ph\.status === 'running' && !state\.tasks\.some\(\(t\) => t\.plan_id === ph\.plan_id && !\['merged', 'cancelled'\]\.includes\(t\.status\)\)/);
});

test('a done phase shows its done_note as a muted line', () => {
  assert.match(html, /ph\.status === 'done' && ph\.done_note/);
  assert.match(html, /class: 'rm-note', 'data-done-note': '', text: `Done: \$\{ph\.done_note\}`/);
  assert.match(html, /\.rm-note \{ color:var\(--muted\)/);
});
