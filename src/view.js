import { $, fillColumns, unfilled } from "./columns.js";
import { busy, showError } from "./main.js";
import { fmtValue, summarize } from "./types.js";
import { renderGrid, renderRows } from "./ui-grid.js";

export const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
export const num = (n) => (n == null ? "-" : Number(n).toLocaleString("en-US"));
export function bytesHuman(n) {
  if (n == null) return "-";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)) + " " + u[i];
}
export const pct = (a, b) => (b ? (a / b * 100).toFixed(a / b >= 0.1 || a === 0 ? 0 : 1) + "%" : "0%");

export const COL_W = 178, ROW_H = 22;
/* how many cells may be drawn in one go before the grid falls back to
   windowing; 100 rows of 40 columns fits comfortably inside it */
export const CELL_BUDGET = 8000;
export const PAGE_SIZES = [10, 100, 200, 500, 1000, 3000, Infinity];
export const state = { src: null, meta: null, table: null, view: null, page: 0, pageSize: 100, first: 0 };

/**
 * A view is what the grid draws: a list of columns, a row count, and an
 * optional Int32Array picking which underlying rows to show, in what order.
 * The unfiltered table is a view with no index, so nothing is copied until a
 * query actually reshapes the data.
 */
/**
 * Which of the table's columns the grid shows, in what order. Pinned columns
 * float to the front and stick to the left edge; hidden ones drop out. This is
 * a display concern only — every column stays decoded and queryable.
 */
export function newDisplay(cols) {
  return { order: cols.map((_c, i) => i), hidden: new Set(), pinned: new Set() };
}
export function displayOrder() {
  const d = state.display;
  if (!d) return null;
  const pinned = d.order.filter((ci) => d.pinned.has(ci));
  const rest = d.order.filter((ci) => !d.pinned.has(ci));
  return pinned.concat(rest).filter((ci) => !d.hidden.has(ci));
}
export function displayCols(cols) {
  const order = displayOrder();
  if (!order) return cols;
  const out = [];
  for (const ci of order) if (cols[ci]) out.push(cols[ci]);
  return out.length ? out : cols;
}
export function pinnedCount() {
  const d = state.display;
  return d ? d.order.filter((ci) => d.pinned.has(ci) && !d.hidden.has(ci)).length : 0;
}
export function baseView(table) {
  return { cols: displayCols(table.cols), index: null, count: table.rowsLoaded, label: null, agg: false };
}
export function viewValue(view, ci, row) {
  const rows = view.cols[ci].rows;
  return view.index ? rows[view.index[row]] : rows[row];
}
export function summarizeView(view) {
  for (const col of view.cols) col.summary = summarize(col, view.index, view.count);
}
/** Every column a query names, wherever it names it. */
export function queryColumns(q) {
  const out = [];
  if (!q) return out;
  for (const f of q.filters) out.push(f.ci);
  for (const s of q.sort) if (s.ci != null) out.push(s.ci);
  for (const ci of q.select) out.push(ci);
  for (const ci of q.groupBy) out.push(ci);
  for (const m of q.metrics) out.push(m.ci);
  return out;
}
/**
 * The columns worth decoding: what the grid is showing and what the query
 * names. Partition columns come out of the path and cost nothing, and a
 * hidden column a filter mentions is still needed.
 */
export function neededColumns(table, running) {
  const need = new Set();
  const cols = table.cols;
  for (let i = 0; i < cols.length; i++) if (cols[i].partKey !== undefined) need.add(i);
  const q = state.query;
  /* an aggregate puts its own columns on screen and a SELECT list names the
     ones it keeps, so while either is running the rest of the display is not
     being drawn and does not need decoding */
  const live = q && (running || q.active);
  const shapesItself = live &&
    ((q.mode === "agg" && (q.groupBy.length || q.metrics.length)) || (q.mode === "rows" && q.select.length));
  if (!shapesItself) {
    const order = displayOrder();
    if (!order || !order.length) for (let i = 0; i < cols.length; i++) need.add(i);
    else for (const ci of order) need.add(ci);
  }
  for (const ci of queryColumns(q)) need.add(ci);
  return need;
}
export const wantedColumns = (table) => [...neededColumns(table)];
/**
 * Columns are decoded when something wants them, which means something can
 * find one behind. Rather than draw a hole, fill it in and come back.
 * Returns true when it has taken over: the caller should stop.
 */
export function needFilled(indexes, again) {
  if (!state.table || !state.dataset) return false;
  const behind = unfilled(state.table, indexes);
  if (!behind.length) return false;
  if (state.filling) return true;
  state.filling = true;
  const names = behind.map((ci) => state.table.cols[ci].name);
  busy(true, "decoding " + (names.length === 1 ? '"' + names[0] + '"' : num(names.length) + " more columns") + "…");
  fillColumns(state.dataset, state.table, behind)
    .then(() => { state.filling = false; busy(false); again(); })
    .catch((e) => { state.filling = false; busy(false); showError(e); });
  return true;
}

