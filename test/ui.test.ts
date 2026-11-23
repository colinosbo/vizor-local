import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Static guards over public/index.html. Nothing here runs the page: every check is a
// pragmatic text scan, so each heuristic is documented where it is used. The checks
// are exported as pure functions over a string so the tests can also prove that they
// fail on a seeded violation.

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

/** Replace comments with spaces (same length) so offsets stay valid. `//` only counts at line start or after whitespace, so `http://` in strings is safe. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n\s]/g, ' '));

const scriptOf = (src: string): string => {
  const parts: string[] = [];
  // Keep offsets irrelevant: scripts are scanned on their own.
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) parts.push(m[1]);
  return stripComments(parts.join('\n'));
};

/** Index of the bracket that closes the one at `open`, skipping '…', "…" and `…${}…` literals. -1 if unbalanced. */
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
        else if (src[i] === '$' && src[i + 1] === '{') {
          const end = closeOf(src, i + 1);
          if (end < 0) return -1;
          i = end;
        }
      }
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// (a) innerHTML sources
// ---------------------------------------------------------------------------

/**
 * Every write to an HTML sink. Allowed: `.innerHTML = ICONS[name]` (the icon() helper)
 * and `.innerHTML = COPY_ICON`, both constant strings. Anything else is reported:
 * template strings, concatenation, `+=`, outerHTML, insertAdjacentHTML, document.write.
 */
