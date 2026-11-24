import { test } from "node:test";
import assert from "node:assert/strict";
import { planShape, type PlanShapeTask } from "../src/plan-shape.js";

const t = (key: string, deps: string[] = [], writeScope: string[] = []): PlanShapeTask => ({
  key,
  deps,
  writeScope,
});

test("independent tasks form one wave", () => {
  const s = planShape([t("a"), t("b"), t("c")]);
  assert.deepEqual(s.waves, [["a", "b", "c"]]);
  assert.equal(s.width, 3);
  assert.equal(s.longestChain, 1);
});

test("diamond gives three waves", () => {
  const s = planShape([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])]);
  assert.deepEqual(s.waves, [["a"], ["b", "c"], ["d"]]);
  assert.equal(s.width, 2);
  assert.equal(s.longestChain, 3);
  assert.deepEqual(s.chain, ["a", "b", "d"]);
});

test("linear chain of five", () => {
  const s = planShape([
    t("a"),
    t("b", ["a"]),
    t("c", ["b"]),
    t("d", ["c"]),
    t("e", ["d"]),
  ]);
  assert.equal(s.longestChain, 5);
  assert.deepEqual(s.chain, ["a", "b", "c", "d", "e"]);
  assert.equal(s.width, 1);
});

test("cycle members are excluded from waves and chain", () => {
  const s = planShape([t("x", ["y"]), t("y", ["x"]), t("z"), t("w", ["x"])]);
  assert.deepEqual(s.waves, [["z"]]);
  assert.equal(s.longestChain, 1);
  assert.deepEqual(s.chain, ["z"]);
});

test("unknown deps are ignored", () => {
  const s = planShape([t("a", ["ghost"]), t("b", ["a"])]);
  assert.deepEqual(s.waves, [["a"], ["b"]]);
  assert.deepEqual(s.chain, ["a", "b"]);
});

test("hotFiles needs three tasks sharing a glob", () => {
  const s = planShape([
    t("a", [], ["src/x.ts", "src/y.ts"]),
    t("b", [], ["src/x.ts", "src/y.ts"]),
    t("c", [], ["src/x.ts"]),
    t("d", [], ["docs/**"]),
  ]);
  assert.deepEqual(s.hotFiles, [{ glob: "src/x.ts", tasks: ["a", "b", "c"] }]);
});

test("empty input", () => {
  assert.deepEqual(planShape([]), {
    waves: [],
    width: 0,
    longestChain: 0,
    chain: [],
    hotFiles: [],
  });
});

test("input is not mutated", () => {
  const input = [t("a"), t("b", ["a"], ["g"])];
  const copy = structuredClone(input);
  planShape(input);
  assert.deepEqual(input, copy);
});
