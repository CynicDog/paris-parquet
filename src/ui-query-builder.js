// The Query panel: the drag-and-drop zone builder (SELECT/GROUP BY/METRICS/
// WHERE/ORDER BY) and the SQL text box it stays in sync with — `renderZones`
// draws the builder from the query object, `adoptSql` parses edited SQL
// back into one.

import { $ } from "./columns.js";
import { drag } from "./main.js";
import { describeScope, runWhole } from "./pushdown.js";
import { AGG_GROUPS, AGG_SHORT, AGG_TITLE, AGGS, CUBE_MAX_COLS, filterIssue, NO_OPERAND, newQuery, nextQid, PREDS, parseSql, querySql, resetQuery } from "./query.js";
import { renderRows } from "./ui-grid.js";
import { esc, state } from "./view.js";

export const TYPE_TAG = { number: "NUM", string: "STR", bool: "BOOL", temporal: "TS", binary: "BIN", nested: "LIST" };
export function typeTag(spec) {
  if (spec.kind === "temporal") return spec.sub === "date" ? "DATE" : spec.sub === "time" ? "TIME" : "TS";
  return TYPE_TAG[spec.kind] || "?";
}

export function renderQueryColumns() {
  const table = state.table;
  if (!table) return;
  let html = "<div class='qhead'>Columns</div>";
  table.cols.forEach((c, i) => {
    html += "<div class='qcol' draggable='true' data-ci='" + i + "' title='" + esc(c.name + " - " + c.spec.label) +
      "'><span class='qgrab'>∷</span><span class='qcname'>" + esc(c.name) + "</span>" +
      "<span class='qtag t-" + c.spec.kind + "'>" + typeTag(c.spec) + "</span></div>";
  });
  $("qcols").innerHTML = html;
}

export function zone(id, label, hint, body, empty, extra) {
  return "<div class='qzone'><div class='qzlabel" + (extra ? " qzl-flex" : "") + "'>" + label +
    (extra ? "<span class='grow'></span>" + extra : "") + "</div>" +
    "<div class='qdrop" + (empty ? " empty" : "") + "' data-zone='" + id + "'>" +
    (empty ? "<span class='qhint'>" + hint + "</span>" : body) + "</div></div>";
}
export const GROUP_MODES = [["", "flat"], ["PIVOT", "pivot"], ["ROLLUP", "rollup"], ["CUBE", "cube"]];
export function groupModeCtl(q) {
  if (q.groupBy.length < 1) return "";
  return "<span class='gmode' title=\"pivot turns the last column's own values into new output columns, Excel-style. rollup and cube add subtotal rows instead: rollup nests by position (a, then a+b, then the grand total), cube adds every combination. Either way the dropped column shows as null, same as SQL's own ROLLUP/CUBE.\">" +
    GROUP_MODES.filter(([v]) => v !== "CUBE" || q.groupBy.length <= CUBE_MAX_COLS).map(([v, l]) =>
      "<button class='" + (q.groupMode === v ? "on" : "") + "' aria-pressed='" + (q.groupMode === v) + "' data-act='groupmode' data-v='" + v + "'>" + l + "</button>"
    ).join("") + "</span>";
}
/* Which metric rows have "more" open. UI state, not query state: what
   newQuery() holds is what round-trips through the SQL box, and whether a
   row is expanded has no business being in a query. */
const metricsOpen = new Set();
const aggBtn = (a, m) => "<button class='qb" + (m.agg === a ? " on" : "") + "' aria-pressed='" + (m.agg === a) + "' data-act='agg' data-id='" + m.id +
  "' data-v='" + a + "' title='" + esc(AGG_TITLE[a] || "") + "'>" + AGG_SHORT[a] + "</button>";
/**
 * The six common aggregates stay inline, one click each, and the rest live
 * behind a "more" button that widens the row to the right where there is
 * room and wraps onto the next line where there is not -- .qrow already
 * wraps, so no popover is needed and nothing can be clipped. When the
 * chosen metric is one of the hidden ones, it is pinned onto the button
 * itself, so a closed row never misstates what it computes.
 */
