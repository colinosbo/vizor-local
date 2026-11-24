import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Static markup tests read the page as text and cannot see a syntax error that leaves the dashboard blank.
// Compile every inline script (without running it) so an unbalanced bracket fails CI instead of the browser.
test('every inline script in public/index.html compiles', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, 'found the page script');
  for (const [i, code] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(code, { filename: `index.html#script${i}` }), `inline script ${i} has a syntax error`);
  }
});
