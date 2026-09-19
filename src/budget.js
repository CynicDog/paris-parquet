// The memory budget: how many bytes of decoded cells the page is willing to
// hold, an estimate of what decoding a row group costs, and the planning that
// keeps a load inside it. Nothing here touches the page; it reads the footer's
// own numbers and answers "will this fit?" before anything is decoded, so a file
// that would not fit is narrowed or refused with a reason rather than left to
// take the tab down.
//
// The per-cell costs are measured, not guessed: docs/stress-test.md records
// them (tests/stress/stress.mjs, calibrate scenario). They are the size of a
// decoded value once the JS engine has built it, which is several times the
// size on disk, and by far the most for plain strings and decimals. They are
// rounded up and multiplied by SAFETY, because underestimating is the
// expensive mistake.

import { rangeCount } from "./encoding.js";
import { chunkFor } from "./workers.js";

export const MB = 1048576;

/**
 * "This would not fit" is an answer, not a bug: it is shown to the person like any other
 * error, but it is not logged to the console as one.
 */
export class Refusal extends Error {
  constructor(message) { super(message); this.name = "Refusal"; }
}
/** Bytes per decoded cell, by the kind of column, measured. */
export const CELL = { fixed: 20, dictionary: 16, decimal: 120, nested: 120, unknown: 32, stringBase: 180, stringPerByte: 2,
  /* a date or timestamp is converted per row whatever its encoding, so a dictionary saves nothing; a list costs a base and a share per element */
  temporal: 48, nestedBase: 70, nestedPerElement: 18 };
/**
 * Estimates are multiplied by this. The per-cell costs above are what a decoded value keeps once
 * decoding is done; what takes a tab down is the peak while it is happening, when a row group's
 * buffers and the arrays built from them are alive together. Measured on a 200-column file, the
 * peak was about twice what the estimate of the retained size gave.
 */
export const SAFETY = 2;

/**
 * The most decoded data the page will hold, in bytes. About a quarter of what a tab can
 * comfortably use: the estimate is not exact, decoding needs headroom for its own buffers,
 * and the rest of the page has to live somewhere too. navigator.deviceMemory (Chromium
 * only, coarse, capped at 8) scales it down on small machines; a stored setting
 * ("paris-parquet-memory-mb") or setBudgetMB() overrides it.
 */
let override = null;
export function setBudgetMB(mb) { override = mb == null ? null : Math.max(0.0001, +mb); }
export function budgetBytes() {
  if (override != null) return override * MB;
  try {
    const v = +localStorage.getItem("paris-parquet-memory-mb");
    if (v >= 64) return v * MB;
  } catch (_e) { /* no storage: use the default */ }
  const gb = typeof navigator !== "undefined" ? navigator.deviceMemory : undefined;
  return (gb ? Math.max(512, Math.min(2048, gb * 256)) : 1536) * MB;
}

/**
 * What one decoded cell of this column costs, from what the footer says about its chunk.
 * `type` is the physical type, `meta` the column chunk's metadata.
 */
export function cellBytes(spec, type, meta, groupRows) {
  if (!spec) return CELL.unknown;
  if (spec.nested) {
    /* the footer says how many leaf values the chunk holds for how many rows, so a long list is priced as one */
    const per = groupRows && meta && meta.numValues ? meta.numValues / groupRows : 0;
    return Math.max(CELL.nested, Math.ceil(CELL.nestedBase + CELL.nestedPerElement * per));
  }
  if (spec.decimal) return CELL.decimal;
  if (spec.kind === "temporal") return CELL.temporal;
  return cellBytesPlain(spec, type, meta);
}
/**
 * Whether a chunk's data pages are mostly dictionary-encoded. A writer starts a dictionary and falls back to
 * plain when it grows too big, so a chunk can list a dictionary encoding while nearly every value is stored
 * (and decoded) as a full value: what the pages actually used decides, where the footer says.
 */
