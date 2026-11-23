import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Phase 6 narrow-window guards over public/index.html: 40px hit targets below 900px, a one-column
// stack, and a DOM order that matches the reading order (status strip, Needs you, Board).

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
const style = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');

/** Body of every `@media (max-width: Npx)` block with N <= limit, found by brace matching. */
function narrowBlocks(css: string, limit = 899): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g)) {
    if (Number(m[1]) > limit) continue;
    let depth = 1, i = m.index! + m[0].length;
    const from = i;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    out.push(css.slice(from, i - 1));
  }
  return out;
}

/** Rules `selectors { body }` of a flat block, split into selector list and declarations. */
function rulesOf(block: string): { selectors: string[]; body: string }[] {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] }));
}
const px = (body: string, prop: string): number | null => {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
};
/** Smallest min-height / min-width (px) any narrow rule gives `selector`, or null. */
function narrowMin(css: string, selector: string, prop: 'min-height' | 'min-width'): number | null {
  let best: number | null = null;
  for (const block of narrowBlocks(css))
    for (const r of rulesOf(block)) {
      const v = px(r.body, prop);
      if (v !== null && r.selectors.includes(selector)) best = best === null ? v : Math.max(best, v);
    }
  return best;
}

const CONTROLS = ['.btn', '.nav', '.sitem', '.wordmark', '.seg button', '.rm-mode', '.lane-head', '.disclosure', '.pal-opt', '.tcard',
  'input[type=text]', 'input[type=number]', 'select', 'textarea', '.info-btn', '.copy'];
const ICON_ONLY = ['.info-btn', '.copy'];

test('a max-width media query at or below 899px exists', () => {
  assert.ok(narrowBlocks(style).length > 0);
});

test('below 900px every control selector has min-height of 40px or more', () => {
  for (const sel of CONTROLS) {
    const v = narrowMin(style, sel, 'min-height');
    assert.ok(v !== null && v >= 40, `${sel} needs min-height >= 40px under the narrow media query (got ${v})`);
  }
});

test('below 900px icon-only controls have min-width of 40px or more', () => {
  for (const sel of ICON_ONLY) {
    const v = narrowMin(style, sel, 'min-width');
    assert.ok(v !== null && v >= 40, `${sel} needs min-width >= 40px (got ${v})`);
  }
});

test('the narrow query is able to fail: a 32px control is caught', () => {
  const css = '@media (max-width: 899px) { .btn { min-height:32px; } }';
  assert.strictEqual(narrowMin(css, '.btn', 'min-height'), 32);
  assert.strictEqual(narrowMin('@media (max-width: 1100px) { .btn { min-height:40px; } }', '.btn', 'min-height'), null);
});

test('a narrow rule makes the main layout one column', () => {
  const rules = narrowBlocks(style).flatMap(rulesOf);
  const one = (sel: string) => rules.some((r) => r.selectors.includes(sel) && /grid-template-columns\s*:\s*(minmax\(0,\s*1fr\)|1fr)\s*(;|$)/.test(r.body.trim()));
  assert.ok(rules.some((r) => r.selectors.includes('body') && /display\s*:\s*block/.test(r.body)), 'body stops being a two-column grid');
  assert.ok(one('.stats'), 'stat cards stack');
  assert.ok(one('.kanban'), 'board lanes stack vertically');
  assert.ok(!rules.some((r) => r.selectors.includes('.kanban') && px(r.body, 'min-width') !== null && px(r.body, 'min-width')! > 0), 'kanban has no fixed minimum width');
});

test('the board columns collapse to one column and name each cell', () => {
  const rules = narrowBlocks(style).flatMap(rulesOf);
  assert.ok(rules.some((r) => r.selectors.includes('.khead') && /display\s*:\s*none/.test(r.body)));
  assert.ok(rules.some((r) => r.selectors.some((s) => s.startsWith('.cell[data-label]::before'))));
  assert.ok(/'data-label': label/.test(script));
});

test('overlays fit the viewport at narrow widths', () => {
  const rules = narrowBlocks(style).flatMap(rulesOf);
  assert.ok(rules.some((r) => r.selectors.includes('#infoPop') && /max-width\s*:\s*calc\(100vw/.test(r.body)));
  assert.ok(rules.some((r) => r.selectors.includes('#toast') && /left\s*:/.test(r.body) && /right\s*:/.test(r.body)));
  assert.match(style, /\.pal\s*\{[^}]*width:min\(600px,\s*100%\)/);
});

test('markup order: status strip, then Needs you, then Board', () => {
  const strip = markup.indexOf('id="strip"');
  const overview = markup.indexOf('id="v-overview"');
  const board = markup.indexOf('id="v-board"');
  assert.ok(strip >= 0 && overview > strip, 'status strip precedes the overview');
  assert.ok(board > overview, 'Board follows the overview');
});

test('inside the overview, Needs you is built before Progress so DOM order is reading order', () => {
  const need = script.indexOf("class: 'col col-need'");
  const main = script.indexOf("class: 'col col-main'");
  assert.ok(need >= 0 && main >= 0, 'both columns are classed');
  assert.ok(script.indexOf("panel('Needs you'") > need, 'Needs you panel lives in col-need');
  assert.match(script, /\.\.\.\[[\s\S]*class: 'col col-main'[\s\S]*class: 'col col-need'[\s\S]*\]\.reverse\(\)/, 'columns are emitted need-first');
  const wide = style.match(/@media \(min-width: 1101px\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(wide && /\.col-need\s*\{[^}]*grid-column:2/.test(wide[1]) && /\.col-main\s*\{[^}]*grid-column:1/.test(wide[1]), 'wide layout keeps Needs you on the right');
});
