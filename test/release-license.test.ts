import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Release hygiene: MIT LICENSE at the root, and the unslop credit (CC BY 4.0) in README and NOTICE.

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('LICENSE exists with the MIT text and copyright line', () => {
  assert.ok(fs.existsSync(path.join(process.cwd(), 'LICENSE')));
  const text = read('LICENSE');
  for (const s of ['MIT License', 'Colin Osborn', 'Copyright (c) 2026']) assert.ok(text.includes(s), s);
});

for (const file of ['README.md', 'NOTICE.md']) {
  test(`${file} credits the unslop skill`, () => {
    const text = read(file);
    for (const s of ['Damir Sokolovsky', 'heydamir', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'https://github.com/heydamir/unslop']) {
      assert.ok(text.includes(s), `${file} missing ${s}`);
    }
  });
}

test('NOTICE.md says the copy was modified', () => {
  assert.match(read('NOTICE.md'), /modified/i);
});

test('skills/unslop/SKILL.md keeps its credit paragraph', () => {
  assert.ok(read('skills', 'unslop', 'SKILL.md').includes('heydamir'));
});
