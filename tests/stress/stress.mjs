/**
 * Stress test: drives the real page in Chromium against a large parquet file
 * and records time and memory at each step, so "how big a file can this open"
 * is a number rather than a guess.
 *
 *   uv run --with pyarrow,numpy tools/big-fixture.py /tmp/big.parquet --rows 10000000
 *   node tests/stress/stress.mjs /tmp/big.parquet
 *   node tests/stress/stress.mjs /tmp/big.parquet --scenarios open,grow --limit-mb 8000 --json out.json
 *   node tests/stress/stress.mjs /tmp/big.parquet --app /tmp/older-index.html    # the same run against an older build
 *
 * Scenarios (each starts from a fresh page):
 *   open          open the file; what the first paint costs
 *   grow          keep loading more rows until the file is done or memory runs out
 *   filter        a WHERE over the rows already loaded
 *   scan-narrow   Scan file with a WHERE on a clustered key (should skip nearly everything)
 *   scan-broad    Scan file with a WHERE on a column with no clustering (cannot skip)
 *   agg           a grouped aggregate with a percentile over the loaded rows
 *   pct-all       one column's P99 over EVERY row: load all of it, then aggregate
 *
 * Memory is physical footprint (macOS `footprint`, which counts pages the OS has
 * compressed or swapped; resident size does not) summed over every process the browser
 * started, sampled every 150 ms while each step runs. A step that reaches --limit-mb
 * (default 3500) is killed and reported as a ceiling rather than left to push the machine
 * into swap. The page's own JS heap is reported beside it, since typed arrays and decoded
 * buffers live outside the heap.
 *
 * Needs the column names tools/big-fixture.py writes (id, cat_i_000, metric_f_000,
 * cat_s_000), and playwright as the other browser tests do.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { killTree, memoryProbe } from "./memory.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf("--" + name); return i < 0 ? def : argv[i + 1]; };
const file = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
if (!file) { console.error("usage: node tests/stress/stress.mjs FILE.parquet [--scenarios a,b] [--limit-mb N] [--json out.json]"); process.exit(2); }
const LIMIT_MB = +opt("limit-mb", 3500);
const STEP_MS = +opt("step-timeout", 300) * 1000;
const WANT = (opt("scenarios", "open,grow,filter,scan-narrow,scan-broad,agg,pct-all")).split(",");
const appPath = opt("app", path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "index.html"));   /* --app: another build to compare against */
const results = [];
const mb = (n) => Math.round(n);

/* memory is measured per platform by tests/stress/memory.mjs, which stops rather than fall back to a measure that cannot see swapped memory */
const probe = memoryProbe(argv.includes("--allow-rss"));
const rssMB = (dir) => probe.mb(dir);
console.log("memory measured as: " + probe.what);

async function fresh() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paris-stress-"));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true, viewport: { width: 1500, height: 950 },
    args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
  });
  const page = context.pages()[0] || await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const s = { dir, context, page, cdp, crashed: false, logs: [] };
  page.on("crash", () => { s.crashed = true; });
  page.on("pageerror", (e) => s.logs.push("pageerror: " + e.message));
  await page.goto("file://" + appPath);
  return s;
}
async function close(s) {
  try { await s.context.close(); } catch (_e) { /* killed */ }
  killTree(s.dir, false);
  try { rmSync(s.dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
}
async function heap(s) {
  try {
    const { metrics } = await s.cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { used: m.JSHeapUsedSize / 1048576, total: m.JSHeapTotalSize / 1048576 };
  } catch (_e) { return { used: NaN, total: NaN }; }
}
const idle = (s) => s.page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: STEP_MS, polling: 200 });