export function innerHtmlViolations(src: string): string[] {
  const code = scriptOf(src);
  const bad: string[] = [];
  const sink = /\.\s*(innerHTML|outerHTML)\s*(\+?=)(?!=)\s*([^;\n]*)|\[\s*['"](innerHTML|outerHTML)['"]\s*\]\s*(\+?=)(?!=)|\.\s*insertAdjacentHTML\s*\(|document\s*\.\s*write(?:ln)?\s*\(/g;
  for (const m of code.matchAll(sink)) {
    const rhs = (m[3] ?? '').trim();
    const allowed = m[1] === 'innerHTML' && m[2] === '=' && /^(?:ICONS\[name\]|COPY_ICON)$/.test(rhs);
    if (!allowed) bad.push(m[0].trim());
  }
  return bad;
}

test('innerHTML is only assigned from the constant icon map', () => {
  assert.deepStrictEqual(innerHtmlViolations(html), []);
  const allowed = [...scriptOf(html).matchAll(/\.innerHTML\s*=\s*(ICONS\[name\]|COPY_ICON)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(allowed, ['COPY_ICON', 'ICONS[name]'], 'the two icon assignments are still present');
  // The guard has to bite on each way of smuggling data in.
  for (const bad of [
    '<script>x.innerHTML = data.title;</script>',
    '<script>x.innerHTML = `<b>${data.title}</b>`;</script>',
    "<script>x.innerHTML = '<b>' + t + '</b>';</script>",
    '<script>x.innerHTML += ICONS[name];</script>',
    '<script>x.outerHTML = COPY_ICON;</script>',
    "<script>x.insertAdjacentHTML('beforeend', t);</script>",
  ]) assert.ok(innerHtmlViolations(bad).length > 0, `flags ${bad}`);
  assert.deepStrictEqual(innerHtmlViolations('<script>s.innerHTML = ICONS[name];</script>'), []);
});

// ---------------------------------------------------------------------------
// (b) button labels
// ---------------------------------------------------------------------------

/**
 * Static markup: `<button …>inner</button>` passes when it has a non-empty aria-label,
 * or its inner markup has visible text once tags (svg, empty spans) are stripped.
 */
export function unlabeledStaticButtons(src: string): string[] {
  const markup = stripComments(src.replace(/<script\b[\s\S]*?<\/script>/g, ''));
  const bad: string[] = [];
  for (const m of markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const labelled = /\baria-label\s*=\s*"[^"]+"/.test(m[1]) || /\baria-labelledby\s*=\s*"[^"]+"/.test(m[1]);
    const text = m[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!labelled && !text) bad.push(m[0]);
  }
  return bad;
}

/** Calls of the element helper that create a button: h('button', …), el('button', …), createElement('button'). */
const BUTTON_CALL = /\b(?:h|el|createElement)\(\s*(['"])button\1/g;

/** Remove every `icon(…)` call (an svg with aria-hidden never counts as a label) and the leading attrs object. */
function childArgsOf(call: string): string {
  const comma = call.indexOf(',');
  if (comma < 0) return '';
  let rest = call.slice(comma + 1).replace(/^\s+/, '');
  if (rest.startsWith('{')) {
    const end = closeOf(rest, 0);
    rest = end < 0 ? '' : rest.slice(end + 1);
  }
  for (let at = rest.search(/\bicon\(/); at >= 0; at = rest.search(/\bicon\(/)) {
    const end = closeOf(rest, rest.indexOf('(', at));
    rest = rest.slice(0, at) + (end < 0 ? '' : rest.slice(end + 1));
  }
  return rest.replace(/[\s,)]/g, '');
}

/**
 * Script-built buttons. A call passes when its props carry `aria-label` or `text:`, or it
 * has child arguments left after removing icon() calls and the attrs object (a string,
 * template, h('span', …) or identifier child is taken to be visible text). An icon-only
 * call whose props spread a caller-supplied object (`...attrs`) is a helper: every call
 * of that helper (`name({ … })`) must then itself pass an aria-label.
 */
export function unlabeledScriptButtons(src: string): string[] {
  const code = scriptOf(src);
  const bad: string[] = [];
  for (const m of code.matchAll(BUTTON_CALL)) {
    const open = m.index! + m[0].indexOf('(');
    const end = closeOf(code, open);
    if (end < 0) { bad.push(`unbalanced call at ${m.index}`); continue; }
    const call = code.slice(open + 1, end);
    if (/['"]aria-label['"]\s*:/.test(call) || /(^|[,{\s])text\s*:/.test(call) || childArgsOf(call)) continue;
    if (/\.\.\.\s*\w+/.test(call)) {
      const named = [...code.slice(Math.max(0, m.index! - 200), m.index!).matchAll(/(?:const|let)\s+(\w+)\s*=\s*\(/g)];
      const name = named.at(-1)?.[1];
      let ok = !!name;
      for (const c of name ? code.matchAll(new RegExp(`(?<![\\w.])${name}\\(\\s*\\{`, 'g')) : []) {
        const cEnd = closeOf(code, c.index! + c[0].indexOf('('));
        if (!/['"]aria-label['"]\s*:/.test(code.slice(c.index!, cEnd))) ok = false;
      }
      if (ok) continue;
    }
    bad.push(code.slice(m.index!, Math.min(end + 1, m.index! + 120)));
  }
  return bad;
}

test('static <button> elements have visible text or an aria-label', () => {
  assert.deepStrictEqual(unlabeledStaticButtons(html), []);
  assert.ok((html.match(/<button\b/g) ?? []).length > 5, 'buttons were found at all');
  for (const bad of ['<button></button>', '<button class="btn" type="button"> <svg aria-hidden="true"></svg> </button>'])
    assert.strictEqual(unlabeledStaticButtons(bad).length, 1, `flags ${bad}`);
  for (const ok of ['<button aria-label="Close"><svg></svg></button>', '<button>Save</button>'])
    assert.deepStrictEqual(unlabeledStaticButtons(ok), []);
});

test('script-built buttons have text, children or an aria-label', () => {
  assert.deepStrictEqual(unlabeledScriptButtons(html), []);
  assert.ok([...scriptOf(html).matchAll(BUTTON_CALL)].length > 20, 'script buttons were found at all');
  for (const bad of [
    "<script>const a = h('button', { class: 'btn' });</script>",
    "<script>const a = h('button', { class: 'btn' }, icon('x'));</script>",
    "<script>const a = document.createElement('button');</script>",
    "<script>const btn = (attrs, ic) => h('button', { ...attrs }, icon(ic)); btn({ title: 'x' }, 'up');</script>",
  ]) assert.ok(unlabeledScriptButtons(bad).length > 0, `flags ${bad}`);
  for (const ok of [
    "<script>h('button', { class: 'btn', 'aria-label': 'Close' }, icon('x'));</script>",
    "<script>h('button', { class: 'btn', text: 'Go' });</script>",
    "<script>h('button', { class: 'btn' }, icon('x'), 'Go');</script>",
    "<script>const btn = (attrs, ic) => h('button', { ...attrs }, icon(ic)); btn({ 'aria-label': 'Up' }, 'up');</script>",
  ]) assert.deepStrictEqual(unlabeledScriptButtons(ok), [], `accepts ${ok}`);
});

// ---------------------------------------------------------------------------
// (c) one primary per section
// ---------------------------------------------------------------------------

const classTokens = (attrs: string): string[] => (/\bclass\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/);

/**
 * Static markup: every `<section>…</section>` (these are the top-level view containers,
 * and do not nest) may hold at most one element whose class list has both `btn` and `primary`.
 * Returns one entry per offending section.
 */
export function staticPrimaryViolations(src: string): string[] {
  const markup = stripComments(src.replace(/<script\b[\s\S]*?<\/script>/g, ''));
  const bad: string[] = [];
  for (const s of markup.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)) {
    let n = 0;
    for (const t of s[2].matchAll(/<(?:button|a|div|span|input)\b([^>]*)>/g)) {
      const cls = classTokens(t[1]);
      if (cls.includes('btn') && cls.includes('primary')) n++;
    }
    if (n > 1) bad.push(`${/\bid="([^"]*)"/.exec(s[1])?.[1] ?? 'section'}: ${n} primaries`);
  }
  return bad;
}

/**
 * Script: a builder is a top-level `function name(` or `const name = (` / `async` form
 * (column 0), running to the next one. Each builder may create at most one button whose
 * `class:` string has both `btn` and `primary`. Branches of one ternary count too: if two
 * primaries can never show together, one still has to be a plain `btn` and be promoted at
 * render time, which keeps this check simple.
 */
export function scriptPrimaryViolations(src: string): string[] {
  const code = scriptOf(src);
  const starts = [...code.matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/gm)];
  const bad: string[] = [];
  starts.forEach((s, i) => {
    const body = code.slice(s.index!, starts[i + 1]?.index ?? code.length);
    let n = 0;
    for (const m of body.matchAll(BUTTON_CALL)) {
      const open = m.index! + m[0].indexOf('(');
      const end = closeOf(body, open);
      const cls = /\bclass\s*:\s*(['"`])([^'"`]*)\1/.exec(body.slice(open, end < 0 ? undefined : end))?.[2].split(/\s+/) ?? [];
      if (cls.includes('btn') && cls.includes('primary')) n++;
    }
    if (n > 1) bad.push(`${s[1] ?? s[2]}: ${n} primaries`);
  });
  return bad;
}

test('at most one .btn.primary per static section', () => {
  assert.deepStrictEqual(staticPrimaryViolations(html), []);
  assert.ok((html.match(/<section\b/g) ?? []).length >= 5, 'sections were found at all');
  assert.ok(/class="btn primary"/.test(html), 'a static primary exists');
  const two = '<section id="v-x"><button class="btn primary">A</button><div><button class="btn primary" type="button">B</button></div></section>';
  assert.strictEqual(staticPrimaryViolations(two).length, 1);
  const split = '<section><button class="btn primary">A</button></section><section><button class="btn primary">B</button></section>';
  assert.deepStrictEqual(staticPrimaryViolations(split), []);
  assert.deepStrictEqual(staticPrimaryViolations('<section><button class="btn primary">A</button><button class="btn ghost primaryish">B</button></section>'), []);
});

test('script builders create at most one .btn.primary each', () => {
  assert.deepStrictEqual(scriptPrimaryViolations(html), []);
  const two = "<script>\nfunction renderX() {\n  return [h('button', { class: 'btn primary' }, 'A'), h('button', { class: 'btn primary', type: 'button' }, 'B')];\n}\n</script>";
  assert.strictEqual(scriptPrimaryViolations(two).length, 1);
  const split = "<script>\nfunction a() { return h('button', { class: 'btn primary' }, 'A'); }\nfunction b() { return h('button', { class: 'btn primary' }, 'B'); }\n</script>";
  assert.deepStrictEqual(scriptPrimaryViolations(split), []);
});
