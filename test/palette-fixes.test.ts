import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();

type Match = { score: number; hits: number[] } | null;

function fnSource(name: string): string {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name}() exists`);
  return m[0];
}

const fuzzy = new Function(`${fnSource('fuzzy')}; return fuzzy;`)() as (q: string, t: string) => Match;

test('fuzzy: scattered letters no longer match', () => {
  assert.strictEqual(fuzzy('update', 'Use plain dark accents'), null);
  assert.ok(fuzzy('update', 'Run the deploy and update docs'));
  assert.deepStrictEqual(fuzzy('update', 'Run the deploy and update docs')?.hits, [19, 20, 21, 22, 23, 24]);
});

test('fuzzy: word starts and contiguous runs match', () => {
  assert.deepStrictEqual(fuzzy('upd', 'Update roadmap')?.hits, [0, 1, 2]);
  assert.deepStrictEqual(fuzzy('pg', 'Push to GitHub')?.hits, [0, 8]);
  assert.deepStrictEqual(fuzzy('rt', 'Retry task')?.hits, [0, 6]);
  assert.ok(fuzzy('x', 'ship-x') && fuzzy('x', 'ship-x')!.hits[0] === 5, 'hyphen starts a word');
});

test('fuzzy: backtracks when the first pick fails', () => {
  // The first "a" at index 0 cannot continue to "b" there; the match is at index 4.
  assert.deepStrictEqual(fuzzy('ab', 'ac ab')?.hits, [3, 4]);
  assert.deepStrictEqual(fuzzy('aab', 'ax aab')?.hits, [3, 4, 5]);
});

test('fuzzy: longer runs and earlier, shorter text score higher', () => {
  assert.ok(fuzzy('push', 'Push to GitHub')!.score > fuzzy('push', 'Push to GitHub and more words')!.score);
  assert.ok(fuzzy('add', 'Add roadmap')!.score > fuzzy('add', 'Roadmap add')!.score);
});

test('renderPalette preselects the first View row when the search is empty', () => {
  const src = fnSource('renderPalette');
  assert.match(src, /findIndex\(\(x\) => x\.kind === 'View'\)/);
  assert.match(src, /q \? palShown\.findIndex\(\(x\) => !x\.disabled\)/);
  assert.match(src, /again >= 0 \? again : first/, 'a kept row stays highlighted');
});

test('the Board key hints show only on the Board view', () => {
  const src = fnSource('renderPaletteFoot');
  assert.match(src, /view === 'board' \?/);
  assert.ok(src.indexOf("view === 'board'") < src.indexOf('Object.entries(BOARD_KEYS).map(([action, keys]) => group(keys,'));
  assert.ok(src.indexOf("view === 'board'") < src.indexOf("text: 'Board'"));
  assert.match(fnSource('openPalette'), /renderPaletteFoot\(\)/, 'footer re-renders on open');
});

test('disabled rows are greyed out, ignore hover and cannot run', () => {
  const css = html.match(/\.pal-opt\[aria-disabled="true"\][^{]*\{[^}]*\}/g)?.join('\n') ?? '';
  assert.match(css, /cursor:not-allowed/);
  assert.match(css, /\.lbl[^{]*\{[^}]*color:var\(--muted\)/);
  assert.match(css, /svg[^{]*\{[^}]*color:var\(--muted\)/);
  assert.match(css, /\.hint/);
  assert.match(fnSource('renderPalette'), /onmousemove: \(\) => \{ if \(!x\.disabled && palActive !== i\)/);
  assert.match(fnSource('renderPalette'), /'aria-disabled': x\.disabled \? 'true' : null/);
  assert.match(fnSource('runPaletteItem'), /if \(!x \|\| x\.disabled\) return;/);
  assert.match(fnSource('movePalette'), /if \(!palShown\[i\]\.disabled\)/);
});

test('Push to GitHub is disabled when Ship reports nothing to push', () => {
  assert.match(fnSource('paletteActions'), /disabled: ship && !ship\.aheadCount \? 'Nothing to push' : null/);
});
