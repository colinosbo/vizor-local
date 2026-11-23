import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

const bar = html.slice(html.indexOf('function autoBar(p)'), html.indexOf('function roadmapCard(p)'));
const card = html.slice(html.indexOf('function roadmapCard(p)'), html.indexOf('function drawEdges()'));
const evt = html.slice(html.indexOf('function evText(e)'), html.indexOf('function evCopies(e)'));
assert.ok(bar.length > 50 && card.length > 50 && evt.length > 50, 'source blocks found');

test('project settings has an auto-approve toggle posting a boolean to /config', () => {
  assert.match(html, /<input type="checkbox" id="sAutoApprove">Auto-approve plans/);
  assert.match(html, /\$\('sAutoApprove'\)\.onchange[\s\S]*?post\(`\/api\/projects\/\$\{p\.id\}\/config`, \{ autoApprove: box\.checked \}\)/);
  assert.match(html, /\$\('sAutoApprove'\)\.checked = p\.auto_approve === 1/);
  assert.match(html, /max 8 tasks, no protected files, previous phase merged/);
});

test('roadmap card has a one-click off switch, and an on switch when off', () => {
  assert.match(bar, /const on = p\.auto_approve === 1/);
  assert.match(bar, /post\(`\/api\/projects\/\$\{encodeURIComponent\(p\.id\)\}\/config`, \{ autoApprove: v \}\)/);
  assert.match(bar, /'data-auto-off': '', onclick: \(\) => setAuto\(false\) \}, 'Turn off auto-approve'/);
  assert.match(bar, /'data-auto-on': '', onclick: \(\) => setAuto\(true\) \}, 'Turn on auto-approve'/);
  assert.match(bar, /Limits: max 8 tasks, no protected files, previous phase merged/);
  assert.match(card, /autoBar\(p\), rows/);
});

test('halted shows its reason and a Resume button on the resume route', () => {
  assert.match(bar, /p\.auto_approve_halted \? h\('div'/);
  assert.match(bar, /`Auto-approve halted: \$\{p\.auto_approve_halted\}`/);
  assert.match(bar, /post\(`\/api\/projects\/\$\{encodeURIComponent\(p\.id\)\}\/auto-approve-resume`\)/);
  assert.match(bar, /'data-auto-resume': '', onclick: resume \}, 'Resume auto-approve'/);
});

test('phase badge shows only when the project setting is on, and toggles auto and manual', () => {
  assert.match(card, /const autoOn = p\.auto_approve === 1/);
  assert.match(card, /autoOn && \['queued', 'review'\]\.includes\(ph\.status\) \? \(ph\.approve_mode === 'off'/);
  assert.match(card, /approve-mode`, \{ mode: 'inherit' \}[^)]*\)[^)]*\}, 'Manual — waits for you'\)/);
  assert.match(card, /approve-mode`, \{ mode: 'off' \}[^)]*\)[^)]*\}, 'auto'\)/);
  assert.match(card, /\/api\/phases\/\$\{ph\.id\}\/approve-mode/);
});

test('a review phase with auto_note reads "Needs you: <reason>"', () => {
  assert.match(card, /ph\.status === 'review' && ph\.auto_note \? h\('p', \{ class: 'rm-need'[^}]*`Needs you: \$\{ph\.auto_note\}`/);
});

test('event log labels the auto-approve events', () => {
  assert.match(evt, /case 'plan_auto_approved':[^\n]*auto-approved \(project setting\)/);
  assert.match(evt, /' v' \+ v/);
  assert.match(evt, /case 'auto_approve_halted': return `Auto-approve halted: \$\{d\.reason\}`/);
});

test('roadmap helper copy depends on the setting', () => {
  // "You approve every plan" is only the off-state copy now.
  assert.match(html, /<span id="rmHelp">You approve every plan<\/span>/);
  assert.match(card, /p\.auto_approve === 1 \? 'Plans that pass the auto-approve limits start on their own; the rest wait for you' : 'You approve every plan'/);
});
