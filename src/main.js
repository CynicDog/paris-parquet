import { decompress, gzipDecompress, lz4BlockDecompress, snappyDecompress, zstdDecompress } from "./codecs.js";
import { $, fillColumns, groupsLeft, loadMore, readColumnRows, rowsAhead, unfilled } from "./columns.js";
import { fileSource, hivePartition, isParquetPath, newTable, readDataset } from "./dataset.js";
import { cellEq, cellKey, colShape, columnStats, datasetShape, diff, initDiff, openCompare, renderDiff, rowDiff, schemaDiff, suggestKey } from "./diff.js";
import { assemble, intersectRanges, mergeRanges, rangeCount, readColumnChunk, readColumnIndex, readOffsetIndex, readPage, readRowsRanges, unionRanges } from "./encoding.js";
import { initJoin, join, openJoinCompare } from "./join.js";
import { bloomBytes, bloomHas, chunkBounds, clauseCanMatch, clauseGroups, clauseRanges, planReport, planScan, readBloom, showPlan, xxh64 } from "./pushdown.js";
import { aggregate, compileFilter, newQuery, parseSql, querySql, runQuery, scopeToBar, sqlTokenize, toggleSort } from "./query.js";
import { readFooter } from "./thrift.js";
import { fmtValue, summarize, typeSpec } from "./types.js";
import { closeInspector, initPicker, openInspector, refreshView, renderRows } from "./ui-grid.js";
import { rawStat, renderMeta, showStat, statValue } from "./ui-metadata.js";
import { adoptSql, initQuery, renderQuery, renderQueryColumns } from "./ui-query-builder.js";
import { initTree } from "./ui-tree.js";
import { baseView, bytesHuman, COL_W, displayCols, esc, exportParts, neededColumns, newDisplay, num, PAGE_SIZES, queryColumns, setView, state, viewValue } from "./view.js";
import { pool, poolStart, workerCan, workerMain } from "./workers.js";

export function columnWidth(index, px) {
  const view = state.view;
  if (!view || !view.cols[index]) return;
  const w = Math.max(56, Math.round(px));
  view.cols[index].width = w;
  const col = $("grid").querySelectorAll("colgroup col")[index + 1];   /* +1: row numbers */
  if (col) col.style.width = w + "px";
}
export function metaHeight(px) {
  const room = Math.max(90, window.innerHeight - 220);
  const h = Math.max(58, Math.min(Math.round(px), room));
  document.documentElement.style.setProperty("--metah", h + "px");
  try { localStorage.setItem("paris-parquet-metah", String(h)); } catch (_e) { /* fine */ }
  renderRows(true);
  return h;
}
/** Runs a pointer drag, keeping the cursor and text selection sane. */
export function drag(event, cls, onMove) {
  event.preventDefault();
  document.body.classList.add(cls);
  const move = (e) => onMove(e);
  const up = () => {
    document.body.classList.remove(cls);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export const THEMES = ["auto", "light", "dark"];
export function applyTheme(name) {
  const root = document.documentElement;
  if (name === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", name);
  $("theme").textContent = name;
  /* file:// pages may refuse storage entirely; the choice just won't persist */
  try { localStorage.setItem("paris-parquet-theme", name); } catch (_e) { /* fine */ }
}
export function storedTheme() {
  try {
    const v = localStorage.getItem("paris-parquet-theme");
    return THEMES.indexOf(v) >= 0 ? v : "auto";
  } catch (_e) { return "auto"; }
}
export function showError(e) {
  const old = $("err");
  if (old) old.remove();
  const box = document.createElement("div");
  box.id = "err";
  box.textContent = (e && e.message) ? e.message : String(e);
  $("stage").prepend(box);
  if (e && e.stack) console.error(e);
}
export function busy(on, text) {
  const b = $("busy");
  b.hidden = !on;
  if (text) b.textContent = text;
}
export const FIRST_ROWS = 20000;

export function isParquetFile(f) { return isParquetPath(f.webkitRelativePath || f.name); }

/**
 * Every parquet file this page load has been handed -- opened, dropped, or
 * picked as the other side of a diff or join -- by path. An entry re-reads
 * its File on demand, so remembering one costs a reference, and the folder
 * panel can offer them all again without a picker dialog (see #17). Nothing
 * is persisted: a reload starts empty, like the folder grant does.
 */
export const seen = new Map();

/**
 * The folder panel keeps its own list of these, and is built after this
 * module (see the manifest in scripts/compose.mjs), so it registers here
 * rather than being imported.
 */
export const fileHooks = { onSeen: null, onOpen: null };

export function remember(entries) {
  let added = 0;
  for (const e of entries) if (!seen.has(e.path)) { seen.set(e.path, e); added++; }
  if (added && fileHooks.onSeen) fileHooks.onSeen();
  return entries;
}

export function entriesFromFiles(list) {
  const out = [];
  for (const f of list) {
    const path = f.webkitRelativePath || f.name;
    if (isParquetPath(path)) out.push({ src: fileSource(f), path });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return remember(out);
}
/** A dropped folder arrives as directory entries, not files; walk it. */
export async function entriesFromDrop(dt) {
  const roots = [];
  if (dt.items) {
    for (const item of dt.items) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) roots.push(entry);
    }
  }
  if (!roots.length || !roots.some((r) => r.isDirectory)) return entriesFromFiles(dt.files);
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const path = prefix + entry.name;
      if (!isParquetPath(path)) return;
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ src: fileSource(file), path });
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, prefix + entry.name + "/");
    }
  };
  for (const r of roots) await walk(r, "");
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return remember(out);
}

