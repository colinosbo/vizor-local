import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

// Static checks over public/index.html: nothing here runs the page.

const html = uiSource();

test('one shared width rule is capped and centred', () => {
  const rule = /\.content-w \{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(rule, /max-width:var\(--content-w/);
  assert.match(rule, /margin-inline:auto/);
});

test('Overview, Ship and Projects use the shared width rule', () => {
  assert.strictEqual(html.match(/class: 'ov content-w'/g)?.length, 2, 'both Overview renders');
  assert.match(html, /class: 'narrow content-w'/);
  assert.match(html, /<div class="split content-w">/);
});

test('no view keeps its own left-pinned cap', () => {
  assert.doesNotMatch(/\.ov \{[^}]*\}/.exec(html)?.[0] ?? '', /max-width/);
  assert.doesNotMatch(/\.narrow \{[^}]*\}/.exec(html)?.[0] ?? '', /max-width/);
});

test('every Board column has empty-state copy', () => {
  const columns = /const COLUMNS = \[(.*)\];/.exec(html)?.[1] ?? '';
  const labels = [...columns.matchAll(/\['(\w+)', \[/g)].map((m) => m[1]);
  assert.strictEqual(labels.length, 6);
  const copy = /const EMPTY_COPY = \{([^}]*)\}/.exec(html)?.[1] ?? '';
  for (const label of labels) assert.match(copy, new RegExp(`\\b${label}: '[^']+'`), `${label} has no empty copy`);
  assert.match(copy, /Waiting: 'Nothing waiting'/);
});

test('empty cells stay hidden in the one-column stack', () => {
  assert.match(html, /\.cell:empty, \.cell\.is-empty \{ display:none; \}/);
});
