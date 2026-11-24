import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

// Static guard over public/index.html: the Ship view shows push guard findings, offers a confirmed
// per-finding override only, and renders the findings a 409 from push or push-now carries.

const html = uiSource();
const style = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const start = html.indexOf('// Push guard: one finding at a time');
const end = html.indexOf('async function loadShip');
const guardEnd = html.indexOf('function renderShip()');
const block = html.slice(start, guardEnd);

test('the push guard block sits in the Ship section', () => {
  assert.ok(start > 0 && guardEnd > start && end > 0, 'block found');
});

test('Ship lists each finding with file, line, reason and a monospace excerpt', () => {
  assert.match(block, /const fs = d\.findings \|\| \[\]/);
  assert.match(block, /f\.file \? `\$\{f\.file\}\$\{f\.line \? ':' \+ f\.line : ''\}`/);
  assert.match(block, /class: 'pg-reason', text: f\.reason/);
  assert.match(block, /f\.excerpt \? h\('code', \{ class: 'pg-excerpt mono'/);
  assert.match(style, /\.pg-excerpt\s*\{[^}]*white-space:pre-wrap/);
});

test('the blocked state is words, not colour, and is announced', () => {
  assert.match(block, /Push blocked: \$\{fs\.length\} finding/);
  assert.match(block, /announce\(`Push blocked:/);
  assert.match(html, /'aria-describedby': blocked \? 'pgPushWhy'/);
  assert.match(html, /Disabled until every finding above is fixed or allowed/);
  assert.match(html, /disabled: !d\.canPush \|\| !!c\.loading, 'aria-describedby'/);
});

test('the blocked panel sits above the push button', () => {
  const panel = html.indexOf('line, blocked,');
  const push = html.indexOf("'data-push': ''");
  assert.ok(panel > 0 && push > panel);
});

test('override posts push-override with a findingId, and only from the confirm button', () => {
  const calls = html.match(/\/push-override`/g) || [];
  assert.strictEqual(calls.length, 1);
  assert.match(block, /post\(`\/api\/projects\/\$\{encodeURIComponent\(pid\)\}\/push-override`, \{ findingId \}\)/);
  assert.match(block, /'data-override-confirm': '', onclick: \(\) => overrideOne\(p\.id, f\.id\)/);
  // The opening button only opens the confirm step.
  assert.match(block, /'data-override': '', [^\n]*onclick: \(\) => askOverride\(p\.id, f\.id\)/);
  assert.match(block, /function overrideOne[\s\S]*loadShip\(pid\)/, 'status is re-fetched afterwards');
});

test('the confirm step names the file and the reason, and Cancel is the focused default', () => {
  assert.match(block, /Allow pushing \$\{pgWhere\(f\)\} even though: \$\{f\.reason\}\?/);
  assert.match(block, /'data-default': '', onclick: \(\) => \{ pgConfirm = null; renderShip\(\); \}/);
  assert.match(html, /querySelector\('\.pg-row \[data-default\]'\)\?\.focus\(\)/);
  assert.doesNotMatch(block, /window\.confirm|[^.\w]confirm\(['"`]/);
});

test('there is no bulk override', () => {
  assert.doesNotMatch(html, /allow all|override all|allow every|allowAll|overrideAll/i);
  // The confirm state is one { pid, findingId }, never a list, and the override sends one id.
  assert.match(block, /pgConfirm = \{ pid, findingId \}/);
  assert.doesNotMatch(block, /findingIds|fs\.forEach\([^)]*override|fs\.map\([^)]*overrideOne/);
  assert.doesNotMatch(html, /push-override`, \{ findingIds/);
});

test('a 409 from push and push-now renders the returned findings', () => {
  assert.match(html, /post\(`\/api\/projects\/\$\{p\.id\}\/push`, \{ sha: d\.local \}, \(m, j\) => \{ if \(j\?\.findings\) pushBlocked\(p\.id, j\)/);
  assert.match(html, /post\(`\/api\/projects\/\$\{p\.id\}\/push-now`, null, \(m, j\) => \{ if \(j\?\.findings\) pushBlocked\(p\.id, j\)/);
  assert.match(block, /function pushBlocked[\s\S]*findings: j\.findings, canPush: false/);
  assert.match(block, /if \(view !== 'ship'\) go\(\{ view: 'ship' \}\)/);
});

test('push guard rows meet the Phase 6 rules', () => {
  // .btn already has a 40px narrow hit target and focus ring; the rows add their own ring and stack in one column.
  assert.match(style, /\.pg \.btn:focus-visible\s*\{[^}]*outline:2px solid var\(--accent\)/);
  assert.match(style, /\.pg-row\s*\{[^}]*flex-direction:column/);
  assert.match(style, /\.pg-file\s*\{[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(style, /\.pg[^{]*\{[^}]*(transition|animation)\s*:/, 'no new motion');
});
