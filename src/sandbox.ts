// Disposable target repository + scripted scenario used by the demo and tests ("Demo App").
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';
import type { PlanBody } from './types.js';
import type { FakeScenario } from './workers.js';

export function createTargetRepo(root: string): { bare: string; checkout: string } {
  const bare = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'Demo App'); // path with a space on purpose
  mkdirSync(seed, { recursive: true });
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'demo-app', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
    'README.md': '# Demo App\n',
    'src/app.js': "export const version = () => '1.0.0';\n",
    'test/app.test.js': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { version } from '../src/app.js';\ntest('version', () => assert.equal(version(), '1.0.0'));\n",
  };
  git(seed, ['init', '--quiet', '--initial-branch=main']);
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(seed, p, '..'), { recursive: true }); writeFileSync(join(seed, p), c); }
  git(seed, ['add', '-A']);
  git(seed, ['commit', '--quiet', '-m', 'Initial Demo App']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', '--quiet', 'origin', 'main']);
  git(root, ['clone', '--quiet', bare, checkout]);
  return { bare, checkout };
}

const T = (body: string) => `import test from 'node:test';\nimport assert from 'node:assert';\n${body}\n`;

export const DEMO_PLAN: PlanBody = {
  summary: 'Activity history with CSV export, plus a rest timer',
  tasks: [
    { key: 'history-ui', title: 'Activity history model', prompt: 'Add a history log with addEntry and totalVolume.',
      acceptance: 'addEntry appends; totalVolume sums weight*reps; tests pass', writeScope: ['src/history/*.js', 'test/history.test.js'], deps: [] },
    { key: 'rest-timer', title: 'Rest timer', prompt: 'Add remaining(startMs, nowMs, durationMs) that never goes below 0.',
      acceptance: 'remaining is exact and clamps at 0; tests pass', writeScope: ['src/timer/**', 'test/timer.test.js'], deps: [] },
    { key: 'history-export', title: 'Export history as CSV', prompt: 'Add toCsv(log) using the history model.',
      acceptance: 'CSV has header and one row per entry plus total; tests pass', writeScope: ['src/history/export/**', 'test/history-export.test.js'], deps: ['history-ui'] },
    { key: 'readme-badge', title: 'Misc helper', prompt: 'Add a misc helper.',
      acceptance: 'helper exists', writeScope: ['src/misc/**'], deps: [] },
  ],
};

export const DEMO_SCENARIO: FakeScenario = {
  'history-ui': [{ say: 'Adding history model and tests', sleepMs: 1500, files: {
    'src/history/history.js': 'export const addEntry = (log, e) => [...log, { ...e }];\nexport const totalVolume = (log) => log.reduce((s, e) => s + e.weight * e.reps, 0);\n',
    'test/history.test.js': T("import { addEntry, totalVolume } from '../src/history/history.js';\ntest('volume', () => assert.equal(totalVolume(addEntry([], { weight: 100, reps: 5 })), 500));"),
  } }],
  'rest-timer': [
    { say: 'Adding rest timer (contains an off-by-one bug)', sleepMs: 100, files: {
      'src/timer/timer.js': 'export const remaining = (start, now, dur) => start + dur - now + 1;\n',
      'test/timer.test.js': T("import { remaining } from '../src/timer/timer.js';\ntest('exact', () => assert.equal(remaining(0, 1000, 90000), 89000));\ntest('clamps', () => assert.equal(remaining(0, 99000, 90000), 0));"),
    } },
    { say: 'Repair: fixing off-by-one and clamping at zero', files: {
      'src/timer/timer.js': 'export const remaining = (start, now, dur) => Math.max(0, start + dur - now);\n',
    } },
  ],
  'history-export': [{ say: 'Adding CSV export on top of merged history model', files: {
    'src/history/export/csv.js': "import { totalVolume } from '../history.js';\nexport const toCsv = (log) => ['weight,reps', ...log.map((e) => `${e.weight},${e.reps}`), `total,${totalVolume(log)}`].join('\\n');\n",
    'test/history-export.test.js': T("import { toCsv } from '../src/history/export/csv.js';\ntest('csv', () => assert.equal(toCsv([{ weight: 100, reps: 5 }]), 'weight,reps\\n100,5\\ntotal,500'));"),
  } }],
  // Negative case: writes outside its approved scope.
  'readme-badge': [{ say: 'Adding helper and also editing README (out of scope)', files: {
    'src/misc/helper.js': 'export const noop = () => {};\n',
    'README.md': '# Demo App\n\n![badge](x)\n',
  } }],
};
