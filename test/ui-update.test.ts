import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Static guard over public/index.html: the Phase 9 update UI (indicator, panel, progress, rollback error,
// settings) exists with accessible names, writes commit subjects as text and never sends an update source.

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const style = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
const start = html.indexOf('// ---------- updates ----------');
const end = html.indexOf('readHash();\nrefresh();');
const block = html.slice(start, end);

/** The opening tag of the element with this id. */
const tag = (id: string) => markup.match(new RegExp(`<\\w+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
/** Text between the opening tag of this id and its closing tag (no nested elements expected). */
const text = (id: string) => markup.match(new RegExp(`\\bid="${id}"[^>]*>([^<]*)<`))?.[1] ?? '';

test('the update block sits at the end of the script', () => {
  assert.ok(start > 0 && end > start, 'block found');
});

test('indicator is a hidden button in the shell that opens the panel and shows the count', () => {
  const t = tag('updInd');
  assert.match(t, /^<button\b/);
  assert.match(t, /\bhidden\b/);
  assert.match(t, /aria-haspopup="dialog"/);
  assert.match(t, /aria-controls="updPanel"/);
  assert.match(t, /aria-expanded="false"/);
  assert.strictEqual(text('updIndText'), 'Update available');
  assert.match(block, /\$\('updIndCount'\)\.textContent = showInd \? `· \$\{behind\}`/);
  // Shown only when the install is behind and the owner has not dismissed this upstream commit.
  assert.match(block, /showInd = on && behind > 0 && !updBusy && updDismissed\(\) !== upd\.check\.upstreamSha/);
  assert.match(block, /\$\('updInd'\)\.hidden = !showInd/);
});

test('the indicator is not a modal and does not animate', () => {
  assert.doesNotMatch(tag('updInd'), /aria-modal/);
  assert.doesNotMatch(tag('updPanel'), /aria-modal/);
  assert.doesNotMatch(style, /(?:#updInd|\.upd-[\w-]+)[^{]*\{[^}]*(transition|animation)\s*:/, 'no motion of its own');
});

test('panel is a labelled dialog with Update now and Not now buttons', () => {
  const t = tag('updPanel');
  assert.match(t, /role="dialog"/);
  assert.match(t, /aria-labelledby="updTitle"/);
  assert.ok(tag('updTitle') && text('updTitle').length > 0, 'title exists');
  assert.match(tag('updNow'), /^<button\b[^>]*type="button"/);
  assert.strictEqual(text('updNow'), 'Update now');
  assert.match(tag('updLater'), /^<button\b[^>]*type="button"/);
  assert.strictEqual(text('updLater'), 'Not now');
  assert.match(tag('updSubjects'), /aria-label="Changes in this update"/);
});

test('Not now hides the indicator until a check finds a different upstream commit', () => {
  assert.match(block, /\$\('updLater'\)\.onclick = \(\) => \{[\s\S]*localStorage\.setItem\(UPD_DISMISSED, sha\)/);
  assert.match(block, /updDismissed\(\) !== upd\.check\.upstreamSha/);
});

test('commit subjects are inserted as text, never as markup', () => {
  assert.match(block, /h\('li', \{ text: String\(s\) \}\)/);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(block, /\$\('updErrText'\)\.textContent = String\(le\.error\)/);
});

test('when updating is not possible the panel gives a plain-language reason instead of the button', () => {
  for (const s of ['You have local changes', 'This copy is ahead of upstream', 'This copy isn’t a git install', 'A worker is running; wait for it to finish'])
    assert.ok(block.includes(s), s);
  assert.match(block, /'local-changes':/);
  assert.match(block, /'ahead-of-upstream':/);
  assert.match(block, /'not-a-git-install':/);
  assert.match(block, /'worker-running':/);
  assert.match(block, /\$\('updNow'\)\.hidden = !e\.eligible/);
  assert.match(block, /\$\('updReason'\)\.hidden = !!e\.eligible/);
  assert.ok(tag('updReason'));
});

test('a zip install gets a link to the repository from the status response', () => {
  assert.match(tag('updRepo'), /^<a\b[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(text('updRepo'), /repository on GitHub/);
  assert.match(block, /const url = String\(upd\?\.repositoryUrl \|\| ''\)/);
  assert.match(block, /a\.href = url/);
  assert.doesNotMatch(html, /href="https:\/\/github\.com\/colinosbo/, 'the URL is not hard-coded in the page');
});

test('progress is a status line that is announced, then polled until the server returns and reloads', () => {
  assert.match(block, /function updProgress\(text\)[\s\S]*announce\(text\)/);
  for (const s of ['Backing up', 'Updating', 'Restarting']) assert.ok(block.includes(s + '…'), s);
  assert.match(block, /post\(`\/api\/update\/\$\{path\}`/);
  assert.match(block, /runUpdate\('apply'\)/);
  assert.match(block, /runUpdate\('revert'\)/);
  assert.match(block, /fetch\('\/api\/update\/status'\)/);
  assert.match(block, /location\.reload\(\)/);
});

test('a rollback error shows once with its text and a Dismiss that calls dismiss-error', () => {
  const t = tag('updErr');
  assert.match(t, /role="alert"/);
  assert.match(t, /\bhidden\b/);
  assert.strictEqual(text('updErrDismiss'), 'Dismiss');
  assert.match(block, /const le = upd\.lastError/);
  assert.match(block, /\$\('updErr'\)\.hidden = !le \|\| updErrGone/);
  assert.match(block, /post\('\/api\/update\/dismiss-error'\)/);
});

test('settings: automatic-check toggle with its GitHub note, bound to the server setting', () => {
  assert.match(markup, /<label class="check"><input type="checkbox" id="updAuto">Check for updates automatically<\/label>/);
  assert.match(markup, /The check contacts GitHub/);
  assert.match(block, /post\('\/api\/update\/settings', \{ checkEnabled: on \}\)/);
  assert.match(block, /\$\('updAuto'\)\.checked = !!upd\.checkEnabled/);
});

test('settings: Check now shows the result and announces it', () => {
  assert.match(tag('updCheck'), /^<button\b[^>]*type="button"/);
  assert.strictEqual(text('updCheck'), 'Check now');
  assert.match(block, /post\('\/api\/update\/check', null,/);
  assert.match(block, /function updResult\(text\)[\s\S]*announce\(text\)/);
  assert.match(block, /updResult\(updResultText\(\)\)/);
  assert.match(block, /'Up to date'/);
});

test('settings: Revert needs a confirm step and exists only when the status offers it', () => {
  assert.match(tag('updRevertBox'), /\bhidden\b/);
  assert.strictEqual(text('updRevert'), 'Revert to previous version');
  assert.match(tag('updRevert'), /aria-expanded="false"[^>]*aria-controls="updRevertConfirm"/);
  assert.match(tag('updRevertConfirm'), /\bhidden\b/);
  assert.strictEqual(text('updRevertGo'), 'Revert now');
  assert.strictEqual(text('updRevertCancel'), 'Cancel');
  assert.match(block, /const canRevert = !!upd\.revert\?\.available/);
  assert.match(block, /\$\('updRevertBox'\)\.hidden = !canRevert/);
  // Only the confirm button starts a revert; the opening button just reveals the confirm.
  assert.strictEqual((block.match(/runUpdate\('revert'\)/g) || []).length, 1);
  assert.match(block, /\$\('updRevertGo'\)\.onclick = \(\) => runUpdate\('revert'\)/);
  assert.doesNotMatch(block, /window\.confirm|[^.\w]confirm\(['"`]/);
});

