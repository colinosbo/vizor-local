import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { uiSource } from './helpers/ui-source.js';

const src = uiSource();
const projects = fs.readFileSync('public/js/projects.js', 'utf8');

test('forge choice, repo and check inputs are bound to the project fields', () => {
  assert.match(projects, /radio\('forgeKind', v, l, n/);
  assert.match(projects, /'local', 'Local'/);
  assert.match(projects, /'github', 'GitHub'/);
  assert.match(projects, /id: 'sGithubRepo'/);
  assert.match(projects, /id: 'sGithubCheck'/);
  assert.match(projects, /p\.forge_kind/);
  assert.match(projects, /fRepo\.value = p\.github_repo/);
  assert.match(projects, /fCheck\.value = p\.github_check \|\| 'ci'/);
  assert.match(projects, /repoField\.hidden = chosenForge\(\) !== 'github'/);
});

test('status line reads forge.ready and forge.problem as text', () => {
  assert.match(projects, /const f = p\.forge/);
  assert.match(projects, /forgeStatus\.textContent = [^;]*f\.ready[^;]*f\.problem/);
});

test('review gate offers Off, Report and Block, each with a plain explanation', () => {
  assert.match(projects, /'off', 'Off', 'No security review'/);
  assert.match(projects, /'report', 'Report', 'Review every PR and show findings, never hold merges'/);
  assert.match(projects, /'block', 'Block', 'Hold merges with critical or high findings until you fix them or merge anyway'/);
  assert.match(projects, /p\.review_gate/);
});

test('config is posted with the forge fields and the review gate, errors shown inline', () => {
  assert.match(projects, /post\(`\/api\/projects\/\$\{encodeURIComponent\(p\.id\)\}\/config`,\s*\{ forgeKind: chosenForge\(\), githubRepo: [^}]*githubCheck:/);
  assert.match(projects, /post\(`\/api\/projects\/\$\{encodeURIComponent\(p\.id\)\}\/config`, \{ reviewGate \}/);
  assert.match(projects, /showErr\(forgeError, m\)/);
  assert.match(projects, /showErr\(gateError, m\)/);
});

test('projects.js never writes innerHTML', () => {
  assert.doesNotMatch(projects, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.ok(src.includes('// ----- Forge and review gate -----'));
});