function mostlyDictionary(meta) {
  const listed = !!(meta && meta.encodings && (meta.encodings.indexOf("RLE_DICTIONARY") >= 0 || meta.encodings.indexOf("PLAIN_DICTIONARY") >= 0));
  if (!listed || !meta.encodingStats || !meta.encodingStats.length) return listed;
  let dict = 0, all = 0;
  for (const s of meta.encodingStats) {
    if (s.pageType !== "DATA_PAGE" && s.pageType !== "DATA_PAGE_V2") continue;
    all += s.count;
    if (s.encoding === "RLE_DICTIONARY" || s.encoding === "PLAIN_DICTIONARY") dict += s.count;
  }
  return all ? dict / all >= 0.5 : listed;
}
function cellBytesPlain(spec, type, meta) {
  const dict = mostlyDictionary(meta);
  if (type === "BYTE_ARRAY" || type === "FIXED_LEN_BYTE_ARRAY") {
    if (dict) return CELL.dictionary;      /* a row holds a reference to a string the dictionary already owns */
    const n = meta && meta.numValues ? meta.numValues : 0;
    const avg = n ? Math.min(1024, Math.max(0, meta.totalUncompressedSize / n - 4)) : 16;
    return CELL.stringBase + CELL.stringPerByte * avg;
  }
  return dict ? CELL.dictionary : CELL.fixed;
}

/** Bytes to hold `rows` values of column `col` from one row group, rounded up. */
export function columnGroupBytes(part, rg, col, rows) {
  if (col.partKey !== undefined) return rows * 8;
  const chunk = chunkFor(rg, col.key);
  const leaf = part.leafByPath.get(col.key);
  return Math.ceil(rows * cellBytes(col.spec, leaf ? leaf.type : null, chunk ? chunk.meta : null, rg.numRows) * SAFETY);
}

/**
 * The row groups a load of about `maxRows` more rows would read, in the order loadMore reads
 * them and skipping what a scan plan ruled out: [{ pi, gi, rows }].
 */
export function groupsAhead(dataset, table, maxRows) {
  const out = [];
  let added = 0;
  let pi = table.nextPart, gi = table.nextGroup;
  while (pi < dataset.parts.length && added < maxRows) {
    const groups = dataset.parts[pi].meta.rowGroups;
    if (gi >= groups.length) { pi++; gi = 0; continue; }
    const key = pi + ":" + gi;
    if (table.plan && !table.plan.has(key)) { gi++; continue; }
    const sel = table.plan ? table.plan.get(key) : null;
    let rows = sel ? rangeCount(sel) : groups[gi].numRows - (pi === table.nextPart && gi === table.nextGroup ? table.nextRow || 0 : 0);
    if (!sel && table.slice && !table.plan) rows = Math.min(rows, maxRows - added);     /* what loadMore will actually take */
    out.push({ pi, gi, rows });
    added += rows;
    gi++;
  }
  return out;
}

/** Estimated bytes to decode the given columns of the given groups. */
export function groupsBytes(dataset, table, groups, columns) {
  let bytes = 0;
  for (const g of groups) {
    const part = dataset.parts[g.pi], rg = part.meta.rowGroups[g.gi];
    for (const ci of columns) bytes += columnGroupBytes(part, rg, table.cols[ci], g.rows);
  }
  return bytes;
}

