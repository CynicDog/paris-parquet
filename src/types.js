import { utf8 } from "./bytes.js";

export const JULIAN_EPOCH = 2440588;                       // 1970-01-01
export function beBigInt(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  if (bytes.length && (bytes[0] & 0x80)) v -= 1n << BigInt(bytes.length * 8);
  return v;
}
export function decimalString(v, scale) {
  const neg = v < 0n;
  let s = (neg ? -v : v).toString();
  if (scale > 0) {
    while (s.length <= scale) s = "0" + s;
    s = s.slice(0, s.length - scale) + "." + s.slice(s.length - scale);
  }
  return (neg ? "-" : "") + s;
}
export function float16(b) {
  const h = b[0] | (b[1] << 8);
  const sign = h >> 15 ? -1 : 1, exp = (h >> 10) & 31, man = h & 1023;
  if (exp === 0) return sign * Math.pow(2, -14) * (man / 1024);
  if (exp === 31) return man ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + man / 1024);
}
export const HEX = [];
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, "0");
export function hex(b, max) {
  let s = "";
  const n = Math.min(b.length, max == null ? b.length : max);
  for (let i = 0; i < n; i++) s += HEX[b[i]];
  return s + (n < b.length ? "…" : "");
}
export function uuidString(b) {
  const h = hex(b);
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
}
export const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
/** True when a type-less BYTE_ARRAY column really holds text. */
export function looksUtf8(values) {
  let checked = 0;
  for (let i = 0; i < values.length && checked < 64; i++) {
    const v = values[i];
    if (!(v instanceof Uint8Array)) return false;
    if (v.length === 0) continue;
    let s;
    try { s = strictUtf8.decode(v); } catch (_e) { return false; }
    if (CONTROL.test(s)) return false;
    checked++;
  }
  return checked > 0;
}

/**
 * Epoch/time values arrive as an integer count of `unit`. Nanoseconds are
 * divided down in BigInt first: 2024 in nanoseconds needs more than 53 bits,
 * so dividing after the cast to double would lose the microseconds.
 */
export function toMillis(unit) {
  if (unit === "MILLIS") return (v) => Number(v);
  if (unit === "MICROS") return (v) => Number(v) / 1e3;
  return (v) => (typeof v === "bigint" ? Number(v / 1000n) / 1e3 : Number(v) / 1e6);
}

/** Works out how a leaf column should be interpreted and displayed. */
export function typeSpec(leaf) {
  const t = leaf.type, lt = leaf.logical, ct = leaf.converted;
  const ln = lt ? lt.name : null;
  const nested = leaf.maxRep > 0;
  const wrap = (spec) => {
    spec.physical = t;
    spec.nested = nested;
    if (nested) { spec.elementKind = spec.kind; spec.kind = "nested"; spec.label = listLabel(leaf, spec.label); }
    return spec;
  };
  const scale = (lt && lt.scale != null) ? lt.scale : (leaf.scale || 0);
  const prec = (lt && lt.precision != null) ? lt.precision : (leaf.precision || 0);

  if (ln === "DECIMAL" || ct === "DECIMAL") {
    const label = "decimal(" + prec + "," + scale + ")";
    if (t === "INT32" || t === "INT64") {
      return wrap({ kind: "number", label, convert: (v) => decimalString(BigInt(v), scale), decimal: true });
    }
    return wrap({ kind: "number", label, convert: (v) => decimalString(beBigInt(v), scale), decimal: true });
  }
  if (ln === "DATE" || ct === "DATE") {
    return wrap({ kind: "temporal", sub: "date", label: "date", convert: (v) => v * 86400000 });
  }
  if (ln === "TIME" || ct === "TIME_MILLIS" || ct === "TIME_MICROS") {
    const unit = ln === "TIME" ? lt.unit : (ct === "TIME_MILLIS" ? "MILLIS" : "MICROS");
    return wrap({ kind: "temporal", sub: "time", label: "time[" + unit.toLowerCase() + "]",
      convert: toMillis(unit) });
  }
  if (ln === "TIMESTAMP" || ct === "TIMESTAMP_MILLIS" || ct === "TIMESTAMP_MICROS") {
    const unit = ln === "TIMESTAMP" ? lt.unit : (ct === "TIMESTAMP_MILLIS" ? "MILLIS" : "MICROS");
    const utc = ln === "TIMESTAMP" ? lt.utc : true;
    return wrap({ kind: "temporal", sub: "timestamp", utc,
      label: "timestamp[" + unit.toLowerCase() + (utc ? ", UTC" : "") + "]",
      convert: toMillis(unit) });
  }
  if (t === "INT96") {
    /* int96 has no UTC flag of its own; writers disagree, so no Z is shown */
    return wrap({ kind: "temporal", sub: "timestamp", utc: false, label: "int96 timestamp",
      convert: (v) => (v.julian - JULIAN_EPOCH) * 86400000 + Number(v.nanos) / 1e6 });
  }
  if (ln === "UUID") return wrap({ kind: "string", label: "uuid", convert: uuidString });
  if (ln === "FLOAT16") return wrap({ kind: "number", label: "float16", convert: float16 });
  if (ct === "INTERVAL") {
    return wrap({ kind: "string", label: "interval", convert: (v) => {
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      return dv.getUint32(0, true) + "mo " + dv.getUint32(4, true) + "d " + dv.getUint32(8, true) + "ms";
    } });
  }
  if (ln === "STRING" || ln === "ENUM" || ln === "JSON" || ct === "UTF8" || ct === "ENUM" || ct === "JSON") {
    const label = ln === "JSON" || ct === "JSON" ? "json" : ln === "ENUM" || ct === "ENUM" ? "enum" : "string";
    return wrap({ kind: "string", label, convert: (v) => utf8.decode(v) });
  }
  if (t === "BOOLEAN") return wrap({ kind: "bool", label: "boolean", convert: (v) => v });
  if (ln === "INTEGER" || (ct && /^(U?INT)_/.test(ct))) {
    const bits = ln === "INTEGER" ? lt.bits : +ct.replace(/^\D+/, "");
    const signed = ln === "INTEGER" ? lt.signed : ct.startsWith("INT");
    const label = (signed ? "int" : "uint") + bits;
    if (!signed) {
      if (bits <= 32) {
        const mask = (1 << bits) - 1;
        return wrap({ kind: "number", label,
          convert: bits === 32 ? (v) => Number(v) >>> 0 : (v) => Number(v) & mask });
      }
      return wrap({ kind: "number", label, convert: (v) => {
        const b = BigInt.asUintN(64, BigInt(v));
        return b <= 9007199254740991n ? Number(b) : b;
      } });
    }
    return wrap({ kind: "number", label, convert: (v) => v });
  }
  if (t === "INT32" || t === "INT64" || t === "FLOAT" || t === "DOUBLE") {
    const label = t === "INT32" ? "int32" : t === "INT64" ? "int64" : t === "FLOAT" ? "float" : "double";
    return wrap({ kind: "number", label, convert: (v) => v });
  }
  /* bytes: decided by sniffing real values later */
  const label = t === "FIXED_LEN_BYTE_ARRAY" ? "fixed[" + leaf.typeLength + "]" : "binary";
  return wrap({ kind: "binary", label, convert: (v) => v, maybeUtf8: true });
}
export function listLabel(leaf, inner) {
  let s = inner;
  for (let i = leaf.chain.length - 1; i >= 0; i--) if (leaf.chain[i].rep === "REPEATED") s = "list<" + s + ">";
  return s;
}

