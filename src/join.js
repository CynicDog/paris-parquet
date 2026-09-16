import { $, loadMore } from "./columns.js";
import { newTable, readDataset } from "./dataset.js";
import { diff, showDiff } from "./diff.js";
import { adoptDataset, entriesFromFiles, busy, showError, FIRST_ROWS } from "./main.js";
import { planScan } from "./pushdown.js";
import { keyPart, newQuery, sortKey, textOf } from "./query.js";
import { lessThan } from "./types.js";
import { renderMeta } from "./ui-metadata.js";
import { renderQuery, renderQueryColumns } from "./ui-query-builder.js";
import { baseView, esc, newDisplay, num, setView, state } from "./view.js";

/**
 * One join at a time, single equality key, inner join only -- see #13. A
 * join is a one-shot materialization, not a live view: it reads both sides
 * fully (pushing the smaller side's key range down into the larger side's
 * row-group skipping, the same machinery `Scan file` uses for a WHERE
 * clause) and replaces the open table with the combined result, which the
 * rest of the app then treats exactly like any other opened file.
 */
export const join = { on: false, b: null, keyA: -1, keyB: -1, before: null, result: null, chain: null };

/**
 * The folder panel offers its files as side B while this panel is open, but
 * it is built later than this module (see the manifest in scripts/
 * compose.mjs), so it registers itself here rather than being imported.
 */
export const joinHooks = { onShow: null, onPick: null };

function sideDisplayName(dataset) {
  if (!dataset) return "";
  if (!dataset.parts.length) return "";
  return dataset.parts.length > 1 ? dataset.parts.length + " files" : dataset.parts[0].path;
}

/** A joined table lives in memory with no parts behind it: already fully
    read, nothing to narrow, no footer to plan against. */
function materialized(dataset) {
  return !dataset.parts.length;
}

/** What the open table is called right now -- the file, or the chain of
    joins already applied to it. */
function currentAName() {
  if (!state.table) return "";
  if (state.table.joined) return join.chain || "the joined table";
  return sideDisplayName(state.dataset);
}

function guessKeys(aCols, bCols) {
  for (let ai = 0; ai < aCols.length; ai++) {
    if (aCols[ai].spec.kind === "nested") continue;
    for (let bi = 0; bi < bCols.length; bi++) {
      if (bCols[bi].spec.kind === "nested") continue;
      if (aCols[ai].name.toLowerCase() === bCols[bi].name.toLowerCase()) return [ai, bi];
    }
  }
  return [-1, -1];
}

export function showJoin(on) {
  if (on && diff.on) showDiff(false);
  join.on = on;
  $("joinwrap").hidden = !on;
  $("gridwrap").hidden = on || !state.view;
  $("pager").hidden = on || !state.view;
  $("toggleJoin").textContent = on ? "Table" : "Join";
  if (joinHooks.onShow) joinHooks.onShow(on);
  if (on) renderJoin();
}

export async function openJoinCompare(entries, label) {
  if (!state.table) return;
  busy(true, "reading the other file…");
  await new Promise((r) => setTimeout(r, 0));
  try {
    const dataset = await readDataset(entries);
    const table = newTable(dataset);
    const budget = Math.max(FIRST_ROWS, state.table.rowsLoaded);
    await loadMore(dataset, table, budget);
    join.b = { dataset, table, name: label || (entries.length === 1 ? entries[0].path : entries.length + " files") };
    const [ai, bi] = guessKeys(state.table.cols, table.cols);
    join.keyA = ai;
    join.keyB = bi;
    join.result = null;
    renderJoin();
    if (joinHooks.onPick) joinHooks.onPick(join.b.name);
  } catch (e) { showError(e); } finally { busy(false); }
}

