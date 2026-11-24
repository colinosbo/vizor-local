import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Static checks over public/index.html: nothing here runs the page.

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

test('palette task results show the task model or default', () => {
  assert.match(html, /id: 'task:' \+ t\.id[^\n]*hint: `\$\{t\.key\} · \$\{t\.model \|\| 'default'\}`/);
});

test('Ship merge history has a Model column filled from the task', () => {
  assert.match(html, /\['Task', 'Plan', 'Model', 'PR', 'Merge commit', 'Status'\]/);
  assert.match(html, /'data-ship-model': '', text: t\.model \|\| 'default'/);
});

for (const [id, label] of [['sPlannerModel', 'Planner model'], ['sWorkerModel', 'Worker model']] as const) {
  test(`${label} select is labelled and offers auto, sonnet and opus`, () => {
    const m = new RegExp(`<label class="field"><span>${label}</span>\\s*<select id="${id}">(.*?)</select>`, 's').exec(html);
    assert.ok(m, `${label} select is missing`);
    const values = [...m[1].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((o) => [o[1], o[2]]);
    assert.deepStrictEqual(values, [['auto', 'Auto routing'], ['sonnet', 'Sonnet'], ['opus', 'Opus']]);
  });
}

test('model defaults are explained, initialised from state and saved with the project config', () => {
  assert.match(html, /<small>Auto keeps the planner's per-task pick<\/small>/);
  assert.match(html, /\$\('sPlannerModel'\)\.value = p\.planner_model \|\| 'auto'/);
  assert.match(html, /\$\('sWorkerModel'\)\.value = p\.worker_model \|\| 'auto'/);
  assert.match(html, /planner_model: \$\('sPlannerModel'\)\.value, worker_model: \$\('sWorkerModel'\)\.value/);
  assert.match(html, /toast\('Settings saved'\)/);
});
