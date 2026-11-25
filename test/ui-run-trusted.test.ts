import { test } from 'node:test';
import assert from 'node:assert';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();
const start = html.indexOf('// run.js:');
const run = html.slice(start, html.indexOf('// </script>', start));

test('Review section renders severity, file:line, title, evidence in a mono-block and the fix', () => {
  assert.match(run, /state\.reviews/);
  assert.match(run, /r\.task_id === taskId/);
  assert.match(run, /class: 'finding'/);
  assert.match(run, /class: 'sev mono', 'data-sev': f\.severity/);
  assert.match(run, /text: `\$\{f\.file\}:\$\{f\.line\}`/);
  assert.match(run, /text: f\.title/);
  assert.match(run, /h\('pre', \{ class: 'mono-block mono', style: MONO_BLOCK, text: f\.evidence \}\)/);
  assert.match(run, /text: `Fix: \$\{f\.fix\}`/);
  assert.match(run, /r\.head_sha === t\.head_sha/);
  assert.match(run, /No security review has run for this task/);
  assert.match(run, /text: r\.status/);
  assert.match(run, /text: r\.model/);
});

test('Security section shows counts and recorded commands, and says when the audit is missing', () => {
  assert.match(run, /a\.security/);
  assert.match(run, /\$\{s\.deniedAttempts\} denied/);
  assert.match(run, /\$\{s\.networkCommands\} network commands/);
  assert.match(run, /h\('pre', \{ class: 'mono-block mono', style: MONO_BLOCK, text: e\.command \}\)/);
  assert.match(run, /\$\{e\.tool\}: \$\{e\.reason\}/);
  assert.match(run, /The audit is not available for this attempt/);
  assert.match(run, /reviewSection\(t\), securitySection\(t, atts\)/);
});

test('canMergeAnyway also opens for a review_blocked hold', () => {
  assert.match(run, /const REVIEW_BLOCKED_HOLD = \/\^merge held:\.\*review_blocked\/;/);
  assert.match(run, /const isReviewBlocked = \(t\) => !!t && t\.status === 'blocked' && REVIEW_BLOCKED_HOLD\.test\(t\.hold_reason \|\| ''\);/);
  assert.match(run, /canMergeAnyway = \(t\) => .*isReviewBlocked\(t\)/);
});

test('the review_blocked panel lists the overridden findings and needs the confirm button', () => {
  assert.match(run, /r\.head_sha === t\.head_sha/);
  assert.match(run, /f\.severity === 'critical' \|\| f\.severity === 'high'/);
  assert.match(run, /'data-override-findings': ''/);
  assert.match(run, /over\.map\(findingEl\)/);
  assert.match(run, /'data-confirm': '', disabled: st\.busy, onclick: confirm/);
  assert.match(run, /overriddenFindings\?\.length/);
  assert.match(run, /toast\(`Merged \$\{t\.key\} at \$\{short\(ok\.mergeSha\)\}\$\{over\}`\)/);
  // One action only: Merge anyway. No second button was added for the review hold.
  assert.strictEqual((run.match(/'data-merge-anyway'/g) || []).length, 1);
});

test('run.js writes no innerHTML', () => {
  assert.doesNotMatch(run, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('the marker ordering other tests slice on is kept', () => {
  const a = run.indexOf('let cancelTask = null');
  assert.ok(a > 0 && a < run.indexOf('// ----- Run -----'));
});
