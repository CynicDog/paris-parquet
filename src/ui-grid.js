import { $ } from "./columns.js";
import { diff } from "./diff.js";
import { runQuery, sortMark } from "./query.js";
import { HEX, fmtValue, hex } from "./types.js";
import { typeTag } from "./ui-query-builder.js";
import { CELL_BUDGET, COL_W, ROW_H, baseView, bytesHuman, displayOrder, esc, needFilled, num, pageBounds, pct, pinnedCount, renderPager, setView, state, viewValue, wantedColumns } from "./view.js";

export function summaryCard(col) {
  const s = col.summary, spec = col.spec;
  if (!s) return "";
  const out = [];
  const kv = (k, v) => '<div class="kv"><span class="lab">' + k + "</span><span>" + v + "</span></div>";
  out.push(kv("nulls", s.nulls ? num(s.nulls) + " &middot; " + pct(s.nulls, s.n) : "0"));
  const valid = s.n - s.nulls;
  out.push('<div class="nullbar"><i class="v" style="width:' + (s.n ? valid / s.n * 100 : 0) +
    '%"></i><i class="n" style="width:' + (s.n ? s.nulls / s.n * 100 : 0) + '%"></i></div>');

  if (spec.kind === "bool") {
    const t = s.trues, f = s.falses, tot = s.n || 1;
    out.push('<div class="bools"><i class="t" style="width:' + (t / tot * 100) + '%">' + (t / tot > 0.14 ? t : "") +
      '</i><i class="f" style="width:' + (f / tot * 100) + '%">' + (f / tot > 0.14 ? f : "") +
      '</i><i class="n" style="width:' + (s.nulls / tot * 100) + '%"></i></div>');
    out.push(kv("true", num(t) + " &middot; " + pct(t, tot)));
    out.push(kv("false", num(f) + " &middot; " + pct(f, tot)));
  } else if (spec.kind === "number" || spec.kind === "temporal") {
    if (!s.count) { out.push(kv("values", "0")); }
    else {
      out.push(kv("min", esc(s.minText)));
      out.push(kv("max", esc(s.maxText)));
      out.push(kv("mean", esc(s.meanText)));
      if (s.max > s.min) {                       /* a constant column has no shape to draw */
        let peak = 1;
        for (const h of s.hist) if (h > peak) peak = h;
        let bars = "";
        for (let i = 0; i < s.hist.length; i++) {
          bars += '<i style="height:' + Math.max(3, s.hist[i] / peak * 100) + '%" title="' + s.hist[i] + '"></i>';
        }
        out.push('<div class="hist">' + bars + "</div>");
      }
      if (s.nonFinite) out.push(kv("nan/inf", num(s.nonFinite)));
    }
  } else if (spec.kind === "string") {
    out.push(kv("distinct", (s.distinctCapped ? "&ge;" : "") + num(s.distinct || 0)));
    if (s.top) {
      let rows = "";
      const top = s.top[0] ? s.top[0][1] : 1;
      for (const pair of s.top) {
        const v = pair[0], c = pair[1];
        rows += '<div class="row" title="' + esc(v) + '"><i style="width:' + (c / top * 100) + '%"></i>' +
          "<span>" + (v === "" ? '<em class="null">(empty)</em>' : esc(v)) + '</span><span class="c">' +
          num(c) + "</span></div>";
      }
      out.push('<div class="top">' + rows + "</div>");
    }
    out.push(kv("length", s.count ? s.minLen + "-" + s.maxLen : "-"));
  } else if (spec.kind === "nested") {
    out.push(kv("empty", num(s.empties || 0)));
    out.push(kv("length", s.count ? s.minLen + "-" + s.maxLen : "-"));
    out.push(kv("avg length", s.count ? s.meanLen.toFixed(2) : "-"));
  } else {
    out.push(kv("size", s.count ? bytesHuman(s.minLen) + " - " + bytesHuman(s.maxLen) : "-"));
    out.push(kv("avg size", s.count ? bytesHuman(Math.round(s.meanLen)) : "-"));
  }
  return '<div class="sum">' + out.join("") + "</div>";
}

