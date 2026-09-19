import assert from "node:assert/strict";
import { test } from "node:test";
import { AGG_MORE, AGGS, aggregate, feedAggBatch, finishAggStream, matchIndex, newAggStream, radixAdvanceStream, radixFeedBatch, radixOpenStream, radixPlanStream, streamable } from "../../src/query.js";
import { RADIX } from "../../src/radix.js";

const numSpec = { kind: "number", label: "double", physical: "DOUBLE", convert: (v) => v };
const strSpec = { kind: "string", label: "string", physical: "BYTE_ARRAY", convert: (v) => v };
const col = (name, spec, rows) => ({ name, spec, leaf: { path: [name], rep: "OPTIONAL" }, rows });

/** A small seeded table: two grouping columns, a metric column with nulls and a long tail, and an integer one. */
function table(n) {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const g1 = [], g2 = [], x = [], y = [];
  for (let i = 0; i < n; i++) {
    g1.push(["a", "b", "c", null, "e"][Math.floor(rnd() * 5)]);
    g2.push(Math.floor(rnd() * 4));
    x.push(rnd() < 0.1 ? null : Math.exp(rnd() * 6) - 1);
    y.push(Math.floor(rnd() * 50));
  }
  return [col("g1", strSpec, g1), col("g2", numSpec, g2), col("x", numSpec, x), col("y", numSpec, y)];
}
const query = (over) => Object.assign({ mode: "agg", filters: [], groupBy: [], groupMode: "", metrics: [], sort: [], limit: null }, over);
const slice = (cols, a, b) => cols.map((c) => Object.assign({}, c, { rows: c.rows.slice(a, b) }));

/** The batch boundaries a list of sizes makes over n rows. */
function bounds(n, sizes) {
  const out = [];
  let at = 0;
  for (const size of sizes) { const end = Math.min(n, at + size); out.push([at, end]); at = end; }
  if (at < n) out.push([at, n]);
  return out;
}
/**
 * Runs the whole table through the stream in batches of the given sizes, dropping each batch as it is
 * folded, then does what the page does for percentiles: narrowing passes over the same batches until
 * every group that counted its values has found its ranks.
 */
function streamed(q, cols, n, sizes) {
  const st = newAggStream(q, cols);
  const parts = bounds(n, sizes);
  for (const [a, b] of parts) feedAggBatch(st, slice(cols, a, b), b - a);
  radixPlanStream(st);
  st.passes = 1;
  while (radixOpenStream(st)) {
    st.passes++;
    for (const [a, b] of parts) radixFeedBatch(st, slice(cols, a, b), b - a);
    radixAdvanceStream(st);
  }
  return { out: finishAggStream(st), st };
}
const whole = (q, cols, n) => aggregate(q, cols, matchIndex(q, cols, n), n);
const rowsOf = (out) => out.map((c) => c.rows);

const N = 4000;
const cols = table(N);
const SPLITS = { "one batch": [N], "even batches": Array(8).fill(500), "ragged batches": [1, 7, 993, 1, 2999] };

test("folding a table in batches gives exactly what aggregating it at once gives, for every metric", () => {
  for (const agg of [...AGGS, ...AGG_MORE, "MODE"]) {
    const q = query({ groupBy: [0], metrics: [{ id: "m", ci: 2, agg, alias: "" }] });
    const want = rowsOf(whole(q, cols, N));
    for (const [name, sizes] of Object.entries(SPLITS)) {
      assert.deepEqual(rowsOf(streamed(q, cols, N, sizes).out), want, `${agg}, ${name}`);
    }
  }
});

test("the same holds for ROLLUP, CUBE, two grouping columns and several metrics at once", () => {
  const metrics = [{ id: "a", ci: 2, agg: "AVG", alias: "" }, { id: "b", ci: 2, agg: "STD", alias: "" }, { id: "c", ci: 3, agg: "P90", alias: "" },
    { id: "d", ci: 3, agg: "COUNT_DISTINCT", alias: "" }, { id: "e", ci: 2, agg: "MAX", alias: "" }];
  for (const groupMode of ["", "ROLLUP", "CUBE"]) {
    const q = query({ groupBy: [0, 1], groupMode, metrics });
    const want = rowsOf(whole(q, cols, N));
    for (const [name, sizes] of Object.entries(SPLITS)) assert.deepEqual(rowsOf(streamed(q, cols, N, sizes).out), want, `${groupMode || "flat"}, ${name}`);
  }
});

