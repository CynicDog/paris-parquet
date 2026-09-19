// Whole-file summary cards. A card above a column describes the rows read; this reads the one column across the
// whole file, a row group at a time (memory: one row group of one column, plus a few numbers, plus at most a few
// thousand string candidates), and replaces the card with one that says so.

import { budgetBytes, bytesText, groupsAhead, groupsBytes } from "./budget.js";
import { loadMore } from "./columns.js";
import { newTable } from "./dataset.js";
import { busy, showMemNote } from "./main.js";
import { progressCancelled, progressStep } from "./progress.js";
import { newWhole, wholeFeed1, wholeFeed2, wholeFinish, wholeNeedsPass2, wholeStart2 } from "./types.js";
import { refreshView } from "./ui-grid.js";
import { num, state } from "./view.js";

const CARD_STEPS = [
  { label: "Check the memory budget", why: "One row group of this one column is all that is held at a time; this checks it fits before reading." },
  { label: "Read", why: "Decoding the column one row group at a time and folding it into the card's totals (count, nulls, range, mean, and for text the most frequent values), then letting it go." },
  { label: "Refine", why: "A histogram needs the range first, and text values that were too many to count exactly are recounted, so the card is exact rather than an estimate." },
];
const cardTick = () => new Promise((r) => setTimeout(r, 0));

/** Recomputes one column's card over every row of the file, then redraws the cards. */
export async function wholeCard(ci) {
  const dataset = state.dataset, table = state.table;
  if (!dataset || !table || !table.cols[ci]) return;
  const col = table.cols[ci];
  const stop = { asked: false };
  busy(true, "Summarizing \u201c" + col.name + "\u201d over the whole file", CARD_STEPS, () => { stop.asked = true; });
  await cardTick();
  try {
    progressStep(0, 0.5, "estimating one row group of this column");
    const probe = newTable(dataset);
    probe.need = new Set([ci]);
    const groups = groupsAhead(dataset, probe, Infinity);
    const biggest = groups.reduce((mx, g) => Math.max(mx, groupsBytes(dataset, probe, [g], [ci])), 0);
    if (biggest > budgetBytes()) {
      showMemNote("Not computed over the whole file: one row group of \u201c" + col.name + "\u201d would take about " + bytesText(biggest) +
        " once decoded, over this page's " + bytesText(budgetBytes()) + " memory budget.");
      return;
    }
    const w = newWhole(col.spec);
    const pass = async (feed, step, label) => {
      for (let i = 0; i < groups.length; i++) {
        if (stop.asked || progressCancelled()) return false;
        const g = groups[i];
        progressStep(step, i / groups.length, label + ": row group " + num(i + 1) + " of " + num(groups.length));
        const batch = newTable(dataset);
        batch.need = new Set([ci]);
        batch.nextPart = g.pi;
        batch.nextGroup = g.gi;
        await loadMore(dataset, batch, 1);
        if (stop.asked || progressCancelled()) return false;
        feed(w, batch.cols[ci].rows, batch.rowsLoaded);
        await cardTick();
      }
      return true;
    };
    if (!(await pass(wholeFeed1, 1, "counting"))) { showMemNote("Cancelled: the card was not changed."); return; }
    if (wholeNeedsPass2(w)) {
      wholeStart2(w);
      if (!(await pass(wholeFeed2, 2, w.kind === "string" ? "recounting the most frequent values" : "drawing the histogram"))) { showMemNote("Cancelled: the card was not changed."); return; }
    }
    if (!dataset.whole) dataset.whole = new Map();
    dataset.whole.set(col.key, wholeFinish(w));
    showMemNote(null);
    refreshView(true);
  } catch (e) {
    showMemNote("Could not summarize \u201c" + col.name + "\u201d over the whole file: " + e.message);
  } finally { busy(false); }
}
