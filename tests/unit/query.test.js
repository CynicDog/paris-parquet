import assert from "node:assert/strict";
import { test } from "node:test";
import { AGG_MORE, AGGS, aggregate, aggSqlExpr, groupingSets, parseSql, sqlTokenize } from "../../src/query.js";

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

/* ------------------------------------------------------- spread metrics */
const one = (agg, cols, ci, rows) => {
  const q = { groupBy: [], groupMode: "", metrics: [{ id: "m1", ci, agg, alias: "" }] };
  return aggregate(q, cols, null, rows)[0].rows[0];
};

test("aggregate: STD, STDP and VAR match the textbook answers", () => {
  const cols = [col("x", numSpec, [2, 4, 4, 4, 5, 5, 7, 9])];
  assert.equal(one("STD", cols, 0, 8), 2.138089935299395);
  assert.equal(one("STDP", cols, 0, 8), 2);
  assert.equal(one("VAR", cols, 0, 8), 4.571428571428571);
  assert.equal(one("CV", cols, 0, 8), 0.427617987059879);
});

test("aggregate: STD survives a mean that dwarfs the spread", () => {
  /* the naive sum-of-squares formula subtracts two numbers that agree to
     ~17 digits here and keeps the rounding noise; Welford does not */
  const cols = [col("t", numSpec, [1e9 + 1, 1e9 + 2, 1e9 + 3, 1e9 + 4])];
  assert.equal(one("STD", cols, 0, 4), 1.2909944487358056);
});

test("aggregate: a single value has a population spread of zero and no sample spread", () => {
  const cols = [col("x", numSpec, [7])];
  assert.equal(one("STDP", cols, 0, 1), 0);
  assert.equal(one("STD", cols, 0, 1), null);     /* n-1 is zero: undefined, not 0 */
  assert.equal(one("RANGE", cols, 0, 1), 0);
});

test("aggregate: a constant column reports exactly zero spread, not a rounding smear", () => {
  const cols = [col("x", numSpec, [1e8 + 7, 1e8 + 7, 1e8 + 7, 1e8 + 7])];
  assert.equal(one("STD", cols, 0, 4), 0);
  assert.equal(one("VAR", cols, 0, 4), 0);
  assert.equal(one("CV", cols, 0, 4), 0);
});

test("aggregate: percentiles interpolate the way QUANTILE_CONT does", () => {
  const cols = [col("x", numSpec, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])];
  assert.equal(one("MED", cols, 0, 10), 5.5);
  assert.equal(one("P90", cols, 0, 10), 9.1);
  assert.equal(one("IQR", cols, 0, 10), 4.5);     /* p75 7.75 - p25 3.25 */
  assert.equal(one("RANGE", cols, 0, 10), 9);
});

test("aggregate: NULLS counts what COUNT skips, and MODE reads categories", () => {
  const cols = [
    col("x", numSpec, [1, null, 3, null, null]),
    col("s", strSpec, ["a", "b", "a", "b", "b"]),
  ];
  assert.equal(one("NULLS", cols, 0, 5), 3);
  assert.equal(one("COUNT", cols, 0, 5), 2);
  assert.equal(one("MODE", cols, 1, 5), "b");
  assert.equal(one("NULLS", cols, 1, 5), 0);
});

test("aggregate: an all-null column has no spread to report", () => {
  const cols = [col("x", numSpec, [null, null])];
  assert.equal(one("NULLS", cols, 0, 2), 2);
  assert.equal(one("STD", cols, 0, 2), null);
  assert.equal(one("MED", cols, 0, 2), null);
  assert.equal(one("MODE", cols, 0, 2), null);
  assert.equal(one("RANGE", cols, 0, 2), null);
});

test("aggregate: pivot's merged overflow bucket gets the same STD as one pass would", () => {
  /* past PIVOT_MAX_COLS the remaining groups are merged rather than
     rescanned, so this is Chan's parallel form being exercised for real */
  const cats = [], amts = [];
  for (let i = 0; i < 60; i++) { cats.push("c" + i); amts.push(i); }
  const cols = [col("region", strSpec, cats.map(() => "r")), col("cat", strSpec, cats), col("amt", numSpec, amts)];
  const q = { groupBy: [0, 1], groupMode: "PIVOT", metrics: [{ id: "m1", ci: 2, agg: "STD", alias: "" }] };
  const out = aggregate(q, cols, null, 60);
  const other = out[out.length - 1];
  assert.equal(other.name, "(other)");            /* amounts 50..59, merged one at a time */
  assert.equal(other.rows[0], 3.0276503540974917);
});

test("parseSql: every metric reads back from the SQL the builder writes for it", () => {
  const cols = [col("region", strSpec, []), col("amount", numSpec, [])];
  for (const agg of AGGS.concat(AGG_MORE)) {
    const text = "SELECT region,\n       " + aggSqlExpr(agg, "amount") + "\nFROM t\nGROUP BY region;";
    const { query, errors } = parseSql(text, cols);
    assert.deepEqual(errors, [], agg + ": " + text);
    assert.equal(query.metrics.length, 1, agg);
    assert.equal(query.metrics[0].agg, agg, agg);
    assert.equal(query.metrics[0].ci, 1, agg);
  }
});

test("parseSql: a composite metric can be ordered by, and aliased", () => {
  const cols = [col("region", strSpec, []), col("amount", numSpec, [])];
  const spread = aggSqlExpr("RANGE", "amount");
  const { query, errors } = parseSql(
    "SELECT region, " + spread + " AS span\nFROM t\nGROUP BY region\nORDER BY " + spread + " DESC;", cols);
  assert.deepEqual(errors, []);
  assert.equal(query.metrics[0].agg, "RANGE");
  assert.equal(query.metrics[0].alias, "span");
  assert.equal(query.sort[0].mid, query.metrics[0].id);
  assert.equal(query.sort[0].dir, "DESC");
});

test("parseSql: STDDEV and STDEV are read as the one STD metric", () => {
  const cols = [col("region", strSpec, []), col("amount", numSpec, [])];
  for (const spelling of ["STDDEV", "STDEV", "STDDEV_SAMP", "stddev_samp"]) {
    const { query, errors } = parseSql("SELECT region, " + spelling + "(amount) FROM t GROUP BY region;", cols);
    assert.deepEqual(errors, [], spelling);
    assert.equal(query.metrics[0].agg, "STD", spelling);
  }
});
