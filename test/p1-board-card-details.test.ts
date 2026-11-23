import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Static checks over public/index.html for the Board card details: nothing here runs the page.

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

/** Source of a top-level `function name(` declaration, up to the next top-level declaration or comment. */
const fnSource = (name: string): string => {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(html);
  assert.ok(m, `function ${name} is missing`);
  const rest = html.slice(m.index + 1);
  const end = rest.search(/^(?:function |\/\/ |const |async function )/m);
  return html.slice(m.index, end < 0 ? undefined : m.index + 1 + end);
};

test('model chip has its own class, focus ring and keyboard reach', () => {
  const chip = fnSource('modelChip');
  assert.match(chip, /class: 'mchip mono'/);
  assert.match(chip, /tabindex: '0'/);
  assert.match(chip, /'aria-label'/);
  assert.match(html, /\.tcard \.mchip:focus-visible\s*\{[^}]*outline/);
  assert.match(html, /\.tcard \.mchip\s*\{[^}]*border:/, 'chip carries a border, not colour alone');
});

test("model chip falls back to 'default' and wires model_why to the tooltip and label", () => {
  const chip = fnSource('modelChip');
  assert.match(chip, /t\.model \|\| 'default'/);
  assert.match(chip, /t\.model_why/);
  assert.match(chip, /title: why \|\| null/);
  assert.match(chip, /aria-label'?: why \? `Model \$\{model\}: \$\{why\}`/);
});

test('chip is rendered on both the full and the merged cards', () => {
  assert.match(fnSource('taskCard'), /modelChip\(t\)/);
  assert.match(html, /const mini = \(t\) =>[\s\S]*?modelChip\(t\)/);
});

test('merged cards show the PR number and a relative merge time without inventing data', () => {
  const label = fnSource('mergedLabel');
  assert.match(label, /`PR #\$\{t\.pr_number\}`/);
  assert.match(label, /merged \$\{ago\(when\)\}/);
  assert.match(label, /t\.updated_at/);
  assert.match(label, /Number\.isFinite/, 'falls back to the PR number alone when the time is unusable');
  assert.match(html, /class: 'merged-label'/);
});

test('running cards keep one shared elapsed timer driven by the attempt start', () => {
  const card = fnSource('taskCard');
  assert.match(card, /t\.status === 'running' && run\) since = sqlTime\(run\.started_at\)/);
  assert.match(card, /class: 'el', 'data-since'/);
  const hooks = html.match(/querySelectorAll\('\.tcard \.el\[data-since\]'\)/g) ?? [];
  assert.strictEqual(hooks.length, 1, 'a single interval updates every elapsed label');
  assert.match(html, /\.tcard \.el \{[^}]*tabular-nums/);
});
