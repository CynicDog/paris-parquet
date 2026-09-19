// Column-chunk loading: reads row groups into `table.cols` incrementally
// (via `loadMore`), catches columns up that were skipped earlier (via
// `fillColumns`), and tracks how much of the dataset is left to read.

import { becomesText, sniffUtf8 } from "./dataset.js";
import { assemble, rangeCount, readColumnChunk, readRowsRanges } from "./encoding.js";
import { progressCancelled } from "./progress.js";
import { chunkFor, groupSource, pool, poolWorthIt, readGroupBytes, workerCan, workerColumn } from "./workers.js";

export async function readColumnRows(dataset, part, rg, col, sel, took, firstGroup, ctx) {
  if (col.partKey !== undefined) {
    const v = part.partValues ? part.partValues[col.partKey] : null;
    const rows = new Array(took);
    rows.fill(v === undefined ? null : v);
    return rows;
  }
  const leaf = part.leafByPath.get(col.key);
  const chunk = chunkFor(rg, col.key);
  if (!leaf || !chunk) {                          /* this file does not have it */
    const rows = new Array(took);
    rows.fill(null);
    return rows;
  }
  if (chunk.filePath) {
    throw new Error("Column " + col.name + " lives in a separate file (" + chunk.filePath +
      "), which parquet allows but nothing writes.");
  }
  if (chunk.encryptedMetadata || chunk.cryptoMetadata) throw new Error("Column " + col.name + " is encrypted.");
  const group = ctx ? ctx.group : null;
  if (ctx && ctx.workers && workerCan(part, col, sel, chunk)) {
    try { return await workerColumn(part, chunk, leaf, col, sel, rg.numRows, group); }
    catch (e) {
      if (!pool.off) {
        throw new Error('Could not read column "' + col.name + '" in ' + part.path + ": " + e.message);
      }
      /* the pool gave up; this thread does it instead */
    }
  }
  const src = groupSource(part.src, group);
  try {
    if (sel) {
      /* page by page, so the text-or-bytes question has to be settled before
         the first of them rather than from the values at hand */
      if (!col.sniffed) {
        col.sniffed = true;
        if (col.spec.maybeUtf8 && await sniffUtf8(dataset, col, [], false)) becomesText(col);
      }
      return await readRowsRanges(src, chunk, leaf, sel, rg.numRows, col.spec.convert);
    }
    if (col.spec.maybeUtf8 && !col.sniffed) {
      /* the values are what decides whether this column is text, so they have
         to arrive physical and be converted after the answer is in */
      const raw = await readColumnChunk(src, chunk, leaf);
      col.sniffed = true;
      if (await sniffUtf8(dataset, col, raw.values, firstGroup)) becomesText(col);
      return assemble(leaf, raw.values, raw.defs, raw.reps, col.spec.convert);
    }
    col.sniffed = true;
    const raw = await readColumnChunk(src, chunk, leaf, col.spec.convert);
    return assemble(leaf, raw.values, raw.defs, raw.reps, null);
  } catch (e) {
    throw new Error('Could not read column "' + col.name + '" in ' + part.path +
      " (" + chunk.meta.codec + ", " + chunk.meta.encodings.join("/") + "): " + e.message);
  }
}

/**
 * Reads row groups, part by part, until `maxRows` more rows have been added.
 *
 * Only the columns in `table.need` are decoded — what the grid is showing and
 * what the query names. Every group read is written down in `table.reads`, so
 * a column nobody wanted yet can be filled in later over exactly the same
 * groups and rows. With no `need` set, everything is decoded, which is what
 * the tests and the diff want.
 */
