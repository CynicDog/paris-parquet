import { Cursor } from "./bytes.js";
import { bitWidth, decompress, POW2, u32le } from "./codecs.js";
import { ENC, PAGE_TYPE, thriftStruct } from "./thrift.js";

export function rleHybrid(b, pos, end, width, count, out) {
  out = out || new Int32Array(count);
  let n = 0;
  const byteWidth = (width + 7) >> 3;
  while (n < count && pos < end) {
    let shift = 1, header = 0, by;
    do { by = b[pos++]; header += (by & 0x7f) * shift; shift *= 128; } while (by & 0x80);
    if (header & 1) {
      const groups = header >> 1;
      const runBytes = groups * width;
      let bp = pos, buf = 0, bits = 0;
      for (let g = 0; g < groups; g++) {
        for (let i = 0; i < 8; i++) {
          while (bits < width) { buf += b[bp++] * POW2[bits]; bits += 8; }
          const v = buf % POW2[width];
          buf = (buf - v) / POW2[width];
          bits -= width;
          if (n < count) out[n++] = v;
        }
        if (n >= count) break;
      }
      pos += runBytes;
    } else {
      const run = header >> 1;
      let v = 0;
      for (let i = 0; i < byteWidth; i++) v += b[pos + i] * POW2[8 * i];
      pos += byteWidth;
      const stop = Math.min(count, n + run);
      while (n < stop) out[n++] = v;
    }
  }
  return out;
}

/** Legacy BIT_PACKED level encoding: MSB-first, no run headers. */
export function bitPackedLegacy(b, pos, end, width, count) {
  const out = new Int32Array(count);
  if (width === 0) return out;
  let buf = 0, bits = 0, n = 0, p = pos;
  while (n < count && (p < end || bits >= width)) {
    while (bits < width && p < end) { buf = buf * 256 + b[p++]; bits += 8; }
    if (bits < width) break;
    const v = Math.floor(buf / POW2[bits - width]);
    bits -= width;
    buf -= v * POW2[bits];
    out[n++] = v;
  }
  return out;
}

/** PLAIN. Appends `count` physical values to `out`. */
export function decodePlain(b, pos, _end, type, count, typeLength, out) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (type) {
    case "BOOLEAN":
      for (let i = 0; i < count; i++) out.push(((b[pos + (i >> 3)] >> (i & 7)) & 1) === 1);
      return pos + ((count + 7) >> 3);
    case "INT32":
      for (let i = 0; i < count; i++) out.push(dv.getInt32(pos + i * 4, true));
      return pos + count * 4;
    case "INT64":
      for (let i = 0; i < count; i++) {
        const v = dv.getBigInt64(pos + i * 8, true);
        out.push(v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v);
      }
      return pos + count * 8;
    case "INT96":
      for (let i = 0; i < count; i++) {
        const p = pos + i * 12;
        const nanos = dv.getBigUint64(p, true);
        const julian = dv.getUint32(p + 8, true);
        out.push({ int96: true, julian, nanos });
      }
      return pos + count * 12;
    case "FLOAT":
      for (let i = 0; i < count; i++) out.push(dv.getFloat32(pos + i * 4, true));
      return pos + count * 4;
    case "DOUBLE":
      for (let i = 0; i < count; i++) out.push(dv.getFloat64(pos + i * 8, true));
      return pos + count * 8;
    case "BYTE_ARRAY":
      for (let i = 0; i < count; i++) {
        const len = u32le(b, pos); pos += 4;
        out.push(b.subarray(pos, pos + len)); pos += len;
      }
      return pos;
    case "FIXED_LEN_BYTE_ARRAY":
      for (let i = 0; i < count; i++) { out.push(b.subarray(pos, pos + typeLength)); pos += typeLength; }
      return pos;
    default: throw new Error("PLAIN: unsupported type " + type);
  }
}

export const same = (v) => v;