export async function openFile(file) { return openEntries(entriesFromFiles([file])); }

/**
 * Makes an already-read dataset the one on screen. Opening a file does this
 * once it has decoded; swapping the two sides of a diff does it without
 * reading anything again.
 */
export function adoptDataset(dataset, table, name, showCount, keepDisplay) {
  state.dataset = dataset;
  state.src = dataset.parts[0].src;
  state.meta = dataset.reference;
  state.table = table;
  if (!keepDisplay) state.display = newDisplay(table.cols);
  setView(baseView(table));
  state.query = newQuery();            /* a different file means different columns */
  $("qstat").textContent = "";
  $("qclear").disabled = true;
  renderQueryColumns();
  renderQuery();
  renderMeta();
  updateButtons();
  $("fileline").innerHTML = "<b>" + esc(name) + "</b> &middot; " +
    (showCount ? num(dataset.parts.length) + " files &middot; " : "") + bytesHuman(dataset.size) + " &middot; " +
    num(dataset.numRows) + " rows x " + num(table.cols.length) + " cols &middot; " +
    num(dataset.numGroups) + " row group" + (dataset.numGroups === 1 ? "" : "s");
  if (diff.on) renderDiff();
}

export async function openEntries(entries, label) {
  const old = $("err");
  if (old) old.remove();
  busy(true, "reading footers...");
  poolStart();                     /* the other cores, once there is a file for them */
  const named = !!label || entries.length === 1;
  const name = label || (entries.length === 1 ? entries[0].path : entries.length + " files");
  $("fileline").innerHTML = "<b>" + esc(name) + "</b>";
  try {
    if (!entries.length) throw new Error("No .parquet files here.");
    let parts = 0;
    const dataset = await readDataset(entries, async (i, n, _path) => {
      parts = n;
      if (n > 1 && (i % 16 === 0 || i === n - 1)) {
        busy(true, "reading footers… " + (i + 1) + " of " + n);
        await new Promise((r) => setTimeout(r, 0));
      }
    });
    parts = dataset.parts.length;
    const table = newTable(dataset);
    /* the display and the query decide which columns are worth decoding, so
       they are settled before the first read rather than after it */
    state.display = newDisplay(table.cols);
    state.query = newQuery();
    table.need = neededColumns(table);
    busy(true, "decoding " + num(Math.min(dataset.numRows, FIRST_ROWS)) + " rows...");
    await new Promise((r) => setTimeout(r, 0));
    await loadMore(dataset, table, FIRST_ROWS);
    showPlan("");
    diff.b = null;                     /* a new file needs a new comparison */
    diff.rows = null;
    diff.keys = [];
    adoptDataset(dataset, table, name, parts > 1 && named, true);
    if (fileHooks.onOpen) fileHooks.onOpen(entries.length === 1 ? entries[0].path : null);
  } catch (e) {
    $("gridwrap").hidden = true;
    $("pager").hidden = true;
    $("query").hidden = true;
    $("qgrip").hidden = true;
    $("drop").hidden = false;
    $("meta").hidden = true;
    $("mgrip").hidden = true;
    $("more").hidden = true;
    $("all").hidden = true;
    $("toggleCols").hidden = true;
    $("toggleDiff").hidden = true;
    $("toggleDiff").textContent = "Diff";
    $("diffwrap").hidden = true;
    diff.on = false;
    $("toggleJoin").hidden = true;
    $("toggleJoin").textContent = "Join";
    $("joinwrap").hidden = true;
    join.on = false;
    $("colpick").hidden = true;
    $("toggleMeta").hidden = true;
    showError(e);
    /* the footer usually parses even when a page does not, and it is the part
       that explains why: codec, encodings, encryption, who wrote the file */
    if (state.meta && state.table) {
      try { renderMeta(); $("toggleMeta").hidden = false; } catch (_e2) { /* nothing to show */ }
    }
  } finally {
    busy(false);
  }
}

