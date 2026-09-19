// Predicate pushdown: turns a query's WHERE clause into a plan of which row
// groups (and, within a group, which page ranges) could hold a matching row,
// using footer statistics, page indexes, and bloom filters (with its own
// xxh64) before `runWhole` rebuilds the table from only what survived.

import { budgetBytes, bytesText, groupsAhead, groupsBytes, heldBytes } from "./budget.js";
import { Cursor } from "./bytes.js";
import { $, loadMore, unfilled } from "./columns.js";
import { newTable } from "./dataset.js";
import { intersectRanges, mergeRanges, rangeCount, readColumnIndex, readOffsetIndex, unionRanges } from "./encoding.js";
import { busy, FIRST_ROWS, showError, showMemNote, updateButtons } from "./main.js";
import { progressStep } from "./progress.js";
import { aggKept, aggSignature, compileFilter, feedAggBatch, finishAggStream, isQuantile, newAggStream, parseOperand, radixAdvanceStream, radixColumns, radixFeedBatch, radixOpenStream, radixPendingBytes, radixPlanStream, runQuery, sortKey, streamable, textOf } from "./query.js";
import { thriftStruct } from "./thrift.js";
import { rawStat, renderMeta } from "./ui-metadata.js";
import { adoptSql } from "./ui-query-builder.js";
import { baseView, bytesHuman, neededColumns, newDisplay, num, setView, state } from "./view.js";

export const PAGE_NARROW_MIN = 4096;
/* and narrowing that leaves most of the group behind is not narrowing */
export const PAGE_NARROW_KEEP = 0.8;

/** Mirrors orGroups: AND binds tighter, so clauses are OR-ed groups of ANDs. */
export function clauseGroups(filters, cols) {
  const groups = [];
  let current = null;
  for (const f of filters) {
    if (!compileFilter(f, cols)) continue;      /* the engine ignores it too */
    if (!current || f.linker === "OR") { current = []; groups.push(current); }
    current.push(f);
  }
  return groups;
}
/** Can the whole WHERE be true for some row, given a verdict per clause? */
export function anyGroupMatches(groups, decide) {
  for (const grp of groups) {
    let ok = true;
    for (let i = 0; i < grp.length; i++) if (!decide(grp[i])) { ok = false; break; }
    if (ok) return true;
  }
  return !groups.length;
}

export const isAscii = (s) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
};

/**
 * The range a column chunk claims, in the space the engine compares in.
 * lo/hi come back null whenever the claim cannot be trusted:
 *  - no statistics at all, or a type whose value we cannot rebuild;
 *  - a repeated column, whose statistics describe leaf values while the
 *    engine compares assembled arrays;
 *  - a byte array with only the deprecated min/max, which some writers
 *    wrote in signed byte order;
 *  - text outside ASCII, where parquet's unsigned byte order and
 *    JavaScript's UTF-16 order can disagree.
 * Truncated statistics stay usable: the spec has them bound the real
 * value rather than replace it.
 */
export function chunkBounds(chunk, leaf, spec) {
  const m = chunk.meta;
  const st = m ? m.statistics : null;
  if (!st) return null;
  const out = { lo: null, hi: null, nulls: st.nullCount == null ? null : st.nullCount,
    values: m.numValues == null ? null : m.numValues };
  if (spec.nested) return out;
  const deprecated = st.minValue == null && st.maxValue == null;
  const bytesTyped = leaf.type === "BYTE_ARRAY" || leaf.type === "FIXED_LEN_BYTE_ARRAY";
  if (deprecated && bytesTyped) return out;
  fillBounds(out, st.minValue != null ? st.minValue : st.min,
    st.maxValue != null ? st.maxValue : st.max, leaf, spec);
  return out;
}
/** Turns a pair of statistics blobs into the range the engine compares in. */
export function fillBounds(out, loB, hiB, leaf, spec) {
  if (!loB || !loB.length || !hiB || !hiB.length) return out;
  let lo, hi;
  try {
    lo = spec.convert(rawStat(loB, leaf));
    hi = spec.convert(rawStat(hiB, leaf));
  } catch (_e) { return out; }
  const key = sortKey(spec);
  if (key) {
    lo = key(lo);
    hi = key(hi);
    if (lo !== lo || hi !== hi || lo > hi) return out;      /* NaN, or nonsense */
  } else {
    lo = lo == null ? null : String(textOf(lo, spec));
    hi = hi == null ? null : String(textOf(hi, spec));
    if (lo == null || hi == null || !isAscii(lo) || !isAscii(hi) || lo > hi) return out;
  }
  out.lo = lo;
  out.hi = hi;
  return out;
}

