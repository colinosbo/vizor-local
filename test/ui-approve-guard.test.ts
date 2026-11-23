import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

test('in-flight rule mirrors the server: running/waiting_ci/merging or an unmerged PR', () => {
  assert.match(html, /\['running', 'waiting_ci', 'merging'\]\.includes\(t\.status\)/);
  assert.match(html, /t\.pr_number != null && !\['merged', 'cancelled'\]\.includes\(t\.status\)/);
});

test('approve checks client state first and posts nothing when tasks are in flight', () => {
  assert.match(html, /const mine = prev \? inFlightOf\(prev\.id\) : \[\];\s*if \(mine\.length\) return openApproveGuard\(plan\.id, mine\);/);
});

test('panel states the consequence plainly and lists key, status and PR', () => {
  assert.match(html, /Approving anyway holds/);
  assert.match(html, /for an owner decision/);
  assert.match(html, /will not merge unless you later choose Merge anyway/);
  assert.match(html, /`PR #\$\{t\.pr_number\}`/);
  assert.match(html, /`Approve and hold \$\{n\} \$\{n === 1 \? 'task' : 'tasks'\}`/);
  const start = html.indexOf('let approveGuard = null');
  const end = html.indexOf('// ----- Roadmap');
  assert.ok(start > 0 && end > start, 'guard block found');
  assert.doesNotMatch(html.slice(start, end), /window\.confirm/);
});

test('force body is sent only from the confirm action', () => {
  const hits = html.match(/force: true/g) || [];
  assert.strictEqual(hits.length, 1);
  assert.match(html, /const confirm = async \(\) => \{\s*const ok = await post\(`\/api\/plans\/\$\{plan\.id\}\/approve`, \{ force: true \}\);/);
  assert.match(html, /'data-confirm': '', onclick: confirm/);
});

test('a 409 with inFlight opens the same panel from the server list', () => {
  assert.match(html, /Array\.isArray\(j\?\.inFlight\) && j\.inFlight\.length\) openApproveGuard\(plan\.id, j\.inFlight\)/);
  assert.match(html, /fail\(j\.error \|\| `Request failed \(\$\{r\.status\}\)`, j\)/);
});

test('Cancel is the focused default; Enter and Escape cancel', () => {
  assert.match(html, /querySelector\('\.guard \[data-default\]'\)\?\.focus\(\)/);
  assert.match(html, /class: 'btn primary', 'data-default': '', onclick: closeApproveGuard \}, 'Cancel'/);
  assert.match(html, /class: 'btn danger', 'data-confirm'/);
  assert.match(html, /e\.key === 'Escape'\) \{[^}]*closeApproveGuard\(\)/);
  assert.match(html, /e\.key === 'Enter' && !e\.target\.hasAttribute\('data-confirm'\)\) \{[^}]*closeApproveGuard\(\)/);
});

test('board keys stay out of the panel and Escape still closes it', () => {
  assert.match(html, /if \(approveGuard && e\.key === 'Escape'\) return closeApproveGuard\(\);\s*if \(e\.target\.closest\?\.\('\.guard'\)\) return;\s*if \(typing \|\| e\.ctrlKey/);
});
