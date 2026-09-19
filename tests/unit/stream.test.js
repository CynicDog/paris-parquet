import assert from "node:assert/strict";
import { test } from "node:test";
import { AGG_MORE, AGGS, aggregate, endValueSlice, feedAggBatch, finishAggStream, matchIndex, newAggStream, radixAdvanceStream, radixFeedBatch, radixOpenStream, radixPlanStream, streamable } from "../../src/query.js";
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

/**
 * What the page does when the running totals do not fit: read the file again in P hash slices. Mode "G"
 * finishes each slice's groups before the next; mode "V" keeps every group and only one slice of the
 * distinct values and mode candidates at a time. Returns the answer rows and the biggest running estimate.
 */
function sliced(q, cols, n, sizes, P, mode) {
  const parts = bounds(n, sizes);
  let peak = 0;
  const finishOne = (st) => {
    radixPlanStream(st);
    while (radixOpenStream(st)) { for (const [a, b] of parts) radixFeedBatch(st, slice(cols, a, b), b - a); radixAdvanceStream(st); }
    return finishAggStream(st);
  };
  if (mode === "G") {
    let out = null;
    for (let k = 0; k < P; k++) {
      const st = newAggStream(q, cols, { P, k, mode });
      for (const [a, b] of parts) feedAggBatch(st, slice(cols, a, b), b - a);
      peak = Math.max(peak, st.track.bytes);
      const part = finishOne(st);
      if (!out) out = part; else for (let i = 0; i < part.length; i++) out[i].rows.push(...part[i].rows);
    }
    return { out, peak };
  }
  const st = newAggStream(q, cols, { P, k: 0, mode });
  for (const [a, b] of parts) feedAggBatch(st, slice(cols, a, b), b - a);
  peak = st.track.bytes;
  endValueSlice(st);
  for (let k = 1; k < P; k++) {
    st.slice = { P, k, mode };
    st.rows = 0;
    for (const [a, b] of parts) feedAggBatch(st, slice(cols, a, b), b - a);
    peak = Math.max(peak, st.track.bytes);
    endValueSlice(st);
  }
  return { out: finishOne(st), peak };
}
/** Rows as sorted strings, since slicing changes the order groups come out in but not which ones there are. */
const asSet = (out) => {
  const n = out[0].rows.length;
  return Array.from({ length: n }, (_, i) => JSON.stringify(out.map((c) => c.rows[i]))).sort();
};

test("hash-sliced passes give the same answer as one pass, group slices and value slices alike", () => {
  const metrics = [{ id: "a", ci: 2, agg: "AVG", alias: "" }, { id: "b", ci: 3, agg: "COUNT_DISTINCT", alias: "" }, { id: "c", ci: 3, agg: "MODE", alias: "" },
    { id: "d", ci: 2, agg: "P99", alias: "" }, { id: "e", ci: 0, agg: "COUNT_DISTINCT", alias: "" }];
  const saved = { ...RADIX };
  RADIX.promote = 8; RADIX.gather = 4;          /* force the counting groups and narrowing passes too */
  try {
    for (const groupMode of ["", "ROLLUP"]) {
      const q = query({ groupBy: [0, 1], groupMode, metrics });
      const want = asSet(whole(q, cols, N));
      for (const mode of ["G", "V"]) for (const P of [2, 3, 8]) {
        assert.deepEqual(asSet(sliced(q, cols, N, [700, 1, 3299], P, mode).out), want, `${groupMode || "flat"}, ${mode} x ${P}`);
      }
    }
    /* no GROUP BY: one group, so only value slices apply */
    const q = query({ metrics: metrics.slice(0, 3) });
    for (const P of [2, 5]) assert.deepEqual(asSet(sliced(q, cols, N, [N], P, "V").out), asSet(whole(q, cols, N)), `single group, V x ${P}`);
  } finally { Object.assign(RADIX, saved); }
});

test("slicing is what makes the running estimate small: each slice keeps about 1/P of the groups or of the values", () => {
  const n = 6000, big = col("id", numSpec, Array.from({ length: n }, (_, i) => i)), v = col("v", numSpec, Array.from({ length: n }, (_, i) => (i * 7919) % n));
  const qg = query({ groupBy: [0], metrics: [{ id: "m", ci: 1, agg: "SUM", alias: "" }] });
  const one = sliced(qg, [big, v], n, [n], 1, "G").peak, eight = sliced(qg, [big, v], n, [n], 8, "G").peak;
  assert.ok(eight < one / 5, `groups: ${eight} vs ${one}`);
  const qv = query({ metrics: [{ id: "m", ci: 1, agg: "COUNT_DISTINCT", alias: "" }] });
  const v1 = sliced(qv, [big, v], n, [n], 1, "V").peak, v8 = sliced(qv, [big, v], n, [n], 8, "V").peak;
  assert.ok(v8 < v1 / 5, `values: ${v8} vs ${v1}`);
  assert.equal(sliced(qv, [big, v], n, [n], 8, "V").out[0].rows[0], n);
});