/**
 * The rows of one row group a clause could be true in, from the page index:
 * every page whose own min/max and null count allow a match. null means the
 * index cannot answer, and the whole group stands.
 */
export async function clauseRanges(part, rg, f, col, numRows) {
  if (!col || col.partKey !== undefined || col.spec.nested) return null;
  const leaf = part.leafByPath ? part.leafByPath.get(col.key) : null;
  if (!leaf || leaf.maxRep > 0) return null;
  let chunk = null;
  for (const c of rg.columns) if (c.meta && c.meta.path.join("\u0001") === col.key) { chunk = c; break; }
  if (!chunk || chunk.filePath) return null;
  const ci = await readColumnIndex(part.src, chunk);
  const locs = await readOffsetIndex(part.src, chunk);
  if (!ci || !locs || locs.length !== ci.nullPages.length) return null;
  const out = [];
  for (let p = 0; p < locs.length; p++) {
    const from = locs[p].row;
    const to = p + 1 < locs.length ? locs[p + 1].row : numRows;
    if (to <= from) return null;                       /* an index we misread */
    const b = { lo: null, hi: null, nulls: ci.nullCounts ? ci.nullCounts[p] : null, values: to - from };
    if (ci.nullPages[p]) b.nulls = to - from;
    else fillBounds(b, ci.mins[p], ci.maxes[p], leaf, col.spec);
    if (clauseCanMatch(f, col.spec, b)) out.push([from, to]);
  }
  return mergeRanges(out);
}

/** False only when no row in a chunk with these bounds could satisfy f. */
export function clauseCanMatch(f, spec, b) {
  const p = f.pred;
  const allNull = b.nulls != null && b.values != null && b.nulls >= b.values;
  if (p === "null") return b.nulls !== 0;
  if (p === "notnull") return !allNull;
  if (p === "like") return true;              /* a substring test has no order */
  if (f.value === "" || f.value == null) return true;
  if (allNull) return false;                  /* every comparison is false on null */
  if (b.lo === null || b.hi === null) return true;
  let a, z;
  const key = sortKey(spec);
  if (key) {
    a = parseOperand(f.value, spec);
    if (!isFinite(a)) return true;
    z = f.valueTo == null || f.valueTo === "" ? a : parseOperand(f.valueTo, spec);
    if (!isFinite(z)) z = a;
  } else {
    a = String(f.value);
    z = f.valueTo == null || f.valueTo === "" ? a : String(f.valueTo);
    if (!isAscii(a) || !isAscii(z)) return true;
  }
  switch (p) {
    case "eq": return !(a < b.lo || a > b.hi);
    case "ne": return !(b.lo === b.hi && b.lo === a && b.nulls === 0);
    case "lt": return b.lo < a;
    case "le": return b.lo <= a;
    case "gt": return b.hi > a;
    case "ge": return b.hi >= a;
    case "between": return !(b.hi < a || b.lo > z);
    default: return true;
  }
}

/** The engine's own test, run against a partition column's single value. */
export function partitionCanMatch(f, col, value) {
  const probe = [];
  probe[f.ci] = { rows: [value], spec: col.spec };
  const test = compileFilter(f, probe);
  return !test || test(0);
}

/* xxh64, which is the only hash parquet's bloom filters use. BigInt keeps
   the 64-bit arithmetic honest; one small value is hashed per clause per
   row group, so its cost never shows. */
export const XXP1 = 11400714785074694791n, XXP2 = 14029467366897019727n,
      XXP3 = 1609587929392839161n, XXP4 = 9650029242287828579n,
      XXP5 = 2870177450012600261n;
