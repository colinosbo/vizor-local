import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { uiSource } from './helpers/ui-source.js';

const html = uiSource();

test('copyBtn helper exists and copies through the clipboard API', () => {
  assert.match(html, /function copyBtn\(text, label\)/);
  assert.match(html, /navigator\.clipboard\.writeText\(/);
});

test('copy falls back to a hidden textarea and execCommand', () => {
  assert.match(html, /createElement|h\('textarea'/);
  assert.match(html, /document\.execCommand\('copy'\)/);
});

test('every copy button has an aria-label and confirms with toast', () => {
  const fn = html.match(/function copyBtn\([\s\S]*?\n\}/);
  assert.ok(fn, 'copyBtn body found');
  assert.match(fn[0], /'aria-label': 'Copy ' \+ label/);
  assert.match(fn[0], /toast\('Copied ' \+ label\)/);
  assert.doesNotMatch(fn[0], /innerHTML\s*=\s*value|innerHTML\s*=\s*text/);
});

test('copy buttons cover PR numbers, SHAs, worktree paths and commands', () => {
  assert.match(html, /copyBtn\([^)]*'PR number'\)/);
  assert.match(html, /copyBtn\([^)]*'SHA'\)/);
  assert.match(html, /'worktree path'/);
  assert.match(html, /'command'/);
});