export function renderJoin() {
  if (!state.table) return;
  const aName = currentAName();
  const undoName = join.before ? join.before.name : aName;
  const b = join.b;
  $("joinbar").innerHTML = "<span class='qtitle'>JOIN</span>" +
    "<span class='dside'>A <b title='" + esc(aName) + "'>" + esc(aName) + "</b></span>" +
    "<span class='muted'>with</span>" +
    (b ? "<span class='dside'>B <b title='" + esc(b.name) + "'>" + esc(b.name) + "</b></span>" +
         "<label class='btn' for='jpicker'>choose another</label>"
       : "<label class='btn' for='jpicker'>choose file B</label>") +
    "<label class='btn' for='jdirpicker' title='Pick a folder; every parquet file in it reads as one table'>folder</label>" +
    "<span class='grow'></span><button id='joinclose'>close</button>";

  let body;
  if (!b) {
    body = "<div id='dropb'><div class='big'>Drop the file to join against here</div>" +
      "<div class='hint'>Or click one in the folder panel on the left, or use " +
      "<b>choose file B</b> above. A is the table already open:<br>" + esc(aName) + "</div></div>";
  } else if (join.result) {
    body = "<div class='jresult'>" + esc(join.result) +
      "<br><button id='jundo'>Undo, back to " + esc(undoName) + "</button></div>";
  } else {
    const aCols = state.table.cols;
    const aOpts = aCols.map((c, i) => "<option value='" + i + "'" + (i === join.keyA ? " selected" : "") +
      ">" + esc(c.name) + "</option>").join("");
    const bOpts = b.table.cols.map((c, i) => "<option value='" + i + "'" + (i === join.keyB ? " selected" : "") +
      ">" + esc(c.name) + "</option>").join("");
    body = "<div class='jkeys'>join <b>" + esc(aName) + "</b>.<select id='jkeyA'>" +
      "<option value='-1'>(pick a column)</option>" + aOpts + "</select>" +
      " to <b>" + esc(b.name) + "</b>.<select id='jkeyB'>" +
      "<option value='-1'>(pick a column)</option>" + bOpts + "</select>" +
      "<button id='jrun' class='act'" + (join.keyA < 0 || join.keyB < 0 ? " disabled" : "") +
      ">Run join</button></div>" +
      "<div class='dnote'>Inner join, one key column each side: only rows with a match on both " +
      "sides are kept. The smaller file is read fully and hashed; the larger one is read with " +
      "its row groups narrowed to the smaller side's key range first.</div>";
  }
  $("joinbody").innerHTML = body;
}

function adoptJoinedTable(dataset, table, description) {
  state.dataset = dataset;
  /* a synthetic joined dataset has no real parts/footer, but undoJoin()
     reuses this to restore the original file too, which does -- only null
     these out when there really is nothing there, or renderMeta() (called
     below, for the non-joined case) crashes reading a null footer */
  state.src = dataset.parts.length ? dataset.parts[0].src : null;
  state.meta = dataset.reference || null;
  state.table = table;
  state.display = newDisplay(table.cols);
  setView(baseView(table));
  state.query = newQuery();
  $("qstat").textContent = "";
  $("qclear").disabled = true;
  renderQueryColumns();
  renderQuery();
  renderMeta();
  $("fileline").innerHTML = "<b>" + esc(description) + "</b> &middot; " +
    num(table.rowsLoaded) + " rows x " + num(table.cols.length) + " cols";
}