/** Runs one step while sampling memory; stops it if it crosses the limit. */
async function step(s, label, fn) {
  let peak = 0, over = false;
  const iv = setInterval(() => {
    const r = rssMB(s.dir);
    if (r > peak) peak = r;
    if (r > LIMIT_MB && !over) { over = true; killTree(s.dir, true); }
  }, 150);
  const t0 = performance.now();
  let value, error = null;
  try { value = await fn(); } catch (e) { error = String(e.message || e).split("\n")[0].slice(0, 160); }
  clearInterval(iv);
  const ms = Math.round(performance.now() - t0);
  if (!over && !s.crashed) peak = Math.max(peak, rssMB(s.dir));
  const outcome = over ? `STOPPED at ${LIMIT_MB} MB limit` : s.crashed ? "TAB CRASHED" : error ? "error: " + error : "ok";
  let h = { used: NaN, total: NaN }, rssNow = NaN;
  if (!over && !s.crashed && !error) { h = await heap(s); rssNow = rssMB(s.dir); }
  const row = { label, ms, peakRssMB: mb(peak), rssMB: mb(rssNow), heapMB: mb(h.used), outcome, ...(value || {}) };
  results.push(row);
  console.log(`  ${label.padEnd(34)} ${String(ms).padStart(7)} ms   mem ${String(mb(peak)).padStart(6)} MB   heap ${String(Number.isNaN(h.used) ? "-" : mb(h.used)).padStart(6)} MB   ${outcome}${value && value.note ? "   " + value.note : ""}`);
  return { over, crashed: s.crashed, error, value };
}
const alive = (r) => !r.over && !r.crashed && !r.error;

async function open(s) {
  return step(s, "open file", async () => {
    await s.page.setInputFiles("#picker", file);
    await idle(s);
    return s.page.evaluate(() => {
      const t = window.PARIS.state.table, d = window.PARIS.state.dataset;
      const shown = t.cols.length - window.PARIS.state.display.hidden.size;
      return { note: `${t.rowsLoaded.toLocaleString()} of ${d.numRows.toLocaleString()} rows, ${shown} of ${t.cols.length} cols shown, ${d.numGroups} row groups`,
        rows: t.rowsLoaded, fileRows: d.numRows, cols: t.cols.length, shown, groups: d.numGroups };
    });
  });
}
async function setSql(s, sql) {
  await s.page.fill("#qsql", sql);
  await s.page.dispatchEvent("#qsql", "input");
}
const text = (s, sel) => s.page.evaluate((q) => (document.querySelector(q) || {}).textContent || "", sel);

