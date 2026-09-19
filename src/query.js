// The query engine: predicate/metric vocabulary, filter compilation, value
// parsing and comparison, row-mode sorting, group-by aggregation (including
// cube grouping sets and pivot), and the SQL text this all round-trips
// through — `querySql()` writes it from the query object, `parseSql()`
// reads it back. `runQuery()` ties it together against the loaded rows.

import { $ } from "./columns.js";
import { describeScope, showPlan, unscan } from "./pushdown.js";
import { newRadix, planRadix, RADIX, RADIX_BYTES, radixAdd, radixAdvance, radixOpen, radixPending, radixQuantile, radixVisit } from "./radix.js";
import { binBounds, fmtValue, lessThan, numeric } from "./types.js";
import { adoptSql, renderQuery } from "./ui-query-builder.js";
import { baseView, displayCols, neededColumns, needFilled, num, setView, state } from "./view.js";

export const PREDS = [
  { id: "eq", label: "=", sql: "=" },
  { id: "ne", label: "≠", sql: "<>" },
  { id: "lt", label: "<", sql: "<" },
  { id: "le", label: "≤", sql: "<=" },
  { id: "gt", label: ">", sql: ">" },
  { id: "ge", label: "≥", sql: ">=" },
  { id: "like", label: "LIKE", sql: "LIKE" },
  { id: "between", label: "BTW", sql: "BETWEEN" },
  { id: "null", label: "NULL", sql: "IS NULL" },
  { id: "notnull", label: "!NULL", sql: "IS NOT NULL" },
];
export const NO_OPERAND = { null: 1, notnull: 1 };
/* The six that answer "how much" and "how big" stay inline in the METRICS
   row; the ones that answer "how spread out" and "how much is missing" sit
   behind the row's "more" button. A metric's `agg` is one of these short
   names, and AGG_FN/AGG_COMPOSITE turn one into the SQL it means. */
export const AGGS = ["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"];
export const AGG_GROUPS = [
  { label: "spread", aggs: ["STD", "STDP", "VAR", "CV", "RANGE"] },
  { label: "distribution", aggs: ["MED", "P90", "P95", "P99", "IQR", "MODE"] },
  { label: "missing", aggs: ["NULLS"] },
];
export const AGG_MORE = AGG_GROUPS.reduce((a, g) => a.concat(g.aggs), []);
export const AGG_SHORT = {
  COUNT: "COUNT", COUNT_DISTINCT: "CNTD", SUM: "SUM", AVG: "AVG", MIN: "MIN", MAX: "MAX",
  STD: "STD", STDP: "STDP", VAR: "VAR", CV: "CV", RANGE: "RANGE",
  MED: "MED", P90: "P90", P95: "P95", P99: "P99", IQR: "IQR", MODE: "MODE", NULLS: "NULLS",
};
export const AGG_TITLE = {
  COUNT: "rows with a value", COUNT_DISTINCT: "distinct values", SUM: "total", AVG: "mean",
  MIN: "smallest", MAX: "largest",
  STD: "standard deviation (sample, n\u22121)", STDP: "standard deviation (population, n)",
  VAR: "variance (sample, n\u22121)", CV: "coefficient of variation \u2014 std \u00f7 |mean|, unitless",
  RANGE: "max \u2212 min", MED: "median", P90: "90th percentile", P95: "95th percentile",
  P99: "99th percentile", IQR: "interquartile range \u2014 p75 \u2212 p25", MODE: "most common value",
  NULLS: "rows with no value",
};
/** The kinds that only mean something over a column that reads as a number. */
export const AGG_NUMERIC = { SUM: 1, AVG: 1, STD: 1, STDP: 1, VAR: 1, CV: 1, RANGE: 1, MED: 1, P90: 1, P95: 1, P99: 1, IQR: 1 };
/** kind -> the SQL function that says it, where one call is enough. */
export const AGG_FN = { STD: "STDDEV_SAMP", STDP: "STDDEV_POP", VAR: "VAR_SAMP", MED: "MEDIAN", MODE: "MODE" };
/**
 * kind -> the SQL it takes more than one call to say, with `#` for the
 * column. The SQL box writes these and reads them back from this same
 * string, so the two directions cannot drift apart.
 */
export const AGG_COMPOSITE = {
  NULLS: "COUNT(*) - COUNT(#)",
  RANGE: "MAX(#) - MIN(#)",
  CV: "STDDEV_SAMP(#) / ABS(AVG(#))",
  IQR: "QUANTILE_CONT(#, 0.75) - QUANTILE_CONT(#, 0.25)",
  P90: "QUANTILE_CONT(#, 0.9)",
  P95: "QUANTILE_CONT(#, 0.95)",
  P99: "QUANTILE_CONT(#, 0.99)",
};
/** Every SQL spelling the parser accepts, mapped onto one internal kind. */
export const AGG_BY_NAME = {
  COUNT: "COUNT", SUM: "SUM", AVG: "AVG", MIN: "MIN", MAX: "MAX", MEDIAN: "MED", MODE: "MODE",
  STDDEV_SAMP: "STD", STDDEV: "STD", STDEV: "STD", STDEV_SAMP: "STD",
  STDDEV_POP: "STDP", STDEVP: "STDP", STDEV_POP: "STDP",
  VAR_SAMP: "VAR", VARIANCE: "VAR", VAR: "VAR",
};
/** The SQL for one metric over one already-quoted column expression. */
export function aggSqlExpr(kind, inner) {
  if (kind === "COUNT_DISTINCT") return "COUNT(DISTINCT " + inner + ")";
  const t = AGG_COMPOSITE[kind];
  return t ? t.replace(/#/g, inner) : (AGG_FN[kind] || kind) + "(" + inner + ")";
}
let qid = 0;
/** Ids for the builder's own chips: unique per page load, nothing more. */
export function nextQid(prefix) {
  qid++;
  return prefix + qid;
}

export function newQuery() {
  return { active: false, mode: "rows", select: [], filters: [], sort: [], groupBy: [], groupMode: "", metrics: [], limit: null };
}

export function parseTemporal(text, spec) {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);          /* raw epoch millis */
  if (spec.sub === "time") {
    const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
    if (!m) return NaN;
    return (((+m[1] * 60 + +m[2]) * 60 + (+m[3] || 0)) * 1e6 + (m[4] ? +(m[4] + "000000").slice(0, 6) : 0)) / 1000;
  }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?Z?$/);
  if (!m) return NaN;
  /* whole microseconds, divided once, the way toMillis() turns a stored
     value into millis -- so a timestamp the grid prints reads back as
     exactly the number it was printed from, not one a fraction below it */
  const whole = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return (whole * 1000 + (m[7] ? +(m[7] + "000000").slice(0, 6) : 0)) / 1000;
}
export function parseOperand(text, spec) {
  const t = String(text).trim();
  if (spec.kind === "number") return parseFloat(t);
  if (spec.kind === "temporal") return parseTemporal(t, spec);
  if (spec.kind === "bool") return /^(true|t|1|y|yes)$/i.test(t) ? 1 : 0;
  return t;
}
/** Numeric key for a stored value, or null when the column compares as text. */
export function sortKey(spec) {
  if (spec.kind === "bool") return (v) => (v === true ? 1 : v === false ? 0 : NaN);
  if (spec.kind === "number" || spec.kind === "temporal") return numeric;
  return null;
}
export function textOf(v, spec) {
  return spec.kind === "string" ? v : fmtValue(v, spec);
}

/** Compiles one clause into a row test, or null if it is not filled in yet. */
export function compileFilter(f, cols) {
  const col = cols[f.ci];
  if (!col) return null;
  const rows = col.rows, spec = col.spec, p = f.pred;
  if (p === "null") return (r) => rows[r] === null || rows[r] === undefined;
  if (p === "notnull") return (r) => rows[r] !== null && rows[r] !== undefined;
  if (f.value === "" || f.value == null) return null;
  if (p === "like") {
    const needle = String(f.value).toLowerCase();
    return (r) => {
      const v = rows[r];
      return v !== null && v !== undefined && String(textOf(v, spec)).toLowerCase().indexOf(needle) >= 0;
    };
  }
  const key = sortKey(spec);
  if (!key) {                                   /* text comparison */
    const a = String(f.value), b = String(f.valueTo == null ? f.value : f.valueTo);
    const get = (r) => { const v = rows[r]; return v === null || v === undefined ? null : String(textOf(v, spec)); };
    switch (p) {
      case "eq": return (r) => get(r) === a;
      case "ne": return (r) => { const x = get(r); return x !== null && x !== a; };
      case "lt": return (r) => { const x = get(r); return x !== null && x < a; };
      case "le": return (r) => { const x = get(r); return x !== null && x <= a; };
      case "gt": return (r) => { const x = get(r); return x !== null && x > a; };
      case "ge": return (r) => { const x = get(r); return x !== null && x >= a; };
      case "between": return (r) => { const x = get(r); return x !== null && x >= a && x <= b; };
      default: return null;
    }
  }
  const a = parseOperand(f.value, spec);
  if (!isFinite(a)) return null;
  const b = f.valueTo == null || f.valueTo === "" ? a : parseOperand(f.valueTo, spec);
  switch (p) {
    case "eq": return (r) => key(rows[r]) === a;
    case "ne": return (r) => { const x = key(rows[r]); return x === x && x !== a; };
    case "lt": return (r) => key(rows[r]) < a;
    case "le": return (r) => key(rows[r]) <= a;
    case "gt": return (r) => key(rows[r]) > a;
    case "ge": return (r) => key(rows[r]) >= a;
    case "between": return (r) => { const x = key(rows[r]); return x >= a && x <= b; };
    default: return null;
  }
}
/**
 * Why a clause will not be applied: "empty" if no value has been typed yet,
 * "invalid" if what was typed is not a value this column could hold. Either
 * way the clause is skipped, and the UI says so rather than quietly widening
 * the result.
 */
