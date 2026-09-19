// The progress popup: what the page is doing, which step of it, and why, for
// anything that takes long enough to notice. It is a native <dialog>, so the page
// behind it is inert, focus is held inside, and Escape asks to cancel, with no
// script for any of that.
//
// A caller declares the steps up front ("read the footers", "plan which row groups
// can match", "decode") so the person sees the whole path and where they are on it,
// then moves through them, giving each a fraction and a one-line explanation:
//
//   progressStart("Running your query", [
//     { label: "Plan", why: "Ruling row groups out from their own statistics." },
//     { label: "Read", why: "Decoding only the row groups that could match." } ]);
//   progressStep(1, 0.4, "row group 12 of 30");
//   progressFinish();
//
// Nothing shows for the first SHOW_AFTER ms, so quick work never flashes a popup,
// and once shown it stays MIN_VISIBLE ms so it does not flicker. #busy stays as a
// plain flag (hidden = idle) that the tests and the rest of the page read; it is
// never displayed.

const SHOW_AFTER = 250;
const MIN_VISIBLE = 450;

const pg = { open: false, steps: [], at: 0, frac: 0, shownAt: 0, showTimer: 0, closeTimer: 0, title: "", detail: "", cancelled: false, onCancel: null, depth: 0 };
const pgEl = (id) => document.getElementById(id);

function pgPaint() {
  const dlg = pgEl("progress");
  if (!dlg) return;
  pgEl("ptitle").textContent = pg.title || "Working…";
  const n = pg.steps.length;
  const list = pgEl("psteps");
  list.hidden = !n;
  list.innerHTML = "";
  pg.steps.forEach((st, i) => {
    const li = document.createElement("li");
    const state = i < pg.at ? "done" : i === pg.at ? "now" : "todo";
    li.className = state;
    const mark = document.createElement("span");
    mark.className = "pmark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = state === "done" ? "✓" : state === "now" ? "▶" : "○";
    const text = document.createElement("span");
    text.className = "ptext";
    text.textContent = st.label;
    const sr = document.createElement("span");
    sr.className = "sr";
    sr.textContent = state === "done" ? " (done)" : state === "now" ? " (in progress)" : " (waiting)";
    li.append(mark, text, sr);
    if (state === "now" && st.why) {
      const why = document.createElement("div");
      why.className = "pwhy";
      why.textContent = st.why;
      li.append(why);
    }
    if (state === "now") li.setAttribute("aria-current", "step");
    list.append(li);
  });
  const bar = pgEl("pbar");
  const determinate = n > 0 && pg.frac != null;
  const overall = n ? Math.min(1, (pg.at + (pg.frac || 0)) / n) : 0;
  bar.classList.toggle("indet", !determinate);
  if (determinate) {
    bar.setAttribute("aria-valuenow", String(Math.round(overall * 100)));
    bar.setAttribute("aria-valuetext", "step " + (pg.at + 1) + " of " + n + ", " + Math.round(overall * 100) + " percent");
  } else {
    bar.removeAttribute("aria-valuenow");
    bar.setAttribute("aria-valuetext", "working");
  }
  pgEl("pfill").style.width = determinate ? Math.round(overall * 100) + "%" : "";
  pgEl("ppct").textContent = determinate ? Math.round(overall * 100) + "%" : "";
  pgEl("pdetail").textContent = pg.detail || "";
  pgEl("pcancel").disabled = !pg.onCancel;
  pgEl("pcancel").textContent = pg.cancelled ? "Stopping…" : "Cancel";
  if (pg.cancelled) pgEl("pcancel").disabled = true;
}

function pgReveal() {
  const dlg = pgEl("progress");
  if (!dlg || pg.open || !pg.depth) return;
  pg.open = true;
  pg.shownAt = performance.now();
  pgPaint();
  try { if (!dlg.open) dlg.showModal(); } catch (_e) { /* not attached yet: stay quiet rather than throw */ }
}

function pgHide() {
  const dlg = pgEl("progress");
  clearTimeout(pg.showTimer);
  pg.showTimer = 0;
  if (dlg && dlg.open) dlg.close();
  pg.open = false;
}

/** Marks the page busy; the popup itself only appears if the work outlasts SHOW_AFTER. */
export function progressStart(title, steps, onCancel, immediate) {
  clearTimeout(pg.closeTimer);
  pg.depth++;
  if (pg.depth === 1) {
    pg.steps = steps || [];
    pg.at = 0;
    pg.frac = steps && steps.length ? 0 : null;
    pg.detail = "";
    pg.cancelled = false;
    pg.onCancel = onCancel || null;
  } else if (steps && steps.length && !pg.steps.length) {
    pg.steps = steps; pg.at = 0; pg.frac = 0;
  }
  if (title) pg.title = title;
  const flag = pgEl("busy");
  if (flag) flag.hidden = false;
  if (!pg.open && !pg.showTimer) pg.showTimer = setTimeout(pgReveal, immediate ? 0 : SHOW_AFTER);
  if (pg.open) pgPaint();
}

/** Moves to step `i` (0-based), `frac` of the way through it, with a one-line detail. */
export function progressStep(i, frac, detail) {
  if (!pg.depth) return;
  pg.at = Math.max(0, Math.min(i, Math.max(0, pg.steps.length - 1)));
  pg.frac = frac == null ? null : Math.max(0, Math.min(1, frac));
  if (detail != null) pg.detail = detail;
  if (pg.open) pgPaint();
}

/** Just says something, for work that has no declared steps. */
export function progressSay(text) {
  if (!pg.depth) return;
  if (!pg.steps.length) pg.title = text || pg.title;
  pg.detail = pg.steps.length ? text : "";
  if (pg.open) pgPaint();
}

export function progressFinish() {
  if (!pg.depth) return;
  pg.depth = Math.max(0, pg.depth - 1);
  if (pg.depth) return;
  const flag = pgEl("busy");
  if (flag) flag.hidden = true;
  clearTimeout(pg.showTimer);
  pg.showTimer = 0;
  if (!pg.open) return;
  pg.at = pg.steps.length;
  pg.frac = 0;
  pgPaint();
  /* the work is done, so the page must not stay inert for the rest of the minimum display time: the popup
     lingers so it does not flicker, but as a plain (non-modal) dialog that lets input through */
  const dlg = pgEl("progress");
  if (dlg && dlg.open && dlg.matches(":modal")) {
    try { dlg.close(); dlg.show(); } catch (_e) { /* if it cannot be reopened it simply closes */ }
  }
  const left = MIN_VISIBLE - (performance.now() - pg.shownAt);
  clearTimeout(pg.closeTimer);
  pg.closeTimer = setTimeout(pgHide, Math.max(0, left));
}

export function progressCancelled() { return pg.cancelled; }
export function progressRequestCancel() {
  if (!pg.onCancel || pg.cancelled) return;
  pg.cancelled = true;
  try { pg.onCancel(); } catch (_e) { /* the work is stopping either way */ }
  if (pg.open) pgPaint();
}

/** Wires the dialog's own controls; called once when the page starts. */
export function initProgress() {
  const dlg = pgEl("progress");
  if (!dlg) return;
  pgEl("pcancel").addEventListener("click", progressRequestCancel);
  /* Escape closes a modal dialog by default; here it asks the work to stop instead */
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); progressRequestCancel(); });
}