export const U64 = (1n << 64n) - 1n;
export const xrot = (x, r) => ((x << r) | (x >> (64n - r))) & U64;
export const xround = (acc, input) => (xrot((acc + input * XXP2) & U64, 31n) * XXP1) & U64;
export function xxh64(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  let h, p = 0;
  if (len >= 32) {
    let v1 = (XXP1 + XXP2) & U64, v2 = XXP2, v3 = 0n, v4 = (-XXP1) & U64;
    for (; p <= len - 32; p += 32) {
      v1 = xround(v1, dv.getBigUint64(p, true));
      v2 = xround(v2, dv.getBigUint64(p + 8, true));
      v3 = xround(v3, dv.getBigUint64(p + 16, true));
      v4 = xround(v4, dv.getBigUint64(p + 24, true));
    }
    h = (xrot(v1, 1n) + xrot(v2, 7n) + xrot(v3, 12n) + xrot(v4, 18n)) & U64;
    for (const v of [v1, v2, v3, v4]) {
      h = ((h ^ xround(0n, v)) * XXP1 + XXP4) & U64;
    }
  } else {
    h = XXP5;
  }
  h = (h + BigInt(len)) & U64;
  for (; p <= len - 8; p += 8) {
    h = ((xrot(h ^ xround(0n, dv.getBigUint64(p, true)), 27n) * XXP1) + XXP4) & U64;
  }
  if (p <= len - 4) {
    h = ((xrot((h ^ ((BigInt(dv.getUint32(p, true)) * XXP1) & U64)), 23n) * XXP2) + XXP3) & U64;
    p += 4;
  }
  for (; p < len; p++) {
    h = (xrot(h ^ ((BigInt(bytes[p]) * XXP5) & U64), 11n) * XXP1) & U64;
  }
  h = (h ^ (h >> 33n)) * XXP2 & U64;
  h = (h ^ (h >> 29n)) * XXP3 & U64;
  return (h ^ (h >> 32n)) & U64;
}

/* the split-block filter: 32-byte blocks of eight 32-bit words, one bit
   set per word, so a lookup is eight ANDs against one cache line */
export const BLOOM_SALT = [0x47b6137b, 0x44974d91, 0x8824ad5b, 0xa2b7289d,
                    0x705495c7, 0x2df1424b, 0x9efc4947, 0x5c6bfb31];
export function bloomHas(data, hash) {
  const blocks = Math.floor(data.length / 32);
  if (!blocks) return true;
  const block = Number(((hash >> 32n) * BigInt(blocks)) >> 32n);
  const key = Number(BigInt.asUintN(32, hash)) >>> 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const base = block * 32;
  for (let i = 0; i < 8; i++) {
    const bit = (Math.imul(key, BLOOM_SALT[i]) >>> 0) >>> 27;
    if ((dv.getUint32(base + i * 4, true) & (1 << bit)) === 0) return false;
  }
  return true;
}
/** Reads a chunk's bloom filter, once, and remembers it on the chunk. */
export async function readBloom(src, chunk) {
  if (chunk.bloom !== undefined) return chunk.bloom;
  chunk.bloom = null;
  const off = chunk.meta ? chunk.meta.bloomFilterOffset : null;
  if (off == null || off <= 0 || off >= src.size) return null;
  try {
    const head = await src.read(off, Math.min(src.size, off + 64));
    const c = new Cursor(head, 0);
    const h = thriftStruct(c);
    const numBytes = h[1] | 0;
    /* every field is a union of one member each; anything else is a filter
       written by a spec we do not know, and is not ours to interpret */
    if (!numBytes || !h[2] || !h[2][1] || !h[3] || !h[3][1] || (h[4] && !h[4][1])) return null;
    const start = off + c.p;
    if (start + numBytes > src.size) return null;
    chunk.bloom = await src.read(start, start + numBytes);
  } catch (_e) { chunk.bloom = null; }
  return chunk.bloom;
}
/**
 * The bytes a bloom filter would have hashed for this operand: the value
 * as parquet stores it physically. Only the types whose text can be turned
 * back into exactly those bytes are offered — a value we might rebuild
 * wrongly would skip a row group that does hold it.
 */
