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

test('setupRows exists and lists the six labels in order', () => {
  const fn = body('setupRows');
  const labels = ['Folder is a git repository', 'Local origin exists', 'Test command set and passing on main',
    'GitHub connected', 'Auto-push chosen', 'First plan approved'];
  let last = -1;
  for (const l of labels) {
    const i = fn.indexOf(`label: '${l}'`);
    assert.ok(i > last, `${l} present and in order`);
    last = i;
  }
});

test('renderOverview renders the checklist in the empty and normal branches', () => {
  const fn = body('renderOverview');
  const calls = fn.match(/renderSetupChecklist\(p\)/g) || [];
  assert.strictEqual(calls.length, 2);
  const empty = fn.slice(fn.indexOf('if (!total)'), fn.indexOf('const eta = etaFor'));
  assert.match(empty, /renderSetupChecklist\(p\)/);
  assert.match(fn.slice(fn.indexOf("h('div', { class: 'stats' }") - 80), /renderSetupChecklist\(p\)/);
});

test('the card is skipped when every row is done', () => {
  const fn = body('renderSetupChecklist');
  assert.match(fn, /rows\.every\(\(r\) => r\.done\)\) return null/);
});

test('each failing row has a fix button', () => {
  const fn = body('setupFix');
  for (const t of ['Re-add with origin', 'Set test command', 'Open Ship', 'Open plan', 'Turn on', 'Keep off']) {
    assert.ok(fn.includes(`'${t}'`), `${t} button`);
  }
  assert.match(fn, /view: 'projects'/);
  assert.match(fn, /view: 'ship'/);
  assert.match(fn, /view: 'plan'/);
  assert.match(fn, /autoPush: true/);
});

test('Keep off is stored under the per-project localStorage key', () => {
  assert.match(html, /const autopushKey = \(pid\) => 'vizor\.autopushChosen\.' \+ pid/);
  assert.match(body('setupFix'), /localStorage\.setItem\(autopushKey\(p\.id\)/);
  assert.match(body('setupRows'), /s\.autoPush \|\| autopushChosen\(p\.id\)/);
});

test('checklist text is never built with innerHTML', () => {
  for (const n of ['setupRows', 'setupFix', 'renderSetupChecklist']) assert.doesNotMatch(body(n), /innerHTML/);
});