/** DELTA_BINARY_PACKED. Returns {values, pos}; int64 accumulates in BigInt. */
export function deltaBinaryPacked(b, pos, _end, _count, big) {
  const rv = () => { let shift = 1, v = 0, by; do { by = b[pos++]; v += (by & 0x7f) * shift; shift *= 128; } while (by & 0x80); return v; };
  const zz = () => { const v = rv(); return v % 2 ? -(v + 1) / 2 : v / 2; };
  const blockSize = rv(), miniPerBlock = rv(), total = rv();
  const first = zz();
  const perMini = blockSize / miniPerBlock;
  const out = [];
  let cur = big ? BigInt(first) : first;
  out.push(cur);
  while (out.length < total) {
    const minDelta = big ? BigInt(zz()) : zz();
    const widths = [];
    for (let i = 0; i < miniPerBlock; i++) widths.push(b[pos++]);
    for (let m = 0; m < miniPerBlock && out.length < total; m++) {
      const w = widths[m];
      if (w === 0) {
        for (let i = 0; i < perMini && out.length < total; i++) {
          cur = big ? cur + minDelta : cur + minDelta;
          out.push(cur);
        }
        continue;
      }
      let bp = pos, buf = 0, bits = 0;
      for (let i = 0; i < perMini; i++) {
        let d;
        if (w <= 32) {
          while (bits < w) { buf += b[bp++] * POW2[bits]; bits += 8; }
          d = buf % POW2[w];
          buf = (buf - d) / POW2[w];
          bits -= w;
          if (big) d = BigInt(d);
        } else {
          while (bits < 32) { buf += b[bp++] * POW2[bits]; bits += 8; }
          const lo = buf % POW2[32];
          buf = (buf - lo) / POW2[32]; bits -= 32;
          const rest = w - 32;
          while (bits < rest) { buf += b[bp++] * POW2[bits]; bits += 8; }
          const hi = buf % POW2[rest];
          buf = (buf - hi) / POW2[rest]; bits -= rest;
          d = big ? BigInt(lo) + (BigInt(hi) << 32n) : lo + hi * POW2[32];
        }
        if (out.length < total) { cur = cur + minDelta + d; out.push(cur); }
      }
      pos += Math.ceil(perMini * w / 8);
    }
  }
  if (big) {
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      if (v >= -9007199254740991n && v <= 9007199254740991n) out[i] = Number(v);
    }
  }
  return { values: out, pos };
}

/** BYTE_STREAM_SPLIT: k independent byte streams, one per byte position. */
export function byteStreamSplit(b, pos, count, width, type, out) {
  const buf = new Uint8Array(count * width);
  for (let j = 0; j < width; j++) {
    const base = pos + j * count;
    for (let i = 0; i < count; i++) buf[i * width + j] = b[base + i];
  }
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < count; i++) {
    switch (type) {
      case "FLOAT": out.push(dv.getFloat32(i * 4, true)); break;
      case "DOUBLE": out.push(dv.getFloat64(i * 8, true)); break;
      case "INT32": out.push(dv.getInt32(i * 4, true)); break;
      case "INT64": {
        const v = dv.getBigInt64(i * 8, true);
        out.push(v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v);
        break;
      }
      default: out.push(buf.subarray(i * width, i * width + width));
    }
  }
  return pos + count * width;
}

/** Decodes one page's value section into physical values. */
/**
 * `convert` turns a physical value into the one the rest of the page uses.
 * It is applied here rather than after assembly so that a dictionary-encoded
 * column converts its dictionary once instead of once per row: a column of
 * a million rows over a thousand distinct strings then decodes a thousand
 * strings, not a million.
 */
export function decodeValues(enc, b, pos, end, type, count, typeLength, dict, out, convert) {
  /* the dictionary arrives converted already, so only the rest goes through */
  const sink = convert ? { push: (v) => out.push(convert(v)) } : out;
  switch (enc) {
    case "PLAIN":
      decodePlain(b, pos, end, type, count, typeLength, sink);
      return;
    case "RLE": {                       // boolean data pages
      const len = u32le(b, pos);
      const idx = rleHybrid(b, pos + 4, pos + 4 + len, 1, count);
      for (let i = 0; i < count; i++) sink.push(idx[i] === 1);
      return;
    }
    case "PLAIN_DICTIONARY":
    case "RLE_DICTIONARY": {
      if (!dict) throw new Error("dictionary page missing for a dictionary-encoded page");
      const w = b[pos];
      const idx = rleHybrid(b, pos + 1, end, w, count);
      for (let i = 0; i < count; i++) out.push(dict[idx[i]]);
      return;
    }
    case "DELTA_BINARY_PACKED": {
      const r = deltaBinaryPacked(b, pos, end, count, type === "INT64");
      for (let i = 0; i < count; i++) sink.push(r.values[i]);
      return;
    }
    case "DELTA_LENGTH_BYTE_ARRAY": {
      const r = deltaBinaryPacked(b, pos, end, count, false);
      let p = r.pos;
      for (let i = 0; i < count; i++) { const n = r.values[i]; sink.push(b.subarray(p, p + n)); p += n; }
      return;
    }
    case "DELTA_BYTE_ARRAY": {
      const pre = deltaBinaryPacked(b, pos, end, count, false);
      const suf = deltaBinaryPacked(b, pre.pos, end, count, false);
      let p = suf.pos;
      let prev = new Uint8Array(0);
      for (let i = 0; i < count; i++) {
        const pl = pre.values[i], sl = suf.values[i];
        const v = new Uint8Array(pl + sl);
        v.set(prev.subarray(0, pl));
        v.set(b.subarray(p, p + sl), pl);
        p += sl;
        sink.push(v);
        prev = v;
      }
      return;
    }
    case "BYTE_STREAM_SPLIT": {
      const w = type === "FLOAT" || type === "INT32" ? 4 : type === "DOUBLE" || type === "INT64" ? 8
        : type === "FIXED_LEN_BYTE_ARRAY" ? typeLength : 0;
      if (!w) throw new Error("BYTE_STREAM_SPLIT: unsupported type " + type);
      byteStreamSplit(b, pos, count, w, type, sink);
      return;
    }
    default:
      throw new Error("Unsupported encoding: " + enc + ".");
  }
}