export function bloomBytes(f, col) {
  if (f.pred !== "eq" || f.value === "" || f.value == null) return null;
  const spec = col.spec, leaf = col.leaf;
  if (!leaf || spec.nested || spec.decimal) return null;
  const t = leaf.type;
  if (spec.kind === "string" && t === "BYTE_ARRAY") return new TextEncoder().encode(String(f.value));
  if (spec.kind !== "number") return null;
  const v = parseOperand(f.value, spec);
  if (!isFinite(v) || !Number.isSafeInteger(v)) return null;
  const b = new Uint8Array(t === "INT32" ? 4 : 8);
  const dv = new DataView(b.buffer);
  if (t === "INT32") dv.setInt32(0, v, true);
  else if (t === "INT64") dv.setBigInt64(0, BigInt.asIntN(64, BigInt(v)), true);
  else return null;
  return b;
}

/**
 * Walks every row group and decides, from the footer alone plus any bloom
 * filters, which ones could hold a matching row. Returns null when there
 * is nothing to push down.
 */
export async function planScan(dataset, query, table, onProgress) {
  const cols = table.cols;
  const groups = clauseGroups(query.filters, cols);
  if (!groups.length) return null;
  const t0 = performance.now();
  const keep = new Map();          /* "part:group" -> null for all of it, or row ranges */
  const plan = { keep, total: 0, kept: 0, bytesTotal: 0, bytesKept: 0, rows: 0, rowsTotal: 0,
    byStats: 0, byBloom: 0, byPartition: 0, byPages: 0, narrowed: 0, rowsSkipped: 0,
    files: 0, filesTotal: dataset.parts.length, ms: 0 };
  const chunkOf = (rg, col) => {
    for (const c of rg.columns) if (c.meta && c.meta.path.join("\u0001") === col.key) return c;
    return null;
  };

  for (let pi = 0; pi < dataset.parts.length; pi++) {
    const part = dataset.parts[pi];
    const rgs = part.meta.rowGroups;
    const bytesOf = (rg) => {
      let n = 0;
      for (const c of rg.columns) if (c.meta) n += c.meta.totalCompressedSize;
      return n;
    };
    /* a partition column holds one value for the whole file, so a clause on
       it can rule out every row group at once */
    const fileOut = !anyGroupMatches(groups, (f) => {
      const col = cols[f.ci];
      if (!col || col.partKey === undefined) return true;
      return partitionCanMatch(f, col, part.partValues ? part.partValues[col.partKey] : null);
    });
    for (let gi = 0; gi < rgs.length; gi++) {
      const rg = rgs[gi];
      plan.total++;
      plan.rowsTotal += rg.numRows;
      plan.bytesTotal += bytesOf(rg);
      if (fileOut) { plan.byPartition++; continue; }

      const bounds = new Map();
      const statsSay = (f) => {
        const col = cols[f.ci];
        if (!col || col.partKey !== undefined) return true;   /* partitions done above */
        if (!bounds.has(f.ci)) {
          const chunk = chunkOf(rg, col);
          const leaf = part.leafByPath ? part.leafByPath.get(col.key) : null;
          bounds.set(f.ci, chunk && leaf ? chunkBounds(chunk, leaf, col.spec) : null);
        }
        const b = bounds.get(f.ci);
        return !b || clauseCanMatch(f, col.spec, b);
      };
      if (!anyGroupMatches(groups, statsSay)) { plan.byStats++; continue; }

      /* whatever the statistics could not rule out, a bloom filter might:
         an equality test on unsorted data is exactly what they are for */
      let ruled = null;
      for (const grp of groups) {
        for (const f of grp) {
          const col = cols[f.ci];
          if (!col || col.partKey !== undefined) continue;
          const bytes = bloomBytes(f, col);
          if (!bytes) continue;
          const chunk = chunkOf(rg, col);
          if (!chunk || chunk.meta.bloomFilterOffset == null) continue;
          const data = await readBloom(part.src, chunk);
          if (data && !bloomHas(data, xxh64(bytes))) {
            if (!ruled) ruled = new Set();
            ruled.add(f);
          }
        }
      }
      if (ruled && !anyGroupMatches(groups, (f) => !ruled.has(f) && statsSay(f))) {
        plan.byBloom++;
        continue;
      }

      /* the same question one level down: which pages of this group could
         hold a match. Ranges are intersected within an AND and united across
         ORs, so every column reads exactly the same rows. */
      let ranges = null, narrowed = false;
      if (rg.numRows > PAGE_NARROW_MIN) {
        const perGroup = [];
        for (const grp of groups) {
          let acc = null;
          for (const f of grp) {
            const r = await clauseRanges(part, rg, f, cols[f.ci], rg.numRows);
            if (!r) continue;                      /* this clause narrows nothing */
            narrowed = true;
            acc = acc === null ? r : intersectRanges(acc, r);
            if (!acc.length) break;
          }
          perGroup.push(acc === null ? [[0, rg.numRows]] : acc);
        }
        if (narrowed) {
          let all = [];
          for (const g of perGroup) all = unionRanges(all, g);
          ranges = all;
        }
      }
      if (ranges) {
        const rows = rangeCount(ranges);
        if (!rows) { plan.byPages++; plan.rowsSkipped += rg.numRows; continue; }
        /* reading page by page costs a read apiece, so it has to save enough
           pages to be worth not reading the chunk in one go */
        if (rows > rg.numRows * PAGE_NARROW_KEEP) ranges = null;
        else { plan.narrowed++; plan.rowsSkipped += rg.numRows - rows; plan.estimated = true; }
      }
      keep.set(pi + ":" + gi, ranges);
      plan.kept++;
      plan.rows += ranges ? rangeCount(ranges) : rg.numRows;
      plan.bytesKept += ranges ? Math.round(bytesOf(rg) * rangeCount(ranges) / rg.numRows) : bytesOf(rg);
    }
    if (onProgress && dataset.parts.length > 1) await onProgress(pi, dataset.parts.length);
  }
  const files = new Set();
  for (const k of keep.keys()) files.add(k.split(":")[0]);
  plan.files = files.size;
  plan.ms = Math.round(performance.now() - t0);
  return plan;
}

