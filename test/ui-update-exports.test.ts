import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

// Static guard over public/js/update.js: it exports the handlers the palette and the sidebar reuse,
// has no import from palette.js (so palette.js can import it without a cycle) and announces status changes.

const src = fs.readFileSync(path.join(process.cwd(), 'public', 'js', 'update.js'), 'utf8').replace(/\r\n/g, '\n');
const all = uiSource().replace(/\r\n/g, '\n');
const renderBody = src.slice(src.indexOf('function renderUpdate()'), src.indexOf('// Lets other modules'));
const infoBody = src.slice(src.indexOf('function updateInfo()'), src.indexOf('async function fetchUpdate()'));

test('update.js does not import palette.js', () => {
  assert.doesNotMatch(src, /from\s+['"]\.\/palette\.js['"]/);
  assert.doesNotMatch(src, /\bpalOpen\b/);
});

test('Escape checks the palette scrim instead of palOpen', () => {
  assert.match(src, /e\.key === 'Escape'[^\n]*\$\('palette'\)\.hidden/);
  assert.match(all, /<div[^>]*\bid="palette"[^>]*\bhidden\b/);
});

test('update.js exports checkUpdateNow, runUpdate, openUpd and updateInfo', () => {
  assert.match(src, /^export \{ checkUpdateNow, runUpdate, openUpd, updateInfo \};$/m);
  assert.ok(src.indexOf('export {') < src.lastIndexOf('// </script>'), 'export sits before the closing marker');
  assert.ok(src.startsWith('// <script>\n') && src.trimEnd().endsWith('// </script>'), 'markers kept');
});

test('updateInfo returns a fresh object with the listed keys', () => {
  for (const key of ['loaded', 'behind', 'checkEnabled', 'gitInstall', 'busy', 'eligible', 'reason']) {
    assert.match(infoBody, new RegExp(`\\b${key}\\b`), key);
  }
  assert.match(infoBody, /loaded: upd !== null/);
  assert.match(infoBody, /behind: updBehind\(\)/);
  assert.match(infoBody, /busy: updBusy/);
  assert.match(infoBody, /upd\?\.eligibility\?\.eligible === true/);
  assert.match(infoBody, /updWhy\(upd\.eligibility/);
  assert.match(infoBody, /return \{/);
});

test('renderUpdate dispatches vizor:update-status on every path', () => {
  assert.match(src, /new CustomEvent\('vizor:update-status'\)/);
  assert.match(renderBody, /if \(!on\) \{[^}]*announceUpdateStatus\(\); return;/);
  assert.match(renderBody.trimEnd(), /announceUpdateStatus\(\);\n\}$/);
});

test('the Apply and Check now buttons still call the same handlers', () => {
  assert.match(src, /\$\('updNow'\)\.onclick = \(\) => runUpdate\('apply'\);/);
  assert.match(src, /\$\('updCheck'\)\.onclick = checkUpdateNow;/);
});