export function filterIssue(f, cols) {
  const col = cols[f.ci];
  if (!col) return "missing";
  if (NO_OPERAND[f.pred]) return null;
  if (f.value === "" || f.value == null) return "empty";
  if (f.pred === "like") return null;
  if (!sortKey(col.spec)) return null;                 /* text compares anything */
  if (!isFinite(parseOperand(f.value, col.spec))) return "invalid";
  if (f.pred === "between" && f.valueTo !== "" && f.valueTo != null &&
      !isFinite(parseOperand(f.valueTo, col.spec))) return "invalid";
  return null;
}

/** AND binds tighter than OR, so the clauses become OR-ed groups of ANDs. */
export function orGroups(filters, cols) {
  const groups = [];
  let current = null;
  for (const f of filters) {
    const test = compileFilter(f, cols);
    if (!test) continue;
    if (!current || f.linker === "OR") { current = []; groups.push(current); }
    current.push(test);
  }
  return groups;
}

export function buildComparator(sorts, cols) {
  const parts = sorts.map((s) => {
    const col = cols[s.ci];
    const rows = col.rows, key = sortKey(col.spec), spec = col.spec;
    const sign = s.dir === "DESC" ? -1 : 1;
    if (key) {
      return (x, y) => {
        const a = key(rows[x]), b = key(rows[y]);
        const an = a !== a || a === undefined, bn = b !== b || b === undefined;
        if (an || bn) return an && bn ? 0 : an ? 1 : -1;     /* nulls last */
        return a < b ? -sign : a > b ? sign : 0;
      };
    }
    return (x, y) => {
      const va = rows[x], vb = rows[y];
      const an = va === null || va === undefined, bn = vb === null || vb === undefined;
      if (an || bn) return an && bn ? 0 : an ? 1 : -1;
      const a = String(textOf(va, spec)), b = String(textOf(vb, spec));
      return a < b ? -sign : a > b ? sign : 0;
    };
  });
  return (x, y) => {
    for (let i = 0; i < parts.length; i++) { const c = parts[i](x, y); if (c) return c; }
    return x - y;
  };
}

/* a group key joins its parts with U+0001 and writes null as U+0000, so no
   two group values can collide by running into each other */
export const keyPart = (v) => (v === null || v === undefined ? "\u0000" : typeof v === "object" ? JSON.stringify(v) : String(v));

/* the group-by positions to scan for, one array per subtotal row: ROLLUP
   drops columns from the right one at a time down to the grand total, CUBE
   is every subset of them. Both start with the full set, so a plain
   GROUP BY is just the one-set list a groupMode of "" produces. */
export const CUBE_MAX_COLS = 8;
export function groupingSets(k, mode) {
  const full = Array.from({ length: k }, (_, i) => i);
  if (mode === "ROLLUP") {
    const sets = [];
    for (let i = k; i >= 0; i--) sets.push(full.slice(0, i));
    return sets;
  }
  if (mode === "CUBE" && k <= CUBE_MAX_COLS) {
    const sets = [];
    for (let mask = (1 << k) - 1; mask >= 0; mask--) {
      const s = [];
      for (let b = 0; b < k; b++) if (mask & (1 << b)) s.push(b);
      sets.push(s);
    }
    return sets;
  }
  return [full];
}

/**
 * One group's running state for one metric. Every field is here rather than
 * per kind so a group is one object shape, but the containers stay null
 * until a metric that needs them turns up -- the way COUNT(DISTINCT)'s set
 * always has.
 */
export function newAcc() {
  return { t: 0, n: 0, sum: 0, c: 0, k: 0, mean: 0, m2: 0, lo: Infinity, hi: -Infinity,
    min: null, max: null, set: null, vals: null, freq: null, sorted: false };
}
/** What a kind has to keep per group, worked out once per kind, not per row. */
const ACC_NEEDS = {};
export function accNeeds(kind) {
  let f = ACC_NEEDS[kind];
  if (!f) {
    f = {
      sum: kind === "SUM" || kind === "AVG",
      stat: kind === "STD" || kind === "STDP" || kind === "VAR" || kind === "CV",
      span: kind === "RANGE",
      vals: kind === "MED" || kind === "IQR" || kind === "P90" || kind === "P95" || kind === "P99",
      set: kind === "COUNT_DISTINCT",
      freq: kind === "MODE",
      minmax: kind === "MIN" || kind === "MAX",
    };
    f.num = f.sum || f.stat || f.span || f.vals;
    ACC_NEEDS[kind] = f;
  }
  return f;
}
/* Neumaier summation: adding a million doubles naively drifts, and the lost
   low bits are exactly what a mean is made of */
function addSum(a, x) {
  const t = a.sum + x;
  a.c += Math.abs(a.sum) >= Math.abs(x) ? (a.sum - t) + x : (x - t) + a.sum;
  a.sum = t;
}

/**
 * What feeding rows into groups needs to know about the metrics, worked out once per batch of rows
 * rather than once per row.
 */
/** A fast 32-bit hash (FNV-1a) of a key's text, for dividing groups or values into slices. */
export function hashKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/**
 * How a streamed aggregate is sliced when its running state would not fit whole. Mode "G" keeps only the
 * groups whose key hashes into slice k of P (each pass then holds about 1/P of the groups); mode "V" keeps
 * only the distinct values (and mode candidates) that hash into slice k, and the passes after the first
 * feed nothing else. Either way the source is read again for every slice, so nothing is written anywhere.
 */
export function sliceFns(slice) {
  if (!slice) return { gslice: null, vslice: null, only: false };
  const P = slice.P, k = slice.k;
  if (slice.mode === "G") return { gslice: (key) => hashKey(key) % P === k, vslice: null, only: false };
  return { gslice: null, vslice: (key) => hashKey(key) % P === k, only: k > 0 };
}
export function groupScanCtx(metrics, mKeys, mSpecs, radix, slice) {
  return {
    metrics, mKeys, radix: !!radix, ...sliceFns(slice),
    needs: metrics.map((m) => accNeeds(m.agg)),
    /* one comparator per metric, built here rather than per row */
    less: metrics.map((_m, i) => (mKeys[i]
      ? (x, y) => lessThan(x, y)
      : (x, y) => String(textOf(x, mSpecs[i])) < String(textOf(y, mSpecs[i])))),
  };
}
/** What a group, a kept value, a distinct value and a mode entry are estimated to cost, for the running byte count. */
export const STATE_BYTES = { group: 96, perMetric: 168, perKeyChar: 2, value: 16, distinct: 72, freq: 104 };

/**
 * Feeds rows into `groups`, which may already hold the running totals of earlier rows: the totals
 * are the only thing kept, so rows can come in batches and be dropped as they are folded. With
 * `keepKeys` each new group also remembers the values it is grouped on (a batch's rows will not
 * be there to ask later), and with `track` its estimated bytes are added to `track.bytes` so a
 * caller can stop a query whose groups, kept values or distinct values are outgrowing memory.
 */
export function feedGroups(groups, ctx, gRows, mRows, positions, index, n, keepKeys, track) {
  const { metrics, mKeys, needs, less, gslice, vslice, only } = ctx, base = ctx.base || 0;
  const total = index ? index.length : n;
  let bytes = 0, groupBytes = 0, setBytes = 0;
  for (let i = 0; i < total; i++) {
    const r = index ? index[i] : i;
    let key = "";
    for (const g of positions) key += keyPart(gRows[g][r]) + "\u0001";
    if (gslice && !gslice(key)) continue;          /* another slice's group */
    let acc = groups.get(key);
    if (!acc) {
      if (only) continue;                          /* later passes of a value-sliced run add nothing new */
      acc = { row: r, m: metrics.map(newAcc) };
      if (keepKeys) acc.gv = positions.map((g) => gRows[g][r]);
      groups.set(key, acc);
      if (track) { const b = STATE_BYTES.group + metrics.length * STATE_BYTES.perMetric + key.length * STATE_BYTES.perKeyChar; bytes += b; groupBytes += b; }
    }
    for (let m = 0; m < metrics.length; m++) {
      const f = needs[m];
      if (only && !(f.set || f.freq)) continue;
      const a = acc.m[m];
      a.t++;                          /* rows in the group; NULLS is t minus n */
      const v = mRows[m][r];
      if (v === null || v === undefined) continue;
      a.n++;
      if (f.num) {
        const x = mKeys[m] ? mKeys[m](v) : NaN;
        if (x === x) {
          a.k++;
          if (f.sum) addSum(a, x);
          if (f.stat) {
            /* Welford. The textbook E[x^2] - E[x]^2 cancels catastrophically
               when the mean dwarfs the spread -- epoch millis, prices in a
               tight band -- and can come out negative. This is the same one
               pass and the same constant memory, and it stays right. */
            const d = x - a.mean;
            a.mean += d / a.k;
            a.m2 += d * (x - a.mean);
          }
          if (f.span) { if (x < a.lo) a.lo = x; if (x > a.hi) a.hi = x; }
          if (f.vals) {
            if (a.rh) radixAdd(a.rh, x);
            else {
              if (!a.vals) a.vals = [];
              a.vals.push(x);
              if (track) bytes += STATE_BYTES.value;
              /* a streamed group that keeps more values than this stops keeping them and counts them into
                 buckets instead (src/radix.js): its percentiles are then found by narrowing passes over the
                 file, exactly, without a sorted copy */
              if (ctx.radix && a.vals.length > RADIX.promote) {
                a.rh = newRadix();
                for (const v of a.vals) radixAdd(a.rh, v);
                if (track) bytes += RADIX_BYTES - a.vals.length * STATE_BYTES.value;
                a.vals = null;
              }
            }
          }
        }
      }
      else if (f.set) {
        const dk = keyPart(v);
        if (vslice && !vslice(dk)) continue;
        if (!a.set) a.set = new Set();
        const before = a.set.size;
        a.set.add(dk);
        if (track && a.set.size !== before) { bytes += STATE_BYTES.distinct; setBytes += STATE_BYTES.distinct; }
      }
      else if (f.freq) {
        const fk = keyPart(v);
        if (vslice && !vslice(fk)) continue;
        if (!a.freq) a.freq = new Map();
        const hit = a.freq.get(fk);
        if (hit) hit.c++; else { a.freq.set(fk, { v, c: 1, at: base + r }); if (track) { bytes += STATE_BYTES.freq; setBytes += STATE_BYTES.freq; } }
      }
      else if (f.minmax) {
        if (a.min === null || less[m](v, a.min)) a.min = v;
        if (a.max === null || less[m](a.max, v)) a.max = v;
      }
    }
  }
  if (track) { track.bytes += bytes; track.group += groupBytes; track.set += setBytes; }
}
export function scanGroups(gRows, mRows, mKeys, mSpecs, metrics, positions, index, n) {
  const groups = new Map();
  feedGroups(groups, groupScanCtx(metrics, mKeys, mSpecs), gRows, mRows, positions, index, n, false, null);
  return groups;
}
/**
 * An exact quantile, linearly interpolated between the two values it falls
 * between -- what duckdb's QUANTILE_CONT and numpy's percentile both give.
 * Exact means the values are kept, so a percentile metric costs memory in
 * the group that a streaming one does not.
 */
