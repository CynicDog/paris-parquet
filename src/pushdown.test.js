import assert from "node:assert/strict";
import { test } from "node:test";
import { clauseCanMatch } from "./pushdown.js";

const numSpec = { kind: "number", label: "int32", physical: "INT32", convert: (v) => v };

function bounds(lo, hi, nulls = 0, values = 100) {
  return { lo, hi, nulls, values };
}

test("clauseCanMatch: an equality outside [lo, hi] cannot match", () => {
  const f = { pred: "eq", value: "5" };
  assert.equal(clauseCanMatch(f, numSpec, bounds(10, 20)), false);
  assert.equal(clauseCanMatch(f, numSpec, bounds(0, 20)), true);
});

test("clauseCanMatch: a range clause narrows to overlapping bounds only", () => {
  const ge = { pred: "ge", value: "195000" };
  assert.equal(clauseCanMatch(ge, numSpec, bounds(0, 194999)), false);
  assert.equal(clauseCanMatch(ge, numSpec, bounds(190000, 200000)), true);
});

test("clauseCanMatch: a chunk that is entirely null cannot satisfy a value comparison", () => {
  const f = { pred: "eq", value: "5" };
  assert.equal(clauseCanMatch(f, numSpec, bounds(null, null, 100, 100)), false);
});

test("clauseCanMatch: IS NULL only matches a chunk that actually has nulls", () => {
  const f = { pred: "null" };
  assert.equal(clauseCanMatch(f, numSpec, bounds(0, 10, 0, 100)), false);
  assert.equal(clauseCanMatch(f, numSpec, bounds(0, 10, 1, 100)), true);
});

test("clauseCanMatch: unproven statistics (no lo/hi) are read, never guessed away", () => {
  const f = { pred: "eq", value: "5" };
  assert.equal(clauseCanMatch(f, numSpec, bounds(null, null, 0, 100)), true);
});

test("clauseCanMatch: BETWEEN is false only when the chunk's range misses entirely", () => {
  const f = { pred: "between", value: "10", valueTo: "20" };
  assert.equal(clauseCanMatch(f, numSpec, bounds(21, 30)), false);
  assert.equal(clauseCanMatch(f, numSpec, bounds(0, 9)), false);
  assert.equal(clauseCanMatch(f, numSpec, bounds(15, 25)), true);
});