export function setView(view) {
  state.view = view;
  state.page = 0;
  summarizeView(view);
  renderGrid();
  renderPager();
}

/* ------------------------------------------------------------ pagination */
export function pageBounds() {
  const v = state.view;
  if (!v) return [0, 0];
  const size = state.pageSize;
  if (!isFinite(size)) return [0, v.count];
  const pages = Math.max(1, Math.ceil(v.count / size));
  if (state.page >= pages) state.page = pages - 1;
  if (state.page < 0) state.page = 0;
  const start = state.page * size;
  return [start, Math.min(v.count, start + size)];
}
export function pageCount() {
  const v = state.view;
  if (!v || !isFinite(state.pageSize)) return 1;
  return Math.max(1, Math.ceil(v.count / state.pageSize));
}
export function gotoPage(n) {
  const last = pageCount() - 1;
  const p = Math.max(0, Math.min(last, n));
  if (p === state.page) return;
  state.page = p;
  $("gridwrap").scrollTop = 0;
  state.first = -1;
  renderRows(true);
  renderPager();
}
export function renderPager() {
  const v = state.view;
  const bar = $("pager");
  if (!v) { bar.hidden = true; return; }
  bar.hidden = false;
  const [from, to] = pageBounds();
  const pages = pageCount();
  const opts = PAGE_SIZES.map((n) => "<option value='" + n + "'" +
    (n === state.pageSize ? " selected" : "") + ">" + (isFinite(n) ? num(n) : "All") + "</option>").join("");
  const dis = (on) => (on ? " disabled" : "");
  bar.innerHTML =
    "<button id='pfirst' title='First page'" + dis(state.page === 0) + ">&laquo;</button>" +
    "<button id='pprev' title='Previous page'" + dis(state.page === 0) + ">&lsaquo;</button>" +
    "<span class='pinfo'>page <input id='pnum' value='" + (state.page + 1) +
    "' size='4' inputmode='numeric'> of " + num(pages) + "</span>" +
    "<button id='pnext' title='Next page'" + dis(state.page >= pages - 1) + ">&rsaquo;</button>" +
    "<button id='plast' title='Last page'" + dis(state.page >= pages - 1) + ">&raquo;</button>" +
    "<span class='psep'></span>" +
    "<label class='pinfo'>rows <select id='psize'>" + opts + "</select></label>" +
    "<span class='psep'></span>" +
    "<span class='pinfo'>" + (v.count ? num(from + 1) + "&ndash;" + num(to) : "0") + " of " + num(v.count) +
    (v.label ? " <b>" + esc(v.label) + "</b>" : "") + "</span>" +
    (state.table && state.table.truncated
      ? "<span class='pinfo muted'>&middot; " + num(state.table.rowsLoaded) + " of " +
        num(state.meta.numRows) + " rows read</span>" : "") +
    "<span class='grow'></span>" +
    "<span class='pinfo'>export <select id='expscope'>" +
    "<option value='page'>this page</option><option value='view'>all " + num(v.count) + " rows</option>" +
    "</select>" +
    "<button id='expcsv'>CSV</button><button id='exptsv'>TSV</button>" +
    "<button id='expjson'>JSON</button><button id='expmd' title='Markdown table'>MD</button>" +
    "<span class='psep'></span>" +
    "<button id='expcopy' title='Copy as TSV, for a spreadsheet'>copy</button>" +
    "<button id='expcopymd' title='Copy as a markdown table'>copy MD</button></span>";
  const scope = state.exportScope || "page";
  $("expscope").value = scope;
  $("expscope").onchange = (e) => { state.exportScope = e.target.value; };
  $("expcsv").onclick = () => doExport("csv");
  $("exptsv").onclick = () => doExport("tsv");
  $("expjson").onclick = () => doExport("json");
  $("expmd").onclick = () => doExport("md");
  $("expcopy").onclick = () => doExport("copy");
  $("expcopymd").onclick = () => doExport("copymd");
  $("pfirst").onclick = () => gotoPage(0);
  $("pprev").onclick = () => gotoPage(state.page - 1);
  $("pnext").onclick = () => gotoPage(state.page + 1);
  $("plast").onclick = () => gotoPage(pages - 1);
  $("pnum").onchange = (e) => {
    const n = parseInt(e.target.value, 10);
    if (isFinite(n)) gotoPage(n - 1); else renderPager();
  };
  $("psize").onchange = (e) => {
    const size = Number(e.target.value);
    const anchor = pageBounds()[0];
    state.pageSize = size;
    state.page = isFinite(size) ? Math.floor(anchor / size) : 0;
    try { localStorage.setItem("paris-parquet-pagesize", String(size)); } catch (_err) { /* fine */ }
    $("gridwrap").scrollTop = 0;
    state.first = -1;
    renderRows(true);
    renderPager();
  };
}

