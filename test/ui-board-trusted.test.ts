import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();
const board = fs.readFileSync(path.join(process.cwd(), 'public', 'js', 'board.js'), 'utf8');

test('the PR number links to github.com with encoded segments and noopener', () => {
  assert.match(html, /https:\/\/github\.com\/\$\{encodeURIComponent\(parts\[0\]\)\}\/\$\{encodeURIComponent\(parts\[1\]\)\}\/pull\/\$\{num\}/);
  assert.match(html, /target: '_blank', rel: 'noopener noreferrer'/);
  assert.match(html, /Number\.isInteger\(num\) \|\| num <= 0/);
});

test('the link needs a github forge and a safe owner/name repo', () => {
  assert.match(html, /f\.kind !== 'github'/);
  assert.match(html, /const REPO_RE = \/\^\[A-Za-z0-9_\.-\]\+\\\/\[A-Za-z0-9_\.-\]\+\$\/;/);
  assert.match(html, /s === '\.' \|\| s === '\.\.'/);
});

test('the shield lamp has pending, ok and bad tones and is skipped when the gate is off', () => {
  assert.match(html, /class: 'shield', 'data-tone': tone/);
  for (const tone of ['pending', 'ok', 'bad']) assert.match(board, new RegExp(`'${tone}'`));
  assert.match(board, /'Review pending'/);
  assert.match(board, /'Review passed'/);
  assert.match(board, /'Review failed'/);
  assert.match(board, /p\.review_gate === 'off'/);
  assert.match(board, /'aria-label': full, title: full/);
});

test('the review is matched on task id and exact head SHA, and blocked shows the finding count', () => {
  assert.match(board, /state\.reviews \|\| \[\]\)\.find\(\(r\) => r\.task_id === t\.id && r\.head_sha === t\.head_sha\)/);
  assert.match(board, /review\.findings\.length/);
  assert.match(board, /finding\$\{count === 1 \? '' : 's'\}/);
});

test('a review_blocked merge hold maps to the Security review blocked reason', () => {
  assert.match(board, /\[\/\^merge held:\.\*review_blocked\/, 'Security review blocked', openRun\]/);
  assert.ok(board.indexOf('review_blocked') < board.indexOf("/^merge held/, 'Merge held by"));
});

test('board.js never writes innerHTML', () => {
  assert.doesNotMatch(board, /innerHTML|outerHTML|insertAdjacentHTML/);
});