export function updateButtons() {
  const t = state.table;
  const can = !!(t && t.truncated);
  $("more").hidden = !can;
  $("all").hidden = !can;
  $("toggleMeta").hidden = !t;
  $("toggleQuery").hidden = !t;
  $("toggleCols").hidden = !t;
  $("toggleDiff").hidden = !t;
  /* the join panel takes its two sides by drop, so it is reachable with
     nothing open yet -- its button lives in the file panel, not here */
  if (t && $("toggleQuery").textContent === "Query" && $("query").hidden) {
    $("query").hidden = false;
    $("qgrip").hidden = false;
    $("toggleQuery").textContent = "Hide query";
  }
  if (can) {
    const next = rowsAhead(t.dataset, t, FIRST_ROWS);
    const left = t.scan ? t.scan.rows - t.rowsLoaded : t.dataset.numRows - t.rowsLoaded;
    $("more").textContent = "Load " + num(next) + " more";
    $("all").textContent = "Load all " + num(left) + (t.scan ? " matching" : "");
  }
}
export async function grow(n) {
  busy(true, "decoding...");
  await new Promise((r) => setTimeout(r, 0));
  try {
    state.table.need = neededColumns(state.table);
    await loadMore(state.dataset, state.table, n);
    if (state.query && state.query.active) runQuery(); else setView(baseView(state.table));
    renderMeta();
    updateButtons();
  } catch (e) { showError(e); } finally { busy(false); }
}

