import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

// Static checks over public/index.html: nothing here runs the page.

const html = uiSource();

test('Run view has a single Activity log heading', () => {
  assert.strictEqual(html.match(/'Activity log'/g)?.length, 1);
  assert.doesNotMatch(html, /emptyState\('Activity log'/);
});

test('empty log copy is gated by task status', () => {
  const m = /emptyState\(null, \['queued', 'running'\]\.includes\(t\.status\)\s*\? '([^']*will be listed here as they happen)'\s*: '([^']*)'/.exec(html);
  assert.ok(m, 'status-gated empty copy is missing');
  assert.strictEqual(m[2], 'No events were recorded for this attempt');
});

test('empty log box sizes to its content', () => {
  assert.match(html, /\.log \.empty \{[^}]*padding:4px 16px/);
  assert.doesNotMatch(/\.log \{[^}]*min-height/.exec(html)?.[0] ?? '', /min-height/);
});

test('PR number and commit hash stay on one line', () => {
  const rule = /\.ship-ref \{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(rule, /white-space:nowrap/);
  assert.match(rule, /flex-wrap:nowrap/);
  assert.match(html, /\.ship-ref > span \{[^}]*text-overflow:ellipsis/);
  assert.match(html, /class: 'ship-ref', title: t\.merge_sha/);
});

test('merge history has a date column and a run link', () => {
  assert.match(html, /'Merged', 'Run'\]/);
  assert.match(html, /stampCell\(t\.updated_at\)/);
  assert.match(html, /'data-ship-run': ''[^\n]*go\(\{ view: 'run', selTask: t\.id \}\)/);
});
