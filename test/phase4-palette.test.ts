import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

const ACTIONS = ['Retry task', 'Push to GitHub', 'Pause dispatch', 'Approve plan', 'Add roadmap'];

// The body of paletteActions(), the single list the palette's actions come from.
function paletteActionList(): string {
  const m = html.match(/function paletteActions\(\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'paletteActions() exists');
  return m[1];
}

// Every h('button', ...) call in the page, up to the end of its statement line.
const buttonCalls = (): string[] => html.match(/h\('button',[^\n]*/g) ?? [];

test('Ctrl+K and Cmd+K toggle the palette, even from text fields', () => {
  assert.match(html, /const isPaletteKey = \(e\) => \(e\.ctrlKey \|\| e\.metaKey\)[^;\n]*e\.key\?\.toLowerCase\(\) === 'k'/);
  // Checked before the typing guard, so chatIn and other fields only reach the palette through Ctrl+K.
  assert.match(html, /if \(isPaletteKey\(e\)\) \{ e\.preventDefault\(\); if \(!e\.repeat\) togglePalette\(\); return; \}\s*if \(palOpen\) return;[^\n]*\s*const typing =/);
});

test('Escape closes the palette', () => {
  assert.match(html, /\$\('palDialog'\)\.addEventListener\('keydown'/);
  assert.match(html, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closePalette\(\); \}/);
});

test('each action exists in the palette action list and as a button label', () => {
  const list = paletteActionList(), buttons = buttonCalls();
  for (const label of ACTIONS) {
    assert.ok(list.includes(`'${label}'`), `${label} is a palette action`);
    assert.ok(buttons.some((b) => b.includes(`'${label}'`) || b.includes('`' + label)), `${label} is a button label`);
  }
});

test('palette actions call the same handlers as their buttons', () => {
  const list = paletteActionList();
  assert.match(list, /run: \(\) => retry\(t\)/);
  assert.match(html, /h\('button', \{ class: 'btn', onclick: \(\) => retry\(t\) \}, icon\('retry'\), 'Retry task'\)/);
  assert.match(list, /askPush\(p\.id\)/);
  assert.match(html, /onclick: \(\) => askPush\(p\.id\) \}, icon\('ship'\)/);
  assert.match(list, /run: togglePause/);
  assert.match(html, /h\('button', \{ class: 'btn', onclick: togglePause \}/);
  assert.match(list, /run: \(\) => approvePlan\(draft\)/);
  assert.match(html, /onclick: \(\) => approvePlan\(plan\) \}, `Approve plan v/);
  assert.match(list, /openRoadmapEditor\(\)/);
  assert.match(html, /h\('button', \{ class: 'btn ghost', onclick: openRoadmapEditor \}/);
});

test('dialog semantics: modal dialog, combobox input, listbox results', () => {
  assert.match(html, /id="palDialog" role="dialog"/);
  assert.match(html, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(html, /role="combobox"[^>]*aria-controls="palList"/);
  assert.match(html, /id="palList" role="listbox"/);
  assert.match(html, /role: 'option'/);
  assert.match(html, /aria-activedescendant/);
});

test('focus is trapped while open and returned on close', () => {
  assert.match(html, /\.inert = true/);
  assert.match(html, /e\.key === 'Tab'\) \{ e\.preventDefault\(\); \$\('palIn'\)\.focus\(\); \}/);
  assert.match(html, /palReturn = document\.activeElement/);
  assert.match(html, /if \(back\?\.isConnected && back !== document\.body\) back\.focus\(\)/);
});

test('fuzzy search is a scored subsequence match', () => {
  const m = html.match(/function fuzzy\(q, text\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'fuzzy() exists');
  const fuzzy = new Function(`${m[0]}; return fuzzy;`)() as (q: string, t: string) => { score: number; hits: number[] } | null;
  assert.strictEqual(fuzzy('xyz', 'Retry task'), null);
  assert.deepStrictEqual(fuzzy('rt', 'Retry task')?.hits, [0, 6]);
  // Contiguous runs and word starts match; scattered letters no longer do.
  assert.ok(fuzzy('push', 'Push to GitHub'));
  assert.strictEqual(fuzzy('push', 'Pause dispatch hush'), null);
  assert.ok(fuzzy('ar', 'Add roadmap'));
  assert.strictEqual(fuzzy('ar', 'Overview chart'), null);
});

test('keycaps render for Ctrl+K and the BOARD_KEYS shortcuts', () => {
  assert.match(html, /const PALETTE_KEYS = \[IS_MAC \? '⌘' : 'Ctrl', 'K'\]/);
  assert.match(html, /const keycaps = \(keys\) =>[^\n]*class: 'kbd'/);
  assert.match(html, /Object\.entries\(BOARD_KEYS\)\.map\(\(\[action, keys\]\) => group\(keys,/);
  assert.match(html, /put\(\$\('palKeys'\), PALETTE_KEYS\.map/);
});
