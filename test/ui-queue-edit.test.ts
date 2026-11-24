import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();

// The roadmap card source, so every assertion is scoped to it rather than matching anywhere in the page.
const start = html.indexOf('const rmUi = {');
const end = html.indexOf('function drawEdges()');
assert.ok(start > 0 && end > start, 'roadmap queue block found');
const card = html.slice(start, end);

test('queued phases get edit, move up, move down and remove controls', () => {
  assert.match(card, /'data-rm-edit': ''/);
  assert.match(card, /'data-rm-move': 'up'/);
  assert.match(card, /'data-rm-move': 'down'/);
  assert.match(card, /'data-rm-remove': ''/);
  // Real buttons, so they are keyboard reachable; nothing relies on drag.
  assert.match(card, /h\('button', \{ class: 'btn ghost', type: 'button', \.\.\.attrs \}/);
  assert.doesNotMatch(card, /draggable|dragstart|ondrag/);
  assert.doesNotMatch(card, /window\.confirm|[^.\w]confirm\(['"`]/);
});

test('edit and insert share a title + prompt form with Save and Cancel', () => {
  assert.match(card, /function rmForm\(draft, kind, onSave, onCancel\)/);
  assert.match(card, /'aria-label': 'Phase title'/);
  assert.match(card, /'aria-label': 'Phase prompt'/);
  assert.match(card, /type: 'submit'[^}]*\}, 'Save'/);
  assert.match(card, /onclick: onCancel \}, 'Cancel'/);
  assert.match(card, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); onCancel\(\)/);
  assert.match(card, /rmForm\(d, 'edit', save, close\)/);
  assert.match(card, /rmForm\(d, 'insert', save, close\)/);
});

test('Insert phase here sits before every queued phase and after the last phase', () => {
  assert.match(card, /'Insert phase here'/);
  assert.match(card, /if \(isQueued\) rows\.push\(rmInsertGap\(p, ph\.position, r\.id\)\)/);
  assert.match(card, /rows\.push\(rmInsertGap\(p, phs\.length \+ 1, r\.id\)\)/);
});

test('controls are gated by phase status', () => {
  // move and edit only inside the queued branch
  assert.match(card, /isQueued \? \[\s*btn\(\{ 'data-rm-move': 'up'/);
  assert.match(card, /btn\(\{ 'data-rm-edit': ''[\s\S]*?\}, 'edit'\)\] : null/);
  // the first and last queued phases cannot move past the queue
  assert.match(card, /disabled: qi === 0, onclick: \(\) => move\(ph\.position - 1/);
  assert.match(card, /disabled: qi === queued\.length - 1, onclick: \(\) => move\(ph\.position \+ 1/);
  // remove: queued, failed and review only
  assert.match(card, /\['queued', 'failed', 'review'\]\.includes\(ph\.status\) \? btn\(\{ 'data-rm-remove'/);
  // running, drafting and done are visibly read-only and never reach a control
  assert.match(card, /readOnly = \['drafting', 'running', 'done'\]\.includes\(ph\.status\)/);
  assert.match(card, /readOnly \? h\('span', \{ class: 'lock', 'data-rm-readonly': ''/);
  assert.match(card, /'rm-row' \+ \(readOnly \? ' ro' : ''\)/);
  // an open edit form is dropped once its phase is no longer queued
  assert.match(card, /if \(rmUi\.edit && statusOf\(rmUi\.edit\.id\) !== 'queued'\) rmUi\.edit = null/);
  // retry stays failed-only
  assert.match(card, /ph\.status === 'failed' \? h\('button', \{ class: 'btn', onclick: async \(\) => \{ if \(await post\(`\/api\/phases\/\$\{ph\.id\}\/retry`\)\)/);
});

test('removing a review phase asks first and says the drafted plan is discarded', () => {
  assert.match(card, /if \(ph\.status !== 'review'\) return remove\(\); rmUi\.confirm = ph\.id/);
  assert.match(card, /'Remove this phase\? Its drafted plan will be discarded'/);
  assert.match(card, /'data-rm-confirm-remove': '', onclick: remove \}, 'Remove and discard plan'/);
  // Keep is the primary, focused default
  assert.match(card, /class: 'btn primary', type: 'button', 'data-rm-key': 'confirm-keep:' \+ ph\.id/);
  assert.match(card, /rmRerender\('confirm-keep:' \+ ph\.id\)/);
});

test('each route is wired once', () => {
  assert.strictEqual((card.match(/`\/api\/projects\/\$\{encodeURIComponent\(p\.id\)\}\/phases`/g) || []).length, 1);
  assert.strictEqual((card.match(/`\/api\/phases\/\$\{ph\.id\}\/move`/g) || []).length, 1);
  assert.strictEqual((card.match(/`\/api\/phases\/\$\{ph\.id\}\/edit`/g) || []).length, 1);
  assert.strictEqual((card.match(/`\/api\/phases\/\$\{ph\.id\}\/remove`/g) || []).length, 1);
  assert.match(card, /\{ position: pos, roadmapId: rid, title: d\.title, prompt: d\.prompt \}/);
  assert.match(card, /\{ position: to \}/);
  assert.match(card, /\{ title: d\.title, prompt: d\.prompt \}/);
});

test('server errors show inline next to the phase, not only as a toast', () => {
  assert.match(card, /post\(path, body, \(m\) => \{ rmUi\.errors\[errKey\] = m; \}\)/);
  assert.match(card, /h\('p', \{ class: 'rm-err note-bad', role: 'alert', 'data-rm-error'/);
  assert.match(card, /rmErr\(ph\.id\)/);
  assert.match(card, /rmErr\(key\)/);
});

test('drafts and focus survive the re-render that every SSE batch triggers', () => {
  assert.match(card, /oninput: \(e\) => \{ draft\.title = e\.target\.value; \}/);
  assert.match(card, /oninput: \(e\) => \{ draft\.prompt = e\.target\.value; \}/);
  assert.match(html, /const rmPrev = rmFocusKey\(\);[\s\S]*?rmRestoreFocus\(rmPrev\);/);
});

test('existing keyboard handling is untouched', () => {
  assert.match(html, /if \(typing \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return;\s*if \(boardKey\(e\)\) return;/);
  assert.match(html, /if \(e\.key === 'Escape' && typing\) return e\.target\.blur\(\);/);
});

test('helper copy keeps the approval sentence for the auto-approve task', () => {
  assert.match(html, /You approve every plan/);
});
