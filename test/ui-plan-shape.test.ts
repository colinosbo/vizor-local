import { test } from 'node:test';
import assert from 'node:assert';
import { uiSource } from './helpers/ui-source.js';

const src = uiSource();
const plan = src.slice(src.indexOf('// plan.js:'), src.indexOf('// </script>', src.indexOf('// plan.js:')));

test('plan.js builds the shape line from shape.waves, shape.longestChain and shape.hotFiles', () => {
  assert.ok(plan.length > 1000, 'plan.js slice found');
  assert.match(plan, /shape\.waves/);
  assert.match(plan, /shape\.longestChain/);
  assert.match(plan, /shape\.hotFiles/);
  assert.match(plan, /class: 'shape-line'/);
  assert.match(plan, /Array\.isArray\(shape\?\.waves\) \|\| !shape\.waves\.length\) return null/);
});

test('hot files show glob and task count, with the task keys in a title', () => {
  assert.match(plan, /title: f\.tasks\.join\(', '\)/);
  assert.match(plan, /\$\{f\.glob\} · \$\{f\.tasks\.length\}/);
});

test('the chain has a text equivalent', () => {
  assert.match(plan, /'Longest chain: ' \+ chain\.join\(' → '\)/);
});

test('on-chain is applied from shape.chain to nodes and edges', () => {
  assert.match(plan, /plan\.shape\.chain/);
  assert.match(plan, /onChain\.has\(t\.key\) \? ' on-chain' : ''/);
  assert.match(plan, /'data-chain': \[\.\.\.onChain\]\.join\(' '\)/);
  assert.match(plan, /onChainEdge\(d, n\.dataset\.key\)\) cls\.push\('on-chain'\)/);
  assert.match(plan, /chain\[i \+ 1\] === to/);
});

test('the graph wiring stays', () => {
  assert.match(plan, /hooks\.lanes = drawEdges;/);
  assert.match(plan, /requestAnimationFrame\(drawEdges\)/);
});

test('plan.js never writes innerHTML', () => {
  assert.doesNotMatch(plan, /innerHTML/);
});
