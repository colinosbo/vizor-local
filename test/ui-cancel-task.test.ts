import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();
const start = html.indexOf('let cancelTask = null');
const end = html.indexOf('// ----- Run -----');
const block = html.slice(start, end);

test('the gate excludes merged, merging and cancelled tasks', () => {
  assert.match(html, /const canCancelTask = \(t\) => !!t && !\['merged', 'merging', 'cancelled'\]\.includes\(t\.status\);/);
  assert.ok(start > 0 && end > start, 'cancel task block found');
  // Every place that renders the action sits behind that gate.
  const uses = html.match(/canCancelTask\(t\)/g) || [];
  assert.ok(uses.length >= 3, 'run button, board card and palette are gated');
});

test('the real cancel is sent once, with dryRun:false, from the confirm handler only', () => {
  const real = html.match(/\/cancel`, \{ dryRun: false/g) || [];
  assert.strictEqual(real.length, 1);
  assert.match(html, /const confirm = async \(\) => \{\s*st\.seq\+\+;[^\n]*\n\s*st\.busy = true; st\.error = null; renderRun\(\);\s*const ok = await post\(`\/api\/tasks\/\$\{encodeURIComponent\(t\.id\)\}\/cancel`, \{ dryRun: false, reroute: st\.reroute \}/);
  assert.match(html, /'data-confirm': '', disabled: st\.busy \|\| st\.loading \|\| !pv, onclick: confirm/);
  // Every other call to the route is a dry run.
  const all = block.match(/\/cancel`, \{ dryRun: (true|false)/g) || [];
  assert.deepStrictEqual(all.map((x) => x.slice(-4)), ['true', 'alse']);
});

test('opening the panel only previews with a dry run', () => {
  const open = block.slice(block.indexOf('function openCancelTask'), block.indexOf('function closeCancelTask'));
  assert.match(open, /\/cancel`, \{ dryRun: true, reroute: st\.reroute \}/);
  assert.doesNotMatch(open, /dryRun: false/);
  assert.match(open, /st\.loadPreview\(\);/);
});

test('the opening buttons only call openCancelTask', () => {
  assert.match(html, /'data-cancel-task': '', onclick: \(\) => openCancelTask\(t\)/);
  assert.match(html, /e\.stopPropagation\(\); openCancelTask\(t\)/);
  assert.match(html, /label: 'Cancel task…'[^\n]*run: \(\) => openCancelTask\(t\)/);
});

test('the panel explains rerouting and offers the checkbox, checked by default', () => {
  assert.match(html, /reroute: true, loading: true/);
  assert.match(html, /'No other tasks depend on this one'/);
  assert.match(html, /'Reroute dependents'/);
  assert.match(html, /Dependents keep waiting on \$\{t\.key\}/);
  assert.match(html, /\$\{deps\(r\.before\)\} → \$\{deps\(r\.after\)\}/);
  // Unchecking asks the server for a fresh preview.
  assert.match(html, /st\.reroute = e\.target\.checked; st\.loadPreview\(\)/);
});

test('a refused cancel shows no confirm button and says why', () => {
  assert.match(html, /const blocked = pv && !pv\.cancellable;/);
  assert.match(html, /'data-cancel-reason': '', text: pv\.reason/);
  assert.match(html, /blocked \? null : h\('button', \{ class: 'btn danger', 'data-confirm': ''/);
});

test('Keep task is the focused default; Escape closes; no browser confirm', () => {
  assert.match(html, /'data-default': '', disabled: st\.busy, onclick: closeCancelTask \}, blocked \? 'Close' : 'Keep task'/);
  assert.match(html, /cancelTask && !cancelTask\.busy && view === 'run' && e\.key === 'Escape'\) return closeCancelTask\(\)/);
  assert.match(block, /e\.key === 'Escape' && !st\.busy\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closeCancelTask\(\)/);
  assert.doesNotMatch(block, /window\.confirm|[^.\w]confirm\(['"`]/);
});

test('the server error is shown inline and the button is busy while it runs', () => {
  assert.match(html, /\(m\) => \{ st\.error = m; \}\);/);
  assert.match(html, /st\.error \? h\('p', \{ class: 'note-bad', role: 'alert', 'data-cancel-error': '', text: st\.error \}\)/);
  assert.match(html, /st\.busy \? 'Cancelling' : 'Cancel task'/);
  assert.match(html, /if \(ok\) \{ cancelTask = null; toast\(`Cancelled \$\{t\.key\}`\); refresh\(\); \}\s*else renderRun\(\);/);
});