export function quantileOf(a, p) {
  if (a.rh) return radixQuantile(a.rh, p);
  const v = a.vals;
  if (!v || !v.length) return null;
  if (!a.sorted) { v.sort((x, y) => x - y); a.sorted = true; }
  const h = (v.length - 1) * p, lo = Math.floor(h), d = h - lo;
  return d ? v[lo] + (v[lo + 1] - v[lo]) * d : v[lo];
}
export function metricValue(m, kind) {
  switch (kind) {
    case "COUNT": return m.n;
    case "COUNT_DISTINCT": return (m.dc || 0) + (m.set ? m.set.size : 0);
    case "NULLS": return m.t - m.n;
    case "SUM": return m.n ? m.sum + m.c : null;
    case "AVG": return m.n ? (m.sum + m.c) / m.n : null;
    case "MIN": return m.min;
    case "MAX": return m.max;
    case "RANGE": return m.k ? m.hi - m.lo : null;
    /* m2 is a sum of squares and cannot really be negative; rounding can
       still leave it a hair below zero on a constant column */
    case "STD": return m.k > 1 ? Math.sqrt(Math.max(0, m.m2 / (m.k - 1))) : null;
    case "STDP": return m.k ? Math.sqrt(Math.max(0, m.m2 / m.k)) : null;
    case "VAR": return m.k > 1 ? Math.max(0, m.m2 / (m.k - 1)) : null;
    /* spread divided by level: unitless, so it is the one metric that
       compares columns which have no business being compared in their own
       units. Undefined at a mean of zero, where it would divide by it. */
    case "CV": return m.k > 1 && m.mean !== 0 ? Math.sqrt(Math.max(0, m.m2 / (m.k - 1))) / Math.abs(m.mean) : null;
    case "MED": return quantileOf(m, 0.5);
    case "P90": return quantileOf(m, 0.9);
    case "P95": return quantileOf(m, 0.95);
    case "P99": return quantileOf(m, 0.99);
    case "IQR": { const a = quantileOf(m, 0.25); return a === null ? null : quantileOf(m, 0.75) - a; }
    case "MODE": {
      let best = m.best || null;                /* the best candidate of the slices already finished */
      if (m.freq) for (const e of m.freq.values()) if (!best || e.c > best.c || (e.c === best.c && e.at < best.at)) best = e;   /* ties go to the first seen */
      return best ? best.v : null;
    }
    default: return null;
  }
}
export const AGG_COUNT_SPEC = { kind: "number", label: "count", physical: "INT64", convert: (v) => v };
export function metricSpec(m, cols) {
  const src = cols[m.ci];
  const counts = m.agg === "COUNT" || m.agg === "COUNT_DISTINCT" || m.agg === "NULLS";
  /* MIN/MAX/MODE hand back a value the column really holds, so they keep its
     type; everything else is a derived number, and one that has left the
     column's units behind -- STD of a timestamp is a duration, not a date */
  const keeps = m.agg === "MIN" || m.agg === "MAX" || m.agg === "MODE";
  return counts ? AGG_COUNT_SPEC : keeps ? src.spec : { kind: "number", label: m.agg.toLowerCase(), physical: src.spec.physical, convert: (v) => v };
}
export function metricName(m, cols) { return m.alias || AGG_SHORT[m.agg] + "(" + cols[m.ci].name + ")"; }

export function aggregate(q, cols, index, n) {
  const gcis = q.groupBy;
  if (q.groupMode === "PIVOT" && gcis.length >= 1) return pivotTable(q, cols, index, n);

  const metrics = q.metrics.filter((m) => cols[m.ci]);
  const gRows = gcis.map((ci) => cols[ci].rows);
  const mRows = metrics.map((m) => cols[m.ci].rows);
  const mKeys = metrics.map((m) => sortKey(cols[m.ci].spec));
  const mSpecs = metrics.map((m) => cols[m.ci].spec);

  const outCols = [];
  for (const ci of gcis) outCols.push({ name: cols[ci].name, spec: cols[ci].spec, leaf: cols[ci].leaf, rows: [] });
  for (const m of metrics) outCols.push({ name: metricName(m, cols), spec: metricSpec(m, cols), rows: [] });

  /* every grouping set is a full pass over the rows: SUM could be re-added
     across a finer group's already-summed rows, but AVG, MIN/MAX and
     COUNT(DISTINCT) cannot be derived from an already-aggregated subtotal,
     so each set scans fresh rather than rolling up the previous one */
  for (const positions of groupingSets(gcis.length, q.groupMode)) {
    emitGroups(outCols, scanGroups(gRows, mRows, mKeys, mSpecs, metrics, positions, index, n), gcis, positions, metrics, cols);
  }
  return outCols;
}
/**
 * Writes finished groups out as rows. A column this grouping set dropped shows null, the same as
 * SQL's own ROLLUP/CUBE -- indistinguishable from a real null there, which is the one ambiguity
 * the standard has too. A group that kept its own key values (a streamed one) reads them from
 * there; otherwise they come from the row it first appeared at.
 */
export function emitGroups(outCols, groups, gcis, positions, metrics, cols) {
  for (const acc of groups.values()) {
    let k = 0;
    for (let g = 0; g < gcis.length; g++) {
      const at = positions.indexOf(g);
      outCols[k++].rows.push(at < 0 ? null : acc.gv ? acc.gv[at] : cols[gcis[g]].rows[acc.row]);
    }
    for (let m = 0; m < metrics.length; m++) outCols[k++].rows.push(metricValue(acc.m[m], metrics[m].agg));
  }
}

/** Which rows of a batch pass the WHERE clause: null when there is none (every row does), else their indexes. */
export function matchIndex(q, cols, n) {
  const groups = orGroups(q.filters, cols);
  if (!groups.length) return null;
  const buf = new Int32Array(n);
  let k = 0;
  for (let r = 0; r < n; r++) {
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      let ok = true;
      for (let i = 0; i < grp.length; i++) if (!grp[i](r)) { ok = false; break; }
      if (ok) { buf[k++] = r; break; }
    }
  }
  return buf.slice(0, k);
}

/** True when a query can be answered by folding row groups one at a time (everything but a pivot). */
export function streamable(q) {
  return q.mode === "agg" && (q.groupBy.length > 0 || q.metrics.length > 0) && q.groupMode !== "PIVOT";
}

/**
 * A streamed aggregate: running totals per group (one map per grouping set), fed a batch of decoded
 * rows at a time. `bytes` is the running estimate of what the totals, the values a percentile keeps
 * and the distinct values a count keeps have cost so far.
 */
export function newAggStream(q, cols, slice) {
  const metrics = q.metrics.filter((m) => cols[m.ci]);
  const sets = groupingSets(q.groupBy.length, q.groupMode);
  return { q, metrics, sets, slice: slice || null, maps: sets.map(() => new Map()), track: { bytes: 0, group: 0, set: 0 }, rows: 0, matched: 0, batches: 0, last: cols };
}
/** True when the query has a metric that keeps distinct values or mode candidates, the only kind a value slice can shrink. */
export function hasSetMetrics(q) {
  return q.metrics.some((m) => { const f = accNeeds(m.agg); return f.set || f.freq; });
}
/**
 * After a pass of a value-sliced run: what this slice's distinct values and mode candidates came to is folded
 * into totals and the sets are let go, so the next slice starts empty. Distinct values in different slices are
 * different values, so their counts simply add; the mode is the best candidate seen in any slice.
 */