/** What the scan saved, in the words of what it read rather than skipped. */
export function planReport(plan) {
  const skipped = plan.total - plan.kept;
  if (!skipped) {
    return "read every one of " + num(plan.total) + " row groups &mdash; " +
      "nothing in this file's statistics rules any of them out";
  }
  const why = [];
  if (plan.byStats) why.push(num(plan.byStats) + " by statistics");
  if (plan.byBloom) why.push(num(plan.byBloom) + " by bloom filter");
  if (plan.byPartition) why.push(num(plan.byPartition) + " by partition");
  if (plan.byPages) why.push(num(plan.byPages) + " by page index");
  return "read <b>" + num(plan.kept) + "</b> of " + num(plan.total) + " row groups" +
    (plan.filesTotal > 1 ? " in " + num(plan.files) + " of " + num(plan.filesTotal) + " files" : "") +
    " &middot; " + (plan.estimated ? "about " : "") + "<b>" + bytesHuman(plan.bytesKept) +
      "</b> of " + bytesHuman(plan.bytesTotal) +
    " &middot; skipped " + num(skipped) + " (" + why.join(", ") + ")" +
    (plan.narrowed ? " &middot; and " + num(plan.narrowed) + " narrowed by page to " +
      num(plan.rows) + " of " + num(plan.rowsTotal) + " rows" : "") +
    " in " + num(plan.ms) + " ms";
}

const RUN_STEPS = [
  { label: "Plan", why: "Ruling row groups out from what the file's footer says about each one (min and max, bloom filters, page index), without reading any data." },
  { label: "Check the memory budget", why: "Estimating what the row groups that remain will take once decoded, so a query that would not fit is refused now rather than run out of memory halfway." },
  { label: "Read", why: "Decoding only the columns the query uses, from only the row groups that could match. An aggregate folds each row group into running totals and lets it go, so memory does not grow with the file." },
  { label: "Compute", why: "Working out the answer from what was read." },
];
/* a query with a percentile has one more step: the passes that find it exactly */
const RUN_STEPS_PCT = RUN_STEPS.slice(0, 3).concat([
  { label: "Refine percentiles", why: "Percentiles are exact and found without sorting: the first pass counted values into buckets, and each further pass collects only the bucket a percentile falls in (or narrows it by another 16 bits), so a sorted copy of the column is never held." },
], RUN_STEPS.slice(3));
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Frees the decoded rows a table holds, so its replacement can be read without both in memory at once. */
function releaseRows(table) {
  for (const c of table.cols) { c.rows = []; c.filled = 0; }
}
/** Reads the first rows back after a run that released them was cancelled or failed. */
async function restoreBrowse(dataset) {
  busy(true, "Restoring the view");
  try {
    const table = newTable(dataset);
    table.need = neededColumns(table);
    await loadMore(dataset, table, FIRST_ROWS);
    state.table = table;
    if (state.query && state.query.active) runQuery(); else setView(baseView(table));
    renderMeta();
    updateButtons();
    describeScope();
  } catch (e) { showError(e); } finally { busy(false); }
}