export function renderGrid() {
  if (state.table && needFilled(wantedColumns(state.table), () => refreshView(true))) return;
  const view = state.view;
  if (!view) return;
  const grid = $("grid");
  const cols = view.cols;
  let html = "<colgroup><col style='width:62px'>";
  for (let i = 0; i < cols.length; i++) {
    if (!cols[i].width) cols[i].width = COL_W;
    html += "<col style='width:" + cols[i].width + "px'>";
  }
  html += "</colgroup><thead><tr class='r-name'><th class='rownum'>#</th>";
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    const title = (c.leaf ? c.leaf.path.join(".") : c.name) + "  -  " + c.spec.label +
      (c.leaf ? " (" + c.spec.physical + ", " + c.leaf.rep.toLowerCase() + ")" : "");
    html += "<th class='sortable' title='" + esc(title) + " — click to sort, shift-click to add a key'>" +
      sortMark(i) + "<span class='cname'>" + esc(c.name) +
      "</span><span class='ctype t-" + c.spec.kind + "'>" + esc(c.spec.label) +
      (c.leaf && c.leaf.rep === "OPTIONAL" && !c.spec.nested ? "?" : "") +
      "</span><i class='grip' data-col='" + i + "' title='Drag to resize, double-click to reset'></i></th>";
  }
  html += "</tr><tr class='r-sum'><th class='rownum'></th>";
  for (const c of cols) html += "<th>" + summaryCard(c) + "</th>";
  html += "</tr></thead><tbody id='tbody'></tbody>";
  grid.innerHTML = html;

  /* Per-column alignment and colour go in one stylesheet keyed by position,
     so a body cell can be a bare <td> - at 40 columns that is the difference
     between a smooth scroll and a stuttering one. */
  let css = "";
  const pins = pinnedCount();
  let pinLeft = 62;                                   /* past the row-number column */
  for (let i = 0; i < cols.length; i++) {
    const kind = cols[i].spec.kind;
    const nth = "#grid td:nth-child(" + (i + 2) + ")";
    if (kind === "number") css += nth + "{text-align:right}";
    else if (kind === "bool") css += nth + "{color:var(--bool)}";
    else if (kind === "binary" || kind === "nested") css += nth + "{color:var(--dim)}";
    if (i < pins) {
      const n = i + 2;
      css += "#grid tbody td:nth-child(" + n + "){position:sticky;left:" + pinLeft + "px;z-index:2}";
      css += "#grid thead th:nth-child(" + n + "){left:" + pinLeft + "px;z-index:5}";
      css += "#grid tbody td:nth-child(" + n + "),#grid thead th:nth-child(" + n +
        "){border-right:1px solid var(--line)}";
      pinLeft += cols[i].width || COL_W;
    }
  }
  $("colstyle").textContent = css;

  $("gridwrap").hidden = diff.on;
  $("drop").hidden = true;
  const nameRow = grid.querySelector("tr.r-name");
  document.documentElement.style.setProperty("--nameh", nameRow.offsetHeight + "px");
  state.first = -1;
  renderRows(true);
}

export function renderRows(force) {
  const view = state.view;
  if (!view) return;
  const wrap = $("gridwrap"), body = $("tbody");
  if (!body) return;
  const [pageStart, pageEnd] = pageBounds();
  const total = pageEnd - pageStart;
  const ncols = view.cols.length;
  let first, visible;
  if (total * ncols <= CELL_BUDGET) {
    /* A small page goes into the DOM whole. Scrolling then costs nothing at
       all: the early return below sees the same window every time. Replacing
       the tbody is a fixed cost regardless of row count, so drawing 100 rows
       is no dearer than drawing the 35 that happen to be on screen. */
    first = 0;
    visible = total;
  } else {
    const head = wrap.querySelector("thead").offsetHeight;
    const viewport = wrap.clientHeight;
    const scroll = Math.max(0, wrap.scrollTop - head);
    visible = Math.ceil(viewport / ROW_H) + 12;
    first = Math.max(0, Math.floor(scroll / ROW_H) - 6);
    if (first + visible > total) first = Math.max(0, total - visible);
  }
  if (!force && first === state.first) return;
  state.first = first;
  const last = Math.min(total, first + visible);
  const cols = view.cols;
  const index = view.index;
  const span = ncols + 1;
  const specs = new Array(ncols), data = new Array(ncols);
  for (let i = 0; i < ncols; i++) { specs[i] = cols[i].spec; data[i] = cols[i].rows; }
  const parts = [];
  if (first > 0) {
    parts.push("<tr><td class='pad' colspan='" + span + "' style='height:" + first * ROW_H + "px'></td></tr>");
  }
  for (let r = first; r < last; r++) {
    const abs = pageStart + r;
    const src = index ? index[abs] : abs;
    parts.push("<tr data-r='", String(abs), "'><td class='rownum'>", String((view.agg ? abs : src) + 1), "</td>");
    for (let ci = 0; ci < ncols; ci++) {
      const v = data[ci][src];
      if (v === null || v === undefined) { parts.push("<td class='null'>null</td>"); continue; }
      let text = fmtValue(v, specs[ci]);
      if (text.length > 300) text = text.slice(0, 300) + "...";
      /* only long values need the tooltip, and skipping it halves the markup */
      parts.push(text.length > 22 ? "<td title='" + esc(text) + "'>" : "<td>", esc(text), "</td>");
    }
    parts.push("</tr>");
  }
  if (last < total) {
    parts.push("<tr><td class='pad' colspan='" + span + "' style='height:" + (total - last) * ROW_H + "px'></td></tr>");
  }
  body.innerHTML = parts.join("");
  if (state.inspectAt) closeInspector();
}

