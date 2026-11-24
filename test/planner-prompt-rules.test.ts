import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plannerPrompt } from '../src/orchestrator.js';
import type { Project } from '../src/types.js';

const build = (p: Partial<Project>): string => plannerPrompt(p as Project, 'a.js', 'req');
const prompt = build({ ci_command: 'npm ci && npm test', max_workers: 3 });

const RULES: Record<string, string> = {
  a: "List every task's exact write scope",
  b: 'New code goes in new files',
  c: 'Shared touchpoints',
  d: 'Write contracts into the task prompts',
  e: 'tasks per wave (this project',
  f: 'longest dependency chain is more than 4 tasks',
  g: 'One concern per task',
  h: 'End the plan summary with',
};

for (const [letter, phrase] of Object.entries(RULES)) {
  test(`rule ${letter} is in the planner prompt`, () => {
    assert.match(prompt, new RegExp(`^${letter}\\. .*${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
  });
}

test('rule e interpolates max_workers', () => {
  assert.match(prompt, /^e\. Aim for about 3 tasks per wave/m);
});

test('a project without max_workers falls back to 1 and never prints undefined', () => {
  const p = build({ ci_command: 'npm ci && npm test' });
  assert.match(p, /^e\. Aim for about 1 tasks per wave/m);
  assert.ok(!p.includes('undefined'));
});

test('existing rules are kept', () => {
  assert.match(prompt, /"opus"/);
  assert.match(prompt, /"sonnet"/);
  assert.ok(prompt.includes('npm ci && npm test'));
  assert.ok(prompt.includes('node --test'));
  assert.ok(prompt.includes('unslop'));
  assert.ok(prompt.includes('empty tasks array'));
  assert.ok(!prompt.includes('NON-overlapping writeScope globs when they can run in parallel'));
});