/**
 * Runs the query against the whole file, which is what a query means. A WHERE is first planned
 * against the footer so only the row groups that could match are read (the answer is the same as
 * reading everything; the difference is how much came off disk). An aggregate then reads every
 * row of the columns it needs, and a plain query reads the first matches and pages on demand.
 * Either is checked against the memory budget before anything is decoded, and refused with the
 * numbers if it will not fit, rather than quietly answering about fewer rows.
 */
export async function runWhole() {
  const dataset = state.dataset, q = state.query, cur = state.table;
  if (!dataset || !cur) return;
  if (state.sqlDirty && !adoptSql(false)) return;
  const agg = q.mode === "agg" && (q.groupBy.length || q.metrics.length);
  const hasWhere = clauseGroups(q.filters, cur.cols).length > 0;
  /* nothing further to read: browsing a file with no filter, or a table that already holds every row
     of every column this query needs. A table that holds every row but lacks a column is NOT topped up:
     that would keep the columns of every earlier query in memory too, so what is held would grow with
     the history of queries instead of with what this one needs. It is rebuilt with just what is needed. */
  const complete = cur.rowsLoaded >= dataset.numRows && !cur.scan && !unfilled(cur, [...neededColumns(cur, true)]).length;
  if ((!hasWhere && !agg) || complete) { runQuery(); return; }
  const stop = { asked: false };
  let needRestore = false;
  const pct = !!agg && q.metrics.some((m) => isQuantile(m.agg));
  const steps = pct ? RUN_STEPS_PCT : RUN_STEPS;
  const computeStep = steps.length - 1;
  busy(true, agg ? "Aggregating the whole file" : "Searching the whole file", steps, () => { stop.asked = true; });
  await tick();
  try {
    progressStep(0, 0.1, hasWhere ? "reading row group statistics for the WHERE clause" : "no WHERE clause, so every row group is needed");
    const plan = hasWhere ? await planScan(dataset, q, cur, async (i, n) => {
      progressStep(0, (i + 1) / n, "file " + num(i + 1) + " of " + num(n));
      await tick();
    }) : null;
    const table = newTable(dataset);
    if (plan) { table.plan = plan.keep; table.scan = plan; }
    table.need = neededColumns(table, true);

    progressStep(1, 0.3, "estimating the size of the row groups that remain");
    const groups = groupsAhead(dataset, table, agg ? Infinity : FIRST_ROWS);
    const cols = [...table.need];
    const budget = budgetBytes();
    const cost = groupsBytes(dataset, table, groups, cols);
    if (agg && streamable(q)) {
      /* folded one row group at a time: what has to fit is the largest single group, and the running
         totals, which cannot be known in advance (how many groups, how many distinct values) and are
         watched as they grow instead */
      const biggest = groups.reduce((mx, g) => Math.max(mx, groupsBytes(dataset, table, [g], cols)), 0);
      if (biggest > budget) {
        showMemNote("Not run over the whole file: one row group of " + num(cols.length) + " column" + (cols.length === 1 ? "" : "s") +
          " would take about " + bytesText(biggest) + " once decoded, over this page's " + bytesText(budget) + " memory budget. Aggregate fewer columns.",
          [{ label: "Run on the " + num(cur.rowsLoaded) + " rows already read", run: () => { showMemNote(null); runQuery(); } }]);
        return;
      }
      if (heldBytes(dataset, cur) > 0) { releaseRows(cur); state.view = null; needRestore = true; }
      const st = newAggStream(q, cur.cols);
      const room = budget - biggest;
      const t0 = performance.now();
      for (let i = 0; i < groups.length; i++) {
        if (stop.asked) break;
        const g = groups[i], of = groups.length;
        progressStep(2, i / of, "row group " + num(i + 1) + " of " + num(of) + ": reading");
        const batch = newTable(dataset);
        batch.plan = table.plan;
        batch.need = table.need;
        batch.nextPart = g.pi;
        batch.nextGroup = g.gi;
        await loadMore(dataset, batch, 1);
        if (stop.asked) break;
        feedAggBatch(st, batch.cols, batch.rowsLoaded);
        progressStep(2, (i + 1) / of, "row group " + num(i + 1) + " of " + num(of) + ": folded into " + num(st.maps[0].size) + " group" + (st.maps[0].size === 1 ? "" : "s"));
        if (st.track.bytes > room) {
          showMemNote("Not run over the whole file: after " + num(i + 1) + " of " + num(of) + " row groups its running totals (" + num(st.maps[0].size) +
            " groups, and the values a percentile, distinct count or mode has to keep) were estimated at " + bytesText(st.track.bytes) +
            ", over what this page can hold beside a decoded row group (" + bytesText(room) + "). Group by a column with fewer distinct values, or use fewer or lighter metrics: " +
            "a percentile keeps every value and a distinct count every distinct value.",
            [{ label: "Run on the " + num(cur.rowsLoaded) + " rows already read", run: () => { showMemNote(null); runQuery(); } }]);
          return;
        }
        await tick();
      }
      if (stop.asked) { showMemNote("Cancelled: nothing was changed."); return; }
      /* the groups that kept counts instead of values now find their percentiles by narrowing passes: each
         re-reads only the columns it still needs, and collects only the bucket a percentile falls in */
      if (pct) {
        radixPlanStream(st);
        let pass = 1;
        while (radixOpenStream(st) && !stop.asked) {
          pass++;
          const pending = radixPendingBytes(st);
          if (st.track.bytes + pending > room) {
            showMemNote("Not run over the whole file: finding exact percentiles for " + num(st.maps[0].size) + " groups needs about " + bytesText(pending) +
              " more than the running totals already hold, over what this page can hold beside a decoded row group (" + bytesText(room) +
              "). Group by a column with fewer distinct values, or ask for fewer percentiles.",
              [{ label: "Run on the " + num(cur.rowsLoaded) + " rows already read", run: () => { showMemNote(null); runQuery(); } }]);
            return;
          }
          const need = radixColumns(st);
          for (let i = 0; i < groups.length; i++) {
            if (stop.asked) break;
            const g = groups[i], of = groups.length;
            progressStep(3, i / of, "pass " + num(pass) + ", row group " + num(i + 1) + " of " + num(of) + ": collecting the buckets the percentiles fall in");
            const batch = newTable(dataset);
            batch.plan = table.plan;
            batch.need = need;
            batch.nextPart = g.pi;
            batch.nextGroup = g.gi;
            await loadMore(dataset, batch, 1);
            if (stop.asked) break;
            radixFeedBatch(st, batch.cols, batch.rowsLoaded);
            await tick();
          }
          if (stop.asked) break;
          radixAdvanceStream(st);
        }
        if (stop.asked) { showMemNote("Cancelled: nothing was changed."); return; }
      }
      progressStep(computeStep, 0.5, num(st.maps[0].size) + " group" + (st.maps[0].size === 1 ? "" : "s") + " from " + num(st.rows) + " rows");
      await tick();
      state.agg = { sig: aggSignature(q), dataset, outCols: finishAggStream(st), rows: st.rows, plan, ms: Math.round(performance.now() - t0) };
      showMemNote(null);
      runQuery();          /* shows the kept answer; the browsing table is read back narrow, in the finally below */
      return;
    }
    if (agg && cost > budget) {
      showMemNote("Not run over the whole file: reading " + num(groups.reduce((n, g) => n + g.rows, 0)) + " rows of " + num(cols.length) +
        " column" + (cols.length === 1 ? "" : "s") + " would take about " + bytesText(cost) + ", over this page's " + bytesText(budget) +
        " memory budget. Narrow it with a WHERE clause on a column the file is sorted or clustered by, or aggregate fewer columns.",
        [{ label: "Run on the " + num(cur.rowsLoaded) + " rows already read", run: () => { showMemNote(null); runQuery(); } }]);
      return;
    }

    /* the table on screen is about to be replaced, so what it holds is freed first: the old rows and
       the new ones are never in memory together (if this is cancelled or fails, the view is read back) */
    if (heldBytes(dataset, cur) > 0) { releaseRows(cur); state.view = null; needRestore = true; }
    progressStep(2, 0, "row group 1 of " + num(groups.length));
    await tick();
    await loadMore(dataset, table, agg ? Infinity : FIRST_ROWS, (_pi, _gi, ci, n) => {
      progressStep(2, (table.groupsLoaded + ci / n) / Math.max(1, groups.length),
        "row group " + num(Math.min(groups.length, table.groupsLoaded + 1)) + " of " + num(groups.length) + ", column " + num(ci + 1) + " of " + num(n));
    });
    if (stop.asked) { showMemNote("Cancelled: nothing was changed."); return; }

    progressStep(3, 0.5, num(table.rowsLoaded) + " rows in memory");
    await tick();
    state.table = table;
    needRestore = false;
    if (state.display.order.length !== table.cols.length) state.display = newDisplay(table.cols);
    renderMeta();
    updateButtons();
    showMemNote(null);
    runQuery();
  } catch (e) {
    showError(e);
  } finally {
    busy(false);
    /* in the finally, not after it: a cancelled run leaves the try block by return, and would skip this */
    if (needRestore) await restoreBrowse(dataset);
  }
}

