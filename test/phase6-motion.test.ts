import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

// Phase 6 motion guards over public/index.html: one easing curve, durations only from tokens, reduced motion
// stops everything, the running lamp is the only loop, and live refreshes do not replay entrances.

const html = uiSource();
const rawStyle = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const style = rawStyle.replace(/\/\*[\s\S]*?\*\//g, '');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const PHASE1 = ['--t-fast', '--t-menu', '--t-view'];
// Documented exceptions (see the comment in :root): the lamp loop half-cycle and the Home card stagger.
const ALLOWED = ['--t-lamp', '--t-stagger'];
const DURATION_TOKENS = new Set([...PHASE1, ...ALLOWED]);

/** Every transition / animation declaration (shorthand and longhands) as { prop, value }. */
const decls = [...style.matchAll(/(?:^|[;{\s])((?:transition|animation)(?:-[a-z-]+)?)\s*:\s*([^;{}]+)/g)]
  .map((m) => ({ prop: m[1], value: m[2].replace(/!important/g, '').trim() }));

/** Split on commas that are not inside parentheses. */
const splitTop = (v: string) => {
  const out: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '(') depth++; else if (v[i] === ')') depth--;
    else if (v[i] === ',' && depth === 0) { out.push(v.slice(from, i).trim()); from = i + 1; }
  }
  out.push(v.slice(from).trim());
  return out;
};

/** Body of each `@media (<query>)` block, by brace matching. */
function mediaBlocks(css: string, query: RegExp): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@media\s*([^{]+)\{/g)) {
    if (!query.test(m[1])) continue;
    let depth = 1, i = m.index! + m[0].length;
    const from = i;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    out.push(css.slice(from, i - 1));
  }
  return out;
}

const rootBody = style.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
const tokenValue = (name: string) => rootBody.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim();

test('motion tokens: one easing curve and the Phase 1 durations live in :root', () => {
  assert.strictEqual(tokenValue('--ease'), 'cubic-bezier(0.22, 1, 0.36, 1)');
  assert.strictEqual(tokenValue('--t-fast'), '140ms');
  assert.strictEqual(tokenValue('--t-menu'), '200ms');
  assert.strictEqual(tokenValue('--t-view'), '320ms');
  for (const t of ALLOWED) assert.match(tokenValue(t) ?? '', /^\d+ms$/, `${t} is defined in :root`);
  // The allowlist is documented next to the tokens, in the unstripped stylesheet.
  const rootRaw = rawStyle.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const t of ALLOWED) assert.match(rootRaw, new RegExp(`\\/\\*[\\s\\S]*${t}[\\s\\S]*?\\*\\/`), `${t} is explained in a comment`);
  // No other --t-* token sneaks in.
  const defined = [...rootBody.matchAll(/(--t-[a-z-]+)\s*:/g)].map((m) => m[1]);
  assert.deepStrictEqual(defined.sort(), [...DURATION_TOKENS].sort());
});

test('there are transition and animation declarations to check', () => {
  assert.ok(decls.filter((d) => d.prop === 'transition').length >= 10);
  assert.ok(decls.filter((d) => d.prop === 'animation').length >= 5);
});

