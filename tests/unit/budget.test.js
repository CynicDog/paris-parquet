import assert from "node:assert/strict";
import test from "node:test";
import { affordableGroups, budgetBytes, CELL, cellBytes, fitColumns, fitFill, groupsAhead, groupsBytes, heldBytes, loadAllBytes, loadAllRefusal, MB, SAFETY, setBudgetMB } from "../../src/budget.js";

/** A one-file dataset of `groups` row groups of `rows` rows, with a numeric and a string column. */
function fake(groups, rows, opts = {}) {
  const chunk = (name, encodings, size) => ({ meta: { path: [name], encodings, numValues: rows, totalUncompressedSize: size } });
  const rg = () => ({ numRows: rows, columns: [chunk("n", ["PLAIN"], rows * 8), chunk("s", opts.dictionary ? ["RLE_DICTIONARY"] : ["PLAIN"], rows * 12)] });
  const dataset = {
    parts: [{
      meta: { rowGroups: Array.from({ length: groups }, rg) },
      leafByPath: new Map([["n", { type: "DOUBLE" }], ["s", { type: "BYTE_ARRAY" }]]),
    }],
  };
  const table = {
    nextPart: 0, nextGroup: 0, plan: opts.plan || null, reads: [],
    cols: [
      { key: "n", spec: { kind: "number" }, rows: [], filled: 0 },
      { key: "s", spec: { kind: "string" }, rows: [], filled: 0 },
    ],
  };
  return { dataset, table };
}

test("a decoded cell costs what it was measured to cost", () => {
  assert.equal(cellBytes(null, "INT32", null), CELL.unknown);
  assert.equal(cellBytes({ kind: "number" }, "DOUBLE", { encodings: ["PLAIN"] }), CELL.fixed);
  assert.equal(cellBytes({ kind: "number", decimal: true }, "FIXED_LEN_BYTE_ARRAY", null), CELL.decimal);
  assert.equal(cellBytes({ nested: true }, "INT32", null), CELL.nested);
  assert.equal(cellBytes({ kind: "string" }, "BYTE_ARRAY", { encodings: ["RLE_DICTIONARY"], numValues: 10, totalUncompressedSize: 500 }), CELL.dictionary);
});

test("a plain string costs more the longer it is, dictionary strings do not", () => {
  const short = cellBytes({ kind: "string" }, "BYTE_ARRAY", { encodings: ["PLAIN"], numValues: 100, totalUncompressedSize: 100 * 6 });
  const long = cellBytes({ kind: "string" }, "BYTE_ARRAY", { encodings: ["PLAIN"], numValues: 100, totalUncompressedSize: 100 * 64 });
  assert.ok(long > short * 2, `${long} vs ${short}`);
  const dict = cellBytes({ kind: "string" }, "BYTE_ARRAY", { encodings: ["RLE_DICTIONARY"], numValues: 100, totalUncompressedSize: 100 * 64 });
  assert.ok(dict < short);
});

test("the groups a load would read follow the plan and stop at the row count asked for", () => {
  const { dataset, table } = fake(5, 1000);
  assert.deepEqual(groupsAhead(dataset, table, 1500).map((g) => g.gi), [0, 1]);
  assert.deepEqual(groupsAhead(dataset, table, Infinity).map((g) => g.gi), [0, 1, 2, 3, 4]);
  const planned = fake(5, 1000, { plan: new Map([["0:1", null], ["0:3", [[0, 200]]]]) });
  const got = groupsAhead(planned.dataset, planned.table, Infinity);
  assert.deepEqual(got.map((g) => [g.gi, g.rows]), [[1, 1000], [3, 200]]);
});

test("the estimate is the rows times the per-cell cost, rounded up by the safety factor", () => {
  const { dataset, table } = fake(1, 1000);
  const groups = groupsAhead(dataset, table, Infinity);
  assert.equal(groupsBytes(dataset, table, groups, [0]), Math.ceil(1000 * CELL.fixed * SAFETY));
});

test("columns are kept in order until the budget is spent, and at least one always is", () => {
  const { dataset, table } = fake(1, 100000);
  const groups = groupsAhead(dataset, table, Infinity);
  const one = groupsBytes(dataset, table, groups, [0]);
  const roomy = fitColumns(dataset, table, [0, 1], groups, 1e12);
  assert.deepEqual([roomy.keep, roomy.drop], [[0, 1], []]);
  const tight = fitColumns(dataset, table, [0, 1], groups, one + 1);
  assert.deepEqual([tight.keep, tight.drop], [[0], [1]]);
  const none = fitColumns(dataset, table, [1, 0], groups, 1);
  assert.deepEqual(none.keep, [1], "a file with nothing decoded shows nothing, so the first is kept");
  assert.equal(none.over, true);
});

test("how many of the coming groups fit, counting what is already held", () => {
  const { dataset, table } = fake(4, 1000);
  const groups = groupsAhead(dataset, table, Infinity);
  const each = groupsBytes(dataset, table, [groups[0]], [0]);
  const two = affordableGroups(dataset, table, groups, [0], each * 2 + 1);
  assert.deepEqual([two.groups, two.rows, two.all], [2, 2000, false]);
  assert.equal(affordableGroups(dataset, table, groups, [0], each * 10).all, true);
  table.cols[0].rows = new Array(1000).fill(0);            /* one group's worth already held */
  assert.ok(heldBytes(dataset, table) > 0);
  assert.equal(affordableGroups(dataset, table, groups, [0], each * 2 + 1).groups, 1);
});

test("filling in columns that fell behind the reads is costed against what is held", () => {
  const { dataset, table } = fake(2, 1000);
  table.reads = [{ pi: 0, gi: 0, rows: 1000 }, { pi: 0, gi: 1, rows: 1000 }];
  table.cols[0].rows = new Array(2000).fill(0);
  table.cols[0].filled = 2;
  const held = heldBytes(dataset, table);
  const fit = fitFill(dataset, table, [1], held + 10);
  assert.deepEqual([fit.keep, fit.drop], [[], [1]]);
  assert.deepEqual(fitFill(dataset, table, [1], 1e12).keep, [1]);
});

test("the budget can be set, and falls back to something between half a gigabyte and two", () => {
  setBudgetMB(300);
  assert.equal(budgetBytes(), 300 * MB);
  setBudgetMB(null);
  assert.ok(budgetBytes() >= 512 * MB && budgetBytes() <= 2048 * MB);
});

test("reading everything is costed from where the table has read to, and refused with a reason when it does not fit", () => {
  const { dataset, table } = fake(4, 1000);
  const all = loadAllBytes(dataset, table, [0, 1]);
  assert.equal(all, groupsBytes(dataset, table, groupsAhead(dataset, table, Infinity), [0, 1]));
  table.cols[0].rows = new Array(1000).fill(0);
  assert.ok(loadAllBytes(dataset, table, [0, 1]) > all, "what is already held counts too");
  assert.equal(loadAllRefusal("both files", 100, 1000, "x"), null);
  const why = loadAllRefusal("both files", 5 * MB, 1 * MB, "Compare a smaller file.");
  assert.match(why, /^Not run: reading every row of both files would take about 5 MB once decoded, over this page's 1 MB memory budget\. Compare a smaller file\.$/);
});