/** What one decoded cell of a column is estimated to cost, from the first row group's description of it. */
export function cellCost(dataset, col) {
  if (col.partKey !== undefined) return 8;
  if (col.costPerCell === undefined) {
    const part = dataset.parts[0], rg = part ? part.meta.rowGroups[0] : null;    /* a joined table has no file behind it */
    const chunk = rg ? chunkFor(rg, col.key) : null;
    const leaf = part ? part.leafByPath.get(col.key) : null;
    col.costPerCell = Math.ceil(cellBytes(col.spec, leaf ? leaf.type : null, chunk ? chunk.meta : null, rg ? rg.numRows : 0) * SAFETY);
  }
  return col.costPerCell;
}
/** What `rows` more rows of the given columns are estimated to cost once decoded. */
export function rowsBytes(dataset, table, columns, rows) {
  let bytes = 0;
  for (const ci of columns) bytes += rows * cellCost(dataset, table.cols[ci]);
  return bytes;
}
/** What the decoded rows the table already holds are estimated to cost. */
export function heldBytes(dataset, table) {
  let bytes = 0;
  for (let ci = 0; ci < table.cols.length; ci++) {
    const col = table.cols[ci];
    const n = col.rows.length;
    if (n) bytes += n * cellCost(dataset, col);
  }
  return bytes;
}

/**
 * Which of `columns` (in priority order) fit in `budget` for the given groups. Always keeps
 * at least the first, since a file with nothing decoded shows nothing, and says so if even
 * that one does not fit.
 */
export function fitColumns(dataset, table, columns, groups, budget) {
  const keep = [], drop = [];
  let used = 0;
  for (const ci of columns) {
    const cost = groupsBytes(dataset, table, groups, [ci]);
    if (!keep.length || used + cost <= budget) { keep.push(ci); used += cost; } else drop.push(ci);
  }
  return { keep, drop, bytes: used, over: keep.length === 1 && used > budget };
}

/**
 * How many of the coming groups can be loaded and still leave the held total under `budget`,
 * for the columns the table is decoding. `all` says whether every one of them fits.
 */
export function affordableGroups(dataset, table, groups, columns, budget) {
  let used = heldBytes(dataset, table), n = 0, rows = 0;
  for (const g of groups) {
    const cost = groupsBytes(dataset, table, [g], columns);
    if (used + cost > budget) break;
    used += cost; n++; rows += g.rows;
  }
  return { groups: n, rows, bytes: used, all: n === groups.length };
}

/** Estimated bytes to decode the given columns for every row group the table has already read. */
export function fillBytes(dataset, table, columns) {
  let bytes = 0;
  for (const ci of columns) {
    const col = table.cols[ci];
    for (let r = col.filled; r < table.reads.length; r++) {
      const read = table.reads[r];
      const part = dataset.parts[read.pi];
      bytes += columnGroupBytes(part, part.meta.rowGroups[read.gi], col, read.rows);
    }
  }
  return bytes;
}

/**
 * Which of the columns the page is about to fill in (behind the reads the table has already
 * made) still fit in `budget` beside what it holds. Whatever does not fit is `drop`.
 */
export function fitFill(dataset, table, columns, budget) {
  const keep = [], drop = [];
  let used = heldBytes(dataset, table);
  for (const ci of columns) {
    const cost = fillBytes(dataset, table, [ci]);
    if (used + cost <= budget) { keep.push(ci); used += cost; } else drop.push(ci);
  }
  return { keep, drop, bytes: used };
}

/**
 * Estimated bytes to hold every row of `columns`, from wherever `table` has read to, plus what it
 * already holds. For the operations that need whole files at once (a join, a row-by-row diff).
 */
export function loadAllBytes(dataset, table, columns) {
  return heldBytes(dataset, table) + groupsBytes(dataset, table, groupsAhead(dataset, table, Infinity), columns);
}

/** Null if reading all of it fits `budget`; otherwise the sentence that says why not, and what to do. */
export function loadAllRefusal(what, bytes, budget, advice) {
  if (bytes <= budget) return null;
  return "Not run: reading every row of " + what + " would take about " + bytesText(bytes) + " once decoded, over this page's " +
    bytesText(budget) + " memory budget. " + advice;
}

export function bytesText(n) {
  if (n >= 1024 * MB) return (n / (1024 * MB)).toFixed(n >= 10 * 1024 * MB ? 0 : 1) + " GB";
  return Math.max(1, Math.round(n / MB)) + " MB";
}