export async function loadMore(dataset, table, maxRows, onProgress) {
  let added = 0;
  while (table.nextPart < dataset.parts.length && added < maxRows) {
    if (progressCancelled()) break;         /* the popup's Cancel: stop at a row group boundary */
    const part = dataset.parts[table.nextPart];
    const meta = part.meta;
    if (table.nextGroup >= meta.rowGroups.length) { table.nextPart++; table.nextGroup = 0; continue; }
    const planKey = table.nextPart + ":" + table.nextGroup;
    if (table.plan && !table.plan.has(planKey)) {
      table.nextGroup++;                   /* the plan proved it cannot match */
      continue;
    }
    /* null means the whole group; a list of ranges means only those rows */
    let sel = table.plan ? table.plan.get(planKey) : null;
    const rg = meta.rowGroups[table.nextGroup];
    const from = table.nextRow || 0;              /* how far into this group an earlier, partial read got */
    let took = sel ? rangeCount(sel) : rg.numRows - from;
    /* a browsing table decodes only as many rows as were asked for, even from the middle of a huge group, and
       picks up there next time: a million-row group is not decoded whole to show a screenful of it */
    if (!sel && table.slice && !table.plan && took > maxRows - added) took = maxRows - added;
    const finishes = !!sel || from + took >= rg.numRows;
    if (!sel && (from > 0 || took < rg.numRows)) sel = [[from, from + took]];
    const firstGroup = table.nextPart === 0 && table.nextGroup === 0 && from === 0;
    table.reads.push({ pi: table.nextPart, gi: table.nextGroup, sel, rows: took, firstGroup });
    /* every column of the group is asked for at once: with a pool they
       decode side by side, and without one they queue up as before */
    const wanted = [];
    for (let ci = 0; ci < table.cols.length; ci++) {
      const col = table.cols[ci];
      if (table.need && !table.need.has(ci) && col.partKey === undefined) continue;
      wanted.push(ci);
    }
    const keys = new Set();
    for (const ci of wanted) if (table.cols[ci].partKey === undefined) keys.add(table.cols[ci].key);
    const ctx = {
      group: sel || keys.size < 2 ? null : await readGroupBytes(part.src, rg, keys),
      workers: poolWorthIt(part, rg, table.cols, wanted, sel),
    };
    const decoded = await Promise.all(wanted.map((ci) =>
      readColumnRows(dataset, part, rg, table.cols[ci], sel, took, firstGroup, ctx)));
    for (let k = 0; k < wanted.length; k++) {
      const col = table.cols[wanted[k]];
      appendRows(col, decoded[k]);
      col.filled = table.reads.length;
      if (onProgress) onProgress(table.nextPart, table.nextGroup, wanted[k], table.cols.length);
    }
    added += took;
    table.rowsLoaded += took;
    if (from === 0) table.groupsLoaded++;
    if (finishes) { table.nextRow = 0; table.nextGroup++; } else table.nextRow = from + took;
  }
  table.truncated = groupsLeft(dataset, table) > 0;
  return added;
}

/**
 * Rows arrive as a plain array or, when a worker found every value of a
 * column to be a number with no nulls among them, as a Float64Array it could
 * hand over without copying. Both index and measure the same; only joining
 * two pieces has to know the difference.
 */
export function appendRows(col, rows) {
  const have = col.rows;
  if (!have.length) { col.rows = rows; return; }
  if (!rows.length) return;
  const a = ArrayBuffer.isView(have), b = ArrayBuffer.isView(rows);
  if (a && b) {
    const merged = new Float64Array(have.length + rows.length);
    merged.set(have);
    merged.set(rows, have.length);
    col.rows = merged;
    return;
  }
  col.rows = (a ? Array.from(have) : have).concat(b ? Array.from(rows) : rows);
}

/** Which columns are behind, of those asked for. */
export function unfilled(table, indexes) {
  const out = [];
  if (!table || !table.reads) return out;
  for (const ci of indexes) {
    const col = table.cols[ci];
    if (col && col.filled < table.reads.length && out.indexOf(ci) < 0) out.push(ci);
  }
  return out;
}
/** Decodes columns over the groups already read, so they catch up. */
export async function fillColumns(dataset, table, indexes, onProgress) {
  const behind = unfilled(table, indexes);
  for (let k = 0; k < behind.length; k++) {
    const col = table.cols[behind[k]];
    for (let r = col.filled; r < table.reads.length; r++) {
      const read = table.reads[r];
      const part = dataset.parts[read.pi];
      const rg = part.meta.rowGroups[read.gi];
      appendRows(col, await readColumnRows(dataset, part, rg, col, read.sel, read.rows, read.firstGroup,
        { group: null, workers: poolWorthIt(part, rg, table.cols, [behind[k]], read.sel) }));
      col.filled = r + 1;
    }
    if (onProgress) await onProgress(k + 1, behind.length, col.name);
  }
  return behind.length;
}

/** How many row groups this table has still to read, the plan included. */
export function groupsLeft(dataset, table) {
  let n = 0;
  for (let pi = table.nextPart; pi < dataset.parts.length; pi++) {
    const groups = dataset.parts[pi].meta.rowGroups.length;
    for (let gi = pi === table.nextPart ? table.nextGroup : 0; gi < groups; gi++) {
      if (!table.plan || table.plan.has(pi + ":" + gi)) n++;
    }
  }
  return n;
}
/** …and how many rows the next `limit` worth of them would add. */
export function rowsAhead(dataset, table, limit) {
  let rows = 0;
  for (let pi = table.nextPart; pi < dataset.parts.length && rows < limit; pi++) {
    const groups = dataset.parts[pi].meta.rowGroups;
    for (let gi = pi === table.nextPart ? table.nextGroup : 0; gi < groups.length && rows < limit; gi++) {
      if (!table.plan) {
        const rest = groups[gi].numRows - (pi === table.nextPart && gi === table.nextGroup ? table.nextRow || 0 : 0);
        rows += table.slice ? Math.min(rest, limit - rows) : rest;
        continue;
      }
      const sel = table.plan.get(pi + ":" + gi);
      if (sel !== undefined) rows += sel ? rangeCount(sel) : groups[gi].numRows;
    }
  }
  return rows;
}

export const $ = (id) => document.getElementById(id);