/* -------------------------------------------------------------- export */
/** The value as the grid shows it, minus the display truncation. */
export function exportText(v, spec) {
  return v === null || v === undefined ? null : fmtValue(v, spec);
}
/** Real JSON types where they exist, so numbers stay numbers. */
export function exportJson(v, spec) {
  if (v === null || v === undefined) return null;
  if (spec.kind === "number") return typeof v === "number" ? v : typeof v === "bigint" ? v.toString() : v;
  if (spec.kind === "bool") return v === true;
  if (spec.kind === "nested") {
    const inner = { kind: spec.elementKind, sub: spec.sub, utc: spec.utc };
    const walk = (x) => (x === null || x === undefined ? null : Array.isArray(x) ? x.map(walk) : exportJson(x, inner));
    return walk(v);
  }
  return fmtValue(v, spec);
}
export function csvField(text, sep) {
  if (text === null) return "";
  return /["\r\n]/.test(text) || text.indexOf(sep) >= 0 ? '"' + text.replace(/"/g, '""') + '"' : text;
}
/** A markdown cell: pipes escaped, and newlines turned into breaks so the
    row survives — a raw newline would end the table. */
export function mdField(text) {
  if (text === null) return "";
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
/** Builds the export as an array of chunks; Blob takes it without a join. */
export function exportParts(format, from, to) {
  const view = state.view;
  const cols = view.cols, n = cols.length;
  const parts = [];
  const sep = format === "tsv" ? "\t" : ",";
  if (format === "json") {
    parts.push("[\n");
    for (let r = from; r < to; r++) {
      const obj = {};
      for (let ci = 0; ci < n; ci++) obj[cols[ci].name] = exportJson(viewValue(view, ci, r), cols[ci].spec);
      parts.push("  " + JSON.stringify(obj) + (r < to - 1 ? ",\n" : "\n"));
    }
    parts.push("]\n");
    return parts;
  }
  if (format === "md") {
    parts.push("| " + cols.map((c) => mdField(c.name)).join(" | ") + " |\n");
    /* numbers line up on the right, the way the grid shows them */
    parts.push("| " + cols.map((c) => (c.spec.kind === "number" ? "---:" : ":---")).join(" | ") + " |\n");
    const cells = new Array(n);
    for (let r = from; r < to; r++) {
      for (let ci = 0; ci < n; ci++) cells[ci] = mdField(exportText(viewValue(view, ci, r), cols[ci].spec));
      parts.push("| " + cells.join(" | ") + " |\n");
    }
    return parts;
  }
  parts.push(cols.map((c) => csvField(c.name, sep)).join(sep) + "\n");
  const row = new Array(n);
  for (let r = from; r < to; r++) {
    for (let ci = 0; ci < n; ci++) row[ci] = csvField(exportText(viewValue(view, ci, r), cols[ci].spec), sep);
    parts.push(row.join(sep) + "\n");
  }
  return parts;
}
export function exportName(ext) {
  const base = (state.src && state.src.name ? state.src.name : "parquet").replace(/\.[^.]*$/, "");
  const v = state.view;
  return base + (v && v.label ? "-" + v.label : "") + "." + ext;
}
export function exportScope() {
  return $("expscope") && $("expscope").value === "view" ? [0, state.view.count] : pageBounds();
}
export function download(parts, mime, filename) {
  const url = URL.createObjectURL(new Blob(parts, { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export const COPY_LIMIT = 200000;
export function doExport(format) {
  if (!state.view) return;
  const [from, to] = exportScope();
  if (format === "copy" || format === "copymd") {
    const rows = Math.min(to, from + COPY_LIMIT);
    const text = exportParts(format === "copymd" ? "md" : "tsv", from, rows).join("");
    const btn = $(format === "copymd" ? "expcopymd" : "expcopy");
    const was = btn.textContent;
    const say = (msg) => { btn.textContent = msg; setTimeout(() => { btn.textContent = was; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => say(rows < to ? "copied " + num(rows - from) : "copied"))
        .catch(() => say("blocked"));
    } else say("blocked");
    return;
  }
  const mime = format === "json" ? "application/json"
    : format === "tsv" ? "text/tab-separated-values"
    : format === "md" ? "text/markdown" : "text/csv";
  const ext = format;
  download(exportParts(format, from, to), mime + ";charset=utf-8", exportName(ext));
}

/* ---------------------------------------------------------------- grid */