/* -------------------------------------------------------- column picker */
export function refreshView(keepPage) {
  const page = state.page;
  if (state.query && state.query.active) runQuery();
  else setView(baseView(state.table));
  if (keepPage) { state.page = page; state.first = -1; renderRows(true); renderPager(); }
}
export function renderPicker() {
  const table = state.table, d = state.display;
  if (!table || !d) return;
  const needle = ($("cpsearch") ? $("cpsearch").value : "").trim().toLowerCase();
  const order = d.order.filter((ci) => d.pinned.has(ci)).concat(d.order.filter((ci) => !d.pinned.has(ci)));
  let rows = "";
  for (const ci of order) {
    const c = table.cols[ci];
    if (!c) continue;
    if (needle && c.name.toLowerCase().indexOf(needle) < 0 && c.spec.label.toLowerCase().indexOf(needle) < 0) continue;
    const shown = !d.hidden.has(ci), pinned = d.pinned.has(ci);
    rows += "<div class='cprow" + (pinned ? " pinned" : "") + "' draggable='true' data-ci='" + ci + "'>" +
      "<span class='qgrab'>∷</span>" +
      "<input type='checkbox' data-act='cpshow' data-ci='" + ci + "'" + (shown ? " checked" : "") + ">" +
      "<span class='cpname" + (shown ? "" : " off") + "' title='" + esc(c.name) + "'>" + esc(c.name) + "</span>" +
      "<span class='qtag t-" + c.spec.kind + "'>" + typeTag(c.spec) + "</span>" +
      "<button class='cppin" + (pinned ? " on" : "") + "' data-act='cppin' data-ci='" + ci +
      "' title='" + (pinned ? "Unpin" : "Pin to the left") + "'>pin</button></div>";
  }
  const hidden = d.hidden.size;
  $("cphead").innerHTML = "<b>" + num(table.cols.length - hidden) + " of " + num(table.cols.length) +
    " columns</b><span class='grow'></span>" +
    "<button data-act='cpall' title='Show every column'>all</button>" +
    "<button data-act='cponly' title='Hide all but the first'>none</button>" +
    "<button data-act='cpclose'>×</button>";
  $("cplist").innerHTML = rows || "<div class='qhint' style='padding:8px'>no column matches</div>";
}
export function togglePicker(show) {
  const el = $("colpick");
  const open = show === undefined ? el.hidden : show;
  el.hidden = !open;
  if (!open) return;
  renderPicker();
  const box = $("toggleCols").getBoundingClientRect();
  el.style.top = box.bottom + 4 + "px";
  el.style.left = Math.max(8, Math.min(box.left, window.innerWidth - el.offsetWidth - 8)) + "px";
  $("cpsearch").focus();
}
export function initPicker() {
  $("toggleCols").addEventListener("click", () => togglePicker());
  $("cpsearch").addEventListener("input", renderPicker);
  const act = (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const d = state.display, ci = +el.dataset.ci;
    switch (el.dataset.act) {
      case "cpshow": if (d.hidden.has(ci)) d.hidden.delete(ci); else d.hidden.add(ci); break;
      case "cppin": if (d.pinned.has(ci)) d.pinned.delete(ci); else d.pinned.add(ci); break;
      case "cpall": d.hidden.clear(); break;
      case "cponly": {
        /* leaving everything hidden would be a blank grid, so keep the first */
        d.hidden = new Set(state.table.cols.map((c, i) => i).filter((i) => i !== displayOrder()[0]));
        break;
      }
      case "cpclose": togglePicker(false); return;
      default: return;
    }
    renderPicker();
    refreshView(true);
  };
  $("cphead").addEventListener("click", act);
  $("cplist").addEventListener("click", act);
  $("cplist").addEventListener("change", act);
  let dragging = null;
  $("cplist").addEventListener("dragstart", (e) => {
    const row = e.target.closest(".cprow");
    if (!row) return;
    dragging = +row.dataset.ci;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(dragging));
  });
  $("cplist").addEventListener("dragover", (e) => {
    const row = e.target.closest(".cprow");
    if (!row || dragging === null) return;
    e.preventDefault();
    for (const r of $("cplist").children) r.classList.remove("dropafter", "dropbefore");
    const box = row.getBoundingClientRect();
    row.classList.add(e.clientY > box.top + box.height / 2 ? "dropafter" : "dropbefore");
  });
  $("cplist").addEventListener("drop", (e) => {
    const row = e.target.closest(".cprow");
    if (!row || dragging === null) return;
    e.preventDefault();
    const target = +row.dataset.ci;
    const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
    const d = state.display;
    d.order = d.order.filter((ci) => ci !== dragging);
    const at = d.order.indexOf(target);
    d.order.splice(at < 0 ? d.order.length : at + (after ? 1 : 0), 0, dragging);
    dragging = null;
    renderPicker();
    refreshView(true);
  });
  $("cplist").addEventListener("dragend", () => {
    dragging = null;
    for (const r of $("cplist").children) r.classList.remove("dropafter", "dropbefore");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!$("colpick").hidden && !e.target.closest("#colpick") && !e.target.closest("#toggleCols")) {
      togglePicker(false);
    }
  }, true);
}

