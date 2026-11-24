import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { uiModules } from './helpers/ui-source.js';

// Static markup tests read the page as text and cannot see a syntax error that leaves the dashboard blank.
// The page is one module entry plus public/js/*.js: check the entry tag, parse every module, and make sure
// every relative import points at a file that exists.
const root = process.cwd();
const jsDir = path.join(root, 'public', 'js');

test('index.html has no inline script and exactly one module entry under /js/', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  const inline = tags.filter((m) => !/\bsrc=/.test(m[0]) || m[1].trim() !== '');
  assert.deepEqual(inline.map((m) => m[0].slice(0, 80)), [], 'no inline script');
  assert.equal(tags.length, 1, 'exactly one script tag');
  assert.match(tags[0][0], /^<script type="module" src="\/js\/[a-z0-9-]+\.js"><\/script>$/);
  const entry = /src="\/js\/([a-z0-9-]+\.js)"/.exec(tags[0][0])![1];
  assert.ok(fs.existsSync(path.join(jsDir, entry)), `${entry} exists in public/js`);
});

test('every module in public/js parses', () => {
  const files = uiModules(root);
  assert.ok(files.length > 0, 'found the modules');
  for (const file of files) {
    // package.json is type: module, so node --check parses each .js file as an ES module.
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.basename(file)} has a syntax error:\n${r.stderr}`);
  }
});

test('every relative import resolves to a file in public/js', () => {
  for (const file of uiModules(root)) {
    const code = fs.readFileSync(file, 'utf8');
    const specs = [...code.matchAll(/^\s*(?:import|export)\b[^;'"]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of specs) {
      assert.match(spec, /^\.\/[a-z0-9-]+\.js$/, `${path.basename(file)}: import '${spec}' is a './name.js' path`);
      assert.ok(fs.existsSync(path.join(jsDir, spec.slice(2))), `${path.basename(file)}: '${spec}' exists`);
    }
  }
});