/**
 * The line under the query bar: what the answer on screen covers. It says so every time, because
 * an answer about the first quarter of a percent of a file reads exactly like an answer about all of it.
 */
export function describeScope() {
  const t = state.table, d = state.dataset, q = state.query;
  if (!t || !d) { showPlan(""); return; }
  const total = d.numRows, read = t.rowsLoaded;
  const pctRead = total ? Math.min(100, (read / total) * 100) : 100;
  const share = pctRead >= 10 ? Math.round(pctRead) : pctRead >= 1 ? pctRead.toFixed(1) : pctRead.toFixed(2);
  if (!(q && q.active)) {
    showPlan(read < total ? "Showing the first <b>" + num(read) + "</b> of " + num(total) + " rows (" + share + "%). <b>Run</b> searches the whole file." : "");
    return;
  }
  const kept = aggKept();
  if (kept) {
    showPlan("<b>Whole file.</b> " + (kept.plan ? "Aggregated over " + planReport(kept.plan) + "." : "Searched all " + num(kept.rows) + " rows."));
    return;
  }
  if (t.scan) {
    const agg = q.mode === "agg";
    const more = t.truncated ? " Showing matches from the first " + num(t.groupsLoaded) + " of them; <b>Load more</b> reads on." : "";
    showPlan("<b>Whole file.</b> " + (agg ? "Aggregated over " : "") + planReport(t.scan) + "." + (agg ? "" : more));
    return;
  }
  if (read >= total) { showPlan("<b>Whole file.</b> Searched all " + num(total) + " rows."); return; }
  showPlan("<em>Only the " + num(read) + " rows read so far (" + share + "% of the file), not the whole file.</em> " +
    "Use <b>Run</b> to search all of it" + (t.truncated ? ", or Load more to read further" : "") + ".");
}
export function showPlan(html) {
  const el = $("qplan");
  el.innerHTML = html;
  el.hidden = !html;
}
/** A scanned table holds only the rows that could match, so leaving the
    query behind means reading the file again the ordinary way. */
export async function unscan() {
  const dataset = state.dataset;
  if (!dataset || !state.table || !state.table.scan) return;
  busy(true, "reading the file again…");
  await new Promise((r) => setTimeout(r, 0));
  try {
    const table = newTable(dataset);
    await loadMore(dataset, table, FIRST_ROWS);
    state.table = table;
    setView(baseView(table));
    renderMeta();
    updateButtons();
    describeScope();               /* it described the scanned table until this read finished */
  } catch (e) { showError(e); } finally { busy(false); }
}
