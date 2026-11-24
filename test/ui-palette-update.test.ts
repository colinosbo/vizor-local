import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const js = (name: string) => fs.readFileSync(path.join(process.cwd(), 'public', 'js', name), 'utf8');
const palette = js('palette.js');
const update = js('update.js');
const fuzzySrc = uiSource().match(/function fuzzy\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(fuzzySrc, 'fuzzy() exists');
const fuzzy = new Function(`${fuzzySrc[0]}; return fuzzy;`)() as (q: string, t: string) => unknown;

test('palette.js imports the update handlers', () => {
  assert.match(palette, /import \{ checkUpdateNow, runUpdate, updateInfo \} from '\.\/update\.js';/);
});

test('both update items exist and call the update.js handlers', () => {
  assert.match(palette, /id: 'update-check', label: 'Check for updates'[\s\S]*?run: checkUpdateNow \}/);
  assert.match(palette, /id: 'update-apply', label: 'Update Vizor'[\s\S]*?run: \(\) => runUpdate\('apply'\)/);
  assert.match(palette, /u\.behind > 0 && !u\.busy/);
  assert.match(palette, /commit\$\{u\.behind === 1 \? '' : 's'\} behind/);
});

test('update items are global, not inside paletteActions()', () => {
  const actions = palette.match(/function paletteActions\(\) \{[\s\S]*?\n\}/)![0];
  assert.ok(!actions.includes('update-check') && !actions.includes('update-apply'));
  assert.match(palette, /\.\.\.updateActions\(\)/);
});

test('disabled reasons are present', () => {
  for (const s of ['Update status not loaded yet', 'Update checks are turned off', 'This copy isn’t a git install',
    'An update is running', 'Not eligible to update']) assert.ok(palette.includes(s), s);
});

test('panel and palette share the same handlers', () => {
  assert.match(update, /\$\('updCheck'\)\.onclick = checkUpdateNow;/);
  assert.match(update, /\$\('updNow'\)\.onclick = \(\) => runUpdate\('apply'\)/);
});

test('palette.js makes no /api/update requests', () => {
  assert.ok(!palette.includes('/api/update'));
});

test('typing update matches both labels', () => {
  assert.ok(fuzzy('update', 'Check for updates'));
  assert.ok(fuzzy('update', 'Update Vizor'));
});