export function endValueSlice(st) {
  for (const map of st.maps) {
    for (const acc of map.values()) {
      for (const a of acc.m) {
        if (a.set) { a.dc = (a.dc || 0) + a.set.size; a.set = null; }
        if (a.freq) {
          for (const e of a.freq.values()) if (!a.best || e.c > a.best.c || (e.c === a.best.c && e.at < a.best.at)) a.best = e;
          a.freq = null;
        }
      }
    }
  }
  st.track.bytes -= st.track.set;
  st.track.set = 0;
}
export function feedAggBatch(st, cols, n) {
  const q = st.q, gcis = q.groupBy;
  const index = matchIndex(q, cols, n);
  const gRows = gcis.map((ci) => cols[ci].rows);
  const mRows = st.metrics.map((m) => cols[m.ci].rows);
  const ctx = groupScanCtx(st.metrics, st.metrics.map((m) => sortKey(cols[m.ci].spec)), st.metrics.map((m) => cols[m.ci].spec), true, st.slice);
  ctx.base = st.rows;                    /* rows before this batch: where a value was first seen decides a tied mode */
  for (let i = 0; i < st.sets.length; i++) feedGroups(st.maps[i], ctx, gRows, mRows, st.sets[i], index, n, true, st.track);
  st.rows += n;
  st.matched += index ? index.length : n;
  st.batches++;
  st.last = cols;
}
/* ---- the passes that find exact percentiles for groups that kept counts instead of values ---- */
const QUANTILES = { MED: [0.5], P90: [0.9], P95: [0.95], P99: [0.99], IQR: [0.25, 0.75] };
export const isQuantile = (agg) => !!QUANTILES[agg];
const eachRadix = (st, fn) => {
  for (const map of st.maps) for (const acc of map.values()) for (let m = 0; m < st.metrics.length; m++) if (acc.m[m].rh) fn(acc.m[m].rh, m);
};
/** After the first pass: where in its buckets each wanted rank falls. */
export function radixPlanStream(st) {
  eachRadix(st, (rh, m) => planRadix(rh, QUANTILES[st.metrics[m].agg]));
}
export function radixOpenStream(st) {
  let open = false;
  eachRadix(st, (rh) => { if (radixOpen(rh)) open = true; });
  return open;
}
/** What the next narrowing pass will hold: the buckets it gathers and the digit counters it fills. */
export function radixPendingBytes(st) {
  let bytes = 0;
  eachRadix(st, (rh) => { bytes += radixPending(rh); });
  return bytes;
}
/** The columns a narrowing pass has to read: what groups and filters need, and only the percentile columns still open. */
export function radixColumns(st) {
  const need = new Set(st.q.groupBy);
  for (const f of st.q.filters) need.add(f.ci);
  eachRadix(st, (rh, m) => { if (radixOpen(rh)) need.add(st.metrics[m].ci); });
  return need;
}
/** One batch of a narrowing pass: every value goes to the targets its group's buckets still want. */
export function radixFeedBatch(st, cols, n) {
  const q = st.q, gcis = q.groupBy;
  const index = matchIndex(q, cols, n);
  const total = index ? index.length : n;
  const gRows = gcis.map((ci) => cols[ci].rows);
  const mRows = st.metrics.map((m) => cols[m.ci].rows);
  const mKeys = st.metrics.map((m) => sortKey(cols[m.ci].spec));
  for (let s = 0; s < st.sets.length; s++) {
    const positions = st.sets[s], map = st.maps[s];
    for (let i = 0; i < total; i++) {
      const r = index ? index[i] : i;
      let key = "";
      for (const g of positions) key += keyPart(gRows[g][r]) + "\u0001";
      const acc = map.get(key);                  /* a group in another slice was never kept, so it is not here */
      if (!acc) continue;
      for (let m = 0; m < st.metrics.length; m++) {
        const rh = acc.m[m].rh;
        if (!rh || !rh.targets) continue;
        const v = mRows[m][r];
        if (v === null || v === undefined) continue;
        const x = mKeys[m] ? mKeys[m](v) : NaN;
        if (x === x) radixVisit(rh, x);
      }
    }
  }
}
/** After a narrowing pass over the whole file. */
export function radixAdvanceStream(st) {
  eachRadix(st, (rh) => { if (radixOpen(rh)) radixAdvance(rh); });
}

/** The output columns of a finished stream, named and typed from the last batch's columns. */
export function finishAggStream(st) {
  const q = st.q, gcis = q.groupBy, cols = st.last, metrics = st.metrics;
  const outCols = [];
  for (const ci of gcis) outCols.push({ name: cols[ci].name, spec: cols[ci].spec, leaf: cols[ci].leaf, rows: [] });
  for (const m of metrics) outCols.push({ name: metricName(m, cols), spec: metricSpec(m, cols), rows: [] });
  for (let i = 0; i < st.sets.length; i++) emitGroups(outCols, st.maps[i], gcis, st.sets[i], metrics, cols);
  return outCols;
}
/** What identifies an aggregate's answer, so a stored one can be reused when only the ordering or limit changed. */
/** The stored streamed aggregate, if it is the answer to the query on screen. */
export function aggKept() {
  const q = state.query, a = state.agg;
  if (!q || !a || a.dataset !== state.dataset) return null;
  if (!(q.mode === "agg" && (q.groupBy.length || q.metrics.length))) return null;
  return a.sig === aggSignature(q) ? a : null;
}
export function aggSignature(q) {
  return JSON.stringify([q.filters.map((f) => [f.ci, f.pred, f.value, f.valueTo, f.linker]), q.groupBy, q.groupMode,
    q.metrics.map((m) => [m.id, m.ci, m.agg, m.alias])]);
}

/* Excel-style reshape: the last GROUP BY column's own distinct values
   become new output columns instead of a row of their own, and every
   other grouped column stays a row dimension. A cell nothing matched is
   null, same as an unfilled cell in a spreadsheet pivot. Past
   PIVOT_MAX_COLS distinct values, the rest fold into one "(other)"
   column rather than being dropped -- every row is still accounted for. */
export const PIVOT_MAX_COLS = 50;
export function mergeAcc(target, acc, metrics, mKeys, mSpecs) {
  for (let mi = 0; mi < metrics.length; mi++) {
    const a = acc.m[mi], o = target[mi], f = accNeeds(metrics[mi].agg);
    o.t += a.t;
    o.n += a.n;
    if (f.sum) { const x = a.n ? a.sum + a.c : NaN; if (x === x) addSum(o, x); }
    if (f.stat) {
      /* Chan's parallel form: two Welford states combine exactly, which is
         what lets a pivot merge partial groups instead of rescanning them */
      if (a.k) {
        const k = o.k + a.k, d = a.mean - o.mean;
        o.m2 += a.m2 + d * d * ((o.k * a.k) / k);
        o.mean += d * (a.k / k);
        o.k = k;
      }
    } else o.k += a.k;
    if (f.span) { if (a.lo < o.lo) o.lo = a.lo; if (a.hi > o.hi) o.hi = a.hi; }
    if (f.vals && a.vals) {
      if (!o.vals) o.vals = [];
      for (let i = 0; i < a.vals.length; i++) o.vals.push(a.vals[i]);
      o.sorted = false;
    }
    if (f.set && a.set) { if (!o.set) o.set = new Set(); for (const v of a.set) o.set.add(v); }
    if (f.freq && a.freq) {
      if (!o.freq) o.freq = new Map();
      for (const [fk, e] of a.freq) {
        const hit = o.freq.get(fk);
        if (hit) hit.c += e.c; else o.freq.set(fk, { v: e.v, c: e.c, at: e.at });
      }
    }
    if (f.minmax) {
      const cmpLess = mKeys[mi]
        ? (x, y) => lessThan(x, y)
        : (x, y) => String(textOf(x, mSpecs[mi])) < String(textOf(y, mSpecs[mi]));
      if (a.min !== null && (o.min === null || cmpLess(a.min, o.min))) o.min = a.min;
      if (a.max !== null && (o.max === null || cmpLess(o.max, a.max))) o.max = a.max;
    }
  }
}
export function pivotTable(q, cols, index, n) {
  const gcis = q.groupBy;
  const rowCis = gcis.slice(0, -1);
  const pivotCi = gcis[gcis.length - 1];
  const pivotSpec = cols[pivotCi].spec;
  const declared = q.metrics.filter((m) => cols[m.ci]);
  /* an empty METRICS zone still needs something in each cell, so pivot
     falls back to COUNT of the pivoted column, the way a fresh Excel
     pivot defaults its Values area to Count */
  const metrics = declared.length ? declared : [{ id: "n", ci: pivotCi, agg: "COUNT", alias: "" }];

  const gRows = gcis.map((ci) => cols[ci].rows);
  const mRows = metrics.map((m) => cols[m.ci].rows);
  const mKeys = metrics.map((m) => sortKey(cols[m.ci].spec));
  const mSpecs = metrics.map((m) => cols[m.ci].spec);
  const positions = gcis.map((_, i) => i);
  const groups = scanGroups(gRows, mRows, mKeys, mSpecs, metrics, positions, index, n);

  const rowOrder = [];
  const rowIndex = new Map();     /* rowKey -> { dims, cells: Map(pivotKey -> acc), other } */
  const pivotOrder = [];
  const pivotIndex = new Map();   /* pivotKey -> raw pivot value */
  let overflow = false;

  for (const acc of groups.values()) {
    let rk = "";
    for (const ci of rowCis) rk += keyPart(cols[ci].rows[acc.row]) + "\u0001";
    let rec = rowIndex.get(rk);
    if (!rec) {
      rec = { dims: rowCis.map((ci) => cols[ci].rows[acc.row]), cells: new Map(), other: null };
      rowIndex.set(rk, rec);
      rowOrder.push(rk);
    }
    const pv = cols[pivotCi].rows[acc.row];
    const pk = keyPart(pv);
    let known = pivotIndex.has(pk);
    if (!known && pivotOrder.length < PIVOT_MAX_COLS) { pivotIndex.set(pk, pv); pivotOrder.push(pk); known = true; }
    if (known) rec.cells.set(pk, acc);
    else {
      overflow = true;
      if (!rec.other) rec.other = metrics.map(newAcc);
      mergeAcc(rec.other, acc, metrics, mKeys, mSpecs);
    }
  }

  const outCols = [];
  for (const ci of rowCis) outCols.push({ name: cols[ci].name, spec: cols[ci].spec, leaf: cols[ci].leaf, rows: [] });
  const pivotCols = [];   /* { pk, mi } in output order, parallel to outCols past the row dims */
  const addPivotGroup = (pk, label) => {
    for (let mi = 0; mi < metrics.length; mi++) {
      const name = metrics.length > 1 ? label + " · " + metricName(metrics[mi], cols) : label;
      outCols.push({ name, spec: metricSpec(metrics[mi], cols), rows: [] });
      pivotCols.push({ pk, mi });
    }
  };
  for (const pk of pivotOrder) addPivotGroup(pk, pk === "\u0000" ? "(null)" : textOf(pivotIndex.get(pk), pivotSpec));
  if (overflow) addPivotGroup(null, "(other)");

  for (const rk of rowOrder) {
    const rec = rowIndex.get(rk);
    let k = 0;
    for (let i = 0; i < rowCis.length; i++) outCols[k++].rows.push(rec.dims[i]);
    for (const { pk, mi } of pivotCols) {
      let bucket = null;
      if (pk === null) bucket = rec.other ? rec.other[mi] : null;
      else { const acc = rec.cells.get(pk); bucket = acc ? acc.m[mi] : null; }
      outCols[k++].rows.push(bucket ? metricValue(bucket, metrics[mi].agg) : null);
    }
  }
  return outCols;
}

