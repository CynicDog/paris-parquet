import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, groupingSets, parseSql, sqlTokenize } from "./query.js";

const numSpec = { kind: "number", label: "int32", physical: "INT32", convert: (v) => v };
const strSpec = { kind: "string", label: "string", physical: "BYTE_ARRAY", convert: (v) => v };

function col(name, spec, rows) {
  return { name, spec, leaf: { path: [name], rep: "OPTIONAL" }, rows };
}

test("groupingSets: flat mode is just the full set once", () => {
  const sets = groupingSets(3, "");
  assert.deepEqual(sets, [[0, 1, 2]]);
});

test("groupingSets: rollup nests by position down to the grand total", () => {
  const sets = groupingSets(3, "ROLLUP");
  assert.deepEqual(sets, [[0, 1, 2], [0, 1], [0], []]);
});

test("groupingSets: cube is every subset, largest first", () => {
  const sets = groupingSets(2, "CUBE");
  assert.deepEqual(sets, [[0, 1], [1], [0], []]);
});

test("groupingSets: cube beyond the column cap falls back to flat", () => {
  const sets = groupingSets(20, "CUBE");
  assert.deepEqual(sets, [Array.from({ length: 20 }, (_, i) => i)]);
});

test("aggregate: rollup subtotals and the grand total sum to the same value as flat SUM", () => {
  const cols = [
    col("region", strSpec, ["north", "north", "south", "south"]),
    col("category", strSpec, ["a", "b", "a", "b"]),
    col("amount", numSpec, [10, 20, 30, 40]),
  ];
  const qFlat = { groupBy: [0, 1], groupMode: "", metrics: [{ id: "m1", ci: 2, agg: "SUM", alias: "" }] };
  const flat = aggregate(qFlat, cols, null, 4);
  assert.equal(flat[0].rows.length, 4);
  const flatTotal = flat[2].rows.reduce((a, b) => a + b, 0);
  assert.equal(flatTotal, 100);

  const rollup = aggregate({ ...qFlat, groupMode: "ROLLUP" }, cols, null, 4);
  // 4 detail rows + 2 region subtotals + 1 grand total
  assert.equal(rollup[0].rows.length, 7);
  const grandTotalRow = rollup[2].rows[rollup[2].rows.length - 1];
  assert.equal(grandTotalRow, flatTotal);
  // the grand total row drops both group columns to null
  assert.equal(rollup[0].rows[rollup[0].rows.length - 1], null);
  assert.equal(rollup[1].rows[rollup[1].rows.length - 1], null);
});

test("aggregate: pivot reshapes the last grouped column's values into columns", () => {
  const cols = [
    col("region", strSpec, ["north", "north", "south", "south"]),
    col("category", strSpec, ["a", "b", "a", "b"]),
    col("amount", numSpec, [10, 20, 30, 40]),
  ];
  const q = { groupBy: [0, 1], groupMode: "PIVOT", metrics: [{ id: "m1", ci: 2, agg: "SUM", alias: "" }] };
  const pivot = aggregate(q, cols, null, 4);
  assert.deepEqual(pivot.map((c) => c.name), ["region", "a", "b"]);
  assert.equal(pivot[0].rows.length, 2); // one row per region
  const northRow = pivot[0].rows.indexOf("north");
  assert.equal(pivot[1].rows[northRow], 10); // north/a
  assert.equal(pivot[2].rows[northRow], 20); // north/b
});

test("aggregate: pivot with no metrics falls back to COUNT of the pivoted column", () => {
  const cols = [
    col("region", strSpec, ["north", "north", "south"]),
    col("category", strSpec, ["a", "b", "a"]),
  ];
  const q = { groupBy: [0, 1], groupMode: "PIVOT", metrics: [] };
  const pivot = aggregate(q, cols, null, 3);
  assert.deepEqual(pivot.map((c) => c.name), ["region", "a", "b"]);
  const northRow = pivot[0].rows.indexOf("north");
  assert.equal(pivot[1].rows[northRow], 1);
  assert.equal(pivot[2].rows[northRow], 1);
});

test("parseSql/querySql: ROLLUP and CUBE round-trip through the SQL box", () => {
  const cols = [col("region", strSpec, []), col("category", strSpec, []), col("amount", numSpec, [])];
  for (const mode of ["ROLLUP", "CUBE"]) {
    const text = `SELECT region,\n       category,\n       SUM(amount)\nFROM t\nGROUP BY ${mode}(region, category);`;
    const { query, errors } = parseSql(text, cols);
    assert.deepEqual(errors, []);
    assert.equal(query.groupMode, mode);
    assert.deepEqual(query.groupBy, [0, 1]);
  }
});

test("parseSql: a join is named and refused, not silently accepted", () => {
  const cols = [col("a", numSpec, [])];
  const { errors } = parseSql("SELECT a FROM t JOIN u ON t.a = u.a;", cols);
  assert.ok(errors.some((e) => /join/i.test(e.msg)));
});

test("sqlTokenize: keeps ROLLUP/CUBE/PIVOT as plain names, not keywords", () => {
  const toks = sqlTokenize("GROUP BY ROLLUP(a, b)");
  const kinds = toks.filter((t) => t.t !== "end").map((t) => t.t);
  assert.deepEqual(kinds, ["kw", "kw", "name", "op", "name", "op", "name", "op"]);
});
