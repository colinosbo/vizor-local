import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
const body = (name: string) => {
  const m = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} body found`);
  return m[0];
};

test('emptyState renders a heading, a reason and at most one button', () => {
  const fn = body('emptyState');
  assert.match(fn, /class: 'empty'/);
  assert.strictEqual((fn.match(/h\('h2'/g) || []).length, 1);
  assert.strictEqual((fn.match(/h\('p'/g) || []).length, 1);
  assert.strictEqual((fn.match(/h\('button'/g) || []).length, 1);
  assert.match(fn, /action \?/, 'button is optional');
});

test('each listed view uses emptyState', () => {
  const views: Record<string, number> = {
    planCanvas: 1, renderOverview: 5, renderBoard: 2, renderRun: 3, renderShip: 2, renderProjects: 1, renderPalette: 1, renderPlan: 1,
  };
  for (const [name, min] of Object.entries(views)) {
    const calls = body(name).match(/emptyState\(/g) || [];
    assert.ok(calls.length >= min, `${name} calls emptyState at least ${min} times, found ${calls.length}`);
  }
});

test('old one-line empty copy is gone', () => {
  for (const old of ["class: 'none'", "text: 'No tasks yet'", "text: 'No projects yet'", "text: 'No events yet'"]) {
    assert.ok(!html.includes(old), `${old} removed`);
  }
});

test('the filtered board empty state clears the filter', () => {
  const fn = body('renderBoard');
  const i = fn.indexOf('if (!shown.length)');
  assert.ok(i > 0);
  assert.match(fn.slice(i, i + 600), /setBoardFilter\(p\.id, 'all'\)/);
});

test('no put() call is left with no children for a list container', () => {
  const bare = html.match(/\bput\(\$\('[\w-]+'\)\s*\)/g);
  assert.strictEqual(bare, null, `bare put calls: ${bare}`);
  assert.ok(!/put\(\$\('[\w-]+'\),\s*\[\]\s*\)/.test(html));
});

test('palette empty slot is filled by emptyState and the static markup is a container', () => {
  assert.match(html, /<div class="pal-none" id="palNone" hidden><\/div>/);
  assert.match(body('renderPalette'), /put\(\$\('palNone'\), emptyState\(/);
});

test('the setup checklist card is still on the Overview', () => {
  assert.strictEqual((body('renderOverview').match(/renderSetupChecklist\(p\)/g) || []).length, 2);
});
