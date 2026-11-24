import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();
const KEYS = ['checks', 'verifying', 'held', 'superseded'];

const explain = (): Record<string, string> => {
  const m = html.match(/const EXPLAIN = (\{[\s\S]*?\n\});/);
  assert.ok(m, 'EXPLAIN map found');
  return new Function(`return ${m[1]}`)();
};
const infoBtnBody = () => {
  const m = html.match(/function infoBtn\([\s\S]*?\n\}/);
  assert.ok(m, 'infoBtn body found');
  return m[0];
};

test('EXPLAIN has all four keys, short plain-language strings', () => {
  const map = explain();
  assert.deepStrictEqual(Object.keys(map).sort(), [...KEYS].sort());
  for (const k of KEYS) {
    const s = map[k];
    assert.ok(typeof s === 'string' && s.trim().length > 0, `${k} is non-empty`);
    assert.ok(s.length <= 300, `${k} is ${s.length} characters`);
    assert.doesNotMatch(s, /\bCI\b|\bSHA\b|rebase|fast-forward/i, `${k} avoids jargon`);
  }
});

test('infoBtn sets aria-label, aria-expanded and aria-controls', () => {
  const fn = infoBtnBody();
  assert.match(fn, /'aria-label': `What does \$\{name\} mean\?`/);
  assert.match(fn, /'aria-expanded'/);
  assert.match(fn, /'aria-controls': 'infoPop'/);
});

test('infoBtn never assigns innerHTML and the popover uses textContent', () => {
  assert.doesNotMatch(infoBtnBody(), /innerHTML/);
  assert.match(infoBtnBody(), /infoPop\.textContent = EXPLAIN\[key\]/);
});

test('Escape and outside clicks close the popover', () => {
  assert.match(html, /e\.key === 'Escape' && infoOpen/);
  assert.match(html, /pointerdown[\s\S]{0,200}closeInfo/);
  assert.match(infoBtnBody(), /addEventListener\('blur'/);
});

test('infoBtn is used for each of the four keys', () => {
  for (const k of KEYS) {
    const direct = new RegExp(`infoBtn\\('${k}'\\)`).test(html);
    const viaMap = new RegExp(`(?:INFO_OF|\\{[^}]*)[^\\n]*['"]?${k}['"]?`).test(html.replace(/const EXPLAIN[\s\S]*?\n\};/, ''));
    assert.ok(direct || viaMap, `infoBtn used for ${k}`);
  }
  assert.match(html, /infoBtn\(INFO_OF\[/, 'status chips go through INFO_OF');
});