export function runQuery() {
  const q = state.query, table = state.table;
  if (!table) return;
  /* a whole-file aggregate that was streamed is kept, so ordering or limiting it does not re-aggregate
     over whatever rows happen to be loaded */
  const kept = aggKept();
  /* running is what settles it: an aggregate about to replace the grid does
     not need the columns it is replacing */
  if (!kept && needFilled([...neededColumns(table, true)], runQuery)) return;
  const t0 = performance.now();
  const cols = table.cols, n = kept ? kept.rows : table.rowsLoaded;

  let index = kept ? null : matchIndex(q, cols, n);

  let view;
  if (q.mode === "agg" && (q.groupBy.length || q.metrics.length)) {
    const outCols = kept ? kept.outCols.map((c) => Object.assign({}, c, { rows: c.rows.slice() })) : aggregate(q, cols, index, n);
    let count = outCols.length ? outCols[0].rows.length : 0;
    const order = aggSort(q, cols, outCols);
    if (order) {
      const idx = new Int32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      idx.sort(buildComparator(order, outCols));
      for (const c of outCols) { const src = c.rows; c.rows = new Array(count); for (let i = 0; i < count; i++) c.rows[i] = src[idx[i]]; }
    }
    if (q.limit != null && q.limit < count) { count = q.limit; for (const c of outCols) c.rows.length = count; }
    view = { cols: outCols, index: null, count, agg: true, label: "grouped" };
  } else {
    const outCols = q.select.length ? q.select.map((ci) => cols[ci]).filter(Boolean) : displayCols(cols);
    if (q.sort.length) {
      if (!index) { index = new Int32Array(n); for (let i = 0; i < n; i++) index[i] = i; }
      index.sort(buildComparator(q.sort, cols));
    }
    let count = index ? index.length : n;
    if (q.limit != null && q.limit < count) {
      count = q.limit;
      if (index) index = index.subarray(0, count);
    }
    view = { cols: outCols, index, count, agg: false,
      label: !index ? (count < n ? "limited" : null) : orGroups(q.filters, cols).length ? "filtered" : "sorted" };
  }
  q.active = true;
  const ms = Math.round(performance.now() - t0);
  setView(view);
  const skipped = q.filters.filter((f) => filterIssue(f, cols)).length;
  /* a partial answer says how partial: "from 250,000 read" hides that the file has ten million */
  const ofTotal = table.scan ? table.scan.rows : table.dataset.numRows;
  const scan = kept ? kept.plan : table.scan;
  const partial = !kept && table.truncated;
  $("qstat").innerHTML = "<b>" + num(view.count) + "</b> " + (view.agg ? "groups" : "rows") +
    " from " + (table.topk ? "the top of " + num(table.topk.seen) + " matching rows" : partial ? "the first " + num(n) + " of " + num(ofTotal) + " rows" : num(n)) + " &middot; " + (kept ? kept.ms : ms) + " ms" +
    (skipped ? " &middot; <em class='qwarn'>" + skipped + " clause" + (skipped === 1 ? "" : "s") +
      " skipped</em>" : "") +
    (scan ? " &middot; over " + num(scan.kept) + " of " + num(scan.total) +
      " row groups" : "");
  $("qclear").disabled = false;
  describeScope();
}
/* ---- the top rows of the whole file, without holding the file ---- */
/**
 * A bounded ranking: the K best rows seen so far by the query's ORDER BY, each kept as just its sort values and
 * where it came from (part, row group, row number). Memory is K rows of the sort columns, however many rows go by.
 */
export function newTopK(q, k) {
  const sortCis = [...new Set(q.sort.map((s) => s.ci))];
  return { q, k, sortCis, best: sortCis.map(() => []), part: [], group: [], row: [], seen: 0 };
}
/** The row-group row number of each row of a batch that was read through `sel` ranges (null: the whole group, so the same). */
function rowNumbers(sel, n) {
  if (!sel) return null;
  const out = new Int32Array(n);
  let at = 0;
  for (const [a, b] of sel) for (let r = a; r < b && at < n; r++) out[at++] = r;
  return out;
}
/** Folds one row group's sort and WHERE columns into the ranking: rows that cannot beat the current K-th are never copied. */
export function feedTopK(t, cols, n, pi, gi, sel) {
  const q = t.q, index = matchIndex(q, cols, n);
  const total = index ? index.length : n;
  t.seen += total;
  if (!total) return;
  const nb = t.row.length, at = rowNumbers(sel, n);
  const comb = cols.map(() => null);
  t.sortCis.forEach((ci, s) => {
    const src = cols[ci].rows, rows = t.best[s].slice();
    for (let i = 0; i < total; i++) rows.push(src[index ? index[i] : i]);
    comb[ci] = { spec: cols[ci].spec, rows };
  });
  const cmp = buildComparator(q.sort, comb);
  const worst = nb >= t.k ? nb - 1 : -1;
  const cand = [];
  for (let i = 0; i < nb; i++) cand.push(i);
  for (let i = nb; i < nb + total; i++) if (worst < 0 || cmp(worst, i) > 0) cand.push(i);
  cand.sort(cmp);
  const keep = cand.slice(0, t.k);
  t.best = t.sortCis.map((ci) => keep.map((i) => comb[ci].rows[i]));
  const part = [], group = [], row = [];
  for (const i of keep) {
    if (i < nb) { part.push(t.part[i]); group.push(t.group[i]); row.push(t.row[i]); continue; }
    const r = index ? index[i - nb] : i - nb;
    part.push(pi); group.push(gi); row.push(at ? at[r] : r);
  }
  t.part = part; t.group = group; t.row = row;
}
/** Where the kept rows live, as the per-row-group ranges a table can be read through. */
export function topKPlan(t) {
  const by = new Map();
  for (let i = 0; i < t.row.length; i++) {
    const key = t.part[i] + ":" + t.group[i];
    const list = by.get(key) || [];
    if (!list.length) by.set(key, list);
    list.push(t.row[i]);
  }
  const plan = new Map();
  for (const [key, rows] of [...by].sort((a, b) => { const [pa, ga] = a[0].split(":"), [pb, gb] = b[0].split(":"); return pa - pb || ga - gb; })) {
    rows.sort((a, b) => a - b);
    const ranges = [];
    for (const r of rows) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === r) last[1] = r + 1; else ranges.push([r, r + 1]);
    }
    plan.set(key, ranges);
  }
  return plan;
}
/** What a ranking of K rows costs to hold, in bytes: its sort values and where each row came from. */
export const topKBytes = (k, sortCols) => k * (sortCols * 16 + 40);

/** Which output column a sort clause means in aggregate mode, or -1. */
export function aggSortIndex(q, s) {
  if (q.groupMode === "PIVOT" && q.groupBy.length >= 1) {
    /* a pivoted column's values became new output columns, and a metric
       fans out across all of them, so only the row dimensions that are
       still plain output columns can be ordered on */
    if (s.mid) return -1;
    return q.groupBy.slice(0, -1).indexOf(s.ci);
  }
  if (s.mid) {
    const m = q.metrics.findIndex((x) => x.id === s.mid);
    return m >= 0 ? q.groupBy.length + m : -1;
  }
  const g = q.groupBy.indexOf(s.ci);
  if (g >= 0) return g;
  const m = q.metrics.findIndex((x) => x.ci === s.ci);
  return m >= 0 ? q.groupBy.length + m : -1;
}
/** In aggregate mode, ORDER BY can only mean one of the output columns. */
export function aggSort(q, _cols, outCols) {
  const order = [];
  for (const s of q.sort) {
    const at = aggSortIndex(q, s);
    if (at >= 0 && at < outCols.length) order.push({ ci: at, dir: s.dir });
  }
  return order.length ? order : null;
}
/**
 * Clicking a column header edits the query's ORDER BY, so the header arrows,
 * the ORDER BY zone and the SQL never disagree about how the rows are sorted.
 * Shift-click adds a key instead of replacing.
 */
export function toggleSort(viewIdx, additive, rerun) {
  const view = state.view, q = state.query, table = state.table;
  if (!view || !table) return;
  const col = view.cols[viewIdx];
  if (!col) return;
  let ci = table.cols.indexOf(col), mid = null;
  if (ci < 0 && view.agg) {
    if (viewIdx < q.groupBy.length) ci = q.groupBy[viewIdx];
    else {
      const m = q.metrics[viewIdx - q.groupBy.length];
      if (m) { ci = m.ci; mid = m.id; }
    }
  }
  if (ci < 0) return;
  const same = (s) => (mid ? s.mid === mid : !s.mid && s.ci === ci);
  const at = q.sort.findIndex(same);
  const fresh = () => ({ id: nextQid("s"), ci, dir: "ASC", mid });
  if (!additive) {
    if (at < 0) q.sort = [fresh()];
    else if (q.sort[at].dir === "ASC") q.sort = [Object.assign(q.sort[at], { dir: "DESC" })];
    else q.sort = [];
  } else if (at < 0) q.sort.push(fresh());
  else if (q.sort[at].dir === "ASC") q.sort[at].dir = "DESC";
  else q.sort.splice(at, 1);
  renderQuery();
  (rerun || runQuery)();
}
/**
 * Drags a header to a new position among the columns on screen. SELECT is
 * implicit ("*", in display order) until this runs; the first drag makes it
 * explicit, naming every column currently shown, in the order dragged to --
 * from then on the picker's hide/pin no longer applies, the same as typing
 * a column list into the SQL box would.
 */
