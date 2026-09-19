// The Diff panel: compares two datasets (A, the open file, and B, a chosen
// second one) at three levels — file-level shape, schema drift between their
// columns, and per-column statistics — and can match rows up by key to show
// which ones were added, removed, or changed cell by cell.

import { budgetBytes, loadAllBytes, loadAllRefusal, Refusal } from "./budget.js";
import { $, fillColumns, loadMore } from "./columns.js";
import { newTable, readDataset } from "./dataset.js";
import { join, showJoin } from "./join.js";
import { adoptDataset, busy, entriesFromFiles, FIRST_ROWS, showError, updateButtons } from "./main.js";
import { beBigInt, fmtValue, jsonish } from "./types.js";
import { refreshView } from "./ui-grid.js";
import { datasetName, rawStat, renderMeta, showStat } from "./ui-metadata.js";
import { bytesHuman, esc, needFilled, num, renderPager, state } from "./view.js";

export const diff = { on: false, b: null, keys: [], rows: null, cap: 200 };

export function colShape(col) {
  const leaf = col.leaf;
  if (!leaf) return { phys: "PATH", type: col.spec.label, rep: "partition" };
  return {
    phys: leaf.type + (leaf.typeLength ? "(" + leaf.typeLength + ")" : ""),
    type: col.spec.label,
    rep: leaf.maxRep > 0 ? "repeated" : leaf.maxDef > 0 ? "optional" : "required",
  };
}
export const shapeKey = (s) => s.phys + "\u0001" + String(s.type).replace(" (utf-8)", "") + "\u0001" + s.rep;
export const shapeText = (s) => s.phys + " · " + s.type + " · " + s.rep;

/** Columns added, removed, retyped — and the pairs that look like a rename. */
export function schemaDiff(aT, bT) {
  const A = new Map(), B = new Map();
  aT.cols.forEach((col, i) => { A.set(col.key, { col, i, shape: colShape(col) }); });
  bT.cols.forEach((col, i) => { B.set(col.key, { col, i, shape: colShape(col) }); });
  const added = [], removed = [], retyped = [], common = [];
  for (const b of B.values()) if (!A.has(b.col.key)) added.push(b);
  for (const a of A.values()) {
    const b = B.get(a.col.key);
    if (!b) { removed.push(a); continue; }
    common.push({ a, b });
    if (shapeKey(a.shape) !== shapeKey(b.shape)) retyped.push({ a, b });
  }
  /* One column gone and one arrived holding exactly the same shape, with no
     other candidate on either side, is far more likely a rename than both. */
  const renamed = [];
  for (const a of removed.slice()) {
    const k = shapeKey(a.shape);
    const to = added.filter((b) => shapeKey(b.shape) === k);
    const from = removed.filter((x) => shapeKey(x.shape) === k);
    if (to.length === 1 && from.length === 1) {
      renamed.push({ a, b: to[0] });
      removed.splice(removed.indexOf(a), 1);
      added.splice(added.indexOf(to[0]), 1);
    }
  }
  return { added, removed, retyped, renamed, common };
}

/** File-level numbers, summed over every part and every row group. */
export function datasetShape(dataset, table) {
  let comp = 0, uncomp = 0;
  const codecs = new Set(), encs = new Set();
  for (const part of dataset.parts) {
    for (const rg of part.meta.rowGroups) {
      for (const c of rg.columns) {
        if (!c.meta) continue;
        comp += c.meta.totalCompressedSize;
        uncomp += c.meta.totalUncompressedSize;
        codecs.add(c.meta.codec);
        for (const e of c.meta.encodings) encs.add(e);
      }
    }
  }
  const m = dataset.reference;
  return {
    files: dataset.parts.length, rows: dataset.numRows, cols: table.cols.length,
    groups: dataset.numGroups, size: dataset.size, comp, uncomp,
    codecs: [...codecs].sort().join(", ") || "-",
    encs: [...encs].sort().join(", ") || "-",
    version: m.version == null ? "?" : "v" + m.version,
    writer: m.createdBy || "-",
    encryption: m.encryption ? m.encryption.algorithm : "none",
    loaded: table.rowsLoaded, truncated: table.truncated,
  };
}

/**
 * Statistics are written in the column's own sort order, which for unsigned
 * ints is unsigned and for decimals is numeric — neither of which is what the
 * physical bytes say. Ordering them the wrong way would move a min/max that
 * never moved, so each type gets the comparison the spec gives it.
 */