/**
 * Decodes the one page starting at `pos` into `out`, which collects values,
 * definition and repetition levels and carries the dictionary between pages.
 * Returns where the next page starts and how many values this one held.
 */
export async function readPage(buf, pos, m, leaf, out) {
  const maxDef = leaf.maxDef, maxRep = leaf.maxRep;
  const defW = bitWidth(maxDef), repW = bitWidth(maxRep);
  const c = new Cursor(buf, pos);
  const h = thriftStruct(c);
  const dataStart = c.p;
  const compSize = h[3] | 0, uncompSize = h[2] | 0;
  const ptype = PAGE_TYPE[h[1]];
  const raw = buf.subarray(dataStart, dataStart + compSize);
  const next = dataStart + compSize;

  if (ptype === "DICTIONARY_PAGE") {
    const dh = h[7] || {};
    const page = await decompress(m.codec, raw, uncompSize);
    const entries = [];
    decodePlain(page, 0, page.length, m.type, dh[1] | 0, leaf.typeLength, entries);
    out.dict = out.convert ? entries.map(out.convert) : entries;
    return { pos: next, n: 0 };
  }
  if (ptype === "INDEX_PAGE") return { pos: next, n: 0 };

  if (ptype === "DATA_PAGE") {
    const dh = h[5];
    if (!dh) throw new Error("data page without a v1 header");
    const n = dh[1] | 0;
    const page = await decompress(m.codec, raw, uncompSize);
    let p = 0;
    if (maxRep > 0) {
      const len = u32le(page, p); p += 4;
      pushLevels(out.reps, page, p, p + len, repW, n, ENC[dh[4]]);
      p += len;
    }
    let nonNull = n;
    if (maxDef > 0) {
      const len = u32le(page, p); p += 4;
      const lv = pushLevels(out.defs, page, p, p + len, defW, n, ENC[dh[3]]);
      p += len;
      nonNull = 0;
      for (let i = 0; i < n; i++) if (lv[i] === maxDef) nonNull++;
    }
    if (nonNull > 0) {
      decodeValues(ENC[dh[2]], page, p, page.length, m.type, nonNull, leaf.typeLength,
        out.dict, out.values, out.convert);
    }
    return { pos: next, n };
  }
  if (ptype === "DATA_PAGE_V2") {
    const dh = h[8];
    if (!dh) throw new Error("v2 data page without a v2 header");
    const n = dh[1] | 0, nulls = dh[2] | 0;
    const defLen = dh[5] | 0, repLen = dh[6] | 0;
    const compressed = dh[7] !== false;
    if (maxRep > 0) pushLevels(out.reps, raw, 0, repLen, repW, n, "RLE");
    if (maxDef > 0) pushLevels(out.defs, raw, repLen, repLen + defLen, defW, n, "RLE");
    const body = raw.subarray(repLen + defLen);
    const page = compressed ? await decompress(m.codec, body, uncompSize - repLen - defLen) : body;
    if (n - nulls > 0) {
      decodeValues(ENC[dh[4]], page, 0, page.length, m.type, n - nulls, leaf.typeLength,
        out.dict, out.values, out.convert);
    }
    return { pos: next, n };
  }
  throw new Error("unknown page type " + h[1]);
}

