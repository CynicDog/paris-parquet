// Web Worker pool for decoding column chunks off the main thread: sizing and
// dispatch on the main-thread side (`poolStart`, `workerColumn`, the
// worth-it heuristics), and `workerMain` — the same file, running as a
// worker — which decodes a chunk and hands values back as a transferable
// buffer wherever it can.

import { becomesText } from "./dataset.js";
import { assemble, readColumnChunk, readRowsRanges } from "./encoding.js";
import { typeSpec } from "./types.js";

export const OWN_SCRIPT = (typeof document !== "undefined" && document.currentScript) || null;
export const pool = { workers: [], free: [], waiting: [], jobs: new Map(), id: 0, url: null,
  off: false, force: false, started: false, used: 0, workMs: 0 };

export function poolStart() {
  if (pool.started) return;
  pool.started = true;
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
  const n = Math.max(0, Math.min(4, cores - 1));
  if (!n || typeof Worker === "undefined" || typeof Blob === "undefined" ||
      typeof URL === "undefined" || !URL.createObjectURL || !OWN_SCRIPT || !OWN_SCRIPT.textContent) {
    pool.off = true;
    return;
  }
  try {
    pool.url = URL.createObjectURL(new Blob([OWN_SCRIPT.textContent], { type: "text/javascript" }));
    for (let i = 0; i < n; i++) {
      const w = new Worker(pool.url);
      w.onmessage = (e) => poolDone(w, e.data);
      w.onerror = () => poolStop();
      pool.workers.push(w);
      pool.free.push(w);
    }
  } catch (_e) { poolStop(); }
}
/** Anything unexpected and the main thread takes the work back. */
export function poolStop() {
  pool.off = true;
  for (const job of pool.jobs.values()) job.reject(new Error("the decoding worker stopped"));
  pool.jobs.clear();
  for (const job of pool.waiting.splice(0)) job.reject(new Error("the decoding worker stopped"));
  for (const w of pool.workers.splice(0)) { try { w.terminate(); } catch (_e) { /* going anyway */ } }
  pool.free.length = 0;
}
export function poolDone(w, msg) {
  const job = pool.jobs.get(msg.id);
  pool.jobs.delete(msg.id);
  pool.free.push(w);
  const next = pool.waiting.shift();
  if (next) poolSend(next);
  if (!job) return;
  if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg);
}
export function poolSend(job) {
  const w = pool.free.pop();
  if (!w) { pool.waiting.push(job); return; }
  pool.jobs.set(job.msg.id, job);
  w.postMessage(job.msg, job.transfer || []);
}
export function poolRun(msg, transfer) {
  return new Promise((resolve, reject) => poolSend({ msg, transfer, resolve, reject }));
}

/**
 * Which columns are worth sending away. Decoding in parallel only pays if
 * the answer can come back without being copied value by value, and what
 * crosses that way is a run of numbers or a run of bytes: both leave as one
 * buffer, handed over rather than cloned. Text, booleans, decimals and
 * anything nested would cost more to clone than they cost to decode, so they
 * are decoded here — which is no loss, because that happens while the
 * workers are busy with the rest.
 */
/* A round trip costs this thread about as much as a small chunk costs to
   decode, so a row group is only worth sending away when there is enough in
   it to more than pay that back. */
export const WORKER_MIN_BYTES = 384 * 1024;
/** The column chunk of one column in one row group. */
export function chunkFor(rg, key) {
  for (const c of rg.columns) if (c.meta && c.meta.path.join("\u0001") === key) return c;
  return null;
}
/** Is there enough work in this row group to be worth the round trips? */
export function poolWorthIt(part, rg, cols, indexes, sel) {
  if (sel || pool.off || !pool.workers.length) return false;
  if (pool.force) return true;          /* for checking that both paths agree */
  let bytes = 0;
  for (const ci of indexes) {
    const col = cols[ci];
    if (col.partKey !== undefined) continue;
    const chunk = chunkFor(rg, col.key);
    if (!chunk || !workerCan(part, col, sel, chunk)) continue;
    bytes += chunk.meta.totalCompressedSize;
    if (bytes >= WORKER_MIN_BYTES) return true;
  }
  return false;
}

export function workerCan(part, col, sel, chunk) {
  if (pool.off || !pool.workers.length || sel || !part.src) return false;
  if (chunk && !(chunk.meta && chunk.meta.totalCompressedSize > 0)) return false;
  const spec = col.spec;
  if (spec.nested || spec.decimal) return false;
  if (spec.maybeUtf8 && !col.sniffed) return false;
  if (spec.kind === "binary") return true;                    /* packs into one buffer */
  if (spec.kind !== "number" && spec.kind !== "temporal") return false;
  return spec.physical === "INT32" || spec.physical === "INT64" || spec.physical === "INT96" ||
    spec.physical === "FLOAT" || spec.physical === "DOUBLE";
}
/** Everything a worker needs to decode one column chunk, as plain data. */
export function workerJob(part, chunk, leaf, col, sel, numRows, bytes, bufStart) {
  const m = chunk.meta;
  return {
    paris: "col", id: ++pool.id, sel, numRows,
    bytes, bufStart, srcSize: part.src.size,
    utf8: / \(utf-8\)$/.test(col.spec.label || ""),
    chunk: {
      filePath: null,
      offsetIndexOffset: chunk.offsetIndexOffset, offsetIndexLength: chunk.offsetIndexLength,
      meta: { codec: m.codec, type: m.type, numValues: m.numValues, encodings: m.encodings,
        dataPageOffset: m.dataPageOffset, dictionaryPageOffset: m.dictionaryPageOffset,
        totalCompressedSize: m.totalCompressedSize },
    },
    leaf: { type: leaf.type, typeLength: leaf.typeLength, logical: leaf.logical, converted: leaf.converted,
      scale: leaf.scale, precision: leaf.precision, maxDef: leaf.maxDef, maxRep: leaf.maxRep,
      chain: (leaf.chain || []).map((c) => ({ rep: c.rep })) },
  };
}
/* A row group's column chunks lie together in the file, so when most of one
   is wanted it is a single read rather than a read apiece — and the decoders
   can then all start at once instead of waiting their turn at the disk. */