export const pad2 = (n) => (n < 10 ? "0" + n : "" + n);
export function fmtDatePart(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}
export function fmtTimePart(ms) {
  const t = ((ms % 86400000) + 86400000) % 86400000;
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60;
  const frac = t - Math.floor(t / 1000) * 1000;
  let out = pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  if (frac > 0) {
    /* milliseconds with up to microsecond resolution, trailing zeros dropped */
    const f = frac.toFixed(3).replace(".", "").padStart(6, "0").replace(/0+$/, "");
    if (f) out += "." + f;
  }
  return out;
}
export function fmtTemporal(ms, spec) {
  if (!isFinite(ms)) return String(ms);
  if (spec.sub === "date") return fmtDatePart(ms);
  if (spec.sub === "time") return fmtTimePart(ms);
  return fmtDatePart(ms) + " " + fmtTimePart(ms) + (spec.utc ? "Z" : "");
}
export function fmtNumber(v) {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  if (!isFinite(v)) return String(v);
  return String(v);
}
export function fmtValue(v, spec) {
  if (v === null || v === undefined) return null;
  switch (spec.kind) {
    case "number": return fmtNumber(v);
    case "bool": return v ? "true" : "false";
    case "temporal": return fmtTemporal(v, spec);
    case "string": return v;
    case "binary": return v instanceof Uint8Array ? hex(v, 24) : String(v);
    default: return jsonish(v, spec);
  }
}
export function jsonish(v, spec) {
  const inner = spec.elementKind ? { kind: spec.elementKind, sub: spec.sub, utc: spec.utc } : spec;
  const walk = (x) => {
    if (x === null || x === undefined) return null;
    if (Array.isArray(x)) return x.map(walk);
    if (inner.kind === "bool") return x === true;
    if (inner.kind === "number" && typeof x === "number") return x;
    return fmtValue(x, inner);
  };
  try { return JSON.stringify(walk(v)); } catch (_e) { return String(v); }
}

export const BINS = 24;
/* Three top values are on show at a time; keeping ten pages of them costs
   nothing next to the counts map they came from, and means paging through
   is instant rather than a rescan. */