export function metricRow(m, name) {
  const open = metricsOpen.has(m.id);
  const pinned = AGGS.indexOf(m.agg) < 0 ? m.agg : null;
  let btns = "";
  for (const a of AGGS) btns += aggBtn(a, m);
  btns += "<button class='qb qmore-btn" + (pinned || open ? " on" : "") + "' aria-expanded='" + !!open + "' data-act='agg-more' data-id='" + m.id +
    "' title='" + (open ? "fewer aggregates" : "standard deviation, percentiles, nulls and more") + "'>" +
    (pinned ? esc(AGG_SHORT[pinned]) + " " : "") + (open ? "⌄" : "⋯") + "</button>";
  let more = "";
  if (open) {
    more = "<div class='qmore'>" + AGG_GROUPS.map((g) =>
      "<span class='qmgroup'><span class='qmlabel'>" + g.label + "</span><span class='qbtns'>" +
      g.aggs.map((a) => aggBtn(a, m)).join("") + "</span></span>").join("") + "</div>";
  }
  return "<div class='qrow'><span class='qbtns'>" + btns + "</span><code>" + esc(name) + "</code>" +
    "<input class='qin' data-in='alias' data-id='" + m.id + "' value='" + esc(m.alias || "") +
    "' placeholder='alias' size='7'>" +
    "<button class='qx' data-act='rm-metric' data-id='" + m.id + "'>×</button>" + more + "</div>";
}

export const chip = (text, act, id) => "<span class='qchip'>" + esc(text) +
  "<button class='qx' data-act='" + act + "' data-id='" + id + "'>×</button></span>";

