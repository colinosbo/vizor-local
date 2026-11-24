import assert from "node:assert/strict";
import test from "node:test";
import { uiSource } from "./helpers/ui-source.js";

const src = uiSource();

test("shield lamp has three tones", () => {
  assert.match(src, /\.shield\s*\{/);
  for (const tone of ["pending", "ok", "bad"]) {
    assert.ok(src.includes(`.shield[data-tone="${tone}"]`), `shield tone ${tone}`);
  }
});

test("finding row and severity pill have four levels", () => {
  assert.match(src, /\.finding\s*\{/);
  assert.match(src, /\.sev\s*\{/);
  for (const sev of ["critical", "high", "medium", "low"]) {
    assert.ok(src.includes(`.sev[data-sev="${sev}"]`), `sev ${sev}`);
  }
});

test("mono-block, on-chain and shape-line exist", () => {
  assert.match(src, /\.mono-block\s*\{[^}]*overflow:auto[^}]*max-height/);
  assert.match(src, /\.on-chain\b/);
  assert.match(src, /svg\.edges path\.on-chain/);
  assert.match(src, /\.shape-line\s*\{/);
});