export const TOP_KEEP = 30;
/** A mean is an estimate; this keeps it short and stops it looking exact. */
export function compactNumber(x) {
  if (!isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e12 || a < 1e-4)) return x.toExponential(4);
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(8)));
}
export function numeric(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return parseFloat(v);
  return typeof v === "number" ? v : NaN;
}
/** a < b, falling back to exact integer order when both land on one double. */
export function lessThan(a, b) {
  const x = numeric(a), y = numeric(b);
  if (x !== y) return x < y;
  if (typeof a === "bigint" || typeof b === "bigint") {
    try { return BigInt(a) < BigInt(b); } catch (_e) { return false; }
  }
  return false;
}
/** Which histogram bin a value lands in: the one rule the bars and a click on them share. */
export const binOf = (x, min, span) => (span > 0 ? Math.min(BINS - 1, Math.floor((x - min) / span * BINS)) : 0);
/**
 * The smallest and largest stored value that fell into one histogram bin,
 * over the same rows the summary counted. Bins are contiguous ranges, so
 * every value between these two lands in this bin and no other -- a filter
 * written with them selects exactly the rows the bar counted, where one
 * written with the bin's computed edges could gain or lose a row to
 * rounding at the boundary. null when the bin is empty.
 */
export function binBounds(col, index, count, bin) {
  const s = col.summary;
  if (!s || !s.hist || !s.hist[bin]) return null;
  const rows = col.rows, span = s.max - s.min;
  const n = count == null ? (index ? index.length : rows.length) : count;
  let lo = null, hi = null;
  for (let i = 0; i < n; i++) {
    const v = index ? rows[index[i]] : rows[i];
    if (v === null || v === undefined) continue;
    const x = numeric(v);
    if (!isFinite(x) || binOf(x, s.min, span) !== bin) continue;
    if (lo === null || lessThan(v, lo)) lo = v;
    if (hi === null || lessThan(hi, v)) hi = v;
  }
  return lo === null ? null : { lo, hi };
}
/**
 * Summarises one column. `index`, when given, selects which underlying rows
 * belong to the current view, so a filtered result summarises itself without
 * copying any values.
 */
export function summarize(col, index, count) {
  const rows = col.rows, spec = col.spec;
  const n = count == null ? (index ? index.length : rows.length) : count;
  const at = index ? (i) => rows[index[i]] : (i) => rows[i];
  let nulls = 0;
  for (let i = 0; i < n; i++) { const v = at(i); if (v === null || v === undefined) nulls++; }
  const s = { n, nulls, kind: spec.kind };

  if (spec.kind === "bool") {
    let t = 0, f = 0;
    for (let i = 0; i < n; i++) { const v = at(i); if (v === true) t++; else if (v === false) f++; }
    s.trues = t; s.falses = f;
    return s;
  }
  if (spec.kind === "number" || spec.kind === "temporal") {
    let min = Infinity, max = -Infinity, sum = 0, cnt = 0, nan = 0;
    let lo = null, hi = null;
    for (let i = 0; i < n; i++) {
      const v = at(i);
      if (v === null || v === undefined) continue;
      const x = numeric(v);
      if (!isFinite(x)) { nan++; continue; }
      if (lo === null || lessThan(v, lo)) lo = v;
      if (hi === null || lessThan(hi, v)) hi = v;
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x; cnt++;
    }
    s.count = cnt; s.nonFinite = nan;
    if (cnt) {
      s.min = min; s.max = max; s.mean = sum / cnt;
      const hist = new Int32Array(BINS);
      const span = max - min;
      for (let i = 0; i < n; i++) {
        const v = at(i);
        if (v === null || v === undefined) continue;
        const x = numeric(v);
        if (!isFinite(x)) continue;
        hist[binOf(x, min, span)]++;
      }
      s.hist = hist;
      /* the text comes from the stored value, so decimals and int64 stay exact */
      s.minText = fmtValue(lo, spec);
      s.maxText = fmtValue(hi, spec);
      s.meanText = spec.kind === "temporal" ? fmtTemporal(s.mean, spec) : compactNumber(s.mean);
    }
    return s;
  }
  /* string / binary / nested */
  const counts = new Map();
  let distinctCapped = false;
  let minLen = Infinity, maxLen = -Infinity, sumLen = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = at(i);
    if (v === null || v === undefined) continue;
    cnt++;
    let key, len;
    if (spec.kind === "string") { key = v; len = v.length; }
    else if (spec.kind === "binary") { key = null; len = v instanceof Uint8Array ? v.length : 0; }
    else { key = null; len = Array.isArray(v) ? v.length : 0; }
    if (len < minLen) minLen = len;
    if (len > maxLen) maxLen = len;
    sumLen += len;
    if (key !== null) {
      if (counts.size < 4096 || counts.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
      else distinctCapped = true;
    }
  }
  s.count = cnt;
  if (cnt) { s.minLen = minLen; s.maxLen = maxLen; s.meanLen = sumLen / cnt; }
  if (counts.size) {
    s.distinct = counts.size;
    s.distinctCapped = distinctCapped;
    s.top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_KEEP);
  }
  if (spec.kind === "nested") {
    let empties = 0;
    for (let i = 0; i < n; i++) { const v = at(i); if (Array.isArray(v) && v.length === 0) empties++; }
    s.empties = empties;
  }
  return s;
}