export async function runJoin() {
  if (!state.table || !join.b || join.keyA < 0 || join.keyB < 0) return;
  const aDatasetIn = state.dataset, aTableIn = state.table;
  const aNameIn = currentAName();
  const b = join.b;
  busy(true, "joining…");
  await new Promise((r) => setTimeout(r, 0));
  try {
    const aIsBuild = aDatasetIn.numRows <= b.dataset.numRows;
    const buildDataset = aIsBuild ? aDatasetIn : b.dataset;
    const buildTable = aIsBuild ? aTableIn : b.table;
    const buildKeyCi = aIsBuild ? join.keyA : join.keyB;
    const probeDataset = aIsBuild ? b.dataset : aDatasetIn;
    const probeSeed = aIsBuild ? b.table : aTableIn;
    const probeKeyCi = aIsBuild ? join.keyB : join.keyA;

    if (!materialized(buildDataset)) {
      busy(true, "reading the smaller side fully…");
      await new Promise((r) => setTimeout(r, 0));
      await loadMore(buildDataset, buildTable, Infinity);
    }

    const buildKeyCol = buildTable.cols[buildKeyCi];
    const kk = sortKey(buildKeyCol.spec);
    const hash = new Map();
    let loRaw = null, hiRaw = null;
    for (let r = 0; r < buildTable.rowsLoaded; r++) {
      const v = buildKeyCol.rows[r];
      if (v === null || v === undefined) continue;
      const k = keyPart(v);
      let list = hash.get(k);
      if (!list) hash.set(k, (list = []));
      list.push(r);
      if (kk) {
        if (loRaw === null || lessThan(v, loRaw)) loRaw = v;
        if (hiRaw === null || lessThan(hiRaw, v)) hiRaw = v;
      }
    }

    let probeTable = probeSeed;
    /* a joined side is already whole and has no footer to plan against, so
       there is nothing to narrow and nothing left to read */
    if (loRaw !== null && !materialized(probeDataset)) {
      const probeKeySpec = probeSeed.cols[probeKeyCi].spec;
      const filter = { ci: probeKeyCi, pred: "between",
        value: textOf(loRaw, probeKeySpec), valueTo: textOf(hiRaw, probeKeySpec) };
      busy(true, "narrowing the larger side…");
      await new Promise((r) => setTimeout(r, 0));
      const plan = await planScan(probeDataset, { filters: [filter] }, probeSeed);
      if (plan) {
        const nt = newTable(probeDataset);
        nt.plan = plan.keep;
        probeTable = nt;
      }
    }
    if (!materialized(probeDataset)) {
      busy(true, "reading the larger side…");
      await new Promise((r) => setTimeout(r, 0));
      await loadMore(probeDataset, probeTable, Infinity);
    }
    const probeKeyCol = probeTable.cols[probeKeyCi];

    const aCols = aIsBuild ? buildTable.cols : probeTable.cols;
    const aKeyCi = aIsBuild ? buildKeyCi : probeKeyCi;
    const bCols = aIsBuild ? probeTable.cols : buildTable.cols;
    const bKeyCi = aIsBuild ? probeKeyCi : buildKeyCi;

    const aNames = new Set(aCols.map((c) => c.name));
    const outCols = aCols.map((c) => ({ name: c.name, spec: c.spec, leaf: c.leaf, rows: [] }));
    const bKept = [];
    bCols.forEach((c, i) => {
      if (i === bKeyCi) return; /* redundant with A's key */
      const name = aNames.has(c.name) ? "b_" + c.name : c.name;
      outCols.push({ name, spec: c.spec, leaf: c.leaf, rows: [] });
      bKept.push(i);
    });

    const buildIsA = aIsBuild;
    const buildCols = buildTable.cols, probeCols = probeTable.cols;
    let matched = 0;
    for (let pr = 0; pr < probeTable.rowsLoaded; pr++) {
      const v = probeKeyCol.rows[pr];
      if (v === null || v === undefined) continue;
      const list = hash.get(keyPart(v));
      if (!list) continue;
      for (const br of list) {
        matched++;
        let k = 0;
        const aSide = buildIsA ? buildCols : probeCols, aRow = buildIsA ? br : pr;
        const bSide = buildIsA ? probeCols : buildCols, bRow = buildIsA ? pr : br;
        for (let i = 0; i < aCols.length; i++) outCols[k++].rows.push(aSide[i].rows[aRow]);
        for (const i of bKept) outCols[k++].rows.push(bSide[i].rows[bRow]);
      }
    }
    for (const c of outCols) c.filled = c.rows.length;

    const bName = b.name;
    const description = aNameIn + " ⋈ " + bName + " on " + aCols[aKeyCi].name + " = " + bCols[bKeyCi].name;
    const joinedDataset = { parts: [], columns: [], partitionCols: [], skipped: [],
      numRows: matched, numGroups: 0, size: 0, reference: null };
    const joinedTable = {
      cols: outCols, dataset: joinedDataset, meta: null,
      nextPart: 0, nextGroup: 0, rowsLoaded: matched, groupsLoaded: 0,
      reads: [], need: null, truncated: false,
      joined: description + " — " + num(matched) + " matched row" + (matched === 1 ? "" : "s") +
        " out of " + num(aDatasetIn.numRows) + " (A) and " + num(b.dataset.numRows) + " (B)",
    };

    /* Undo always goes back to the file, however many joins were chained
       onto it, so the first one is the one worth remembering */
    if (!join.before) join.before = { dataset: aDatasetIn, table: aTableIn, name: aNameIn };
    join.result = joinedTable.joined;
    join.chain = description;
    adoptJoinedTable(joinedDataset, joinedTable, description);
    renderJoin();
  } catch (e) { showError(e); } finally { busy(false); }
}

export function undoJoin() {
  if (!join.before) return;
  const { dataset, table, name } = join.before;
  join.before = null;
  join.result = null;
  join.chain = null;
  join.b = null;
  join.keyA = -1;
  join.keyB = -1;
  /* restoring a real file, not a joined one -- adoptDataset already knows
     how to show it properly (row groups, real footer metadata and all) */
  adoptDataset(dataset, table, name, dataset.parts.length > 1);
  showJoin(false);
}

export function initJoin() {
  $("toggleJoin").addEventListener("click", () => showJoin(!join.on));
  const fromPicker = (e, isDir) => {
    const entries = entriesFromFiles(e.target.files);
    const first = e.target.files[0];
    e.target.value = "";
    if (entries.length) {
      openJoinCompare(entries, isDir && first ? (first.webkitRelativePath || "").split("/")[0] : null);
    } else if (first) showError(new Error('"' + first.name + '" is not a .parquet file.'));
  };
  $("jpicker").addEventListener("change", (e) => fromPicker(e, false));
  $("jdirpicker").addEventListener("change", (e) => fromPicker(e, true));
  $("joinbar").addEventListener("click", (e) => { if (e.target.closest("#joinclose")) showJoin(false); });
  $("joinbody").addEventListener("change", (e) => {
    if (e.target.id === "jkeyA") { join.keyA = +e.target.value; renderJoin(); }
    if (e.target.id === "jkeyB") { join.keyB = +e.target.value; renderJoin(); }
  });
  $("joinbody").addEventListener("click", (e) => {
    if (e.target.closest("#jrun")) runJoin();
    if (e.target.closest("#jundo")) undoJoin();
  });
}