test('every transition / animation uses var(--ease) and no other timing function', () => {
  const otherCurve = /cubic-bezier\(|steps\(|\b(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)\b/;
  for (const { prop, value } of decls) {
    if (value === 'none') continue;
    assert.doesNotMatch(value.replace(/var\(--ease\)/g, ''), otherCurve, `${prop}: ${value}`);
    if (prop === 'transition' || prop === 'animation') {
      for (const seg of splitTop(value)) assert.match(seg, /var\(--ease\)/, `${prop} segment "${seg}" names var(--ease)`);
    }
    if (/timing-function$/.test(prop)) assert.strictEqual(value, 'var(--ease)', `${prop}: ${value}`);
  }
  // The only cubic-bezier in the stylesheet is the --ease token itself.
  assert.strictEqual((style.match(/cubic-bezier\(/g) ?? []).length, 1);
});

test('durations come only from --t-* tokens; no raw ms or s values', () => {
  for (const { prop, value } of decls) {
    if (value === 'none') continue;
    assert.doesNotMatch(value, /(?<![\w-])\d*\.?\d+m?s\b/, `${prop}: ${value} has a raw time`);
    for (const m of value.matchAll(/var\((--t-[a-z-]+)\)/g)) assert.ok(DURATION_TOKENS.has(m[1]), `${prop}: ${m[1]} is not a duration token`);
    if (prop === 'transition' || prop === 'animation') {
      for (const seg of splitTop(value)) assert.match(seg, /var\(--t-(?:fast|menu|view|lamp)\)/, `${prop} segment "${seg}" has a token duration`);
    }
  }
  // Allowlisted tokens stay in their one place each.
  const uses = (t: string) => decls.filter((d) => d.value.includes(`var(${t})`));
  assert.deepStrictEqual(uses('--t-lamp').map((d) => d.prop), ['animation']);
  assert.match(uses('--t-lamp')[0].value, /^lamp-run\b/);
  assert.deepStrictEqual(uses('--t-stagger').map((d) => d.prop), ['animation-delay']);
});

test('every named animation has a keyframes block', () => {
  const frames = new Set([...style.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  for (const { prop, value } of decls.filter((d) => d.prop === 'animation' && d.value !== 'none')) {
    const name = value.split(/\s+/)[0];
    assert.ok(frames.has(name), `${prop}: ${value} references missing @keyframes ${name}`);
  }
});

test('prefers-reduced-motion: reduce removes every transition and animation', () => {
  const blocks = mediaBlocks(style, /prefers-reduced-motion\s*:\s*reduce/);
  assert.ok(blocks.length >= 1, 'a reduced-motion block exists');
  const all = blocks.join('\n');
  const rule = all.match(/\*\s*,\s*\*::before\s*,\s*\*::after\s*\{([^}]*)\}/);
  assert.ok(rule, 'the reduce block targets *, *::before, *::after');
  assert.match(rule![1], /transition\s*:\s*none\s*!important/);
  assert.match(rule![1], /animation\s*:\s*none\s*!important/);
  // The script honours the same query for JS-driven motion (count-up, view entrance, board moves).
  assert.match(script, /matchMedia\(\s*'\(prefers-reduced-motion: reduce\)'\s*\)/);
});

test('lamp-run is the only infinite animation', () => {
  const infinite = decls.filter((d) => /\binfinite\b/.test(d.value));
  assert.strictEqual(infinite.length, 1, 'exactly one looping declaration');
  assert.match(infinite[0].value, /^lamp-run\b/);
  assert.strictEqual((style.match(/\binfinite\b/g) ?? []).length, 1);
  // No loops from script either (Web Animations iterations, or an infinite animation string).
  assert.doesNotMatch(script, /iterations\s*:/);
  assert.doesNotMatch(script, /\binfinite\b/);
});

test('refreshes do not replay entrances or swap identical nodes', () => {
  // The view entrance only runs when the shown view changes.
  assert.match(script, /const entering = shown !== shownView;/);
  assert.match(script, /if \(entering\) \{[^}]*enterView\(/);
  // Home cards take .enter only on the render that follows entering Home; otherwise unchanged cards are kept.
  const home = script.match(/function renderHome\(entering\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(home, /if \(!animate\) return keepSame\(\$\('homeGrid'\), cards\);/);
  assert.match(home, /classList\.add\('enter'\)/);
  assert.doesNotMatch(script.match(/function homeCard\(p\) \{([\s\S]*?)\n\}/)?.[1] ?? '', /\benter\b/);
  // Board cards move only when their column changed since the last render of the same project.
  const cols = script.match(/function animateColumnChanges\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(cols, /if \(first \|\| still \|\| prev == null \|\| prev === col\) continue;[\s\S]*classList\.add\('col-in'\)/);
  assert.strictEqual((script.match(/'col-in'/g) ?? []).length, 1, 'col-in is added in one place');
  // Live figures write only on change, and the count-up skips unchanged values.
  assert.match(script, /const setText = \(el, text\) => \{ if \(el\.textContent !== text\) el\.textContent = text; \};/);
  assert.match(script, /if \(from === to\)/);
});

test('live data does not shift layout: tabular figures and a reserved lamp slot', () => {
  assert.match(style, /\.sitem \.num \{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(style, /\.pcard \.pct \{[^}]*width:\s*40px/);
  assert.match(style, /\.lane-head \.cnt \{[^}]*width:\s*56px/);
  // The strip lamp hides with visibility, keeping its slot, instead of toggling display.
  assert.match(style, /\.sitem \.lamp\.idle \{\s*visibility:\s*hidden;\s*\}/);
  assert.doesNotMatch(html, /id="hsLamp"[^>]*\bhidden\b/);
  assert.doesNotMatch(script, /dot\.hidden\s*=|hsLamp'\)\.hidden/);
});