export const GROUP_READ_MAX = 32 * 1024 * 1024;
export async function readGroupBytes(src, rg, wanted) {
  let lo = Infinity, hi = 0, want = 0;
  for (const c of rg.columns) {
    if (!c.meta) continue;
    const [a, b] = chunkRange(src, c.meta);
    if (a < lo) lo = a;
    if (b > hi) hi = b;
    if (wanted.has(c.meta.path.join("\u0001"))) want += b - a;
  }
  const span = hi - lo;
  if (!(span > 0) || span > GROUP_READ_MAX) return null;
  if (want < span * 0.6) return null;        /* most of it is not wanted */
  return { lo, hi, bytes: await src.read(lo, hi) };
}
/** A source that answers out of the bytes already in hand where it can. */
export function groupSource(src, group) {
  if (!group) return src;
  return {
    size: src.size, file: src.file,
    async read(a, b) {
      if (a >= group.lo && b <= group.hi) return group.bytes.subarray(a - group.lo, b - group.lo);
      return src.read(a, b);
    },
  };
}

/** The bytes of a whole column chunk, dictionary page included. */
export function chunkRange(src, m) {
  let start = m.dataPageOffset;
  if (m.dictionaryPageOffset != null && m.dictionaryPageOffset > 0 && m.dictionaryPageOffset < start) {
    start = m.dictionaryPageOffset;
  }
  return [start, Math.min(src.size, start + m.totalCompressedSize)];
}
/**
 * Reading the file is not work the main thread minds doing — it waits on the
 * disk rather than the processor — and handing the bytes over costs nothing,
 * where letting three workers open the same file at once costs plenty.
 */
export async function workerColumn(part, chunk, leaf, col, sel, numRows, group) {
  const [start, end] = chunkRange(part.src, chunk.meta);
  const raw = await groupSource(part.src, group).read(start, end);
  /* handing a buffer over detaches it, so it has to be this job's alone: a
     window onto the row group's bytes, or onto anything else, is copied */
  const own = !group && raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength;
  const buf = own ? raw.buffer : raw.slice().buffer;
  const res = await poolRun(workerJob(part, chunk, leaf, col, sel, numRows, buf, start), [buf]);
  pool.used++;
  pool.workMs += res.ms || 0;
  if (res.nums) return res.nums;
  if (!res.packed) return res.rows;
  const { bytes, offsets, nulls } = res;
  const rows = new Array(offsets.length - 1);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = nulls[i] ? null : bytes.subarray(offsets[i], offsets[i + 1]);
  }
  return rows;
}

/* This is the other end of it: the same file, running as a worker. */
export function workerMain(scope) {
  scope.onmessage = async (e) => {
    const m = e.data;
    if (!m || m.paris !== "col") return;
    const t0 = Date.now();
    try {
      const chunkBytes = new Uint8Array(m.bytes);
      const src = {
        size: m.srcSize,
        async read(a, b) { return chunkBytes.subarray(a - m.bufStart, b - m.bufStart); },
      };
      const spec = typeSpec(m.leaf);
      if (m.utf8) becomesText({ spec });
      let rows;
      if (m.sel) {
        rows = await readRowsRanges(src, m.chunk, m.leaf, m.sel, m.numRows, spec.convert);
      } else {
        const raw = await readColumnChunk(src, m.chunk, m.leaf, spec.convert);
        rows = assemble(m.leaf, raw.values, raw.defs, raw.reps, null);
      }
      /* a column of numbers with no nulls goes over as one buffer, handed
         across rather than copied: cloning three million values one at a time
         costs more than decoding them did */
      let numeric = rows.length > 0;
      for (let i = 0; i < rows.length; i++) {
        if (typeof rows[i] !== "number") { numeric = false; break; }
      }
      if (numeric) {
        const nums = new Float64Array(rows.length);
        for (let i = 0; i < rows.length; i++) nums[i] = rows[i];
        scope.postMessage({ id: m.id, nums, ms: Date.now() - t0 }, [nums.buffer]);
        return;
      }
      /* every value a window onto the page buffer: send the bytes once */
      let packable = rows.length > 0;
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i];
        if (v === null || v === undefined) continue;
        if (!(v instanceof Uint8Array)) { packable = false; break; }
      }
      if (packable) {
        let total = 0;
        for (let i = 0; i < rows.length; i++) if (rows[i]) total += rows[i].length;
        const bytes = new Uint8Array(total);
        const offsets = new Int32Array(rows.length + 1);
        const nulls = new Uint8Array(rows.length);
        let at = 0;
        for (let i = 0; i < rows.length; i++) {
          offsets[i] = at;
          const v = rows[i];
          if (v === null || v === undefined) { nulls[i] = 1; continue; }
          bytes.set(v, at);
          at += v.length;
        }
        offsets[rows.length] = at;
        scope.postMessage({ id: m.id, packed: true, bytes, offsets, nulls, ms: Date.now() - t0 },
          [bytes.buffer, offsets.buffer, nulls.buffer]);
        return;
      }
      scope.postMessage({ id: m.id, rows, ms: Date.now() - t0 });
    } catch (err) {
      scope.postMessage({ id: m.id, error: (err && err.message) || String(err) });
    }
  };
}
