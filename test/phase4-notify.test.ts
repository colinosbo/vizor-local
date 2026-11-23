import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

// Body of the settings toggle handler: from its assignment to the first line that closes it.
function toggleHandler(): { start: number; end: number } {
  const start = html.indexOf("$('sNotify').onchange = async");
  assert.ok(start >= 0, 'settings toggle handler exists');
  const end = html.indexOf('\n};', start);
  assert.ok(end > start, 'settings toggle handler is closed');
  return { start, end };
}

test('requestPermission is called only inside the settings toggle handler', () => {
  const calls = [...html.matchAll(/requestPermission/g)].map((m) => m.index!);
  assert.strictEqual(calls.length, 1, 'exactly one requestPermission call');
  const { start, end } = toggleHandler();
  assert.ok(calls[0] > start && calls[0] < end, 'requestPermission sits inside the toggle handler');
  // Not at top level: the call is preceded by the handler's own await, inside its function body.
  assert.match(html.slice(start, end), /await Notification\.requestPermission\(\)/);
});

test('notifications are off by default', () => {
  assert.match(html, /<input type="checkbox" id="sNotify">/, 'checkbox has no checked attribute');
  assert.match(html, /const notifyKey = \(pid\) => 'vizor\.notify\.' \+ pid/, 'setting is stored per project');
  assert.match(html, /localStorage\.getItem\(notifyKey\(pid\)\) === '1'/, 'only an explicit opt-in turns it on');
  assert.match(html, /\$\('sNotify'\)\.checked = notifyOn\(p\.id\)/);
});

test('denied permission unticks the box and explains with a toast', () => {
  const { start, end } = toggleHandler();
  const body = html.slice(start, end);
  assert.match(body, /box\.checked = false/);
  assert.match(body, /toast\(perm === 'denied'/);
});

test('the option is hidden when the Notification API is missing', () => {
  assert.match(html, /const canNotify = 'Notification' in window/);
  assert.match(html, /\$\('sNotifyRow'\)\.hidden = \$\('sNotifyHint'\)\.hidden = !canNotify/);
});

test('refresh seeds the first snapshot and notifies only the four transitions, once each', () => {
  assert.match(html, /state = await r\.json\(\);\s*notifyTransitions\(state\)/);
  assert.match(html, /if \(!prev \|\| !canNotify\) return; \/\/ first load only seeds the snapshot/);
  assert.match(html, /notified\.has\(f\.key\)/);
  const facts = html.slice(html.indexOf('function notifyFacts('), html.indexOf('let notifyPrev'));
  const keys = [...facts.matchAll(/key: `(\w+):\$\{[^}]+\}(?::\$\{[^}]+\})?:(\w+)`/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(keys.sort(), ['plan:draft', 'plan:merged', 'push:failed', 'task:blocked']);
});