const SCENARIOS = {
  async open(s) { await open(s); },

  /** Presses "Load more" until the file is read, the page stops itself at its budget, or memory runs out. */
  async grow(s) {
    const o = await open(s);
    if (!alive(o)) return;
    for (let i = 1; i <= 24; i++) {
      if (await s.page.isHidden("#more")) return;
      const r = await step(s, `Load more (press ${i})`, async () => {
        await s.page.click("#more");
        await idle(s);
        return s.page.evaluate(() => {
          const t = window.PARIS.state.table;
          const note = document.getElementById("memnote");
          return { note: `${t.rowsLoaded.toLocaleString()} rows loaded` + (note && !note.hidden ? " | " + note.textContent.slice(0, 90) : ""),
            rows: t.rowsLoaded, stopped: !!(note && !note.hidden && /stopped|Not loaded/.test(note.textContent)) };
        });
      });
      if (!alive(r) || (r.value && r.value.stopped)) return;
    }
  },

  async filter(s) {
    const o = await open(s); if (!alive(o)) return;
    await step(s, "Run: WHERE (whole file)", async () => {
      await setSql(s, "SELECT id, cat_i_000, metric_f_000\nFROM t\nWHERE cat_i_000 = 3;");
      await s.page.click("#qrun"); await idle(s);
      return { note: ((await text(s, "#qstat")) + " | " + (await text(s, "#qplan"))).replace(/\s+/g, " ").trim().slice(0, 220) };
    });
  },

  async "scan-narrow"(s) {
    const o = await open(s); if (!alive(o)) return;
    const mid = Math.floor(o.value.fileRows / 2);
    await step(s, "Run: WHERE on a clustered key", async () => {
      await setSql(s, `SELECT id, cat_i_000, metric_f_000\nFROM t\nWHERE id >= ${mid} AND id < ${mid + 1000};`);
      await s.page.click("#qrun"); await idle(s);
      return { note: (await text(s, "#qplan")).replace(/\s+/g, " ").trim().slice(0, 150) };
    });
  },

  async "scan-broad"(s) {
    const o = await open(s); if (!alive(o)) return;
    await step(s, "Run: WHERE on an unclustered col", async () => {
      await setSql(s, "SELECT id, cat_i_000, metric_f_000\nFROM t\nWHERE cat_i_000 = 3;");
      await s.page.click("#qrun"); await idle(s);
      return { note: (await text(s, "#qplan")).replace(/\s+/g, " ").trim().slice(0, 150) };
    });
  },

  async agg(s) {
    const o = await open(s); if (!alive(o)) return;
    await step(s, "Run: grouped P99 (whole file)", async () => {
      await setSql(s, "SELECT cat_s_000, COUNT(*), QUANTILE_CONT(metric_f_000, 0.99)\nFROM t\nGROUP BY cat_s_000;");
      await s.page.click("#qrun"); await idle(s);
      return { note: ((await text(s, "#qstat")) + " | " + (await text(s, "#qplan")) + " | " + (await text(s, "#memnote"))).replace(/\s+/g, " ").trim().slice(0, 240) };
    });
  },

  /** Only metrics that fold into running totals: memory should not depend on how many rows there are. */
  async "agg-mergeable"(s) {
    const o = await open(s); if (!alive(o)) return;
    /* --budget-mb N: the page's own memory budget for this run, after opening. Holding the columns the query names would
       not fit under a small one, so a run that completes under it proves the aggregate folds one row group at a time. */
    if (opt("budget-mb", null)) await s.page.evaluate((n) => window.PARIS.setBudgetMB(n), +opt("budget-mb", 0));
    await step(s, "Run: COUNT/AVG/STD/MIN/MAX by group", async () => {
      await setSql(s, "SELECT cat_s_000, COUNT(*), AVG(metric_f_000), STDDEV_SAMP(metric_f_001), MIN(metric_f_002), MAX(count_l_003), SUM(count_l_004)\nFROM t\nGROUP BY cat_s_000;");
      await s.page.click("#qrun"); await idle(s);
      return { note: ((await text(s, "#qstat")) + " | " + (await text(s, "#qplan"))).replace(/\s+/g, " ").trim().slice(0, 200) };
    });
  },

  /** High-cardinality: a distinct count and a GROUP BY whose running totals outgrow the budget, answered in hash slices. */
  async "agg-highcard"(s) {
    const o = await open(s); if (!alive(o)) return;
    const shape = async () => s.page.evaluate(() => {
      const v = window.PARIS.state.view;
      return v ? { groups: v.cols[0].rows.length, sums: v.cols.map((c) => (typeof c.rows[0] === "number" ? c.rows.reduce((a, b) => a + b, 0) : null)), first: v.cols.map((c) => c.rows[0]) } : null;
    });
    await step(s, "Run: COUNT(DISTINCT hi_s_000) over the whole file", async () => {
      await setSql(s, "SELECT COUNT(DISTINCT hi_s_000), COUNT(*)\nFROM t;");
      await s.page.click("#qrun"); await idle(s);
      const r = await shape();
      return { note: JSON.stringify(r && r.first) + " | " + (await text(s, "#memnote")).slice(0, 160) + (await text(s, "#qplan")).slice(0, 120), distinct: r && r.first[0], count: r && r.first[1] };
    });
    await step(s, "Run: SELECT id, COUNT(*), SUM(metric_f_000) GROUP BY id (one group per row)", async () => {
      await setSql(s, "SELECT id, COUNT(*), SUM(metric_f_000)\nFROM t\nGROUP BY id;");
      await s.page.click("#qrun"); await idle(s);
      const r = await shape();
      return { note: (r ? r.groups.toLocaleString() + " groups, counts add to " + r.sums[1].toLocaleString() + " | " : "") + (await text(s, "#memnote")).slice(0, 200), groups: r && r.groups, countSum: r && r.sums[1], sum: r && r.sums[2] };
    });
  },

  /** The top rows of the whole file by a column: ranking reads that one column a row group at a time. */
  async topn(s) {
    const o = await open(s); if (!alive(o)) return;
    await step(s, "Run: top 100 by metric_f_000 (whole file)", async () => {
      await setSql(s, "SELECT id, metric_f_000, cat_s_000\nFROM t\nORDER BY metric_f_000 DESC, id\nLIMIT 100;");
      await s.page.click("#qrun"); await idle(s);
      const got = await s.page.evaluate(() => {
        const v = window.PARIS.state.view;
        return v ? { n: v.count, ids: Array.from({ length: Math.min(100, v.count) }, (_, i) => v.cols[0].rows[v.index ? v.index[i] : i]), first: v.cols[1].rows[v.index ? v.index[0] : 0] } : null;
      });
      return { note: `${got && got.n} rows, largest ${got && got.first} | ` + (await text(s, "#qplan")).replace(/\s+/g, " ").trim().slice(0, 160), ids: got && got.ids, largest: got && got.first };
    });
  },

  /** A card over the whole file for a numeric and a text column: exact, one row group at a time. */
  async cards(s) {
    const o = await open(s); if (!alive(o)) return;
    for (const name of ["metric_f_000", "cat_s_000", "hi_s_000"]) {
      await step(s, "whole-file card: " + name, async () => {
        await s.page.evaluate((n) => { const t = window.PARIS.state.table; return window.PARIS.wholeCard(t.cols.findIndex((c) => c.name === n)); }, name);
        await idle(s);
        const card = await s.page.evaluate((n) => {
          const t = window.PARIS.state.table, c = t.cols.find((x) => x.name === n), w = window.PARIS.state.dataset.whole && window.PARIS.state.dataset.whole.get(c.key);
          return w ? { n: w.n, nulls: w.nulls, min: w.min, max: w.max, mean: w.mean, count: w.count, distinct: w.distinct, capped: w.distinctCapped, top: w.top && w.top.slice(0, 3) } : null;
        }, name);
        return { note: JSON.stringify(card).slice(0, 220), card, name };
      });
    }
  },

  /** A large-by-small join: the larger side is streamed, so the peak should not follow its row count. Needs --dim SMALL.parquet with an `id` column. */
  async join(s) {
    const dim = opt("dim", null);
    if (!dim) { console.log("  join: pass --dim SMALL.parquet (a file with an id column)"); return; }
    const o = await open(s); if (!alive(o)) return;
    await step(s, "Join the file to " + path.basename(dim) + " on id", async () => {
      await s.page.click("#toggleJoin");
      await s.page.setInputFiles("#jpicker", dim);
      await s.page.waitForTimeout(500);
      await s.page.selectOption("#jkeyA", { label: "id" });
      await s.page.selectOption("#jkeyB", { label: "id" });
      await s.page.click("#jrun"); await idle(s);
      const r = await s.page.evaluate(() => ({ rows: window.PARIS.state.table.rowsLoaded, err: (document.getElementById("err") || {}).textContent || "" }));
      return { note: `${r.rows.toLocaleString()} result rows ${r.err.slice(0, 200)}`, rows: r.rows };
    });
  },

  async "pct-all"(s) {
    const o = await open(s); if (!alive(o)) return;
    await step(s, "Run: P99 of one column (whole file)", async () => {
      await setSql(s, "SELECT QUANTILE_CONT(metric_f_000, 0.99)\nFROM t;");
      await s.page.click("#qrun"); await idle(s);
      const value = await s.page.evaluate(() => {
        const v = window.PARIS.state.view;
        return v && v.cols[0] && v.cols[0].rows.length ? v.cols[0].rows[0] : null;
      });
      const rows = await s.page.evaluate(() => window.PARIS.state.table.rowsLoaded);
      return { note: `P99 = ${value} over ${rows.toLocaleString()} rows | ` + (await text(s, "#qplan")).replace(/\s+/g, " ").trim().slice(0, 120), p99: value, rows };
    });
  },

  /** Escape during a whole-file run: it stops, says so, and the view it replaced comes back intact. */
  async cancel(s) {
    const o = await open(s); if (!alive(o)) return;
    const before = o.value.rows;
    await step(s, "Run, then Escape half way", async () => {
      /* enough columns that the read takes a moment and there is one to interrupt, few enough to fit the budget */
      const avgs = Array.from({ length: 3 }, (_, i) => "AVG(metric_f_" + String(i).padStart(3, "0") + ")").join(", ");
      await setSql(s, "SELECT cat_s_000, COUNT(*), " + avgs + "\nFROM t\nGROUP BY cat_s_000;");
      await s.page.click("#qrun");
      await s.page.waitForFunction(() => { const d = document.getElementById("progress"); return d && d.open; }, null, { timeout: 30000 });
      await s.page.keyboard.press("Escape");        /* the moment the popup is up, while it is still reading: the compute step blocks the page and cannot be interrupted */
      await idle(s);
      await s.page.waitForFunction(() => document.getElementById("busy").hidden && window.PARIS.state.table.rowsLoaded > 0, null, { timeout: 60000 });
      const after = await s.page.evaluate(() => ({ rows: window.PARIS.state.table.rowsLoaded, view: !!window.PARIS.state.view }));
      const note = (await text(s, "#memnote")).replace(/\s+/g, " ").trim();
      const stopped = /Cancelled/.test(note);
      return { note: (stopped ? "CANCELLED" : "the run finished before Escape landed (not a cancel test)") + `: ${after.rows.toLocaleString()} rows (had ${before.toLocaleString()}), view ${after.view ? "restored" : "MISSING"} | ${note}` };
    });
  },

  /**
   * Memory each kind of column costs once decoded, one row group at a time. The file is
   * handed to the page's own reader through a spare file input, so nothing but the columns
   * being measured is ever decoded (opening it through the picker would decode every
   * column first, and the noise from that swamps the numbers).
   */
  async calibrate() {
    const kinds = ["id", "ts", "cat_i", "cat_s", "hi_s", "metric_f", "count_l", "ratio_f32", "flag_b", "money_d", "day_d", "sparse", "long_s", "list_i", "list_s", "struct_m", "dec_w"];
    for (const kind of kinds) {
      const s2 = await fresh();
      try {
        await s2.page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.id = "cal"; document.body.appendChild(i); });
        await s2.page.setInputFiles("#cal", file);
        await s2.page.evaluate(() => window.gc && window.gc());
        await new Promise((r) => setTimeout(r, 500));
        const base = memoryMB(s2.dir);
        const info = await s2.page.evaluate(async (k) => {
          const P = window.PARIS;
          const d = await P.readDataset(P.entriesFromFiles([document.getElementById("cal").files[0]]));
          const t = P.newTable(d);
          const want = new Set();
          t.cols.forEach((c, i) => { if (c.name === k || c.name.startsWith(k + "_")) want.add(i); });
          t.need = want;
          const est = P.groupsBytes(d, t, P.groupsAhead(d, t, 1), [...want]);      /* what the page would have said before decoding */
          await P.loadMore(d, t, 1);
          let cells = 0; for (const i of want) cells += t.cols[i].rows.length;
          window.__held = t;
          return { cols: want.size, cells, est };
        }, kind);
        await s2.page.evaluate(() => window.gc && window.gc());
        await new Promise((r) => setTimeout(r, 700));
        const after = memoryMB(s2.dir);
        const per = (after - base) * 1048576 / Math.max(1, info.cells);
        if (!info.cells) { console.log("  " + kind + ": not in this file"); await close(s2); continue; }
        /* the estimate includes a factor of two for the decode's peak, so it should sit above what stays held: at least 0.8x (the measure is good to about 15 MB) and, to not refuse needlessly, not far above */
        const ratio = info.est / Math.max(1, (after - base) * 1048576);
        /* under about 40 MB the reading is dominated by what starting a decode costs (workers, buffers), not by the cells */
        const verdict = (after - base) < 40 ? "too small to judge" : ratio < 0.8 ? "UNDER-ESTIMATE" : ratio > 6 ? "over-estimate (safe)" : "ok";
        results.push({ label: "calibrate " + kind, cols: info.cols, cells: info.cells, deltaMB: mb(after - base), bytesPerCell: +per.toFixed(1), estimatedMB: mb(info.est / 1048576), ratio: +ratio.toFixed(2), verdict });
        console.log(`  ${kind.padEnd(10)} ${String(info.cols).padStart(3)} cols  ${String(info.cells).padStart(10)} cells   +${String(mb(after - base)).padStart(5)} MB   ${per.toFixed(1).padStart(6)} bytes/cell   estimate ${String(mb(info.est / 1048576)).padStart(6)} MB = ${ratio.toFixed(2)}x  ${verdict}`);
      } catch (e) { console.log("  " + kind + " failed: " + String(e.message).split("\n")[0]); }
      await close(s2);
    }
  },
};

console.log(`stress: ${file}\n  memory limit ${LIMIT_MB} MB, step timeout ${STEP_MS / 1000}s, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 1073741824)} GB RAM\n`);
for (const name of WANT) {
  if (!SCENARIOS[name]) { console.log("unknown scenario " + name); continue; }
  console.log(name);
  const s = await fresh();
  try { await SCENARIOS[name](s); } catch (e) { console.log("  scenario failed: " + String(e.message).split("\n")[0]); }
  for (const l of s.logs.slice(0, 3)) console.log("  " + l);
  await close(s);
}
const out = opt("json", null);
if (out) writeFileSync(out, JSON.stringify({ file, limitMB: LIMIT_MB, when: new Date().toISOString(), results }, null, 1));
/* the estimate must not fall below what decoding actually left held: that is the check calibrate exists for */
const under = results.filter((r) => r.verdict === "UNDER-ESTIMATE");
if (under.length) { console.log("\nthe memory estimate is below the measurement for: " + under.map((r) => r.label + " (" + r.ratio + "x)").join(", ")); process.exitCode = 1; }