export function newSink(leaf, dict, convert) {
  return { values: [], defs: leaf.maxDef > 0 ? [] : null, reps: leaf.maxRep > 0 ? [] : null,
    dict: dict === undefined ? null : dict, convert: convert || null };
}

/** With a `convert`, the values come back converted; without one, physical. */
export async function readColumnChunk(src, chunk, leaf, convert) {
  const m = chunk.meta;
  if (!m) throw new Error("column chunk has no metadata (encrypted?)");
  let start = m.dataPageOffset;
  if (m.dictionaryPageOffset != null && m.dictionaryPageOffset > 0 && m.dictionaryPageOffset < start) {
    start = m.dictionaryPageOffset;
  }
  const end = Math.min(src.size, start + m.totalCompressedSize);
  const buf = await src.read(start, end);

  const out = newSink(leaf, undefined, convert);
  let pos = 0, seen = 0;
  while (pos < buf.length && seen < m.numValues) {
    const r = await readPage(buf, pos, m, leaf, out);
    pos = r.pos;
    seen += r.n;
  }
  return { values: out.values, defs: out.defs, reps: out.reps, count: seen };
}

/* ------------------------------------------------------- page indexes */
/**
 * A parquet file may carry, beside the footer, an index per column chunk:
 * where each page starts and which row it begins at (the offset index), and
 * each page's own min, max and null count (the column index). Together they
 * say which pages of a row group could hold a matching row, which is the
 * same question the statistics answer for whole row groups, one level down.
 * Both are read once and remembered on the chunk.
 */
export async function readOffsetIndex(src, chunk) {
  if (chunk.offsets !== undefined) return chunk.offsets;
  chunk.offsets = null;
  const off = chunk.offsetIndexOffset;
  if (off == null || off <= 0 || off >= src.size) return null;
  try {
    const len = chunk.offsetIndexLength || 4096;
    const buf = await src.read(off, Math.min(src.size, off + len));
    const st = thriftStruct(new Cursor(buf, 0));
    const list = st[1];
    if (!list || !list.length) return null;
    const out = list.map((p) => ({ offset: p[1], size: p[2] | 0, row: p[3] }));
    for (const p of out) if (!(p.offset >= 0) || !(p.size > 0) || !(p.row >= 0)) return null;
    chunk.offsets = out;
  } catch (_e) { chunk.offsets = null; }
  return chunk.offsets;
}
export async function readColumnIndex(src, chunk) {
  if (chunk.pageStats !== undefined) return chunk.pageStats;
  chunk.pageStats = null;
  const off = chunk.columnIndexOffset;
  if (off == null || off <= 0 || off >= src.size) return null;
  try {
    const len = chunk.columnIndexLength || 65536;
    const buf = await src.read(off, Math.min(src.size, off + len));
    const st = thriftStruct(new Cursor(buf, 0));
    const nullPages = st[1], mins = st[2], maxes = st[3];
    if (!nullPages || !mins || !maxes) return null;
    if (mins.length !== nullPages.length || maxes.length !== nullPages.length) return null;
    chunk.pageStats = { nullPages, mins, maxes, nullCounts: st[5] || null };
  } catch (_e) { chunk.pageStats = null; }
  return chunk.pageStats;
}

