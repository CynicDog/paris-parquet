import { $ } from "./columns.js";
import { showPlan, unscan, updateScanButton } from "./pushdown.js";
import { fmtValue, lessThan, numeric } from "./types.js";
import { renderQuery } from "./ui-query-builder.js";
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
export const AGGS = ["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"];
export const AGG_SHORT = { COUNT: "COUNT", COUNT_DISTINCT: "CNTD", SUM: "SUM", AVG: "AVG", MIN: "MIN", MAX: "MAX" };
export const AGG_BY_NAME = { COUNT: "COUNT", SUM: "SUM", AVG: "AVG", MIN: "MIN", MAX: "MAX" };
let qid = 0;
/** Ids for the builder's own chips: unique per page load, nothing more. */
export function nextQid(prefix) {
  qid++;
  return prefix + qid;
}

export function newQuery() {
  return { active: false, mode: "rows", select: [], filters: [], sort: [], groupBy: [], groupMode: "", metrics: [], limit: null };
}

/* -------------------------------------------------------- value parsing */
export function parseTemporal(text, spec) {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);          /* raw epoch millis */
  if (spec.sub === "time") {
    const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
    if (!m) return NaN;
    return ((+m[1] * 60 + +m[2]) * 60 + (+m[3] || 0)) * 1000 + (m[4] ? +(m[4] + "000").slice(0, 3) : 0);
  }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?Z?$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0),
    m[7] ? +(m[7] + "000").slice(0, 3) : 0);
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

/* ------------------------------------------------------------- filtering */
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

/* ------------------------------------------------------------ aggregates */
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

export function scanGroups(gRows, mRows, mKeys, mSpecs, metrics, positions, index, n) {
  const groups = new Map();
  const total = index ? index.length : n;
  for (let i = 0; i < total; i++) {
    const r = index ? index[i] : i;
    let key = "";
    for (const g of positions) key += keyPart(gRows[g][r]) + "\u0001";
    let acc = groups.get(key);
    if (!acc) {
      acc = { row: r, m: metrics.map(() => ({ n: 0, sum: 0, c: 0, min: null, max: null, set: null })) };
      groups.set(key, acc);
    }
    for (let m = 0; m < metrics.length; m++) {
      const v = mRows[m][r];
      if (v === null || v === undefined) continue;
      const a = acc.m[m];
      a.n++;
      const kind = metrics[m].agg;
      if (kind === "SUM" || kind === "AVG") {
        const x = mKeys[m] ? mKeys[m](v) : NaN;
        if (x === x) {
          /* Neumaier summation: adding a million doubles naively drifts, and
             the lost low bits are exactly what a mean is made of */
          const t = a.sum + x;
          a.c += Math.abs(a.sum) >= Math.abs(x) ? (a.sum - t) + x : (x - t) + a.sum;
          a.sum = t;
        }
      }
      else if (kind === "COUNT_DISTINCT") {
        if (!a.set) a.set = new Set();
        a.set.add(keyPart(v));
      }
      else if (kind === "MIN" || kind === "MAX") {
        const cmpLess = mKeys[m]
          ? (x, y) => lessThan(x, y)
          : (x, y) => String(textOf(x, mSpecs[m])) < String(textOf(y, mSpecs[m]));
        if (a.min === null || cmpLess(v, a.min)) a.min = v;
        if (a.max === null || cmpLess(a.max, v)) a.max = v;
      }
    }
  }
  return groups;
}
export function metricValue(m, kind) {
  if (kind === "COUNT") return m.n;
  if (kind === "COUNT_DISTINCT") return m.set ? m.set.size : 0;
  if (kind === "SUM") return m.n ? m.sum + m.c : null;
  if (kind === "AVG") return m.n ? (m.sum + m.c) / m.n : null;
  if (kind === "MIN") return m.min;
  if (kind === "MAX") return m.max;
  return null;
}
export const AGG_COUNT_SPEC = { kind: "number", label: "count", physical: "INT64", convert: (v) => v };
export function metricSpec(m, cols) {
  const src = cols[m.ci];
  const isCount = m.agg === "COUNT" || m.agg === "COUNT_DISTINCT";
  const keeps = m.agg === "MIN" || m.agg === "MAX";
  return isCount ? AGG_COUNT_SPEC : keeps ? src.spec : { kind: "number", label: m.agg.toLowerCase(), physical: src.spec.physical, convert: (v) => v };
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
    const groups = scanGroups(gRows, mRows, mKeys, mSpecs, metrics, positions, index, n);
    for (const acc of groups.values()) {
      let k = 0;
      /* a column this grouping set dropped shows null, the same as SQL's own
         ROLLUP/CUBE -- indistinguishable from a real null there, which is
         the one ambiguity the standard has too */
      for (let g = 0; g < gcis.length; g++) {
        outCols[k++].rows.push(positions.indexOf(g) >= 0 ? cols[gcis[g]].rows[acc.row] : null);
      }
      for (let m = 0; m < metrics.length; m++) outCols[k++].rows.push(metricValue(acc.m[m], metrics[m].agg));
    }
  }
  return outCols;
}

/* ------------------------------------------------------------- pivot */
/* Excel-style reshape: the last GROUP BY column's own distinct values
   become new output columns instead of a row of their own, and every
   other grouped column stays a row dimension. A cell nothing matched is
   null, same as an unfilled cell in a spreadsheet pivot. Past
   PIVOT_MAX_COLS distinct values, the rest fold into one "(other)"
   column rather than being dropped -- every row is still accounted for. */
