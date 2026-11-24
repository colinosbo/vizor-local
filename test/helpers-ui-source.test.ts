import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { uiModules, uiSource } from "./helpers/ui-source.js";

function makeRoot(withJs: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-source-"));
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "public", "index.html"), "HTML_MARK");
  if (withJs) {
    const js = path.join(root, "public", "js");
    fs.mkdirSync(path.join(js, "sub"), { recursive: true });
    fs.writeFileSync(path.join(js, "b.js"), "B_MARK");
    fs.writeFileSync(path.join(js, "a.js"), "A_MARK");
    fs.writeFileSync(path.join(js, "notes.txt"), "NOTES_MARK");
    fs.writeFileSync(path.join(js, "sub", "c.js"), "C_MARK");
  }
  return root;
}

test("uiSource orders index.html, then js files by name", () => {
  const root = makeRoot(true);
  try {
    assert.equal(uiSource(root), "HTML_MARK\nA_MARK\nB_MARK");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uiSource and uiModules skip non-.js files and subfolders", () => {
  const root = makeRoot(true);
  try {
    const src = uiSource(root);
    assert.ok(!src.includes("NOTES_MARK"));
    assert.ok(!src.includes("C_MARK"));
    assert.deepEqual(uiModules(root), [
      path.join(root, "public", "js", "a.js"),
      path.join(root, "public", "js", "b.js"),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a root without public/js returns only index.html", () => {
  const root = makeRoot(false);
  try {
    assert.equal(uiSource(root), "HTML_MARK");
    assert.deepEqual(uiModules(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uiSource() with the real repo root includes the real index.html", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
  assert.ok(uiSource().startsWith(html));
});