/* Ranges are [from, to) row numbers within a row group, sorted and disjoint. */
export function mergeRanges(list) {
  if (list.length < 2) return list;
  const out = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const last = out[out.length - 1];
    if (list[i][0] <= last[1]) last[1] = Math.max(last[1], list[i][1]);
    else out.push(list[i]);
  }
  return out;
}
export function intersectRanges(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (lo < hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}
export function unionRanges(a, b) {
  return mergeRanges(a.concat(b).sort((x, y) => x[0] - y[0]).map((r) => [r[0], r[1]]));
}
export function rangeCount(ranges) {
  let n = 0;
  for (const r of ranges) n += r[1] - r[0];
  return n;
}
export const rangesTouch = (ranges, from, to) => ranges.some((r) => r[0] < to && from < r[1]);

/**
 * Reads exactly the rows in `ranges`, reading only the pages that hold them
 * where a page index says where those are. Without one, or for a repeated
 * column whose pages the index cannot be trusted to split on rows, the whole
 * chunk is read and the rows are taken out of it — the same rows either way,
 * which is what keeps every column of a row group lined up.
 */
export async function readRowsRanges(src, chunk, leaf, ranges, numRows, convert) {
  const locs = leaf.maxRep === 0 ? await readOffsetIndex(src, chunk) : null;
  if (locs && locs.length) {
    try { return await readPagesRanges(src, chunk, leaf, locs, ranges, numRows, convert); }
    catch (_e) { chunk.offsets = null; }   /* an index we cannot follow: read it all */
  }
  const raw = await readColumnChunk(src, chunk, leaf, convert);
  const all = assemble(leaf, raw.values, raw.defs, raw.reps, null);
  const out = [];
  for (const r of ranges) for (let i = r[0]; i < r[1]; i++) out.push(all[i]);
  return out;
}
export async function readPagesRanges(src, chunk, leaf, locs, ranges, numRows, convert) {
  const m = chunk.meta;
  let dict = null;
  if (m.dictionaryPageOffset != null && m.dictionaryPageOffset > 0 &&
      m.dictionaryPageOffset < locs[0].offset) {
    const buf = await src.read(m.dictionaryPageOffset, locs[0].offset);
    const sink = newSink(leaf, undefined, convert);
    await readPage(buf, 0, m, leaf, sink);
    dict = sink.dict;                         /* converted once, for every page */
  }
  const out = [];
  for (let i = 0; i < locs.length; i++) {
    const from = locs[i].row;
    const to = i + 1 < locs.length ? locs[i + 1].row : numRows;
    if (!rangesTouch(ranges, from, to)) continue;
    const buf = await src.read(locs[i].offset, Math.min(src.size, locs[i].offset + locs[i].size));
    const sink = newSink(leaf, dict, convert);
    await readPage(buf, 0, m, leaf, sink);
    const rows = assemble(leaf, sink.values, sink.defs, sink.reps, null);
    if (rows.length !== to - from) {
      throw new Error("the page index says page " + i + " holds rows " + from + " to " + to +
        ", but it decodes to " + rows.length);
    }
    for (const r of ranges) {
      const lo = Math.max(r[0], from), hi = Math.min(r[1], to);
      for (let x = lo; x < hi; x++) out.push(rows[x - from]);
    }
  }
  return out;
}

export function pushLevels(sink, b, pos, end, width, count, enc) {
  let lv;
  if (width === 0) lv = new Int32Array(count);
  else if (enc === "BIT_PACKED") lv = bitPackedLegacy(b, pos, end, width, count);
  else lv = rleHybrid(b, pos, end, width, count);
  if (sink) for (let i = 0; i < count; i++) sink.push(lv[i]);
  return lv;
}

/* ----------------------------------------------------- record assembly */
/**
 * Turns (values, definition levels, repetition levels) back into one value
 * per row, nesting arrays wherever the path repeats.
 */
/** `convert` is optional: values that arrived converted pass straight through. */
export function assemble(leaf, values, defs, reps, convert) {
  const maxDef = leaf.maxDef, maxRep = leaf.maxRep;
  if (!convert) convert = same;
  if (maxRep === 0) {
    if (maxDef === 0) return convert === same ? values : values.map(convert);
    const rows = new Array(defs.length);
    let vi = 0;
    for (let i = 0; i < defs.length; i++) rows[i] = defs[i] === maxDef ? convert(values[vi++]) : null;
    return rows;
  }
  const chain = leaf.chain;
  const rows = [];
  let i = 0, vi = 0;
  const n = defs ? defs.length : values.length;

  const readNode = (j, ancDef, ancRep) => {
    const node = chain[j];
    const isLeaf = j === chain.length - 1;
    const myDef = ancDef + (node.rep === "REQUIRED" ? 0 : 1);
    const myRep = ancRep + (node.rep === "REPEATED" ? 1 : 0);
    if (node.rep === "REPEATED") {
      if (defs[i] < myDef) { i++; return defs[i - 1] < ancDef ? null : []; }
      const arr = [];
      do {
        arr.push(isLeaf ? takeLeaf(myDef) : readNode(j + 1, myDef, myRep));
      } while (i < n && reps[i] >= myRep);
      return arr;
    }
    if (defs[i] < myDef) { i++; return null; }
    return isLeaf ? takeLeaf(myDef) : readNode(j + 1, myDef, myRep);
  };
  const takeLeaf = (myDef) => {
    const v = defs[i] >= myDef ? convert(values[vi++]) : null;
    i++;
    return v;
  };
  while (i < n) rows.push(readNode(0, 0, 0));
  return rows;
}