export function init() {
  applyTheme(storedTheme());
  initQuery();
  initPicker();
  initDiff();
  initJoin();
  initTree();
  $("theme").addEventListener("click", () => {
    applyTheme(THEMES[(THEMES.indexOf($("theme").textContent) + 1) % THEMES.length]);
  });
  const fromPicker = (e, label) => {
    const entries = entriesFromFiles(e.target.files);
    const first = e.target.files[0];
    e.target.value = "";              /* so picking the same thing again re-reads it */
    if (entries.length) openEntries(entries, label && first ? (first.webkitRelativePath || "").split("/")[0] : null);
    else if (first) showError(new Error('"' + first.name + '" is not a .parquet file.'));
  };
  $("picker").addEventListener("change", (e) => fromPicker(e, false));
  $("dirpicker").addEventListener("change", (e) => fromPicker(e, true));
  $("more").addEventListener("click", () => grow(FIRST_ROWS));
  $("all").addEventListener("click", () => grow(Infinity));
  $("toggleMeta").addEventListener("click", () => {
    const m = $("meta");
    state.metaTouched = true;
    m.classList.toggle("collapsed");
    const hidden = m.classList.contains("collapsed");
    $("mgrip").hidden = hidden;
    $("toggleMeta").textContent = hidden ? "Show metadata" : "Hide metadata";
    renderRows(true);
  });
  try {
    const qh = +localStorage.getItem("paris-parquet-queryh");
    if (qh > 0) document.documentElement.style.setProperty("--queryh", qh + "px");
  } catch (_e) { /* fine */ }
  try {
    const size = Number(localStorage.getItem("paris-parquet-pagesize"));
    if (PAGE_SIZES.indexOf(size) >= 0 || size === Infinity) state.pageSize = size;
  } catch (_e) { /* fine */ }
  try {
    const saved = +localStorage.getItem("paris-parquet-metah");
    if (saved > 0) document.documentElement.style.setProperty("--metah", saved + "px");
  } catch (_e) { /* fine */ }
  $("mgrip").addEventListener("pointerdown", (e) =>
    drag(e, "rowsizing", (ev) => metaHeight(window.innerHeight - ev.clientY)));
  $("gridwrap").addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("i.grip");
    if (!grip) return;
    const index = +grip.dataset.col;
    const startX = e.clientX, startW = state.view.cols[index].width || COL_W;
    drag(e, "colsizing", (ev) => {
      state.justResized = true;
      columnWidth(index, startW + ev.clientX - startX);
    });
    window.addEventListener("pointerup", () => setTimeout(() => { state.justResized = false; }, 0), { once: true });
  });
  $("gridwrap").addEventListener("dblclick", (e) => {
    const grip = e.target.closest("i.grip");
    if (grip) columnWidth(+grip.dataset.col, COL_W);
  });
  $("gridwrap").addEventListener("click", (e) => {
    if (state.justResized) return;              /* the click that ends a drag */
    if (e.target.closest("i.grip")) return;
    const th = e.target.closest("tr.r-name th");
    if (th) {
      if (th.classList.contains("rownum")) return;
      const idx = Array.prototype.indexOf.call(th.parentNode.children, th) - 1;
      if (idx >= 0) toggleSort(idx, e.shiftKey);
      return;
    }
    const bar = e.target.closest("tr.r-sum .hist.scopes i, tr.r-sum .top .row.scopes, tr.r-sum .bools.scopes i");
    if (bar) {
      const sth = bar.closest("th");
      scopeToBar(Array.prototype.indexOf.call(sth.parentNode.children, sth) - 1, bar.dataset);
      return;
    }
    const td = e.target.closest("#tbody td");
    if (!td || td.classList.contains("rownum") || td.classList.contains("pad")) return;
    if (String(window.getSelection())) return;     /* they were selecting text */
    const tr = td.parentNode;
    const ci = Array.prototype.indexOf.call(tr.children, td) - 1;
    const r = +tr.dataset.r;
    if (ci >= 0 && isFinite(r)) openInspector(r, ci, td);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInspector(); });
  document.addEventListener("pointerdown", (e) => {
    if (state.inspectAt && !e.target.closest("#inspect") && !e.target.closest("#tbody td")) closeInspector();
  }, true);
  let raf = 0;
  $("gridwrap").addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderRows(false); });
  });
  window.addEventListener("resize", () => {
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--metah"));
    if (cur > 0) metaHeight(cur); else renderRows(true);
  });
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const isFileDrag = (e) => e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types || [], "Files");
  document.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    stop(e);
    document.body.classList.add("dragging");
  });
  document.addEventListener("dragleave", (e) => { if (e.relatedTarget === null) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", async (e) => {
    if (!isFileDrag(e)) return;
    stop(e);
    document.body.classList.remove("dragging");
    /* dropped onto the diff or join panel, it is the other side rather than a new file */
    const onPanel = (id) => state.table && e.target.closest && e.target.closest(id);
    const compare = diff.on && onPanel("#diffwrap");
    const joinB = join.on && onPanel("#joinwrap");
    busy(true, "looking through what you dropped…");
    let entries = [];
    try { entries = await entriesFromDrop(e.dataTransfer); }
    catch (err) { busy(false); showError(err); return; }
    if (!entries.length) {
      busy(false);
      showError(new Error("Nothing here ends in .parquet."));
      return;
    }
    const folder = entries[0].path.indexOf("/") > 0 ? entries[0].path.split("/")[0] : null;
    if (compare) openCompare(entries, folder);
    else if (joinB) openJoinCompare(entries, folder);
    else openEntries(entries, folder);
  });
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

/* exposed so this file can be driven from a test harness */
/* running as a worker: no document, and the job is to decode what is asked */
if (typeof document === "undefined" && typeof self !== "undefined" && typeof importScripts === "function") {
  workerMain(self);
}

export const HOST = typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : null);
if (HOST) HOST.PARIS = { readFooter, readDataset, loadMore, newTable, typeSpec, summarize, assemble, fmtValue, decompress,
  hivePartition, isParquetPath, entriesFromFiles,
  runQuery, querySql, parseSql, sqlTokenize, adoptSql,
  baseView, setView, compileFilter, aggregate, exportParts, viewValue,
  displayCols, newDisplay, refreshView,
  diff, schemaDiff, datasetShape, columnStats, rowDiff, suggestKey, cellEq, cellKey, colShape,
  rawStat, showStat, statValue,
  fillColumns, unfilled, neededColumns, queryColumns, readColumnRows, readColumnChunk, readPage,
  planScan, planReport, chunkBounds, clauseCanMatch, clauseGroups, xxh64, bloomHas, readBloom,
  bloomBytes, groupsLeft, rowsAhead, readOffsetIndex, readColumnIndex, readRowsRanges, clauseRanges,
  intersectRanges, unionRanges, mergeRanges, rangeCount,
  pool, poolStart, workerCan,
  zstdDecompress, snappyDecompress, lz4BlockDecompress, gzipDecompress, fileSource, state };