/* ------------------------------------------------------- cell inspector */
export function hexDump(bytes) {
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = bytes.subarray(off, off + 16);
    let h = "", a = "";
    for (let i = 0; i < 16; i++) {
      h += i < slice.length ? HEX[slice[i]] + (i === 7 ? "  " : " ") : (i === 7 ? "    " : "   ");
      if (i < slice.length) { const c = slice[i]; a += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
    }
    lines.push(off.toString(16).padStart(8, "0") + "  " + h + " |" + a + "|");
  }
  return lines.join("\n");
}
/** The whole value, laid out for reading rather than for a table cell. */
export function inspectText(v, spec) {
  if (v === null || v === undefined) return "null";
  if (spec.kind === "binary" && v instanceof Uint8Array) return hexDump(v);
  if (spec.kind === "nested") {
    const inner = { kind: spec.elementKind, sub: spec.sub, utc: spec.utc };
    const walk = (x) => {
      if (x === null || x === undefined) return null;
      if (Array.isArray(x)) return x.map(walk);
      if (inner.kind === "bool") return x === true;
      if (inner.kind === "number" && typeof x === "number") return x;
      if (inner.kind === "binary" && x instanceof Uint8Array) return hex(x);
      return fmtValue(x, inner);
    };
    try { return JSON.stringify(walk(v), null, 2); } catch (e) { return String(v); }
  }
  return fmtValue(v, spec);
}
export function closeInspector() {
  const el = $("inspect");
  el.hidden = true;
  state.inspectAt = null;
}
export function openInspector(viewRow, ci, cell) {
  const view = state.view;
  if (!view || !view.cols[ci]) return;
  const col = view.cols[ci], spec = col.spec;
  const v = viewValue(view, ci, viewRow);
  const text = inspectText(v, spec);
  const isNull = v === null || v === undefined;
  const bits = [];
  if (col.leaf) {
    bits.push(col.leaf.type + (col.leaf.typeLength ? "(" + col.leaf.typeLength + ")" : ""));
    bits.push(col.leaf.rep.toLowerCase());
  }
  let size = "";
  if (typeof v === "string") size = num(v.length) + " chars";
  else if (v instanceof Uint8Array) size = num(v.length) + " bytes";
  else if (Array.isArray(v)) size = num(v.length) + (v.length === 1 ? " element" : " elements");
  const srcRow = view.index ? view.index[viewRow] : viewRow;
  $("inspect").innerHTML =
    "<div class='ihead'><b>" + esc(col.leaf ? col.leaf.path.join(".") : col.name) + "</b>" +
    "<span class='grow'></span><button id='icopy'>copy</button><button id='iclose'>×</button></div>" +
    "<div class='imeta'><span class='t-" + spec.kind + "'>" + esc(spec.label) + "</span>" +
    (bits.length ? "<span class='muted'>" + esc(bits.join(" · ")) + "</span>" : "") +
    "<span class='muted'>row " + num((view.agg ? viewRow : srcRow) + 1) + "</span>" +
    (size ? "<span class='muted'>" + size + "</span>" : "") + "</div>" +
    "<pre class='ibody" + (isNull ? " null" : "") + "'>" + esc(text) + "</pre>";
  const el = $("inspect");
  el.hidden = false;
  const box = cell.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(box.left, window.innerWidth - w - 8);
  let top = box.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, box.top - h - 4);
  el.style.left = Math.max(8, left) + "px";
  el.style.top = top + "px";
  state.inspectAt = { viewRow, ci };
  $("iclose").onclick = closeInspector;
  $("icopy").onclick = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    $("icopy").textContent = "copied";
    setTimeout(() => { const b = $("icopy"); if (b) b.textContent = "copy"; }, 1200);
  };
}

/* ------------------------------------------------------------ metadata */
/** The physical value a statistics blob holds, before any logical type. */
