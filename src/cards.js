// Summary cards over every row, not the rows read. A card above a column describes the rows the view
// covers; when the view covers more than is loaded (an unfiltered file, or a WHERE with more matches than
// were read) the rest is counted in the background: the view's columns, in batches that fit the memory
// budget, one row group at a time, with the cards filling in as each batch finishes. Nothing is asked of
// the person: no button, no option. Until a card is done it shows what the loaded rows say, and a slim
// status line says the rest is being counted. Foreground work (a Run, a load) always goes first.

import { budgetBytes, groupsAhead, groupsBytes } from "./budget.js";
import { $, loadMore } from "./columns.js";
import { newTable } from "./dataset.js";
import { isBusy } from "./main.js";
import { matchIndex } from "./query.js";
import { newWhole, wholeFeed1, wholeFeed2, wholeFinish, wholeNeedsPass2, wholeStart2 } from "./types.js";
import { summaryCard } from "./ui-grid.js";
import { num, state } from "./view.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** What decides which rows a card covers: the WHERE clause (a card for the same column over other rows is another card). */
function cardSig(q) {
  if (!q || !q.active || q.mode === "agg" || !q.filters.length) return "";
  return JSON.stringify(q.filters.map((f) => [f.ci, f.pred, f.value, f.valueTo, f.linker]));
}
const keyOf = (sig, col) => sig + "\u0001" + col.key;
/** The whole-view card for a column, if it has been counted. */
export function cardFor(col) {
  const d = state.dataset, s = cardSigNow();
  if (s === null || !d || !d.whole || col.partKey !== undefined) return null;
  return d.whole.get(keyOf(s, col)) || null;
}
/** The signature of the rows the current view covers when they are more than are loaded, else null (cards over the view's own rows are complete). */
function cardSigNow() {
  const t = state.table, d = state.dataset, v = state.view;
  if (!t || !d || !v || v.agg) return null;
  if (!t.truncated && !t.topk) return null;          /* a table holding every row of the view already has complete cards */
  return cardSig(state.query);
}
/** True while cards for the current view are still being counted. */
export function cardsPending() {
  return job.running || !!wanted().length;
}
/** Resolves when nothing is left to count (for tests and tooling). */
export async function cardsIdle() {
  for (let i = 0; i < 6000; i++) { if (!cardsPending()) return; await wait(50); }
}

const job = { running: false, token: 0, done: 0, total: 0, sig: null, dataset: null };
/** Columns of the current view whose whole-view card has not been counted. */
function wanted() {
  const sig = cardSigNow(), d = state.dataset, t = state.table, v = state.view;
  if (sig === null || !d || !t || !v) return [];
  const have = d.whole || new Map();
  return v.cols.filter((c) => t.cols.indexOf(c) >= 0 && c.partKey === undefined && !have.has(keyOf(sig, c)));
}

/** Called whenever the grid is drawn: makes sure the columns on screen are being counted. */
export function ensureCards() {
  const list = wanted();
  if (!list.length) { if (!job.running) setStatus(null); return; }
  if (job.running && job.dataset === state.dataset && job.sig === cardSigNow()) return;   /* the loop picks up new columns itself */
  if (job.running) { job.token++; return; }                                             /* another view: the loop stops, and restarts below */
  runJob();
}

function setStatus(text, fraction) {
  const el = $("cardprog");
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.innerHTML = "";
  const t = document.createElement("span");
  t.textContent = text;
  const bar = document.createElement("progress");
  bar.max = 100;
  bar.value = Math.round((fraction || 0) * 100);
  bar.setAttribute("aria-label", "share of the file counted");
  el.append(t, bar);
}

/** Redraws just the cards of the columns that were counted, without redrawing the grid. */
function redraw(cols) {
  const ths = document.querySelectorAll("#grid tr.r-sum th");
  const view = state.view, own = state.table ? state.table.cols : [];
  if (!view) return;
  for (const c of cols) {
    const at = view.cols.indexOf(c);
    if (at >= 0 && ths[at + 1]) ths[at + 1].innerHTML = summaryCard(c, !view.agg && own.indexOf(c) >= 0);
  }
}

