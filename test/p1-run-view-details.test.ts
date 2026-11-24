import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Static checks over public/index.html for the Run view details: nothing here runs the page.

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

test('run header shows the model line with its reason', () => {
  assert.match(html, /'data-run-model': ''/);
  assert.match(html, /t\.model \|\| 'default'/);
  assert.match(html, /t\.model_why/);
});

test('task list has a labelled search that announces the result count', () => {
  assert.match(html, /<label for="tsearch">Search tasks<\/label><input[^>]*id="tsearch"/);
  assert.match(html, /addEventListener\('input'[\s\S]{0,120}renderTaskList/);
  assert.match(html, /announce\(`\$\{shown\.length\} of \$\{tasks\.length\}/);
  assert.match(html, /\.tsearch label/);
});

test('attempt table has the detail columns and stays readable on narrow screens', () => {
  const m = /\['Attempt',([^\]]*)\]\.map\(\(x\) => h\('th'/.exec(html);
  assert.ok(m, 'attempt header list is missing');
  for (const col of ['Finished', 'Duration', 'Model', 'Reason', 'PR']) assert.ok(m[1].includes(`'${col}'`), `${col} column is missing`);
  assert.match(html, /\.atable\s*\{[^}]*overflow-x:auto/);
  assert.match(html, /\.atable:focus-visible/);
  assert.match(html, /title: ago\(d\)/, 'relative time rides on a tooltip');
});
