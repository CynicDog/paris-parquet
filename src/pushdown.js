import { Cursor } from "./bytes.js";
import { $, loadMore } from "./columns.js";
import { newTable } from "./dataset.js";
import { intersectRanges, mergeRanges, rangeCount, readColumnIndex, readOffsetIndex, unionRanges } from "./encoding.js";
import { busy, FIRST_ROWS, showError, updateButtons } from "./main.js";
import { compileFilter, parseOperand, runQuery, sortKey, textOf } from "./query.js";
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

/* ------------------------------------------------------- bloom filters */
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

/* ------------------------------------------------------------ the plan */
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

/* ---------------------------------------------------------- the scan */
/**
 * Plans, then rebuilds the table from only the row groups that survived,
 * then runs the query over them. The answer is the same as reading the
 * whole file; the difference is how much of it came off disk.
 */
export async function runScan() {
  const dataset = state.dataset, q = state.query;
  if (!dataset || !state.table) return;
  if (state.sqlDirty && !adoptSql(true)) return;
  busy(true, "reading what the footers claim…");
  await new Promise((r) => setTimeout(r, 0));
  try {
    const plan = await planScan(dataset, q, state.table, async (i, n) => {
      busy(true, "planning… " + num(i + 1) + " of " + num(n) + " files");
      await new Promise((r) => setTimeout(r, 0));
    });
    if (!plan) {
      showPlan("<em>Nothing to push down — this needs a WHERE clause the file's own " +
        "statistics can be tested against.</em>");
      return;
    }
    const table = newTable(dataset);
    table.plan = plan.keep;
    table.scan = plan;
    table.need = neededColumns(table, true);
    busy(true, "decoding " + num(Math.min(plan.rows, FIRST_ROWS)) + " rows of "
      + num(plan.kept) + " row groups…");
    await new Promise((r) => setTimeout(r, 0));
    await loadMore(dataset, table, FIRST_ROWS);
    state.table = table;
    if (state.display.order.length !== table.cols.length) state.display = newDisplay(table.cols);
    renderMeta();
    updateButtons();
    runQuery();
    showPlan(planReport(plan));
  } catch (e) {
    showError(e);
  } finally { busy(false); }
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
  } catch (e) { showError(e); } finally { busy(false); }
}
/** The button is only worth pressing when there is something to push down. */
export function updateScanButton() {
  const b = $("qscan");
  if (!b) return;
  const t = state.table;
  const groups = t ? t.dataset.numGroups : 0;
  const has = !!(t && state.query && clauseGroups(state.query.filters, t.cols).length);
  b.disabled = !has || groups < 2;
  b.classList.toggle("on", !!(t && t.scan));
}


/**
 * What makes two columns of the same name the same column. The spec label
 * carries the logical type in full ("decimal(9,2)", "timestamp[millis, UTC]"),
 * so it says more than the physical type on its own. The utf-8 note is a
 * sniffing result rather than a property of the file, so it is not compared.
 */