test("a WHERE is applied to each batch, and an aggregate with no group by folds to one row", () => {
  const q = query({ filters: [{ id: "f", ci: 3, pred: "ge", value: "25", valueTo: "", linker: "AND" }], metrics: [{ id: "m", ci: 2, agg: "SUM", alias: "" }, { id: "n", ci: 2, agg: "COUNT", alias: "" }] });
  const want = rowsOf(whole(q, cols, N));
  assert.equal(want[0].length, 1);
  for (const sizes of Object.values(SPLITS)) assert.deepEqual(rowsOf(streamed(q, cols, N, sizes).out), want);
});

test("groups keep their key values after the batch that made them is gone", () => {
  const q = query({ groupBy: [0], metrics: [{ id: "m", ci: 3, agg: "COUNT", alias: "" }] });
  const { out } = streamed(q, cols, N, Array(40).fill(100));
  assert.deepEqual(new Set(out[0].rows), new Set(["a", "b", "c", null, "e"]));
  assert.equal(out[1].rows.reduce((a, b) => a + b, 0), N);
});

test("the running estimate follows what is kept: totals stay small, values and distinct sets grow with the rows", () => {
  const bytes = (agg, groupBy) => streamed(query({ groupBy, metrics: [{ id: "m", ci: 3, agg, alias: "" }] }), cols, N, [N]).st.track.bytes;
  const sum = bytes("SUM", [0]), median = bytes("MED", [0]), distinct = bytes("COUNT_DISTINCT", [0]);
  assert.ok(sum < 5 * 1024, `a sum keeps only totals: ${sum}`);
  assert.ok(median > sum + N * 8, `a percentile keeps every value: ${median} vs ${sum}`);
  assert.ok(distinct > sum && distinct < median, `a distinct count keeps each distinct value once: ${distinct}`);
  const ungrouped = bytes("SUM", []), grouped = bytes("SUM", [0, 1]);
  assert.ok(grouped > ungrouped, "more groups cost more");
});

test("only a pivot cannot be folded one row group at a time", () => {
  assert.equal(streamable(query({ groupBy: [0], metrics: [{ id: "m", ci: 2, agg: "SUM", alias: "" }] })), true);
  assert.equal(streamable(query({ groupBy: [0], groupMode: "PIVOT", metrics: [{ id: "m", ci: 2, agg: "SUM", alias: "" }] })), false);
  assert.equal(streamable(query({ mode: "rows" })), false);
});

test("groups that count their values instead of keeping them still give exact percentiles, in as many passes as it takes", () => {
  const saved = { promote: RADIX.promote, gather: RADIX.gather };
  try {
    RADIX.promote = 8;        /* nearly every group now counts, so nearly every percentile is found by narrowing */
    for (const gather of [1 << 20, 32, 1]) {
      RADIX.gather = gather;
      for (const agg of ["MED", "P90", "P95", "P99", "IQR"]) {
        const q = query({ groupBy: [0, 1], groupMode: "ROLLUP", metrics: [{ id: "m", ci: 2, agg, alias: "" }] });
        const want = rowsOf(whole(q, cols, N));
        for (const [name, sizes] of Object.entries(SPLITS)) {
          const { out, st } = streamed(q, cols, N, sizes);
          assert.deepEqual(rowsOf(out), want, `${agg}, gather ${gather}, ${name}, ${st.passes} passes`);
        }
      }
    }
  } finally { Object.assign(RADIX, saved); }
});

test("a percentile stops keeping values and counts them past the threshold, so its memory stops growing with the rows", () => {
  const saved = RADIX.promote;
  try {
    const q = query({ metrics: [{ id: "m", ci: 2, agg: "P99", alias: "" }] });
    RADIX.promote = 1 << 30;                                   /* never: keep every value */
    const kept = streamed(q, cols, N, [N]).st;
    RADIX.promote = 100;
    const counted = streamed(q, cols, N, [N]).st;
    assert.ok(kept.track.bytes > N * 8, `values kept: ${kept.track.bytes}`);
    assert.ok(counted.track.bytes < kept.track.bytes / 2 + 262144 + 1, `counted instead: ${counted.track.bytes} against ${kept.track.bytes}`);
    const bigger = table(N * 4);
    const more = streamed(q, bigger, N * 4, [N * 4]).st;
    assert.ok(more.track.bytes < counted.track.bytes + 1024, `four times the rows cost no more: ${more.track.bytes} vs ${counted.track.bytes}`);
  } finally { RADIX.promote = saved; }
});