export function renderZones() {
  const q = state.query, table = state.table;
  if (!table) return;
  const cols = table.cols;
  const nameOf = (ci) => (cols[ci] ? cols[ci].name : "?");
  const parts = [];

  if (q.mode === "rows") {
    parts.push(zone("select", "SELECT", "All columns &mdash; drop to pick specific ones",
      q.select.map((ci) => chip(nameOf(ci), "rm-select", ci)).join(""), q.select.length === 0));
  } else {
    parts.push(zone("groupBy", "GROUP BY", "Drop columns to group by",
      q.groupBy.map((ci, i) => chip(nameOf(ci) +
        (q.groupMode === "PIVOT" && i === q.groupBy.length - 1 ? " ⇒ columns" : ""),
        "rm-group", ci)).join(""), q.groupBy.length === 0,
      groupModeCtl(q)));
    parts.push(zone("metrics", "METRICS", "Drop a column to aggregate it",
      q.metrics.map((m) => metricRow(m, nameOf(m.ci))).join(""), q.metrics.length === 0));
  }

  parts.push(zone("where", "WHERE", "Drop a column to filter on it",
    q.filters.map((f, i) => {
      let btns = "";
      for (const p of PREDS) {
        btns += "<button class='qb" + (f.pred === p.id ? " on" : "") + "' aria-pressed='" + (f.pred === p.id) + "' data-act='pred' data-id='" + f.id +
          "' data-v='" + p.id + "'>" + p.label + "</button>";
      }
      const link = i === 0 ? "" : "<button class='qlink' data-act='link' data-id='" + f.id + "'>" +
        (f.linker || "AND") + "</button>";
      const issue = filterIssue(f, cols);
      const inputs = NO_OPERAND[f.pred] ? "" :
        "<input class='qin" + (issue === "invalid" ? " bad" : "") + "' data-in='val' data-id='" + f.id +
        "' value='" + esc(f.value || "") + "' placeholder='value' size='9'" +
        (issue === "invalid" ? " title='not a " + esc(cols[f.ci].spec.label) + " value'" : "") + ">" +
        (f.pred === "between" ? "<input class='qin' data-in='valTo' data-id='" + f.id + "' value='" +
          esc(f.valueTo || "") + "' placeholder='to' size='7'>" : "");
      return "<div class='qrow'>" + link + "<code>" + esc(nameOf(f.ci)) + "</code>" +
        "<span class='qbtns'>" + btns + "</span>" + inputs +
        "<button class='qx' data-act='rm-filter' data-id='" + f.id + "'>×</button></div>";
    }).join(""), q.filters.length === 0));

  /* a sort on a metric names the metric, matching the header and the SQL */
  const sortName = (s) => {
    if (!s.mid) return nameOf(s.ci);
    const m = q.metrics.find((x) => x.id === s.mid);
    return m ? (m.alias || AGG_SHORT[m.agg] + "(" + nameOf(m.ci) + ")") : nameOf(s.ci);
  };
  parts.push(zone("sort", "ORDER BY", "Drop a column to sort by",
    q.sort.map((s) => "<div class='qrow'><code>" + esc(sortName(s)) + "</code>" +
      "<button class='qb on' data-act='dir' data-id='" + s.id + "'>" +
      (s.dir === "ASC" ? "ASC ↑" : "DESC ↓") + "</button>" +
      "<button class='qx' data-act='rm-sort' data-id='" + s.id + "'>×</button></div>").join(""),
    q.sort.length === 0));

  parts.push("<div class='qzone qlimit'><div class='qzlabel'>LIMIT</div>" +
    "<input class='qin' data-in='limit' value='" + (q.limit == null ? "" : q.limit) +
    "' placeholder='none' size='7'></div>");

  $("qzones").innerHTML = parts.join("");
  for (const b of $("qmode").children) { b.classList.toggle("on", b.dataset.mode === q.mode); b.setAttribute("aria-pressed", String(b.dataset.mode === q.mode)); }
}
/** Anything the zones do overwrites the text; the builder wins its own edits. */
export function renderQuery() {
  state.sqlDirty = false;
  renderZones();
  renderSql(true);
  describeScope();
}
/** The builder owns the text unless the user is in the middle of editing it. */
export function renderSql(force) {
  if (!force && state.sqlDirty) return;
  const el = $("qsql");
  el.value = querySql();
  el.classList.remove("bad");
  state.sqlDirty = false;
  showSqlMessages({ errors: [], warnings: [] }, true);
}
export function lineCol(text, at) {
  const upto = text.slice(0, at);
  const line = upto.split("\n").length;
  return line + ":" + (at - upto.lastIndexOf("\n"));
}
export function showSqlMessages(res, quiet) {
  const box = $("qsqlmsg"), state_ = $("qsqlstate"), text = $("qsql").value;
  const items = res.errors.map((e) => ({ cls: "e", m: e })).concat(res.warnings.map((w) => ({ cls: "w", m: w })));
  if (!items.length) {
    box.hidden = true;
    state_.className = quiet ? "" : "ok";
    state_.textContent = quiet ? "" : "· in step with the zones";
    return;
  }
  box.hidden = false;
  box.innerHTML = items.map((i) =>
    "<div class='" + i.cls + "'>" + (i.m.at ? lineCol(text, i.m.at) + "  " : "") + esc(i.m.msg) + "</div>").join("");
  state_.className = res.errors.length ? "bad" : "warn";
  state_.textContent = res.errors.length
    ? "· " + res.errors.length + " problem" + (res.errors.length === 1 ? "" : "s")
    : "· " + res.warnings.length + " note" + (res.warnings.length === 1 ? "" : "s");
}
/** Parses what is in the box and, if it holds together, adopts it. */
export function adoptSql(andRun) {
  const table = state.table;
  if (!table) return false;
  const res = parseSql($("qsql").value, table.cols);
  showSqlMessages(res);
  $("qsql").classList.toggle("bad", res.errors.length > 0);
  if (!res.query) return false;
  res.query.active = state.query ? state.query.active : false;
  state.query = res.query;
  state.sqlDirty = false;
  renderZones();                       /* zones follow the text, text stays put */
  describeScope();
  if (andRun) { renderSql(true); runWhole(); }
  return true;
}