test('every update button has an accessible name', () => {
  for (const id of ['updInd', 'updNow', 'updLater', 'updErrDismiss', 'updCheck', 'updRevert', 'updRevertGo', 'updRevertCancel']) {
    const named = markup.match(new RegExp(`\\bid="${id}"[^>]*aria-label="[^"]+"`)) || text(id).length > 0 || id === 'updInd';
    assert.ok(named, id);
  }
  assert.match(markup, /<span id="updIndText">Update available<\/span>/);
});

test('no upstream URL field or request exists in the UI', () => {
  assert.doesNotMatch(markup, /\bname="upstream|\bid="[^"]*upstream/i);
  assert.doesNotMatch(block, /upstreamUrl|upstream_url|update-upstream|UPDATE_UPSTREAM/i);
  assert.doesNotMatch(block, /JSON\.stringify|body:\s*\{[^}]*(url|upstream)/i);
  // Every update request is a post() with no body or a single checkEnabled flag.
  for (const m of block.matchAll(/post\(([^)]*)\)/g)) assert.doesNotMatch(m[1], /url|upstream|repo/i, m[0]);
  assert.doesNotMatch(block, /fetch\([^)]*(github|https?:)/i);
});

test('update controls meet the Phase 6 rules', () => {
  assert.match(style, /@media[^{]*max-width[^{]*\{[\s\S]*\.upd-link\s*\{?[^}]*min-height:40px|\.check, \.guard \.opt, \.info-btn, \.copy, \.upd-link \{ min-height:40px; \}/);
  assert.match(style, /\.upd-panel\s*\{\s*left:16px; right:16px; width:auto; \}/);
  assert.match(style, /\.upd-link\s*\{[^}]*text-decoration:underline/);
  assert.doesNotMatch(style, /\.upd-[\w-]+\s*\{[^}]*outline\s*:\s*(none|0)/);
});