export function reorderColumns(fromCi, toCi, after) {
  const view = state.view, q = state.query, table = state.table;
  if (!view || !table || view.agg || fromCi === toCi) return;
  if (state.sqlDirty && !adoptSql(false)) return;
  const order = q.select.length ? q.select.slice() : view.cols.map((c) => table.cols.indexOf(c));
  const from = order.indexOf(fromCi);
  if (from < 0) return;
  order.splice(from, 1);
  const at = order.indexOf(toCi);
  order.splice(at < 0 ? order.length : at + (after ? 1 : 0), 0, fromCi);
  q.select = order;
  renderQuery();
  runQuery();
}
/* the clauses a scope may replace: each one admits a single unbroken range
   of this column's values, so a range drawn from inside the current result
   already satisfies it and it can go */
const RANGE_PREDS = { eq: 1, between: 1, lt: 1, le: 1, gt: 1, ge: 1 };
/**
 * Narrows a WHERE list to `clause` as well. With only ANDs it is appended,
 * and any range clause on the same column is dropped rather than stacked,
 * since the new one came from rows that already passed it. With ORs it
 * has to hold in every branch, so a copy goes at the end of each OR group
 * -- AND binds tighter, and one appended to the end would narrow only the
 * last. A group with nothing runnable in it yet gets no copy: that group
 * is skipped today, and a lone scope clause would bring it to life.
 */
export function scopeFilters(filters, clause, cols) {
  const fresh = () => Object.assign({}, clause, { id: nextQid("f"), linker: "AND" });
  if (!filters.some((f, i) => i > 0 && f.linker === "OR")) {
    const kept = filters.filter((f) => !(f.ci === clause.ci && RANGE_PREDS[f.pred] && !filterIssue(f, cols)));
    return kept.concat(fresh());
  }
  const out = [];
  let live = false;
  const close = () => { if (live) out.push(fresh()); live = false; };
  filters.forEach((f, i) => {
    if (i > 0 && f.linker === "OR") close();
    out.push(f);
    if (!filterIssue(f, cols)) live = true;
  });
  close();
  return out;
}
/**
 * A click on a summary bar scopes the result to what that bar counted: a
 * histogram bin to the smallest and largest value that fell in it, a
 * top-values bar to that value, a true/false/null segment to that. `pick`
 * is the bar's dataset: one of bin, top or bool. It goes in as an ordinary WHERE clause, so
 * the zones, the SQL and the grid all move together, and taking it back
 * out is the same × as any other filter.
 */
export function scopeToBar(viewIdx, pick) {
  const view = state.view, table = state.table, q = state.query;
  if (!view || !table || !q || view.agg) return;
  const col = view.cols[viewIdx];
  const ci = table.cols.indexOf(col);
  if (!col || ci < 0) return;
  let clause = null;
  if (pick.bin != null) {
    const b = binBounds(col, view.index, view.count, +pick.bin);
    if (!b) return;
    const lo = fmtValue(b.lo, col.spec), hi = fmtValue(b.hi, col.spec);
    clause = lo === hi ? { ci, pred: "eq", value: lo, valueTo: "" } : { ci, pred: "between", value: lo, valueTo: hi };
  } else if (pick.bool != null) {
    clause = pick.bool === "null" ? { ci, pred: "null", value: "", valueTo: "" }
      : { ci, pred: "eq", value: pick.bool, valueTo: "" };
  } else if (pick.top != null) {
    const top = col.summary && col.summary.top && col.summary.top[+pick.top];
    /* an empty string is how a clause says "no value yet", so '' cannot be one */
    if (!top || top[0] === "") return;
    clause = { ci, pred: "eq", value: top[0], valueTo: "" };
  } else return;
  /* SQL being typed is adopted first, as Run would; if it does not parse,
     the click is refused rather than overwriting it */
  if (state.sqlDirty && !adoptSql(false)) return;
  q.filters = scopeFilters(q.filters, clause, table.cols);
  renderQuery();
  runQuery();
}
/** The arrow a header shows: direction, plus its place when there are several. */
export function sortMark(viewIdx) {
  const view = state.view, q = state.query, table = state.table;
  if (!view || !q || !q.sort.length) return "";
  const col = view.cols[viewIdx];
  let at = -1;
  if (view.agg) {
    at = q.sort.findIndex((s) => aggSortIndex(q, s) === viewIdx);
  } else {
    const ci = table.cols.indexOf(col);
    at = ci < 0 ? -1 : q.sort.findIndex((s) => !s.mid && s.ci === ci);
  }
  if (at < 0) return "";
  return "<span class='sortmark'>" + (q.sort[at].dir === "ASC" ? "▲" : "▼") +
    (q.sort.length > 1 ? "<i>" + (at + 1) + "</i>" : "") + "</span>";
}

export function resetQuery() {
  state.agg = null;
  const mode = state.query ? state.query.mode : "rows";
  const scanned = !!(state.table && state.table.scan);
  state.query = newQuery();
  state.query.mode = mode;
  $("qstat").textContent = "";
  $("qclear").disabled = true;
  showPlan("");
  if (scanned) unscan();
  else if (state.table) setView(baseView(state.table));
  renderQuery();
}

