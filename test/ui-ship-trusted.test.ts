import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiSource } from './helpers/ui-source.js';

const src = uiSource();
const ship = readFileSync('public/js/ship.js', 'utf8');

test('ship branches on the github forge kind', () => {
  assert.match(src, /forge\?\.kind === 'github'/);
});

test('github projects see that merges already land on GitHub, named via textContent', () => {
  assert.ok(src.includes('merges already land on GitHub'));
  assert.match(ship, /text: p\.forge\.repo/);
});

test('push controls are gated on the github branch', () => {
  const gate = ship.indexOf("if (trusted) {");
  const elseBranch = ship.indexOf('} else if (!d) gh');
  assert.ok(gate > -1 && elseBranch > gate, 'trusted branch comes first in the GitHub card chain');
  for (const marker of ['data-push', 'pgPanel(p, d)', 'ship-commits', 'Confirm: push']) {
    assert.ok(ship.indexOf(marker, elseBranch) > -1, `${marker} only in the local-forge branch`);
    assert.ok(ship.slice(gate, elseBranch).indexOf(marker) === -1, `${marker} absent from the github branch`);
  }
});

test('pushAll returns early for github projects before posting', () => {
  const fn = ship.slice(ship.indexOf('async function pushAll'));
  const guard = fn.indexOf("p.forge?.kind === 'github'");
  assert.ok(guard > -1);
  assert.ok(guard < fn.indexOf('push-now'));
  assert.ok(guard < fn.indexOf('pushing = true'));
});

test('ship.js never uses innerHTML', () => {
  assert.ok(!/innerHTML/.test(ship));
});
