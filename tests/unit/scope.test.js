import assert from "node:assert/strict";
import { test } from "node:test";
import { compileFilter, parseTemporal, scopeFilters } from "../../src/query.js";
import { BINS, binBounds, fmtValue, summarize, toMillis } from "../../src/types.js";

const numSpec = { kind: "number", label: "double", physical: "DOUBLE", convert: (v) => v };
const tsSpec = { kind: "temporal", sub: "timestamp", utc: true, label: "timestamp", convert: (v) => v };

function col(name, spec, rows) {
  const c = { name, spec, leaf: { path: [name], rep: "OPTIONAL" }, rows };
  c.summary = summarize(c, null);
  return c;
}
const f = (ci, pred, value, linker, valueTo) => ({ id: "x" + Math.random(), ci, pred, value, valueTo: valueTo || "", linker: linker || "AND" });

test("binBounds: a BETWEEN on a bin's bounds selects exactly the rows the bar counted", () => {
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push(Math.round(Math.sin(i) * 1e4) / 7);
  rows.push(null);
  const c = col("x", numSpec, rows);
  for (let b = 0; b < BINS; b++) {
    const bb = binBounds(c, null, rows.length, b);
    if (!c.summary.hist[b]) { assert.equal(bb, null); continue; }
    const test_ = compileFilter({ ci: 0, pred: "between", value: fmtValue(bb.lo, numSpec), valueTo: fmtValue(bb.hi, numSpec) }, [c]);
    let n = 0;
    for (let r = 0; r < rows.length; r++) if (test_(r)) n++;
    assert.equal(n, c.summary.hist[b], "bin " + b);
  }
});

test("parseTemporal: a microsecond timestamp reads back as exactly the value it was printed from", () => {
  const conv = toMillis("MICROS");
  for (const us of [1700000000345678n, 1700000000000001n, 86399999999n, -1234567n]) {
    const ms = conv(us);
    assert.equal(parseTemporal(fmtValue(ms, tsSpec), tsSpec), ms, String(us));
  }
  const timeSpec = { kind: "temporal", sub: "time" };
  assert.equal(parseTemporal(fmtValue(conv(45296123456n), timeSpec), timeSpec), conv(45296123456n));
});

test("scopeFilters: with only ANDs, replaces a range on the same column and keeps the rest", () => {
  const cols = [col("a", numSpec, [1]), col("b", numSpec, [1])];
  const out = scopeFilters([f(0, "gt", "3"), f(1, "eq", "2"), f(0, "ne", "5"), f(0, "eq", "")],
    { ci: 0, pred: "between", value: "4", valueTo: "9" }, cols);
  assert.deepEqual(out.map((x) => [x.ci, x.pred, x.value]),
    [[1, "eq", "2"], [0, "ne", "5"], [0, "eq", ""], [0, "between", "4"]]);
});

test("scopeFilters: with ORs, every live group gets its own copy", () => {
  const cols = [col("a", numSpec, [1]), col("b", numSpec, [1])];
  const out = scopeFilters([f(0, "gt", "3"), f(1, "eq", "2", "OR"), f(1, "eq", "", "OR")],
    { ci: 0, pred: "eq", value: "7" }, cols);
  assert.deepEqual(out.map((x) => [x.ci, x.pred, x.value, x.linker]), [
    [0, "gt", "3", "AND"], [0, "eq", "7", "AND"],
    [1, "eq", "2", "OR"], [0, "eq", "7", "AND"],
    [1, "eq", "", "OR"],
  ]);
});