async function runJob() {
  job.running = true;
  const my = ++job.token;
  try {
    for (;;) {
      const dataset = state.dataset, table = state.table, sig = cardSigNow(), q = state.query;
      if (sig === null) break;
      job.dataset = dataset; job.sig = sig;
      const todo = wanted();
      if (!todo.length) break;
      /* one batch: as many columns as fit a third of the budget for their biggest row group, plus what the WHERE names */
      const filterCols = sig ? q.filters.map((f) => f.ci).filter((ci) => table.cols[ci]) : [];
      /* the row groups the WHERE could match (a sorted top-N table's own plan is only its winners, so it is not used) */
      const rowGroups = table.scan && table.scan.keep ? table.scan.keep : null;
      const probe = newTable(dataset);
      probe.plan = rowGroups;
      const groups = groupsAhead(dataset, probe, Infinity);
      const room = budgetBytes() / 3;
      const batch = [];
      for (const c of todo) {
        const cols = [...new Set([...batch.map((b) => table.cols.indexOf(b)), ...filterCols, table.cols.indexOf(c)])];
        const biggest = groups.reduce((mx, g) => Math.max(mx, groupsBytes(dataset, probe, [g], cols)), 0);
        if (batch.length && biggest > room) break;
        batch.push(c);
        if (batch.length >= 24) break;
      }
      const at = batch.map((c) => table.cols.indexOf(c));
      const need = new Set([...at, ...filterCols]);
      const ws = new Map(at.map((ci) => [ci, newWhole(table.cols[ci].spec)]));
      const total = groups.length * 2, doneBefore = job.done;
      job.total = Math.max(job.total, doneBefore + total);
      const abandoned = () => my !== job.token || state.dataset !== dataset || cardSigNow() !== sig;
      let stopped = false;
      for (let pass = 1; pass <= 2 && !stopped; pass++) {
        const cur = pass === 1 ? at : at.filter((ci) => wholeNeedsPass2(ws.get(ci)));
        if (!cur.length) break;
        if (pass === 2) for (const ci of cur) wholeStart2(ws.get(ci));
        for (let i = 0; i < groups.length; i++) {
          while (isBusy()) { if (abandoned()) break; await wait(150); }     /* a Run or a load goes first */
          if (abandoned()) { stopped = true; break; }
          setStatus("Counting all " + num(dataset.numRows) + " rows for the column summaries" + (sig ? " that match" : "") + ": " + num(Math.min(at.length, table.cols.length)) + " of " + num(todo.length + (job.doneCols || 0)) + " columns in this pass, row group " + num(i + 1) + " of " + num(groups.length), (doneBefore + (pass - 1) * groups.length + i) / Math.max(1, job.total));
          const g = groups[i];
          const b = newTable(dataset);
          b.need = new Set(pass === 1 ? need : [...cur, ...filterCols]);
          b.plan = rowGroups;
          b.nextPart = g.pi;
          b.nextGroup = g.gi;
          await loadMore(dataset, b, 1);
          if (abandoned()) { stopped = true; break; }
          const n = b.rowsLoaded, index = sig ? matchIndex(q, b.cols, n) : null;
          for (const ci of cur) (pass === 1 ? wholeFeed1 : wholeFeed2)(ws.get(ci), b.cols[ci].rows, n, index);
          await wait(0);
        }
      }
      if (stopped) { if (my !== job.token) { /* a newer view wants the loop */ job.running = false; setStatus(null); ensureCards(); return; } break; }
      if (!dataset.whole) dataset.whole = new Map();
      for (const ci of at) dataset.whole.set(keyOf(sig, table.cols[ci]), wholeFinish(ws.get(ci)));
      job.done = doneBefore + total;
      redraw(batch);
    }
  } catch (e) {
    console.error(e);
  } finally {
    if (my === job.token) { job.running = false; job.done = 0; job.total = 0; setStatus(null); }
  }
}
