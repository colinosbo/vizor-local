import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Phase 6 accessibility guards over public/index.html: the live region, tab order, focus rings,
// colour contrast of the declared tokens, and status that never relies on colour alone.
// Static text scans like test/ui.test.ts; each check is a pure function over a string so the
// tests can also prove it fails on a seeded violation.

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n\s]/g, ' '));
const styleOf = (src: string): string => [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const scriptOf = (src: string): string => stripComments([...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'));
const markupOf = (src: string): string => stripComments(src.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, ''));

/** Index of the bracket closing the one at `open`, skipping string and template literals. -1 if unbalanced. */
function closeOf(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '$' && src[i + 1] === '{') { const end = closeOf(src, i + 1); if (end < 0) return -1; i = end; }
      }
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Split a call's argument text on top-level commas. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ('([{\'"`'.includes(c)) {
      const end = c === "'" || c === '"' || c === '`' ? closeString(args, i) : closeOf(args, i);
      if (end < 0) break;
      i = end;
    } else if (c === ',') { out.push(args.slice(from, i)); from = i + 1; }
  }
  out.push(args.slice(from));
  return out.map((a) => a.trim()).filter(Boolean);
}
function closeString(src: string, open: number): number {
  const q = src[open];
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (q === '`' && src[i] === '$' && src[i + 1] === '{') { const end = closeOf(src, i + 1); if (end < 0) return -1; i = end; }
    else if (src[i] === q) return i;
  }
  return -1;
}

/** CSS rules as [selector, declarations]. Rules inside @media blocks come out with their own selector. */
const cssRules = (css: string): Array<[string, string]> =>
  [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);

// ---------------------------------------------------------------------------
// Live region and announce()
// ---------------------------------------------------------------------------

/** Elements carrying aria-live that are visually hidden (class vh). Returns their opening tags. */
export const hiddenLiveRegions = (src: string): string[] =>
  [...markupOf(src).matchAll(/<\w+\b[^>]*\baria-live="polite"[^>]*>/g)].map((m) => m[0]).filter((t) => /\bclass="[^"]*\bvh\b/.test(t));

/** Body of `function announce(…) { … }`, or null. */
function announceBody(src: string): string | null {
  const code = scriptOf(src);
  const at = code.search(/\bfunction\s+announce\s*\(/);
  if (at < 0) return null;
  const open = code.indexOf('{', at);
  const end = closeOf(code, open);
  return end < 0 ? null : code.slice(open + 1, end);
}

test('one visually hidden polite live region, written with textContent', () => {
  const regions = hiddenLiveRegions(html);
  assert.strictEqual(regions.length, 1, 'exactly one visually hidden aria-live region');
  assert.match(regions[0], /\brole="status"/);
  assert.match(regions[0], /\bid="announcer"/);
  const body = announceBody(html);
  assert.ok(body, 'announce(msg) exists');
  assert.match(body, /\$\('announcer'\)\.textContent\s*=\s*msg/);
  assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML|outerHTML/);
  // The .vh class really hides visually without display:none or visibility:hidden (which would also silence it).
  const vh = cssRules(styleOf(html)).find(([sel]) => sel === '.vh');
  assert.ok(vh, '.vh exists');
  assert.match(vh[1], /position:absolute/);
  assert.doesNotMatch(vh[1], /display:\s*none|visibility:\s*hidden/);
  // Seeded violations.
  assert.deepStrictEqual(hiddenLiveRegions('<div aria-live="polite"></div>'), []);
  assert.strictEqual(hiddenLiveRegions('<div class="vh" aria-live="polite"></div>').length, 1);
});

