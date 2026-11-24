import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';
import { SUPERSEDED_HOLD } from '../src/plan.js';

const html = uiSource();

test('the UI hold reason is exactly the one the server writes', () => {
  assert.match(html, new RegExp(`const SUPERSEDED_HOLD = '${SUPERSEDED_HOLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}';`));
});

test('the action is gated on status blocked and the exact hold reason', () => {
  assert.match(html, /const canMergeAnyway = \(t\) => !!t && t\.status === 'blocked' && t\.hold_reason === SUPERSEDED_HOLD;/);
  // Every place that renders the action sits behind that gate, never a prefix or regex match on the reason.
  const uses = html.match(/canMergeAnyway\(t\) /g) || [];
  assert.ok(uses.length >= 3, 'run button, run panel and board card are gated');
  assert.doesNotMatch(html, /hold_reason\s*\.(startsWith|includes)\(\s*'plan superseded/);
  assert.doesNotMatch(html, /\/\^plan superseded[^/]*\/\.test\(t\.hold_reason/);
});

test('the route is called only from the confirm handler', () => {
  const hits = html.match(/merge-anyway`/g) || [];
  assert.strictEqual(hits.length, 1);
  assert.match(html, /const confirm = async \(\) => \{\s*st\.busy = true; st\.error = null; renderRun\(\);\s*const ok = await post\(`\/api\/tasks\/\$\{encodeURIComponent\(t\.id\)\}\/merge-anyway`/);
  assert.match(html, /'data-confirm': '', disabled: st\.busy, onclick: confirm/);
  // The opening buttons only open the panel.
  assert.match(html, /'data-merge-anyway': '', onclick: \(\) => openMergeAnyway\(t\)/);
  assert.match(html, /e\.stopPropagation\(\); openMergeAnyway\(t\)/);
});

test('the panel lists what is still checked, with the short head SHA', () => {
  assert.match(html, /'The pull request is still open'/);
  assert.match(html, /The required check is green on this exact head, \$\{short\(t\.head_sha\)\}/);
  assert.match(html, /Every changed file is inside the task write scope/);
  assert.match(html, /The branch is up to date with the base branch/);
});

test('Cancel is the focused default; Enter and Escape cancel', () => {
  assert.match(html, /class: 'btn primary', 'data-default': '', onclick: closeMergeAnyway \}, 'Cancel'/);
  assert.match(html, /document\.querySelector\('\.guard \[data-default\]'\)\?\.focus\(\)/);
  assert.match(html, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closeMergeAnyway\(\)/);
  assert.match(html, /e\.key === 'Enter' && !e\.target\.hasAttribute\('data-confirm'\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closeMergeAnyway\(\)/);
  const start = html.indexOf('let mergeAnyway = null');
  const end = html.indexOf('// ----- Run -----');
  assert.ok(start > 0 && end > start, 'merge anyway block found');
  assert.doesNotMatch(html.slice(start, end), /window\.confirm|[^.\w]confirm\(['"`]/);
});

test('a refusal is shown inline in the panel, not only as a toast', () => {
  assert.match(html, /\(m\) => \{ st\.error = m; \}\)/);
  assert.match(html, /st\.error \? h\('p', \{ class: 'note-bad', role: 'alert', 'data-merge-error': '', text: st\.error \}\)/);
  // The failed branch re-renders the panel instead of toasting.
  assert.match(html, /if \(ok\) \{ mergeAnyway = null; toast\(`Merged[^`]*`\); refresh\(\); \}\s*else renderRun\(\);/);
});

test('the event log words owner_override_merge readably', () => {
  assert.match(html, /case 'owner_override_merge': return `Owner merged \$\{[^`]*\?\.key \|\| 'task'\} anyway at \$\{short\(d\.headSha\)\}`;/);
  assert.match(html, /case 'owner_override_merge_failed':/);
  assert.match(html, /case 'owner_override_merge': return \[pr\(d\.prNumber\), sha\(d\.headSha, 'SHA'\)\];/);
});
