/**
 * Stress test: drives the real page in Chromium against a large parquet file
 * and records time and memory at each step, so "how big a file can this open"
 * is a number rather than a guess.
 *
 *   uv run --with pyarrow,numpy tools/big-fixture.py /tmp/big.parquet --rows 10000000
 *   node tests/stress/stress.mjs /tmp/big.parquet
 *   node tests/stress/stress.mjs /tmp/big.parquet --scenarios open,grow --limit-mb 8000 --json out.json
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

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf("--" + name); return i < 0 ? def : argv[i + 1]; };
const file = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
if (!file) { console.error("usage: node tests/stress/stress.mjs FILE.parquet [--scenarios a,b] [--limit-mb N] [--json out.json]"); process.exit(2); }
const LIMIT_MB = +opt("limit-mb", 3500);
const STEP_MS = +opt("step-timeout", 300) * 1000;
const WANT = (opt("scenarios", "open,grow,filter,scan-narrow,scan-broad,agg,pct-all")).split(",");
const appPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "index.html");
const results = [];
const mb = (n) => Math.round(n);

/**
 * Physical memory, in MB, of the browser process and every process under it, as
 * macOS's `footprint` reports it. That is deliberately not resident size: under memory
 * pressure the OS compresses and swaps a renderer's pages, its resident size drops, and
 * a limit based on it never fires while the machine is being pushed over. (An earlier
 * version of this script did exactly that: a renderer at 13 GB read as 2 GB.) Child
 * processes do not carry the profile path on their command line, so the tree is walked
 * from the one process that does. Falls back to resident size where `footprint` is missing.
 */
function memoryMB(dir) {
  let out = "";
  try { out = execSync("ps -axo pid=,ppid=,rss=,command=", { maxBuffer: 1 << 26 }).toString(); } catch (_e) { return 0; }
  const rows = [], kids = new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const r = { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] };
    rows.push(r);
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const tree = [], seen = new Set();
  const walk = (r) => { if (seen.has(r.pid)) return; seen.add(r.pid); tree.push(r); for (const k of kids.get(r.pid) || []) walk(k); };
  for (const r of rows.filter((x) => x.cmd.includes(dir) && !x.cmd.includes("--type="))) walk(r);
  if (!tree.length) return 0;
  try {
    const fp = execSync("footprint " + tree.map((r) => "-p " + r.pid).join(" ") + " 2>/dev/null", { maxBuffer: 1 << 26 }).toString();
    let mb = 0, hits = 0;
    for (const line of fp.split("\n")) {
      const m = /\[\d+\].*Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(line);
      if (!m) continue;
      hits++;
      mb += +m[1] * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1);
    }
    if (hits) return mb;
  } catch (_e) { /* fall through */ }
  return tree.reduce((n, r) => n + r.rss, 0) / 1024;
}
const rssMB = memoryMB;

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
  try { execSync(`pkill -f ${JSON.stringify(s.dir)}`); } catch (_e) { /* none left */ }
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
    if (r > LIMIT_MB && !over) { over = true; try { execSync(`pkill -9 -f ${JSON.stringify(s.dir)}`); } catch (_e) { /* gone */ } }
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
    const kinds = ["id", "ts", "cat_i", "cat_s", "hi_s", "metric_f", "count_l", "ratio_f32", "flag_b", "money_d", "day_d", "sparse"];
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
          await P.loadMore(d, t, 1);
          let cells = 0; for (const i of want) cells += t.cols[i].rows.length;
          window.__held = t;
          return { cols: want.size, cells };
        }, kind);
        await s2.page.evaluate(() => window.gc && window.gc());
        await new Promise((r) => setTimeout(r, 700));
        const after = memoryMB(s2.dir);
        const per = (after - base) * 1048576 / Math.max(1, info.cells);
        results.push({ label: "calibrate " + kind, cols: info.cols, cells: info.cells, deltaMB: mb(after - base), bytesPerCell: +per.toFixed(1) });
        console.log(`  ${kind.padEnd(10)} ${String(info.cols).padStart(3)} cols  ${String(info.cells).padStart(10)} cells   +${String(mb(after - base)).padStart(5)} MB   ${per.toFixed(1).padStart(6)} bytes/cell`);
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