/** Run the announce section of the page in a sandbox and return a driver. */
function announceSandbox(current: string) {
  const code = scriptOf(html);
  const from = code.search(/\bfunction\s+announce\s*\(/), to = code.indexOf('async function refresh(');
  assert.ok(from >= 0 && to > from, 'announce section precedes refresh()');
  const region = { textContent: '' };
  const said: string[] = [];
  const ctx = vm.createContext({ current, $: (id: string) => (id === 'announcer' ? new Proxy(region, { set: (o, k, v) => { if (k === 'textContent') said.push(v); return Reflect.set(o, k, v); } }) : null) });
  vm.runInContext(code.slice(from, to) + '\nglobalThis.announceTransitions = announceTransitions;', ctx);
  return { run: (st: unknown) => (ctx.announceTransitions as (s: unknown) => void)(st), said };
}

test('announces task held, task merged and plan ready, only on transitions', () => {
  const { run, said } = announceSandbox('p1');
  const projects = [{ id: 'p1', name: 'App' }, { id: 'p2', name: 'Site' }];
  const st = (tasks: object[], plans: object[]) => ({ projects, tasks, plans });
  const a = { id: 1, project_id: 'p1', title: 'Add login', status: 'running' };
  const draft = { id: 7, project_id: 'p1', version: 2, status: 'draft' };

  run(st([{ ...a, status: 'blocked' }], [draft]));
  assert.deepStrictEqual(said, [], 'first load announces nothing, even for held tasks and draft plans');
  run(st([{ ...a, status: 'blocked' }], [draft]));
  assert.deepStrictEqual(said, [], 'an unchanged snapshot (the 30s refresh) announces nothing');

  run(st([a], [{ ...draft, status: 'approved' }]));
  assert.deepStrictEqual(said, [], 'running and approved are not announced');
  run(st([{ ...a, status: 'blocked' }], [{ ...draft, status: 'approved' }]));
  assert.deepStrictEqual(said.splice(0), ['Task held: Add login']);
  run(st([{ ...a, status: 'merged' }], [{ ...draft, status: 'approved' }, { id: 8, project_id: 'p2', version: 1, status: 'draft' }]));
  assert.deepStrictEqual(said.splice(0), ['Task merged: Add login. Plan v1 ready for review in Site']);

  const wave = [2, 3, 4].map((id) => ({ id, project_id: 'p1', title: 'T' + id, status: 'merging' }));
  run(st(wave, []));
  run(st(wave.map((t) => ({ ...t, status: 'merged' })), []));
  assert.deepStrictEqual(said.splice(0), ['3 tasks merged'], 'a burst is read as one count');
});

test('refresh() feeds every /api/state snapshot to announceTransitions', () => {
  const code = scriptOf(html);
  const at = code.indexOf('async function refresh(');
  const body = code.slice(at, closeOf(code, code.indexOf('{', at)) + 1);
  assert.match(body, /state\s*=\s*await r\.json\(\);[\s\S]*announceTransitions\(state\)/);
  // The 30s timer only re-renders; it must not be the thing that announces.
  for (const m of code.matchAll(/setInterval\(([\s\S]*?),\s*\d+\)/g)) assert.doesNotMatch(m[1], /announce/);
});

// ---------------------------------------------------------------------------
// Tab order and focus rings
// ---------------------------------------------------------------------------

/** Every positive tabindex in markup or script. */
export function positiveTabindex(src: string): string[] {
  const bad: string[] = [];
  for (const m of markupOf(src).matchAll(/\btabindex\s*=\s*["']?\s*\+?([0-9]+)/gi)) if (Number(m[1]) > 0) bad.push(m[0]);
  const code = scriptOf(src);
  for (const m of code.matchAll(/['"]?tabindex['"]?\s*:\s*['"`]?\s*\+?([0-9]+)/gi)) if (Number(m[1]) > 0) bad.push(m[0]);
  for (const m of code.matchAll(/\.tabIndex\s*=\s*['"]?\s*\+?([0-9]+)/g)) if (Number(m[1]) > 0) bad.push(m[0]);
  for (const m of code.matchAll(/setAttribute\(\s*['"]tabindex['"]\s*,\s*['"`]?\s*\+?([0-9]+)/gi)) if (Number(m[1]) > 0) bad.push(m[0]);
  return bad;
}

test('no positive tabindex anywhere', () => {
  assert.deepStrictEqual(positiveTabindex(html), []);
  assert.ok(/tabindex: '0'/.test(html), 'the focusable cards were found at all');
  for (const bad of ['<div tabindex="2"></div>', "<script>h('div', { tabindex: '3' });</script>", '<script>x.tabIndex = 1;</script>', "<script>x.setAttribute('tabindex', '5');</script>"])
    assert.strictEqual(positiveTabindex(bad).length, 1, `flags ${bad}`);
  assert.deepStrictEqual(positiveTabindex(`<div tabindex="0"></div><script>h('textarea', { tabindex: '-1' });</script>`), []);
});

/** Rules that remove the outline (none or 0) without drawing a border or box-shadow ring in the same rule. */
export function bareOutlineRemovals(src: string): string[] {
  return cssRules(styleOf(src))
    .filter(([, decl]) => /(?:^|[;\s])outline\s*:\s*(?:none|0)\b/.test(decl))
    .filter(([, decl]) => !/(?:^|[;\s])(?:border(?:-color)?|box-shadow)\s*:\s*(?!none)[^;]+/.test(decl))
    .map(([sel]) => sel);
}

test('outline is only removed where a border or box-shadow ring replaces it', () => {
  assert.deepStrictEqual(bareOutlineRemovals(html), []);
  const css = cssRules(styleOf(html));
  const global = css.find(([sel]) => sel === ':focus-visible');
  assert.ok(global && /outline:2px solid var\(--accent\)/.test(global[1]), 'one global :focus-visible ring');
  assert.ok(css.some(([sel, d]) => sel.includes('.pal-opt[aria-selected="true"]') && /border-color:var\(--accent\)/.test(d)), 'active palette option has the accent ring');
  assert.ok(css.some(([sel, d]) => sel === '.prow:focus-visible' && /outline-offset:-2px/.test(d)), 'rows in clipped panels draw the ring inside');
  for (const bad of ['<style>a:focus { outline:none; }</style>', '<style>b:focus-visible { outline:0; color:red; }</style>'])
    assert.strictEqual(bareOutlineRemovals(bad).length, 1, `flags ${bad}`);
  for (const ok of ['<style>i:focus-visible { outline:none; box-shadow:0 0 0 2px red; }</style>', '<style>i:focus-visible { outline:none; border-color:red; }</style>'])
    assert.deepStrictEqual(bareOutlineRemovals(ok), [], `accepts ${ok}`);
});

// ---------------------------------------------------------------------------
// Contrast of the declared token pairs
// ---------------------------------------------------------------------------

/** WCAG 2.x relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `--name:#hex` declarations in :root. */
export function rootTokens(src: string): Record<string, string> {
  const root = cssRules(styleOf(src)).find(([sel]) => sel === ':root');
  if (!root) return {};
  return Object.fromEntries([...root[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

// Every text or icon colour, against every surface it can sit on.
const FOREGROUNDS = ['--text', '--text-2', '--muted', '--accent', '--pos', '--neg', '--neg-text'];
const SURFACES = ['--deep', '--page', '--card', '--raised', '--raised-2'];
const PAIRS: Array<[string, string]> = [...FOREGROUNDS.flatMap((f) => SURFACES.map((s): [string, string] => [f, s])), ['--on-accent', '--accent']];

test('luminance and contrast match the WCAG reference values', () => {
  assert.strictEqual(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.strictEqual(contrast('#ffffff', '#ffffff').toFixed(2), '1.00');
  assert.strictEqual(contrast('#767676', '#ffffff').toFixed(2), '4.54'); // the classic lightest grey that passes on white
  assert.ok(contrast('#777777', '#ffffff') < 4.5);
});

test('every declared foreground/background token pair reaches 4.5:1', () => {
  const tokens = rootTokens(html);
  const low: string[] = [];
  for (const [fg, bg] of PAIRS) {
    assert.ok(tokens[fg] && tokens[bg], `${fg} and ${bg} are declared as #rrggbb in :root`);
    const r = contrast(tokens[fg], tokens[bg]);
    if (r < 4.5) low.push(`${fg} ${tokens[fg]} on ${bg} ${tokens[bg]}: ${r.toFixed(2)}`);
  }
  assert.deepStrictEqual(low, []);
  // The guard bites: the old muted grey failed on raised surfaces.
  assert.ok(contrast('#85858b', tokens['--raised']) < 4.5);
});

test('the ratio table in the :root comment matches the computed ratios', () => {
  const tokens = rootTokens(html);
  const css = styleOf(html);
  for (const fg of FOREGROUNDS) {
    const row = new RegExp(`^\\s*${fg}\\s+(#[0-9a-f]{6})\\s+([\\d. /]+?)\\s*(?:\\(|$)`, 'im').exec(css);
    assert.ok(row, `${fg} has a row in the contrast comment`);
    assert.strictEqual(row[1].toLowerCase(), tokens[fg], `${fg} comment colour matches the token`);
    const listed = row[2].split('/').map((x) => x.trim());
    assert.deepStrictEqual(listed, SURFACES.map((s) => contrast(tokens[fg], tokens[s]).toFixed(2)), `${fg} ratios`);
  }
  const onAccent = /--on-accent\s+(#[0-9a-f]{6}) on --accent\s+([\d.]+)/i.exec(css);
  assert.ok(onAccent && onAccent[2] === contrast(tokens['--on-accent'], tokens['--accent']).toFixed(2), '--on-accent row');
});

test('text colours use tokens, not stray hex values', () => {
  // A hardcoded colour would dodge the table above. Hex is allowed in :root and in the comment only.
  const rules = cssRules(styleOf(html)).filter(([sel]) => sel !== ':root');
  const stray = rules.filter(([, d]) => /(?:^|[;\s])color\s*:\s*#/.test(d)).map(([sel]) => sel);
  assert.deepStrictEqual(stray, []);
  assert.doesNotMatch(scriptOf(html), /['"]color:\s*#|['"]#[0-9a-f]{6}['"]/i);
});

// ---------------------------------------------------------------------------
// Status is never colour alone
// ---------------------------------------------------------------------------

/** Rules hiding a status label or the visually hidden class with display:none or visibility:hidden. */
export function hiddenStatusLabels(src: string): string[] {
  return cssRules(styleOf(src))
    .filter(([sel]) => /\.(?:lbl|status|vh)\b/.test(sel))
    .filter(([, d]) => /display\s*:\s*none|visibility\s*:\s*hidden/.test(d))
    .map(([sel]) => sel);
}

test('status labels are never display:none, even at narrow widths', () => {
  assert.deepStrictEqual(hiddenStatusLabels(html), []);
  const narrow = /@media \(max-width: 1100px\) \{ header \.sitem \.lbl \{([^}]*)\}/.exec(styleOf(html));
  assert.ok(narrow, 'the header strip labels still have a narrow-width rule');
  assert.match(narrow[1], /position:absolute/);
  assert.match(narrow[1], /clip-path:inset\(50%\)/);
  assert.strictEqual(hiddenStatusLabels('<style>@media (max-width: 900px) { .sitem .lbl { display:none; } }</style>').length, 1);
});

/**
 * Every lamp has text beside it. Static markup: the line holding the lamp also holds a .lbl (the
 * markup writes each strip item on one line; nested spans make a parent-element regex unreliable).
 * Script: every `lamp(…)` call either passes a label (second argument, rendered as .vh text),
 * or is an argument of an h(…) call that has other children after the props once lamp() and
 * icon() calls are removed (a status word or a title). Lamps are only made through lamp().
 */
export function unlabeledLamps(src: string): string[] {
  const bad: string[] = [];
  for (const line of markupOf(src).split('\n'))
    if (/class="lamp\b/.test(line) && !/class="[^"]*\blbl\b/.test(line)) bad.push(line.trim().slice(0, 120));
  const code = scriptOf(src);
  for (const m of code.matchAll(/['"`]lamp\b/g)) {
    const line = code.slice(code.lastIndexOf('\n', m.index!) + 1, code.indexOf('\n', m.index!));
    if (!/^const lamp = \(kind, label\)/.test(line)) bad.push('lamp made outside lamp(): ' + line.trim().slice(0, 100));
  }
  // Ranges of every h(...) call, to find the innermost one around each lamp().
  const calls = [...code.matchAll(/\bh\(/g)].map((c) => { const open = c.index! + 1; return { open, end: closeOf(code, open) }; }).filter((c) => c.end > 0);
  for (const m of code.matchAll(/(?<![\w.])lamp\(/g)) {
    const open = m.index! + 4, end = closeOf(code, open);
    if (end < 0) { bad.push(`unbalanced lamp( at ${m.index}`); continue; }
    if (splitArgs(code.slice(open + 1, end)).length >= 2) continue;
    const outer = calls.filter((c) => c.open < m.index! && c.end > end).sort((a, b) => (a.end - a.open) - (b.end - b.open))[0];
    const rest = outer ? splitArgs(code.slice(outer.open + 1, outer.end)).slice(2)
      .filter((a) => !/^(?:lamp|icon|infoBtn)\(/.test(a) && !/^null$/.test(a)) : [];
    if (!rest.length) bad.push(code.slice(m.index!, Math.min(end + 1, m.index! + 100)));
  }
  return bad;
}

test('every lamp is paired with label text', () => {
  assert.deepStrictEqual(unlabeledLamps(html), []);
  assert.ok([...scriptOf(html).matchAll(/(?<![\w.])lamp\(/g)].length > 20, 'lamp calls were found at all');
  // The helper renders the label as visually hidden text inside the lamp.
  assert.match(scriptOf(html), /const lamp = \(kind, label\) => h\('span', \{ class: 'lamp ' \+ \(kind \|\| ''\), title: label \|\| null \}, label \? h\('span', \{ class: 'vh', text: label \}\) : null\);/);
  for (const bad of [
    "<script>\nconst lamp = (kind, label) => 1;\nh('button', { class: 'nav' }, lamp(kind));</script>",
    "<script>\nconst lamp = (kind, label) => 1;\nh('div', { class: 'row' }, lamp('ok'), icon('x'));</script>",
    "<script>\nconst lamp = (kind, label) => 1;\nconst dot = h('span', { class: 'lamp live' });</script>",
    '<div class="sitem"><span class="lamp live"></span><span class="num">3</span></div>',
  ]) assert.ok(unlabeledLamps(bad).length > 0, `flags ${bad}`);
  for (const ok of [
    "<script>\nconst lamp = (kind, label) => 1;\nh('span', { class: 'status' }, lamp(kind), label);</script>",
    "<script>\nconst lamp = (kind, label) => 1;\nh('button', { class: 'nav' }, lamp(kind, 'Held'));</script>",
    '<div class="sitem"><span class="lamp live"></span><span class="lbl">workers busy</span></div>',
  ]) assert.deepStrictEqual(unlabeledLamps(ok), [], `accepts ${ok}`);
});
