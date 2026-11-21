import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

// Pull the shortcut map out of the page and evaluate it, so the test checks the real constant.
function boardKeys(): Record<string, string[]> {
  const m = html.match(/const BOARD_KEYS = Object\.freeze\((\{[\s\S]*?\})\);/);
  assert.ok(m, 'BOARD_KEYS constant exists');
  return new Function(`return ${m[1]}`)();
}

test('BOARD_KEYS maps every board action to its keys', () => {
  const k = boardKeys();
  assert.deepStrictEqual(k.up, ['ArrowUp', 'k']);
  assert.deepStrictEqual(k.down, ['ArrowDown', 'j']);
  assert.deepStrictEqual(k.left, ['ArrowLeft']);
  assert.deepStrictEqual(k.right, ['ArrowRight']);
  assert.deepStrictEqual(k.open, ['Enter']);
  assert.deepStrictEqual(k.retry, ['r']);
  assert.deepStrictEqual(k.back, ['Escape']);
});

test('shortcuts extend the existing keydown handler and skip form fields', () => {
  assert.match(html, /isContentEditable/);
  assert.match(html, /if \(typing \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return;\s*if \(boardKey\(e\)\) return;/);
  assert.match(html, /\^\(INPUT\|TEXTAREA\|SELECT\)\$/);
});

test('Enter opens the run through go()', () => {
  assert.match(html, /action === 'open'\) go\(\{ view: 'run', selTask: card\.dataset\.taskId \}\)/);
});

test('r retries only held cards, via the held action', () => {
  assert.match(html, /const heldOf = /);
  assert.match(html, /const held = heldOf\(state\.tasks\.find/);
  assert.match(html, /held\?\.action\?\.icon === 'retry'\) held\.action\.run\(\)/);
  assert.match(html, /const held = heldOf\(t\);/);
});

test('Escape returns from run to the board and refocuses the opened card', () => {
  assert.match(html, /if \(view === 'run'\) \{\s*if \(action !== 'back' \|\| !selTask\) return false;/);
  assert.match(html, /go\(\{ view: 'board' \}\);\s*\$\('v-board'\)\.querySelector\(`\.tcard\[data-task-id="\$\{CSS\.escape\(id\)\}"\]`\)\?\.focus\(\)/);
});

test('detail popover Escape handling is kept', () => {
  assert.match(html, /e\.key === 'Escape' && !tcPop\.hidden\) hidePop\(\)/);
});

test('j/k and arrows move within a column, left/right across columns', () => {
  assert.match(html, /action === 'up' \|\| action === 'down'/);
  assert.match(html, /c\.dataset\.col === card\.dataset\.col/);
  assert.match(html, /action === 'right' \? 1 : -1/);
});

test('focused card gets a visible ring', () => {
  assert.match(html, /\.tcard:focus-visible \{ outline:2px solid var\(--accent\)/);
});