export function sqlIdent(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"';
}
export function sqlLiteral(text, spec) {
  if (spec.kind === "number" && isFinite(parseFloat(text))) return String(parseFloat(text));
  if (spec.kind === "bool") return /^(true|t|1|y|yes)$/i.test(String(text).trim()) ? "TRUE" : "FALSE";
  return "'" + String(text).replace(/'/g, "''") + "'";
}
/** A file name as a table name: "orders.parquet" reads as orders. */
/** Normalizes a JOIN description so the written and the read-back form of
    the same join compare equal, whatever the spacing, case or quoting. */
export function joinClauseText(text) {
  return String(text).replace(/["]/g, "").replace(/\s*([.=])\s*/g, "$1")
    .replace(/\s+/g, " ").trim().toUpperCase();
}

export function sqlTableName(name) {
  return String(name || "parquet").replace(/\.[^.]*$/, "");
}

/**
 * The FROM clause. A joined table is the one case with more than one file
 * behind it, and it says so -- both names and the key each side -- rather
 * than inventing a single table that nothing on disk corresponds to. The
 * left-hand key is unqualified because it belongs to the table built so
 * far (which after a chain is not any one file), and B's key column is
 * dropped from the result, so it is qualified to stay unambiguous.
 */
export function sqlFromLines(table) {
  const src = state.src ? state.src.name : "";
  const lines = ["FROM " + sqlIdent(sqlTableName(table.joinFrom || src || "parquet"))];
  for (const step of table.joinSteps || []) {
    const b = sqlIdent(sqlTableName(step.table));
    lines.push("INNER JOIN " + b + " ON " + sqlIdent(step.aCol) + " = " + b + "." + sqlIdent(step.bCol));
  }
  return lines;
}

export function querySql() {
  const q = state.query, table = state.table;
  if (!table) return "";
  const cols = table.cols;
  const lines = [];
  if (q.mode === "agg" && (q.groupBy.length || q.metrics.length)) {
    const sel = q.groupBy.map((ci) => sqlIdent(cols[ci].name));
    for (const m of q.metrics) {
      if (!cols[m.ci]) continue;
      const inner = sqlIdent(cols[m.ci].name);
      const fn = aggSqlExpr(m.agg, inner);
      sel.push(m.alias ? fn + " AS " + sqlIdent(m.alias) : fn);
    }
    lines.push("SELECT " + (sel.length ? sel.join(",\n       ") : "*"));
  } else if (q.select.length) {
    lines.push("SELECT " + q.select.map((ci) => sqlIdent(cols[ci].name)).join(",\n       "));
  } else {
    lines.push("SELECT *");
  }
  for (const line of sqlFromLines(table)) lines.push(line);
  let pending = false;
  q.filters.forEach((f, i) => {
    const col = cols[f.ci];
    if (!col) return;
    const p = PREDS.find((x) => x.id === f.pred) || PREDS[0];
    let clause;
    if (NO_OPERAND[f.pred]) clause = sqlIdent(col.name) + " " + p.sql;
    else if (filterIssue(f, cols)) {
      /* no usable value yet: shown so the shape is visible, but not run */
      clause = sqlIdent(col.name) + " " + p.sql + " ?";
      pending = true;
    } else if (f.pred === "between") {
      clause = sqlIdent(col.name) + " BETWEEN " + sqlLiteral(f.value, col.spec) +
        " AND " + sqlLiteral(f.valueTo == null ? f.value : f.valueTo, col.spec);
    } else if (f.pred === "like") clause = sqlIdent(col.name) + " LIKE '%" + String(f.value).replace(/'/g, "''") + "%'";
    else clause = sqlIdent(col.name) + " " + p.sql + " " + sqlLiteral(f.value, col.spec);
    lines.push((i === 0 ? "WHERE " : "  " + (f.linker || "AND") + " ") + clause);
  });
  if (q.mode === "agg" && q.groupBy.length) {
    const gnames = q.groupBy.map((ci) => sqlIdent(cols[ci].name)).join(", ");
    lines.push("GROUP BY " + (q.groupMode ? q.groupMode + "(" + gnames + ")" : gnames));
  }
  const agg = q.mode === "agg" && (q.groupBy.length || q.metrics.length);
  const order = [];
  for (const st of q.sort) {
    const col = cols[st.ci];
    if (!col) continue;
    if (!agg) { order.push(sqlIdent(col.name) + " " + st.dir); continue; }
    /* an aggregate can only be ordered by something it actually selects */
    if (!st.mid && q.groupBy.indexOf(st.ci) >= 0) { order.push(sqlIdent(col.name) + " " + st.dir); continue; }
    const m = st.mid ? q.metrics.find((x) => x.id === st.mid) : q.metrics.find((x) => x.ci === st.ci);
    if (m) {
      const inner = sqlIdent(col.name);
      order.push((m.alias ? sqlIdent(m.alias) : aggSqlExpr(m.agg, inner)) + " " + st.dir);
    }
  }
  if (order.length) lines.push("ORDER BY " + order.join(", "));
  if (q.limit != null) lines.push("LIMIT " + q.limit);
  return lines.join("\n") + ";" +
    (pending ? "\n\n-- clauses shown with ? are skipped: no value, or it does not\n" +
      "-- parse as this column's type" : "");
}


export const SQL_KEYWORDS = {
  SELECT: 1, FROM: 1, WHERE: 1, GROUP: 1, ORDER: 1, BY: 1, LIMIT: 1, AND: 1, OR: 1, NOT: 1,
  IS: 1, NULL: 1, LIKE: 1, BETWEEN: 1, AS: 1, ASC: 1, DESC: 1, DISTINCT: 1, TRUE: 1, FALSE: 1,
  HAVING: 1, JOIN: 1, UNION: 1, OFFSET: 1, INNER: 1, LEFT: 1, RIGHT: 1, FULL: 1, OUTER: 1,
  CROSS: 1, ON: 1, CASE: 1, WHEN: 1, WITH: 1, INTO: 1, VALUES: 1, INSERT: 1, UPDATE: 1, DELETE: 1,
};
export const SQL_SCAN = /\s+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9$]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|<=|>=|<>|!=|[(),.*<>=;]|\S/g;

export function sqlTokenize(text) {
  const out = [];
  SQL_SCAN.lastIndex = 0;
  for (let m = SQL_SCAN.exec(text); m; m = SQL_SCAN.exec(text)) {
    const raw = m[0], at = m.index;
    const c = raw[0];
    if (/\s/.test(c) || raw.startsWith("--") || raw.startsWith("/*")) continue;
    if (c === "'") { out.push({ t: "str", v: raw.slice(1, -1).replace(/''/g, "'"), at, raw }); continue; }
    if (c === '"') { out.push({ t: "name", v: raw.slice(1, -1).replace(/""/g, '"'), at, raw, quoted: true }); continue; }
    if (/[0-9]/.test(c)) { out.push({ t: "num", v: parseFloat(raw), at, raw }); continue; }
    if (/[A-Za-z_]/.test(c)) {
      const up = raw.toUpperCase();
      out.push(SQL_KEYWORDS[up] ? { t: "kw", v: up, at, raw } : { t: "name", v: raw, at, raw });
      continue;
    }
    out.push({ t: "op", v: raw, at, raw });
  }
  out.push({ t: "end", v: "", at: text.length, raw: "" });
  return out;
}

/* A composite metric is more than one SQL call, so it is read back by
   matching the very template the writer printed from, token for token. */
const COMPOSITE_TOKS = {};
export function compositeToks(kind) {
  let t = COMPOSITE_TOKS[kind];
  if (!t) { t = sqlTokenize(AGG_COMPOSITE[kind]).slice(0, -1); COMPOSITE_TOKS[kind] = t; }
  return t;
}

/** Cheap edit distance, only used to suggest a column the user meant. */
export function nearestName(name, names) {
  const a = name.toLowerCase();
  let best = null, bestScore = Infinity;
  for (const n of names) {
    const b = n.toLowerCase();
    if (Math.abs(a.length - b.length) > 3) continue;
    const d = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) d[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = t;
      }
    }
    if (d[b.length] < bestScore) { bestScore = d[b.length]; best = n; }
  }
  return bestScore <= Math.max(2, Math.ceil(name.length / 3)) ? best : null;
}

export const OP_PRED = { "=": "eq", "<>": "ne", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };

/**
 * Parses SQL into the builder's own shape.
 * Returns { query, errors, warnings }; query is null when it cannot be held.
 */
export function parseSql(text, cols) {
  const toks = sqlTokenize(text);
  const errors = [], warnings = [];
  let p = 0;
  const at = (t) => (t ? t.at : text.length);
  const fail = (msg, tok) => { errors.push({ msg, at: at(tok || toks[p]) }); };
  /* p can run past the end when a clause is cut short, so every read clamps */
  const tokAt = (i) => toks[Math.min(i, toks.length - 1)];
  const peek = () => tokAt(p);
  const isKw = (w) => peek().t === "kw" && peek().v === w;
  const isOp = (w) => peek().t === "op" && peek().v === w;
  const step = () => { if (p < toks.length - 1) p++; };
  const eatKw = (w) => (isKw(w) ? (step(), true) : false);
  const eatOp = (w) => (isOp(w) ? (step(), true) : false);
  const names = cols.map((c) => c.name);

  const resolve = (tok) => {
    const name = tok.v;
    const i = names.indexOf(name);
    if (i >= 0) return i;
    const lower = name.toLowerCase();
    const hits = [];
    for (let k = 0; k < names.length; k++) if (names[k].toLowerCase() === lower) hits.push(k);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) { fail('"' + name + '" matches more than one column; quote the exact name', tok); return -1; }
    const near = nearestName(name, names);
    fail('no column named "' + name + '"' + (near ? ' — did you mean "' + near + '"?' : ""), tok);
    return -1;
  };

  /* resolve() reports what it cannot find; matching a template has to be
     able to fail without saying anything, because the next template may fit */
  const lookup = (tok) => {
    if (tok.t !== "name") return -1;
    const i = names.indexOf(tok.v);
    if (i >= 0) return i;
    const lower = tok.v.toLowerCase();
    let hit = -1, seen = 0;
    for (let k = 0; k < names.length; k++) if (names[k].toLowerCase() === lower) { hit = k; seen++; }
    return seen === 1 ? hit : -1;
  };
  /** The composite metric starting here, consumed, or null and nothing moved. */
  const matchComposite = () => {
    for (const kind of Object.keys(AGG_COMPOSITE)) {
      const tpl = compositeToks(kind);
      let i = p, ci = -1, ok = true;
      for (const want of tpl) {
        const got = tokAt(i);
        if (want.t === "op" && want.v === "#") {        /* the column, the same one each time */
          const at = lookup(got);
          if (at < 0 || (ci >= 0 && at !== ci)) { ok = false; break; }
          ci = at;
        } else if (got.t !== want.t || String(got.v).toUpperCase() !== String(want.v).toUpperCase()) {
          ok = false;
          break;
        }
        i++;
      }
      if (ok && ci >= 0) { const tok = peek(); p = i; return { kind, ci, tok }; }
    }
    return null;
  };
  const eatAlias = () => {
    if (eatKw("AS")) {
      if (peek().t === "name") return (step(), tokAt(p - 1)).v;
      fail("expected a name after AS");
      return "";
    }
    return peek().t === "name" ? (step(), tokAt(p - 1)).v : "";
  };

  const q = { active: false, mode: "rows", select: [], filters: [], sort: [], groupBy: [], groupMode: "", metrics: [], limit: null };
  let starSelect = false;
  const selectAggs = [];      /* {ci, agg, alias, tok} */
  const selectPlain = [];     /* {ci, tok} */

  if (!eatKw("SELECT")) { fail("expected SELECT"); return { query: null, errors, warnings }; }
  if (isKw("DISTINCT")) { fail("SELECT DISTINCT is not supported; use GROUP BY instead"); p++; }
  for (;;) {
    if (eatOp("*")) { starSelect = true; }
    else if (peek().t === "kw" && AGG_BY_NAME[peek().v]) { fail("unexpected keyword " + peek().v); p++; }
    else if (peek().t === "name" && tokAt(p + 1) && tokAt(p + 1).t === "op" && tokAt(p + 1).v === "(") {
      const comp = matchComposite();
      if (comp) selectAggs.push({ ci: comp.ci, agg: comp.kind, alias: eatAlias(), tok: comp.tok });
      else {
        const fnTok = peek();
        const fn = fnTok.v.toUpperCase();
        step(); step();
        let agg = null;
        if (fn === "COUNT" && isKw("DISTINCT")) { p++; agg = "COUNT_DISTINCT"; }
        else if (AGG_BY_NAME[fn]) agg = AGG_BY_NAME[fn];
        else fail(fn + "() is not one of COUNT, SUM, AVG, MIN, MAX, MEDIAN, MODE, STDDEV_SAMP/POP, VAR_SAMP or QUANTILE_CONT", fnTok);
        let ci = -1;
        if (eatOp("*")) {
          if (agg !== "COUNT") fail("only COUNT(*) may take a star", fnTok);
          ci = 0;                                      /* COUNT(*) counts rows */
        } else if (peek().t === "name") ci = resolve((step(), tokAt(p - 1)));
        else fail("expected a column inside " + fn + "()");
        if (!eatOp(")")) fail("expected )");
        const alias = eatAlias();
        if (agg && ci >= 0) selectAggs.push({ ci, agg, alias, tok: fnTok });
      }
    } else if (peek().t === "name") {
      const tok = (step(), tokAt(p - 1));
      const ci = resolve(tok);
      if (eatKw("AS") || peek().t === "name") {
        fail("a plain column cannot be renamed here; only aggregates take an alias", tok);
        if (peek().t === "name") p++;
      }
      if (ci >= 0) selectPlain.push({ ci, tok });
    } else { fail("expected a column, * or an aggregate"); break; }
    if (!eatOp(",")) break;
  }

  if (eatKw("FROM")) {
    const fromTok = peek();
    if (peek().t === "name") p++;
    else fail("expected a table name after FROM");
    if (isOp(",") || isKw("JOIN") || isKw("INNER") || isKw("LEFT") || isKw("RIGHT") ||
        isKw("FULL") || isKw("CROSS")) {
      /* a join is run in the Join panel, not from here: the clause the
         builder writes describes the one already applied, so it is read
         back and checked rather than acted on. Anything else is refused
         by name, the way an unrepresentable WHERE is */
      let applied = null;
      if (state.table) applied = state.table.joinSteps ? state.table : null;
      if (!applied) fail("one file at a time: joins are set up in the Join panel, not here");
      else {
        const want = joinClauseText(sqlFromLines(applied).slice(1).join(" "));
        const got = [];
        while (isKw("INNER") || isKw("JOIN") || isKw("ON") || isOp(".") || isOp("=") ||
               peek().t === "name") {
          got.push(peek().t === "kw" ? peek().v : String(peek().v));
          step();
        }
        if (joinClauseText(got.join(" ")) !== want) {
          fail("that is not the join this table came from. It is " +
            sqlFromLines(applied).join(" ") +
            " — set in the Join panel, which is also where it can be changed.", fromTok);
        }
      }
    }
  } else fail("expected FROM");

  const parsePredicate = () => {
    const colTok = peek();
    if (colTok.t !== "name") { fail("expected a column name in WHERE", colTok); p++; return null; }
    step();
    const ci = resolve(colTok);
    if (isKw("IS")) {
      step();
      const not = eatKw("NOT");
      if (!eatKw("NULL")) { fail("expected NULL after IS"); return null; }
      return { ci, pred: not ? "notnull" : "null", value: "", linker: "AND" };
    }
    if (isKw("NOT") && tokAt(p + 1) && tokAt(p + 1).t === "kw" &&
        (tokAt(p + 1).v === "LIKE" || tokAt(p + 1).v === "BETWEEN")) {
      fail("NOT " + tokAt(p + 1).v + " cannot be held by the builder");
      return null;
    }
    if (eatKw("LIKE")) {
      const t = peek();
      if (t.t !== "str") { fail("LIKE needs a quoted pattern", t); return null; }
      step();
      let v = t.v;
      const wrapped = v.startsWith("%") && v.endsWith("%") && v.length >= 2;
      v = v.replace(/^%/, "").replace(/%$/, "");
      if (!wrapped) warnings.push({ msg: "LIKE is matched as 'contains', so the pattern is treated as %" + v + "%", at: at(t) });
      if (v.indexOf("%") >= 0 || v.indexOf("_") >= 0) {
        warnings.push({ msg: "wildcards inside a LIKE pattern are matched literally", at: at(t) });
      }
      return { ci, pred: "like", value: v, linker: "AND" };
    }
    if (eatKw("BETWEEN")) {
      const lo = literal();
      if (!eatKw("AND")) { fail("expected AND in BETWEEN"); return null; }
      const hi = literal();
      if (lo === null || hi === null) return null;
      return { ci, pred: "between", value: lo, valueTo: hi, linker: "AND" };
    }
    const opTok = peek();
    if (opTok.t === "op" && OP_PRED[opTok.v]) {
      step();
      const v = literal();
      if (v === null) return null;
      return { ci, pred: OP_PRED[opTok.v], value: v, linker: "AND" };
    }
    fail("expected a comparison after " + colTok.v, opTok);
    return null;
  };
  function literal() {
    const t = peek();
    if (t.t === "str") { p++; return t.v; }
    if (t.t === "num") { p++; return t.raw; }
    if (t.t === "kw" && (t.v === "TRUE" || t.v === "FALSE")) { p++; return t.v.toLowerCase(); }
    if (t.t === "op" && (t.v === "-" || t.v === "+") && tokAt(p + 1) && tokAt(p + 1).t === "num") {
      step(); step();
      return (t.v === "-" ? "-" : "") + toks[p - 1].raw;
    }
    if (t.t === "kw" && t.v === "NULL") { fail("compare with IS NULL rather than = NULL", t); p++; return null; }
    fail("expected a value", t);
    step();
    return null;
  }
  /* boolean expression -> OR of ANDs, which is exactly what the zones hold */
  const parseAnd = () => {
    const items = [];
    for (;;) {
      if (isKw("NOT")) { fail("NOT cannot be held by the builder"); p++; }
      let pred;
      if (eatOp("(")) {
        const inner = parseOr();
        if (!eatOp(")")) fail("expected )");
        if (inner && inner.length === 1) pred = inner[0].length === 1 ? inner[0][0] : { group: inner[0] };
        else if (inner) { return { nested: inner, items }; }
        else pred = null;
      } else pred = parsePredicate();
      if (pred && pred.group) for (const x of pred.group) items.push(x);
      else if (pred) items.push(pred);
      if (!eatKw("AND")) break;
    }
    return { items };
  };
  const parseOr = () => {
    const groups = [];
    for (;;) {
      const and = parseAnd();
      if (and.nested) {
        fail("an OR inside an AND cannot be held: rewrite (a OR b) AND c as (a AND c) OR (b AND c)");
        return null;
      }
      groups.push(and.items);
      if (!eatKw("OR")) break;
    }
    return groups;
  };
  if (eatKw("WHERE")) {
    const groups = parseOr();
    if (groups) {
      groups.forEach((g, gi) => {
        g.forEach((f, fi) => {
          f.id = nextQid("f");
          f.linker = fi === 0 && gi > 0 ? "OR" : "AND";
          q.filters.push(f);
        });
      });
    }
  }

  if (isKw("GROUP")) {
    step();
    if (!eatKw("BY")) fail("expected BY after GROUP");
    const gfnTok = peek();
    const gfn = gfnTok.t === "name" ? gfnTok.v.toUpperCase() : "";
    const wrapped = (gfn === "ROLLUP" || gfn === "CUBE" || gfn === "PIVOT") &&
      tokAt(p + 1) && tokAt(p + 1).t === "op" && tokAt(p + 1).v === "(";
    if (wrapped) { q.groupMode = gfn; step(); step(); }
    for (;;) {
      const t = peek();
      if (t.t !== "name") { fail("expected a column in GROUP BY", t); break; }
      step();
      const ci = resolve(t);
      if (ci >= 0 && q.groupBy.indexOf(ci) < 0) q.groupBy.push(ci);
      if (!eatOp(",")) break;
    }
    if (wrapped && !eatOp(")")) fail("expected ) to close " + gfn + "(...)");
  }
  if (isKw("HAVING")) fail("HAVING is not supported; filter before grouping with WHERE");

  const agg = selectAggs.length > 0 || q.groupBy.length > 0;
  if (agg) {
    q.mode = "agg";
    q.metrics = selectAggs.map((m) => ({ id: nextQid("m"), ci: m.ci, agg: m.agg, alias: m.alias }));
    if (starSelect) fail("SELECT * cannot be mixed with grouping; list the columns");
    for (const s of selectPlain) {
      if (q.groupBy.indexOf(s.ci) < 0) {
        fail('"' + cols[s.ci].name + '" is selected but not grouped; add it to GROUP BY or aggregate it', s.tok);
      }
    }
    for (const g of q.groupBy) {
      if (!selectPlain.some((s) => s.ci === g)) {
        warnings.push({ msg: '"' + cols[g].name + '" is grouped, so it is selected too', at: 0 });
      }
    }
  } else {
    q.mode = "rows";
    q.select = starSelect ? [] : selectPlain.map((s) => s.ci);
  }

  if (isKw("ORDER")) {
    step();
    if (!eatKw("BY")) fail("expected BY after ORDER");
    for (;;) {
      const t = peek();
      let entry = null;
      if (t.t === "name" && tokAt(p + 1) && tokAt(p + 1).t === "op" && tokAt(p + 1).v === "(") {
        /* ORDER BY COUNT(x) — match it to the metric that produces it */
        const fnTok = toks[p];
        const comp = matchComposite();
        let kind = null, ci = -1, shown = "";
        if (comp) { kind = comp.kind; ci = comp.ci; shown = AGG_SHORT[kind]; }
        else {
          const fn = fnTok.v.toUpperCase();
          shown = fn + "(...)";
          step(); step();
          const distinct = fn === "COUNT" && isKw("DISTINCT") ? (p++, true) : false;
          kind = distinct ? "COUNT_DISTINCT" : AGG_BY_NAME[fn];
          if (eatOp("*")) ci = 0; else if (peek().t === "name") ci = resolve((step(), tokAt(p - 1)));
          if (!eatOp(")")) fail("expected )");
        }
        const m = q.metrics.find((x) => x.ci === ci && x.agg === kind);
        if (m) entry = { id: nextQid("s"), ci: m.ci, mid: m.id, dir: "ASC" };
        else fail("ORDER BY " + shown + " does not match anything selected", fnTok);
      } else if (t.t === "name") {
        step();
        const alias = q.metrics.find((m) => m.alias && m.alias === t.v);
        if (alias) entry = { id: nextQid("s"), ci: alias.ci, mid: alias.id, dir: "ASC" };
        else {
          const ci = resolve(t);
          if (ci >= 0) {
            if (agg && q.groupBy.indexOf(ci) < 0 && !q.metrics.some((m) => m.ci === ci)) {
              fail('"' + t.v + '" is not selected, so it cannot be ordered by', t);
            } else entry = { id: nextQid("s"), ci, dir: "ASC" };
          }
        }
      } else { fail("expected a column in ORDER BY", t); break; }
      if (eatKw("DESC")) { if (entry) entry.dir = "DESC"; }
      else eatKw("ASC");
      if (entry) q.sort.push(entry);
      if (!eatOp(",")) break;
    }
  }

  if (eatKw("LIMIT")) {
    const t = peek();
    if (t.t === "num" && t.v > 0 && Number.isInteger(t.v)) { q.limit = t.v; p++; }
    else { fail("LIMIT needs a positive whole number", t); p++; }
  }
  if (isKw("OFFSET")) fail("OFFSET is not supported; use the pager");
  if (isKw("UNION")) fail("UNION is not supported");
  eatOp(";");
  /* only worth saying when nothing more specific has already been said */
  if (peek().t !== "end" && !errors.length) fail("unexpected " + (peek().raw || "input"), peek());

  for (const f of q.filters) {
    const issue = filterIssue(f, cols);
    if (issue === "invalid") {
      const col = cols[f.ci];
      errors.push({ msg: '"' + f.value + '" is not a ' + col.spec.label + " value for " + col.name, at: 0 });
    }
  }
  for (const m of q.metrics) {
    const col = cols[m.ci];
    if (AGG_NUMERIC[m.agg] && col && col.spec.kind !== "number") {
      warnings.push({ msg: m.agg + "(" + col.name + ") over a " + col.spec.label + " column yields nothing", at: 0 });
    }
  }
  return { query: errors.length ? null : q, errors, warnings };
}