export function statOrder(leaf, spec) {
  const t = leaf.type;
  if (t === "BOOLEAN") return (a, b) => (a === b ? 0 : a ? 1 : -1);
  if (t === "INT96") {
    return (a, b) => (a.julian !== b.julian ? a.julian - b.julian
      : a.nanos < b.nanos ? -1 : a.nanos > b.nanos ? 1 : 0);
  }
  if (t === "INT32" || t === "INT64" || t === "FLOAT" || t === "DOUBLE") {
    if (/^uint/.test(spec.label || "")) {
      const bits = t === "INT32" ? 32 : 64;
      return (a, b) => {
        const x = BigInt.asUintN(bits, BigInt(a)), y = BigInt.asUintN(bits, BigInt(b));
        return x < y ? -1 : x > y ? 1 : 0;
      };
    }
    return (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  }
  if (spec.decimal) {
    return (a, b) => { const x = beBigInt(a), y = beBigInt(b); return x < y ? -1 : x > y ? 1 : 0; };
  }
  return (a, b) => {                                    /* unsigned byte order */
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
}

/** Every row group's statistics for one column, folded into one min/max. */
export function columnStats(dataset, col) {
  const leaf = col.leaf;
  if (!leaf) return null;
  const key = col.key, spec = col.spec, cmp = statOrder(leaf, spec);
  let min = null, max = null, nulls = 0, values = 0, comp = 0, uncomp = 0;
  let nullsKnown = true, exact = true, seen = false, chunks = 0, unreadable = false;
  const codecs = new Set(), encs = new Set();
  for (const part of dataset.parts) {
    for (const rg of part.meta.rowGroups) {
      for (const c of rg.columns) {
        if (!c.meta || c.meta.path.join("\u0001") !== key) continue;
        seen = true;
        chunks++;
        comp += c.meta.totalCompressedSize;
        uncomp += c.meta.totalUncompressedSize;
        values += c.meta.numValues;
        codecs.add(c.meta.codec);
        for (const e of c.meta.encodings) encs.add(e);
        const st = c.meta.statistics;
        if (!st) { nullsKnown = false; continue; }
        if (st.nullCount != null) nulls += st.nullCount; else nullsKnown = false;
        if (st.minExact === false || st.maxExact === false) exact = false;
        const lo = st.minValue != null ? st.minValue : st.min;
        const hi = st.maxValue != null ? st.maxValue : st.max;
        try {
          if (lo && lo.length) { const v = rawStat(lo, leaf); if (min === null || cmp(v, min) < 0) min = v; }
          if (hi && hi.length) { const v = rawStat(hi, leaf); if (max === null || cmp(v, max) > 0) max = v; }
        } catch (_e) { unreadable = true; }
      }
    }
  }
  if (!seen) return null;
  return { chunks, comp, uncomp, values, nulls, nullsKnown, exact, unreadable,
    min: min === null ? null : showStat(min, spec), max: max === null ? null : showStat(max, spec),
    codecs: [...codecs].sort().join(", "), encs: [...encs].sort().join(", ") };
}

/** A stable string for a value, used only to match rows up by key. */
export function cellKey(v, spec) {
  if (v === null || v === undefined) return "\u0000";
  switch (typeof v) {
    case "number": return v !== v ? "NaN" : String(v);
    case "bigint": return v.toString();
    case "boolean": return v ? "t" : "f";
    case "string": return v;
  }
  if (v instanceof Uint8Array) {
    let s = "";
    for (let i = 0; i < v.length; i += 4096) s += String.fromCharCode.apply(null, v.subarray(i, i + 4096));
    return s;
  }
  return jsonish(v, spec);
}
export function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/**
 * Equality for one column, chosen once from its type rather than per cell.
 * A uint64 column holds Numbers for small values and BigInts for large ones,
 * so 5 and 5n are the same value in it; nested values compare by their text.
 */
export function cellEq(spec) {
  if (spec.kind === "binary") {
    return (a, b) => a === b || (a instanceof Uint8Array && b instanceof Uint8Array && bytesEq(a, b));
  }
  if (spec.kind === "nested") {
    return (a, b) => a === b || (a != null && b != null && jsonish(a, spec) === jsonish(b, spec));
  }
  return (a, b) => a === b || (a !== a && b !== b) ||
    (a != null && b != null && typeof a !== "object" && typeof b !== "object" &&
     (typeof a === "bigint") !== (typeof b === "bigint") && Number(a) === Number(b));
}

/** Rows whose key never repeats make a key; a null in it does not. */
export function keyIsUnique(col) {
  const rows = col.rows, n = rows.length;
  if (!n) return false;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    if (rows[i] === null || rows[i] === undefined) return false;
    const k = cellKey(rows[i], col.spec);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}
export const KEYISH = /(^|[_.])(id|key|pk|uuid|guid)$/i;
/** A column that is unique on both sides, preferring one that looks like a key. */
export function suggestKey(aT, bT) {
  const cand = [];
  for (const a of aT.cols) {
    if (a.spec.kind === "nested") continue;
    const b = bT.cols.find((c) => c.key === a.key);
    if (b) cand.push({ a, b, keyish: KEYISH.test(a.name) });
  }
  cand.sort((x, y) => (x.keyish === y.keyish ? 0 : x.keyish ? -1 : 1));
  for (const c of cand) if (keyIsUnique(c.a) && keyIsUnique(c.b)) return [c.a.key];
  return [];
}

/**
 * Matches the two sides up by key and compares every other shared column.
 * One pass over each side builds the key index; one pass over the matched
 * rows finds the cells that moved.
 */
export function rowDiff(aT, bT, keyKeys) {
  if (!keyKeys.length) return { error: "Pick one or more key columns to match rows up by." };
  const at = keyKeys.map((k) => aT.cols.findIndex((c) => c.key === k));
  const bt = keyKeys.map((k) => bT.cols.findIndex((c) => c.key === k));
  if (at.some((i) => i < 0) || bt.some((i) => i < 0)) {
    return { error: "The key columns must exist in both files." };
  }
  const value = [];
  for (let i = 0; i < aT.cols.length; i++) {
    const a = aT.cols[i];
    if (keyKeys.indexOf(a.key) >= 0) continue;
    const j = bT.cols.findIndex((c) => c.key === a.key);
    if (j < 0) continue;
    value.push({ name: a.name, spec: a.spec, bspec: bT.cols[j].spec, eq: cellEq(a.spec),
      A: a.rows, B: bT.cols[j].rows });
  }
  const keysOf = (t, idx) => {
    const cols = idx.map((i) => t.cols[i]);
    const n = t.rowsLoaded;
    const out = new Array(n);
    if (cols.length === 1) {
      const rows = cols[0].rows, spec = cols[0].spec;
      for (let r = 0; r < n; r++) out[r] = cellKey(rows[r], spec);
    } else {
      for (let r = 0; r < n; r++) {
        let s = "";
        for (let c = 0; c < cols.length; c++) s += (c ? "\u0001" : "") + cellKey(cols[c].rows[r], cols[c].spec);
        out[r] = s;
      }
    }
    return out;
  };
  const akeys = keysOf(aT, at), bkeys = keysOf(bT, bt);
  const index = (arr) => {
    const m = new Map();
    let dup = 0;
    for (let r = 0; r < arr.length; r++) { if (m.has(arr[r])) dup++; else m.set(arr[r], r); }
    return { m, dup };
  };
  const A = index(akeys), B = index(bkeys);
  if (A.dup || B.dup) {
    const names = keyKeys.map((k) => { const c = aT.cols.find((x) => x.key === k); return c ? c.name : k; });
    return { error: "(" + names.join(", ") + ") is not unique — " +
      (A.dup ? num(A.dup) + " repeated key" + (A.dup === 1 ? "" : "s") + " in A" : "") +
      (A.dup && B.dup ? ", " : "") +
      (B.dup ? num(B.dup) + " repeated key" + (B.dup === 1 ? "" : "s") + " in B" : "") +
      ". Rows cannot be matched one to one; add a column to the key." };
  }

  const onlyA = [], onlyB = [], changed = [];
  const perCol = new Array(value.length).fill(0);
  let same = 0;
  for (let r = 0; r < akeys.length; r++) {
    const br = B.m.get(akeys[r]);
    if (br === undefined) { onlyA.push(r); continue; }
    let cells = null;
    for (let c = 0; c < value.length; c++) {
      const v = value[c];
      if (!v.eq(v.A[r], v.B[br])) {
        if (!cells) cells = [];
        cells.push(c);
        perCol[c]++;
      }
    }
    if (cells) changed.push({ ar: r, br, cells }); else same++;
  }
  for (let r = 0; r < bkeys.length; r++) if (!A.m.has(bkeys[r])) onlyB.push(r);
  return { keyA: at, keyB: bt, keyKeys, value, onlyA, onlyB, changed, same, perCol,
    rowsA: akeys.length, rowsB: bkeys.length };
}

export function diffCell(v, spec) {
  if (v === null || v === undefined) return "<span class='null'>null</span>";
  let text = fmtValue(v, spec);
  if (text.length > 120) text = text.slice(0, 120) + "…";
  return esc(text);
}
export const dnum = (a, b) => {
  if (a === b) return "<span class='muted'>=</span>";
  const d = b - a;
  return "<span class='" + (d > 0 ? "add" : "rem") + "'>" + (d > 0 ? "+" : "−") + num(Math.abs(d)) + "</span>";
};
export const dtext = (a, b) => (a === b ? "<span class='muted'>=</span>" : "<span class='chg'>changed</span>");

export function diffShapeCard(A, B) {
  const sa = datasetShape(A.dataset, A.table), sb = datasetShape(B.dataset, B.table);
  const row = (k, a, b, d) => "<tr><td class='k'>" + k + "</td><td>" + a + "</td><td>" + b +
    "</td><td class='d'>" + (d == null ? "" : d) + "</td></tr>";
  const ratio = (s) => (s.uncomp ? (s.comp / s.uncomp * 100).toFixed(1) + "%" : "-");
  const out = [
    sa.files > 1 || sb.files > 1 ? row("files", num(sa.files), num(sb.files), dnum(sa.files, sb.files)) : "",
    row("rows", num(sa.rows), num(sb.rows), dnum(sa.rows, sb.rows)),
    row("columns", num(sa.cols), num(sb.cols), dnum(sa.cols, sb.cols)),
    row("row groups", num(sa.groups), num(sb.groups), dnum(sa.groups, sb.groups)),
    row("size", bytesHuman(sa.size), bytesHuman(sb.size), dnum(sa.size, sb.size) + " B"),
    row("column data", bytesHuman(sa.comp), bytesHuman(sb.comp), dnum(sa.comp, sb.comp) + " B"),
    row("ratio", ratio(sa), ratio(sb), dtext(ratio(sa), ratio(sb))),
    row("codecs", esc(sa.codecs), esc(sb.codecs), dtext(sa.codecs, sb.codecs)),
    row("encodings", esc(sa.encs), esc(sb.encs), dtext(sa.encs, sb.encs)),
    row("format", esc(sa.version), esc(sb.version), dtext(sa.version, sb.version)),
    row("encryption", esc(sa.encryption), esc(sb.encryption), dtext(sa.encryption, sb.encryption)),
    row("written by", "<span title='" + esc(sa.writer) + "'>" + esc(sa.writer) + "</span>",
      "<span title='" + esc(sb.writer) + "'>" + esc(sb.writer) + "</span>", dtext(sa.writer, sb.writer)),
    row("read here", num(sa.loaded) + (sa.truncated ? " <span class='muted'>of " + num(sa.rows) + "</span>" : ""),
      num(sb.loaded) + (sb.truncated ? " <span class='muted'>of " + num(sb.rows) + "</span>" : ""), ""),
  ].join("");
  return "<div class='mcard'><h3>shape</h3><table class='kvt dt'>" +
    "<tr><th></th><th>A</th><th>B</th><th></th></tr>" + out + "</table></div>";
}

export function diffSchemaCard(sd) {
  const lines = [];
  const one = (cls, mark, name, detail) => "<tr><td class='mk " + cls + "'>" + mark + "</td><td title='" +
    esc(name) + "'>" + esc(name) + "</td><td>" + detail + "</td></tr>";
  for (const b of sd.added) {
    lines.push(one("add", "+", b.col.name, "<span class='muted'>only in B · " + esc(shapeText(b.shape)) + "</span>"));
  }
  for (const a of sd.removed) {
    lines.push(one("rem", "−", a.col.name, "<span class='muted'>only in A · " + esc(shapeText(a.shape)) + "</span>"));
  }
  for (const r of sd.renamed) {
    lines.push(one("ren", "~", r.a.col.name + " → " + r.b.col.name,
      "<span class='muted'>same shape, different name — a rename?</span>"));
  }
  for (const r of sd.retyped) {
    lines.push(one("chg", "≠", r.a.col.name,
      "<span class='dfrom'>" + esc(shapeText(r.a.shape)) + "</span> <span class='arrow'>→</span> " +
      "<span class='db'>" + esc(shapeText(r.b.shape)) + "</span>"));
  }
  const drifted = sd.added.length + sd.removed.length + sd.renamed.length + sd.retyped.length;
  const head = "<div class='mcard'><h3>schema" + (drifted ? " — " + num(drifted) + " change" +
    (drifted === 1 ? "" : "s") : "") + "</h3>";
  if (!drifted) {
    return head + "<div class='okbox'>Both files describe the same " + num(sd.common.length) +
      " columns, with the same types.</div></div>";
  }
  return head + "<div class='scrollx'><table class='kvt dl'>" + lines.join("") + "</table></div>" +
    "<div class='dnote'>" + num(sd.common.length) + " column" +
    (sd.common.length === 1 ? "" : "s") + " in both</div></div>";
}

export function diffStatsCard(A, B, sd) {
  let rows = "", moved = 0, shown = 0;
  for (const pair of sd.common) {
    const sa = columnStats(A.dataset, pair.a.col), sb = columnStats(B.dataset, pair.b.col);
    if (!sa || !sb) continue;                          /* partition columns have no chunks */
    shown++;
    const nullsMoved = sa.nullsKnown && sb.nullsKnown && sa.nulls !== sb.nulls;
    const minMoved = sa.min !== sb.min, maxMoved = sa.max !== sb.max;
    if (!nullsMoved && !minMoved && !maxMoved) continue;
    moved++;
    const both = (x, y, changed) => (changed
      ? "<span class='da'>" + esc(x == null ? "-" : x) + "</span> <span class='arrow'>→</span> <span class='db'>" +
        esc(y == null ? "-" : y) + "</span>"
      : "<span class='muted'>" + esc(x == null ? "-" : x) + "</span>");
    const nulls = (s) => (s.nullsKnown ? num(s.nulls) : "?");
    rows += "<tr><td title='" + esc(pair.a.col.name) + "'>" + esc(pair.a.col.name) + "</td>" +
      "<td>" + both(nulls(sa), nulls(sb), nullsMoved) + "</td>" +
      "<td>" + both(sa.min, sb.min, minMoved) + "</td>" +
      "<td>" + both(sa.max, sb.max, maxMoved) + "</td>" +
      "<td>" + (sa.exact && sb.exact ? "" : "<span class='muted' title='a writer truncated these statistics," +
        " so they bound the value rather than being it'>truncated</span>") + "</td></tr>";
  }
  const head = "<div class='mcard wide'><h3>statistics — what the files themselves claim</h3>";
  if (!shown) return head + "<div class='dnote'>Neither file carries column statistics.</div></div>";
  if (!moved) {
    return head + "<div class='okbox'>Null counts and min/max are identical across all " +
      num(shown) + " shared columns.</div></div>";
  }
  return head + "<div class='scrollx'><table class='kvt ds'>" +
    "<tr><th>column</th><th>nulls</th><th>min</th><th>max</th><th></th></tr>" + rows + "</table></div>" +
    "<div class='dnote'>" + num(moved) + " of " + num(shown) +
    " shared columns moved. Statistics describe the whole file, not only the rows read here.</div></div>";
}

export function keyName(table, key) {
  const c = table.cols.find((x) => x.key === key);
  return c ? c.name : key;
}
export function diffKeyBar(A, B) {
  const chips = [];
  for (const a of A.table.cols) {
    const b = B.table.cols.find((c) => c.key === a.key);
    if (!b || a.spec.kind === "nested") continue;
    const on = diff.keys.indexOf(a.key) >= 0;
    /* by index: a partition column's key holds a NUL, which an HTML attribute
       would hand back as U+FFFD */
    chips.push("<button class='chip" + (on ? " on" : "") + "' aria-pressed='" + !!on + "' data-dact='key' data-ci='" +
      A.table.cols.indexOf(a) + "' title='" + esc(a.spec.label) + "'>" + esc(a.name) + "</button>");
  }
  if (!chips.length) return "<div class='dnote'>The two files share no column that could be a key.</div>";
  return "<div class='chips'><span class='muted'>key</span>" + chips.join("") +
    "<button data-dact='run' class='act'>Compare rows</button>" +
    (diff.keys.length ? "<button data-dact='nokey'>clear</button>" : "") + "</div>";
}

export function diffRowsCard(A, B) {
  let out = "<div class='mcard wide'><h3>rows</h3>" + diffKeyBar(A, B);
  const r = diff.rows;
  if (!r) {
    return out + "<div class='dnote'>" + (diff.keys.length
      ? "Press <b>Compare rows</b> to match the two sides up on (" +
        esc(diff.keys.map((k) => keyName(A.table, k)).join(", ")) + ")."
      : "Pick the column, or columns, whose value identifies a row.") + "</div></div>";
  }
  if (r.error) return out + "<div class='warnbox'>" + esc(r.error) + "</div></div>";

  out += "<div class='dtally'>" + [
    "<span class='tag'>only in A <b class='rem'>" + num(r.onlyA.length) + "</b></span>",
    "<span class='tag'>only in B <b class='add'>" + num(r.onlyB.length) + "</b></span>",
    "<span class='tag'>changed <b class='chg'>" + num(r.changed.length) + "</b></span>",
    "<span class='tag'>identical <b>" + num(r.same) + "</b></span>",
    "<span class='muted'>matched on (" + esc(r.keyKeys.map((k) => keyName(A.table, k)).join(", ")) +
      ") in " + num(r.ms) + " ms</span>",
  ].join("") + "</div>";
  if (A.table.truncated || B.table.truncated) {
    out += "<div class='warnbox'>Compared the " + num(r.rowsA) + " rows read from A against the " +
      num(r.rowsB) + " read from B, which is not the whole of both files. " +
      "Load every row on both sides for a complete answer.</div>";
  }

  const moved = r.perCol.map((n, i) => ({ n, name: r.value[i].name })).filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n);
  if (moved.length) {
    out += "<div class='bycol'><span class='muted'>changed cells by column</span>" +
      moved.map((x) => "<span class='tag'>" + esc(x.name) + " <b class='chg'>" + num(x.n) + "</b></span>").join("") +
      "</div>";
  }

  const total = r.onlyA.length + r.onlyB.length + r.changed.length;
  if (!total) return out + "<div class='okbox'>Every row matches, cell for cell.</div></div>";

  const head = "<tr><th></th>" + r.keyKeys.map((k) => "<th>" + esc(keyName(A.table, k)) + "</th>").join("") +
    r.value.map((v) => "<th>" + esc(v.name) + "</th>").join("") + "</tr>";
  const keyCells = (t, idx, row) => idx.map((ci) =>
    "<td class='ky'>" + diffCell(t.cols[ci].rows[row], t.cols[ci].spec) + "</td>").join("");
  /* Drawing changed rows first and the rest afterwards would hide one kind of
     difference behind another, so the cap is shared out and what a group does
     not need goes to the others. */
  const share = (sizes) => {
    const even = Math.floor(diff.cap / sizes.length);
    const take = sizes.map((n) => Math.min(n, even));
    let left = diff.cap - take.reduce((a, b) => a + b, 0);
    for (let i = 0; i < sizes.length && left > 0; i++) {
      const more = Math.min(left, sizes[i] - take[i]);
      take[i] += more;
      left -= more;
    }
    return take;
  };
  const [nChanged, nOnlyA, nOnlyB] = share([r.changed.length, r.onlyA.length, r.onlyB.length]);
  let body = "", drawn = 0;
  for (const row of r.changed.slice(0, nChanged)) {
    drawn++;
    body += "<tr><td class='mk chg'>≠</td>" + keyCells(A.table, r.keyA, row.ar);
    const hit = new Set(row.cells);
    for (let c = 0; c < r.value.length; c++) {
      const v = r.value[c];
      body += hit.has(c)
        ? "<td class='moved'><span class='da'>" + diffCell(v.A[row.ar], v.spec) +
          "</span> <span class='arrow'>→</span> <span class='db'>" + diffCell(v.B[row.br], v.bspec) + "</span></td>"
        : "<td class='muted'>" + diffCell(v.A[row.ar], v.spec) + "</td>";
    }
    body += "</tr>";
  }
  for (const ar of r.onlyA.slice(0, nOnlyA)) {
    drawn++;
    body += "<tr class='remrow'><td class='mk rem'>−</td>" + keyCells(A.table, r.keyA, ar) +
      r.value.map((v) => "<td>" + diffCell(v.A[ar], v.spec) + "</td>").join("") + "</tr>";
  }
  for (const br of r.onlyB.slice(0, nOnlyB)) {
    drawn++;
    body += "<tr class='addrow'><td class='mk add'>+</td>" + keyCells(B.table, r.keyB, br) +
      r.value.map((v) => "<td>" + diffCell(v.B[br], v.bspec) + "</td>").join("") + "</tr>";
  }
  out += "<div class='scrollx'><table class='kvt dr'>" + head + body + "</table></div>";
  if (drawn < total) {
    out += "<div class='dnote'>Showing " + num(drawn) + " of " + num(total) +
      " differing rows. <button data-dact='more'>show " + num(Math.min(1000, total - drawn)) +
      " more</button></div>";
  }
  return out + "</div>";
}

export function sideA() {
  return { dataset: state.dataset, table: state.table, name: sideName(state.dataset) };
}
export function sideName(dataset) {
  if (!dataset.parts.length) return "the joined table";   /* no file behind it */
  return dataset.parts.length > 1 ? datasetName(dataset) : dataset.parts[0].path;
}
export function renderDiff() {
  if (!state.table) return;
  /* every card here is read out of the two footers -- row groups, codecs,
     per-column statistics -- and a joined table has no footer of its own.
     Say so rather than diffing half of it against a file */
  if (state.table.joined) {
    $("diffbar").innerHTML = "<span class='qtitle'>COMPARE</span>" +
      "<span class='muted'>not available for a joined table</span>" +
      "<span class='grow'></span><button data-dact='close'>close</button>";
    $("diffbody").innerHTML = "<div class='dnote'>A diff is read from both files' footers — " +
      "row groups, codecs, per-column statistics — and a joined table has none of its own. " +
      "Undo the join first, in the <b>Join</b> panel, to compare the file it came from.</div>";
    return;
  }
  /* growing or scanning the open file leaves columns nobody asked for behind;
     a diff wants all of them */
  if (needFilled(state.table.cols.map((_c, i) => i), renderDiff)) return;
  const A = sideA(), B = diff.b;
  $("diffbar").innerHTML = [
    "<span class='qtitle'>COMPARE</span>",
    "<span class='dside'>A <b title='" + esc(A.name) + "'>" + esc(A.name) + "</b></span>",
    "<span class='muted'>vs</span>",
    B ? "<span class='dside'>B <b title='" + esc(B.name) + "'>" + esc(B.name) + "</b></span>"
      : "<span class='muted'>nothing yet</span>",
    "<label class='btn' for='bpicker'>" + (B ? "Choose another" : "Choose file B") + "</label>",
    "<label class='btn' for='bdirpicker'>Folder</label>",
    B ? "<button data-dact='swap' title='Read B as the open file and A as the comparison'>swap</button>" : "",
    B && (A.table.truncated || B.table.truncated)
      ? "<button data-dact='loadall'>load every row, both sides</button>" : "",
    "<span class='grow'></span>",
    "<button data-dact='close'>close</button>",
  ].join("");
  if (!B) {
    $("diffbody").innerHTML = "<div id='dropb'><div class='big'>Drop the file to compare against here</div>" +
      "<div class='hint'>Or use <b>Choose file B</b> above. A is the file already open:<br>" +
      esc(A.name) + "</div></div>";
    return;
  }
  const sd = schemaDiff(A.table, B.table);
  $("diffbody").innerHTML = diffShapeCard(A, B) + diffSchemaCard(sd) +
    diffStatsCard(A, B, sd) + diffRowsCard(A, B);
}

export function showDiff(on) {
  if (on && join.on) showJoin(false);
  diff.on = on;
  $("diffwrap").hidden = !on;
  $("gridwrap").hidden = on || !state.view;
  $("pager").hidden = on || !state.view;
  $("toggleDiff").textContent = on ? "Table" : "Diff";
  if (on) renderDiff(); else renderPager();
}

/** Reads the other side, to the same row budget the open file was read to. */
export async function openCompare(entries, label) {
  if (!state.table) return;
  const old = $("err");
  if (old) old.remove();
  busy(true, "reading the other file…");
  await new Promise((r) => setTimeout(r, 0));
  try {
    const dataset = await readDataset(entries);
    const table = newTable(dataset);
    const budget = Math.max(FIRST_ROWS, state.table.rowsLoaded);
    busy(true, "decoding " + num(Math.min(dataset.numRows, budget)) + " rows of B…");
    await new Promise((r) => setTimeout(r, 0));
    await loadMore(dataset, table, budget);
    diff.b = { dataset, table,
      name: label || (entries.length === 1 ? entries[0].path : entries.length + " files") };
    diff.rows = null;
    diff.cap = 200;
    busy(true, "decoding the rest of this file to compare it…");
    await new Promise((r) => setTimeout(r, 0));
    await fillColumns(state.dataset, state.table, state.table.cols.map((_c, i) => i));
    diff.keys = suggestKey(state.table, table);
    renderDiff();
  } catch (e) {
    diff.b = null;
    renderDiff();
    showError(e);
  } finally { busy(false); }
}

export async function runRowDiff() {
  if (!diff.b) return;
  busy(true, "matching rows…");
  await new Promise((r) => setTimeout(r, 0));
  try {
    const t0 = Date.now();
    diff.rows = rowDiff(state.table, diff.b.table, diff.keys);
    diff.rows.ms = Date.now() - t0;
    diff.cap = 200;
  } catch (e) {
    diff.rows = { error: e.message };
  } finally {
    busy(false);
    renderDiff();
  }
}

/** Reads every row of both sides, so the row diff covers the whole files. */
export async function loadAllBoth() {
  busy(true, "decoding every row…");
  await new Promise((r) => setTimeout(r, 0));
  try {
    /* every column of every row of both files at once: refuse up front if that cannot fit */
    const everyCol = (t) => t.cols.map((_c, i) => i);
    const need = loadAllBytes(state.dataset, state.table, everyCol(state.table)) +
      (diff.b ? loadAllBytes(diff.b.dataset, diff.b.table, everyCol(diff.b.table)) : 0);
    const why = loadAllRefusal("both files", need, budgetBytes(),
      "Compare a smaller file, or use the schema and statistics comparison, which needs no rows.");
    if (why) throw new Refusal(why);
    state.table.need = null;                       /* the diff wants every column */
    await loadMore(state.dataset, state.table, Infinity);
    await fillColumns(state.dataset, state.table, state.table.cols.map((_c, i) => i));
    if (diff.b) await loadMore(diff.b.dataset, diff.b.table, Infinity);
    refreshView(true);
    renderMeta();
    updateButtons();
    diff.rows = null;
  } catch (e) { showError(e); } finally { busy(false); renderDiff(); }
}

export function initDiff() {
  $("toggleDiff").addEventListener("click", () => showDiff(!diff.on));
  const fromPicker = (e, folder) => {
    const entries = entriesFromFiles(e.target.files);
    const first = e.target.files[0];
    e.target.value = "";                 /* so picking the same thing again re-reads it */
    if (!entries.length) { showError(new Error("No .parquet files there.")); return; }
    openCompare(entries, folder && first ? (first.webkitRelativePath || "").split("/")[0] : null);
  };
  $("bpicker").addEventListener("change", (e) => fromPicker(e, false));
  $("bdirpicker").addEventListener("change", (e) => fromPicker(e, true));
  $("diffwrap").addEventListener("click", (e) => {
    const el = e.target.closest("[data-dact]");
    if (!el) return;
    switch (el.dataset.dact) {
      case "key": {
        const col = state.table.cols[+el.dataset.ci];
        if (!col) break;
        const at = diff.keys.indexOf(col.key);
        if (at >= 0) diff.keys.splice(at, 1); else diff.keys.push(col.key);
        diff.rows = null;
        renderDiff();
        break;
      }
      case "nokey": diff.keys = []; diff.rows = null; renderDiff(); break;
      case "run": runRowDiff(); break;
      case "more": diff.cap += 1000; renderDiff(); break;
      case "close": showDiff(false); break;
      case "swap": swapSides(); break;
      case "loadall": loadAllBoth(); break;
    }
  });
}

/** B becomes the open file and A the comparison, with neither re-read. */
export function swapSides() {
  const b = diff.b;
  if (!b) return;
  const a = sideA();
  adoptDataset(b.dataset, b.table, b.name, b.dataset.parts.length > 1 && !/^\d+ files$/.test(b.name));
  diff.b = { dataset: a.dataset, table: a.table, name: a.name };
  diff.rows = null;
  diff.keys = suggestKey(state.table, diff.b.table);
  renderDiff();
}