export const PIVOT_MAX_COLS = 50;
export function mergeAcc(target, acc, metrics, mKeys, mSpecs) {
  for (let mi = 0; mi < metrics.length; mi++) {
    const a = acc.m[mi], o = target[mi], kind = metrics[mi].agg;
    o.n += a.n;
    if (kind === "SUM" || kind === "AVG") {
      const x = a.n ? a.sum + a.c : NaN;
      if (x === x) {
        const t = o.sum + x;
        o.c += Math.abs(o.sum) >= Math.abs(x) ? (o.sum - t) + x : (x - t) + o.sum;
        o.sum = t;
      }
    } else if (kind === "COUNT_DISTINCT") {
      if (a.set) { if (!o.set) o.set = new Set(); for (const v of a.set) o.set.add(v); }
    } else if (kind === "MIN" || kind === "MAX") {
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
      if (!rec.other) rec.other = metrics.map(() => ({ n: 0, sum: 0, c: 0, min: null, max: null, set: null }));
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

/* -------------------------------------------------------------- running */
export function runQuery() {
  const q = state.query, table = state.table;
  if (!table) return;
  /* running is what settles it: an aggregate about to replace the grid does
     not need the columns it is replacing */
  if (needFilled([...neededColumns(table, true)], runQuery)) return;
  const t0 = performance.now();
  const cols = table.cols, n = table.rowsLoaded;

  const groups = orGroups(q.filters, cols);
  let index = null;
  if (groups.length) {
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
    index = buf.slice(0, k);
  }

  let view;
  if (q.mode === "agg" && (q.groupBy.length || q.metrics.length)) {
    const outCols = aggregate(q, cols, index, n);
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
      label: !index ? (count < n ? "limited" : null) : groups.length ? "filtered" : "sorted" };
  }
  q.active = true;
  const ms = Math.round(performance.now() - t0);
  setView(view);
  const skipped = q.filters.filter((f) => filterIssue(f, cols)).length;
  $("qstat").innerHTML = "<b>" + num(view.count) + "</b> " + (view.agg ? "groups" : "rows") +
    " from " + num(n) + (table.truncated ? " read" : "") + " &middot; " + ms + " ms" +
    (skipped ? " &middot; <em class='qwarn'>" + skipped + " clause" + (skipped === 1 ? "" : "s") +
      " skipped</em>" : "") +
    (table.scan ? " &middot; over " + num(table.scan.kept) + " of " + num(table.scan.total) +
      " row groups" : "");
  $("qclear").disabled = false;
  updateScanButton();
}
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
export function toggleSort(viewIdx, additive) {
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

/* ------------------------------------------------------------ SQL text */
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
      const fn = m.agg === "COUNT_DISTINCT" ? "COUNT(DISTINCT " + inner + ")" : m.agg + "(" + inner + ")";
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
      order.push((m.alias ? sqlIdent(m.alias)
        : m.agg === "COUNT_DISTINCT" ? "COUNT(DISTINCT " + inner + ")" : m.agg + "(" + inner + ")") + " " + st.dir);
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
      const fnTok = peek();
      const fn = fnTok.v.toUpperCase();
      step(); step();
      let agg = null;
      if (fn === "COUNT" && isKw("DISTINCT")) { p++; agg = "COUNT_DISTINCT"; }
      else if (AGG_BY_NAME[fn]) agg = AGG_BY_NAME[fn];
      else fail(fn + "() is not one of COUNT, SUM, AVG, MIN, MAX", fnTok);
      let ci = -1;
      if (eatOp("*")) {
        if (agg !== "COUNT") fail("only COUNT(*) may take a star", fnTok);
        ci = 0;                                        /* COUNT(*) counts rows */
      } else if (peek().t === "name") ci = resolve((step(), tokAt(p - 1)));
      else fail("expected a column inside " + fn + "()");
      if (!eatOp(")")) fail("expected )");
      let alias = "";
      if (eatKw("AS")) { if (peek().t === "name") alias = (step(), tokAt(p - 1)).v; else fail("expected a name after AS"); }
      else if (peek().t === "name") alias = (step(), tokAt(p - 1)).v;
      if (agg && ci >= 0) selectAggs.push({ ci, agg, alias, tok: fnTok });
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
        const fn = fnTok.v.toUpperCase();
        step(); step();
        const distinct = fn === "COUNT" && isKw("DISTINCT") ? (p++, true) : false;
        const kind = distinct ? "COUNT_DISTINCT" : AGG_BY_NAME[fn];
        let ci = -1;
        if (eatOp("*")) ci = 0; else if (peek().t === "name") ci = resolve((step(), tokAt(p - 1)));
        if (!eatOp(")")) fail("expected )");
        const m = q.metrics.find((x) => x.ci === ci && x.agg === kind);
        if (m) entry = { id: nextQid("s"), ci: m.ci, mid: m.id, dir: "ASC" };
        else fail("ORDER BY " + fn + "(...) does not match anything selected", fnTok);
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
    if ((m.agg === "SUM" || m.agg === "AVG") && col && col.spec.kind !== "number") {
      warnings.push({ msg: m.agg + "(" + col.name + ") over a " + col.spec.label + " column yields nothing", at: 0 });
    }
  }
  return { query: errors.length ? null : q, errors, warnings };
}

/* ----------------------------------------------------------------- UI */
