import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { uiSource } from "./helpers/ui-source.js";

const source = uiSource();
const nav = fs.readFileSync(path.join(process.cwd(), "public", "js", "nav.js"), "utf8");

test("version footer sits inside .side-foot after #conn", () => {
  const foot = source.indexOf('<div class="side-foot">');
  const conn = source.indexOf('id="conn"', foot);
  const ver = source.indexOf('id="verFoot"', foot);
  const end = source.indexOf("</aside>", foot);
  assert.ok(foot >= 0 && conn > foot, "#conn is inside .side-foot");
  assert.ok(ver > conn && ver < end, "#verFoot follows #conn inside the sidebar footer");
  assert.match(source, /<button[^>]*id="verFoot"[^>]*type="button"|<button[^>]*type="button"[^>]*id="verFoot"/);
  assert.match(source, /id="verLabel"/);
});

test("nav.js imports openUpd and updateInfo from update.js", () => {
  assert.match(nav, /import\s*\{[^}]*\bopenUpd\b[^}]*\}\s*from\s*'\.\/update\.js'/);
  assert.match(nav, /import\s*\{[^}]*\bupdateInfo\b[^}]*\}\s*from\s*'\.\/update\.js'/);
});

test("nav.js reads state.version?.label and renders it with textContent", () => {
  assert.match(nav, /state\.version\?\.label/);
  assert.match(nav, /\$\('verLabel'\)\.textContent\s*=/);
  assert.doesNotMatch(nav, /verLabel'\)\.innerHTML/);
});

test("clicking the footer calls openUpd", () => {
  assert.match(nav, /\$\('verFoot'\)\.addEventListener\('click',\s*\(\)\s*=>\s*openUpd\(\)\)/);
});

test("nav.js listens for vizor:update-status", () => {
  assert.match(nav, /addEventListener\('vizor:update-status',\s*renderVersion\)/);
});

test("'Update available' text and dot are conditional on behind > 0", () => {
  assert.match(source, /id="verUpd"[^>]*hidden[^>]*>[^]*?ver-dot[^]*?Update available/);
  assert.match(nav, /behind\s*>\s*0/);
  assert.match(nav, /\$\('verUpd'\)\.hidden\s*=\s*!available/);
});
