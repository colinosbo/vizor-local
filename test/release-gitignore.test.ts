import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Release hygiene: .gitignore must keep its original entries and ignore secrets, logs and local data.

const lines = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim());

const ORIGINAL = ['node_modules/', 'dist/', '*.db', '*.db-*', 'worktrees/', 'private/'];
const REQUIRED = ['.env*', '*.pem', '*.key', 'server.json', '*.log', '.claude/settings.local.json', '.local-poc/', '.DS_Store'];

for (const pattern of ORIGINAL) {
  test(`.gitignore keeps original entry ${pattern}`, () => {
    assert.ok(lines.includes(pattern), `missing original entry: ${pattern}`);
  });
}

for (const pattern of REQUIRED) {
  test(`.gitignore ignores ${pattern}`, () => {
    assert.ok(lines.includes(pattern), `missing release pattern: ${pattern}`);
  });
}