export function addToZone(zoneId, ci) {
  const q = state.query;
  switch (zoneId) {
    case "select": if (q.select.indexOf(ci) < 0) q.select.push(ci); break;
    case "groupBy":
      if (q.groupBy.indexOf(ci) < 0) q.groupBy.push(ci);
      if (q.groupMode === "CUBE" && q.groupBy.length > CUBE_MAX_COLS) q.groupMode = "ROLLUP";
      break;
    case "metrics": q.metrics.push({ id: nextQid("m"), ci, agg: "COUNT", alias: "" }); break;
    case "where": q.filters.push({ id: nextQid("f"), ci, pred: "eq", value: "", valueTo: "", linker: "AND" }); break;
    case "sort": if (!q.sort.some((s) => s.ci === ci)) q.sort.push({ id: nextQid("s"), ci, dir: "ASC" }); break;
    default: return;
  }
  renderQuery();
}

export function initQuery() {
  state.query = newQuery();
  $("qmode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    state.query.mode = b.dataset.mode;
    renderQuery();
  });
  $("qcols").addEventListener("dragstart", (e) => {
    const row = e.target.closest(".qcol");
    if (!row) return;
    e.dataTransfer.setData("text/plain", row.dataset.ci);
    e.dataTransfer.effectAllowed = "copy";
  });
  $("qcols").addEventListener("dblclick", (e) => {
    const row = e.target.closest(".qcol");
    if (row) addToZone(state.query.mode === "rows" ? "select" : "groupBy", +row.dataset.ci);
  });
  const zoneAt = (e) => e.target.closest(".qdrop");
  $("qzones").addEventListener("dragover", (e) => {
    const z = zoneAt(e);
    if (!z) return;
    e.preventDefault();
    z.classList.add("over");
  });
  $("qzones").addEventListener("dragleave", (e) => { const z = zoneAt(e); if (z) z.classList.remove("over"); });
  $("qzones").addEventListener("drop", (e) => {
    const z = zoneAt(e);
    if (!z) return;
    e.preventDefault();
    z.classList.remove("over");
    const ci = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (isFinite(ci)) addToZone(z.dataset.zone, ci);
  });
  $("qzones").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const q = state.query, id = b.dataset.id;
    switch (b.dataset.act) {
      case "rm-select": q.select = q.select.filter((ci) => ci !== +id); break;
      case "rm-group":
        q.groupBy = q.groupBy.filter((ci) => ci !== +id);
        if (!q.groupBy.length) q.groupMode = "";
        break;
      case "groupmode": q.groupMode = b.dataset.v; break;
      case "rm-metric": q.metrics = q.metrics.filter((m) => m.id !== id); metricsOpen.delete(id); break;
      case "rm-filter": q.filters = q.filters.filter((f) => f.id !== id); break;
      case "rm-sort": q.sort = q.sort.filter((s) => s.id !== id); break;
      case "pred": { const f = q.filters.find((x) => x.id === id); if (f) f.pred = b.dataset.v; break; }
      case "link": { const f = q.filters.find((x) => x.id === id); if (f) f.linker = f.linker === "OR" ? "AND" : "OR"; break; }
      /* picking one closes the row again, the same as picking one of the six */
      case "agg": { const m = q.metrics.find((x) => x.id === id); if (m) m.agg = b.dataset.v; metricsOpen.delete(id); break; }
      case "agg-more": { if (metricsOpen.has(id)) metricsOpen.delete(id); else metricsOpen.add(id); break; }
      case "dir": { const s = q.sort.find((x) => x.id === id); if (s) s.dir = s.dir === "ASC" ? "DESC" : "ASC"; break; }
      default: return;
    }
    renderQuery();
    /* flat/pivot/rollup/cube reshapes a result already on screen, so it
       reruns immediately rather than waiting for another press of Run --
       every other zone edit still needs one, since those build up a new
       query rather than just changing how this one is presented */
    if (b.dataset.act === "groupmode" && q.active) runWhole();
  });
  /* typing must not re-render, or the input would lose focus mid-word */
  $("qzones").addEventListener("input", (e) => {
    const el = e.target.closest("[data-in]");
    if (!el) return;
    const q = state.query, id = el.dataset.id, v = el.value;
    switch (el.dataset.in) {
      case "val": { const f = q.filters.find((x) => x.id === id); if (f) f.value = v; break; }
      case "valTo": { const f = q.filters.find((x) => x.id === id); if (f) f.valueTo = v; break; }
      case "alias": { const m = q.metrics.find((x) => x.id === id); if (m) m.alias = v; break; }
      case "limit": { const n = parseInt(v, 10); q.limit = isFinite(n) && n > 0 ? n : null; break; }
      default: return;
    }
    /* typing does not re-render the zone, so mark the offending input here */
    if (el.dataset.in === "val" || el.dataset.in === "valTo") {
      const f = q.filters.find((x) => x.id === id);
      const cols = state.table ? state.table.cols : [];
      el.classList.toggle("bad", !!f && filterIssue(f, cols) === "invalid");
    }
    renderSql();
  });
  $("qzones").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runWhole(); }
  });
  let sqlTimer = 0;
  $("qsql").addEventListener("input", () => {
    state.sqlDirty = true;
    clearTimeout(sqlTimer);
    sqlTimer = setTimeout(() => adoptSql(false), 260);
  });
  $("qsql").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); adoptSql(true); }
  });
  $("qsql").addEventListener("blur", () => { clearTimeout(sqlTimer); adoptSql(false); });
  $("qformat").addEventListener("click", () => { if (adoptSql(false)) renderSql(true); });
  /* running searches the whole file: runWhole takes text that has not been adopted yet and
     refuses it if it does not parse, so this does not adopt it first */
  $("qrun").addEventListener("click", () => runWhole());
  $("qclear").addEventListener("click", () => resetQuery());
  $("qcopy").addEventListener("click", () => {
    const text = querySql();
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    $("qcopy").textContent = "copied";
    setTimeout(() => { $("qcopy").textContent = "copy"; }, 1200);
  });
  $("toggleQuery").addEventListener("click", () => {
    const q = $("query");
    const showing = q.hidden;
    q.hidden = !showing;
    $("qgrip").hidden = !showing;
    $("toggleQuery").textContent = showing ? "Hide query" : "Query";
    renderRows(true);
  });
  $("qgrip").addEventListener("pointerdown", (e) =>
    drag(e, "rowsizing", (ev) => queryHeight($("query").getBoundingClientRect().bottom - ev.clientY)));
  /* the zones and the SQL text share the width: drag the grip and one grows
     as the other shrinks, the same way the folder panel and the grid do */
  $("qsqlgrip").addEventListener("pointerdown", (e) =>
    drag(e, "colsizing", (ev) => sqlWidth($("qsqlgrip").parentNode.getBoundingClientRect().right - ev.clientX)));
}
/** How wide the SQL panel is, leaving the zones at least a column's worth. */
export function sqlWidth(px) {
  const room = Math.max(220, window.innerWidth - 460);
  const w = Math.max(220, Math.min(Math.round(px), room));
  document.documentElement.style.setProperty("--qsqlw", w + "px");
  try { localStorage.setItem("paris-parquet-qsqlw", String(w)); } catch (_e) { /* fine */ }
  return w;
}
export function queryHeight(px) {
  const room = Math.max(120, window.innerHeight - 260);
  const h = Math.max(120, Math.min(Math.round(px), room));
  document.documentElement.style.setProperty("--queryh", h + "px");
  try { localStorage.setItem("paris-parquet-queryh", String(h)); } catch (_e) { /* fine */ }
  renderRows(true);
  return h;
}
