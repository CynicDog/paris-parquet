/**
 * The memory budget and the progress popup, in a real browser: a file that will not fit is
 * narrowed or refused with a reason instead of taking the tab down, the popup says which step
 * it is on and why, and none of it costs a request.
 *
 *   node tests/browser/browser-memory.mjs /tmp/fx/push
 *
 * The budget is set to 1 MB so a small fixture trips it; the real default is gigabytes, and
 * tests/stress/stress.mjs is what exercises that against a genuinely large file.
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) || "/tmp/fx/push";
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "..", "index.html");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const requests = [];
await ctx.route("**/*", (route, req) => {
  requests.push(req.url());
  if (req.url().startsWith("file://")) route.continue(); else route.abort();
});
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push("console: " + m.text()); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s) => { failed++; console.log("FAIL " + s); };
const idle = () => page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 120000 });
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, " ").trim());
const open = async (file) => { await page.setInputFiles("#picker", path.join(dir, file)); await idle(); };

await page.goto("file://" + appPath);

/* ---------- the popup ---------- */
if ((await page.getAttribute("#progress", "aria-labelledby")) === "ptitle") ok("the popup is a labelled dialog");
else bad("the popup is not labelled");
if ((await page.getAttribute("#pbar", "role")) === "progressbar") ok("and its bar is a real progressbar");
else bad("the bar has no progressbar role");

/* quick work never flashes it */
await page.evaluate(() => { window.PARIS.progressStart("Quick", [{ label: "One", why: "x" }]); window.PARIS.progressFinish(); });
await page.waitForTimeout(500);
if (!(await page.$eval("#progress", (d) => d.open))) ok("work that finishes at once never opens the popup");
else bad("the popup opened for instant work");

/* slow work does, with its steps, the one in progress explained, and a live bar */
await page.evaluate(() => {
  window.__cancelled = false;
  window.PARIS.progressStart("Testing steps", [
    { label: "Plan", why: "Ruling row groups out from their statistics." },
    { label: "Read", why: "Decoding only what could match." },
  ], () => { window.__cancelled = true; });
});
await page.waitForTimeout(450);
if (await page.$eval("#progress", (d) => d.open && d.matches(":modal"))) ok("slow work opens a modal popup");
else bad("no modal popup for slow work");
const items = await page.$$eval("#psteps li", (l) => l.map((x) => ({ cls: x.className, cur: x.getAttribute("aria-current"), text: x.textContent.replace(/\s+/g, " ").trim() })));
if (items.length === 2 && items[0].cur === "step" && /Ruling row groups out/.test(items[0].text)) ok("it lists the steps and explains the one in progress: " + items[0].text);
else bad("steps: " + JSON.stringify(items));
if (/\(waiting\)/.test(items[1].text) && !/Decoding only/.test(items[1].text)) ok("later steps are marked waiting, not explained yet");
else bad("second step: " + items[1].text);
await page.evaluate(() => window.PARIS.progressStep(1, 0.5, "row group 2 of 4"));
const now = await page.$eval("#pbar", (b) => b.getAttribute("aria-valuenow"));
if (now === "75") ok("the bar reports 75% at half way through the second of two steps");
else bad("aria-valuenow " + now);
if ((await text("#pdetail")) === "row group 2 of 4") ok("and the line under it says where: " + await text("#pdetail"));
else bad("detail: " + await text("#pdetail"));
const done = await page.$eval("#psteps li", (l) => l.className);
if (done === "done") ok("finished steps are marked done");
else bad("first step class " + done);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
if (await page.evaluate(() => window.__cancelled)) ok("Escape asks the work to stop instead of just closing the popup");
else bad("Escape did not cancel");
if (await page.$eval("#progress", (d) => d.open)) ok("the popup stays up while the work winds down");
else bad("the popup closed before the work said it was done");
await page.evaluate(() => window.PARIS.progressFinish());
/* it lingers a moment so it does not flicker, but must not keep the page inert while it does */
const lingering = await page.evaluate(() => { const d = document.getElementById("progress"); return { open: d.open, modal: d.matches(":modal") }; });
if (lingering.open && !lingering.modal) ok("once the work is done the popup lingers as a non-modal dialog, so it does not block input");
else bad("popup right after the work finished: " + JSON.stringify(lingering));
await page.waitForFunction(() => !document.getElementById("progress").open, null, { timeout: 5000 });
ok("and closes on its own");

/* ---------- the budget, on a wide file ---------- */
await page.evaluate(() => window.PARIS.setBudgetMB(1));
await open("widelong.parquet");
const dims = await page.evaluate(() => {
  const P = window.PARIS, t = P.state.table;
  return { cols: t.cols.length, hidden: P.state.display.hidden.size, decoded: t.cols.filter((c) => c.rows.length).length, rows: t.rowsLoaded, fileRows: P.state.dataset.numRows };
});
console.log(`     ${dims.cols} columns, ${dims.hidden} hidden, ${dims.decoded} decoded, ${dims.rows} of ${dims.fileRows} rows`);
if (dims.hidden > 0 && dims.decoded === dims.cols - dims.hidden) ok("a file too big for the budget is opened with fewer columns, and only those are decoded");
else bad(`hidden ${dims.hidden}, decoded ${dims.decoded} of ${dims.cols}`);
const note = await text("#memnote");
if (/^Showing \d+ of \d+ columns\. Decoding all of them would take about/.test(note)) ok("and says so: " + note);
else bad("note: " + note);
if (await page.$("#memnote button")) ok("with a button to choose columns");
else bad("no way to choose columns from the note");

/* asking for more than fits is stopped with a reason */
if (await page.isVisible("#all")) {
  const before = dims.rows;
  await page.click("#all");
  await idle();
  const after = await page.evaluate(() => window.PARIS.state.table.rowsLoaded);
  const n2 = await text("#memnote");
  if (/memory budget/.test(n2) && (after === before || /stopped/.test(n2))) ok("Load all past the budget is stopped, with the reason: " + n2.slice(0, 110) + "…");
  else bad(`Load all: ${before} -> ${after}, note: ${n2}`);
}

/* showing more columns than fit keeps the extra ones hidden */
await page.click("#toggleCols");
await page.click("[data-act='cpall']");
const still = await page.evaluate(() => window.PARIS.state.display.hidden.size);
if (still > 0) ok("Show all columns cannot over-fill the budget: " + still + " stay hidden");
else bad("every column was shown past the budget");
if (/Kept \d+ columns? hidden/.test(await text("#memnote"))) ok("and the note explains: " + await text("#memnote"));
else bad("note after show-all: " + await text("#memnote"));
await page.keyboard.press("Escape");
await page.click("[data-act='cpclose']").catch(() => {});

/* a mergeable aggregate is folded one row group at a time, so it does not need the column in memory: under a
   budget far too small to hold 200,000 rows it still answers about all of them */
await page.goto("file://" + appPath);
await page.evaluate(() => window.PARIS.setBudgetMB(1));
await open("sorted.parquet");
const ask = async (sql) => {
  await page.fill("#qsql", sql);
  await page.dispatchEvent("#qsql", "input");
  await page.waitForTimeout(450);
  await page.click("#qrun");
  await idle();
  return page.evaluate(() => ({
    memnote: document.getElementById("memnote").textContent.replace(/\s+/g, " ").trim(),
    action: (document.querySelector("#memnote button") || {}).textContent || "",
    plan: document.getElementById("qplan").textContent.replace(/\s+/g, " ").trim(),
    first: window.PARIS.state.view && window.PARIS.state.view.cols.map((c) => c.rows[0]),
    cols: window.PARIS.state.view && window.PARIS.state.view.cols.map((c) => c.rows.slice(0, 50)),
    sums: window.PARIS.state.view && window.PARIS.state.view.cols.map((c) => (typeof c.rows[0] === "number" ? c.rows.reduce((a, b) => a + b, 0) : null)),
    err: (document.getElementById("err") || {}).textContent || "",
  }));
};
const folded = await ask("SELECT COUNT(*), AVG(id), MIN(id), MAX(id), STDDEV_SAMP(id) FROM sorted");
if (folded.first && folded.first[0] === 200000 && folded.first[1] === 99999.5 && folded.first[2] === 0 && folded.first[3] === 199999) ok("under a 1 MB budget a COUNT/AVG/MIN/MAX/STD over 200,000 rows still answers, folded a row group at a time: " + JSON.stringify(folded.first.slice(0, 4)));
else bad("streamed aggregate under 1 MB: " + JSON.stringify(folded));
if (/^Whole file\. Searched all 200,000 rows\./.test(folded.plan) && !folded.memnote) ok("with no refusal, and the scope line says it covered every row: " + folded.plan);
else bad("scope/note after the streamed aggregate: " + JSON.stringify(folded));
/* a popup that lingers after the work must not eat what is typed straight after it */
await page.evaluate(() => { window.PARIS.progressStart("Lingering", [{ label: "One", why: "x" }]); });
await page.waitForFunction(() => document.getElementById("progress").open, null, { timeout: 5000 });
await page.evaluate(() => window.PARIS.progressFinish());
await page.fill("#qsql", "SELECT 7 AS typed_at_once");
if ((await page.inputValue("#qsql")) === "SELECT 7 AS typed_at_once" && (await page.evaluate(() => document.activeElement.id)) === "qsql") ok("typing straight after a run, while the popup lingers, lands in the SQL box");
else bad("typing while the popup lingered was lost");
await page.waitForFunction(() => !document.getElementById("progress").open, null, { timeout: 5000 });
const std = folded.first && folded.first[4];
if (Math.abs(std - Math.sqrt((200000 * 200001) / 12)) < 1e-6) ok("its sample standard deviation is the exact one for 0..199,999: " + std);
else bad("STDDEV_SAMP folded across 20 row groups: " + std);

/* sorting the streamed answer re-orders it; it does not re-aggregate over the rows that happen to be loaded */
const sorted = await ask("SELECT grp, COUNT(*) FROM sorted GROUP BY grp ORDER BY grp DESC LIMIT 3");
const g = sorted.cols && sorted.cols[0], gc = sorted.cols && sorted.cols[1];
const total = await ask("SELECT grp, COUNT(*) FROM sorted GROUP BY grp");
const sum = total.sums && total.sums[1];
if (g && g.length === 3 && g[0] > g[1] && g[1] > g[2] && gc.every((c) => c > 0)) ok("a grouped answer keeps its ORDER BY and LIMIT over the whole file: " + JSON.stringify(g));
else bad("grouped, ordered, streamed: " + JSON.stringify(sorted));
if (sum === 200000) ok("and the group counts add up to every row of the file: " + sum);
else bad("the groups' counts add up to " + sum + ", not 200,000");

/* a percentile is found exactly without a sorted copy of the column: the first pass counts values into buckets,
   a second collects the one bucket the percentile falls in. That fits a budget the column itself never could */
const p50 = await ask("SELECT MEDIAN(id) FROM sorted");
if (p50.first && p50.first[0] === 99999.5 && !p50.memnote) ok("under a 1 MB budget the median of 200,000 rows is found exactly, by counting and narrowing: " + p50.first[0]);
else bad("MEDIAN under 1 MB: " + JSON.stringify(p50));
const p99 = await ask("SELECT QUANTILE_CONT(id, 0.99) FROM sorted");
if (p99.first && Math.abs(p99.first[0] - 197999.01) < 1e-6) ok("and so is the 99th percentile, interpolated as QUANTILE_CONT does: " + p99.first[0]);
else bad("P99 under 1 MB: " + JSON.stringify(p99));
await page.evaluate(() => window.PARIS.setBudgetMB(8));      /* ninety-odd groups keep about 2,000 values each: a few MB */
const byGroup = await ask("SELECT grp, MEDIAN(id) FROM sorted GROUP BY grp");
if (byGroup.cols && byGroup.cols[0].length > 20 && !byGroup.memnote && byGroup.cols[1].every((v) => typeof v === "number")) ok("and a median for each of " + byGroup.cols[0].length + "+ groups under 8 MB (each small enough to keep its values, so none needs the extra pass)");
else bad("MEDIAN by group under 8 MB: " + JSON.stringify(byGroup).slice(0, 200));
await page.evaluate(() => window.PARIS.setBudgetMB(1));

/* what still has to be kept is watched as it grows and stopped with the numbers: several percentiles at once need
   a set of buckets each, and a distinct count keeps every distinct value */
const several = await ask("SELECT MEDIAN(id), QUANTILE_CONT(id, 0.9), QUANTILE_CONT(id, 0.95), QUANTILE_CONT(id, 0.99) FROM sorted");
if (/^Not run over the whole file: its running totals were estimated at .* with no GROUP BY there are no groups to split them by/.test(several.memnote)) ok("four percentiles at once outgrow that budget, and with one group there is nothing to slice by, so it is stopped with the numbers: " + several.memnote.slice(0, 110) + "…");
else bad("four percentiles under a 1 MB budget: " + JSON.stringify(several));
/* a distinct count keeps every distinct value, which no longer fits: the file is read again in hash slices, each
   holding the values that hash into it, and the counts of the slices add up to the exact answer */
const distinct = await ask("SELECT COUNT(DISTINCT id), COUNT(DISTINCT grp), COUNT(*) FROM sorted");
if (distinct.first && distinct.first[0] === 200000 && distinct.first[2] === 200000 && !distinct.memnote) ok("under a 1 MB budget COUNT(DISTINCT id) over 200,000 distinct values is exact, by hash slices: " + JSON.stringify(distinct.first));
else bad("COUNT(DISTINCT) under 1 MB: " + JSON.stringify(distinct));
const dgrp = await ask("SELECT grp, COUNT(DISTINCT id), COUNT(*) FROM sorted GROUP BY grp");
if (dgrp.cols && dgrp.cols[0].length > 20 && !dgrp.memnote && dgrp.sums[1] === 200000 && dgrp.sums[2] === 200000) ok("and per group, the distinct ids add up to 200,000 across " + dgrp.cols[0].length + "+ groups");
else bad("grouped COUNT(DISTINCT) under 1 MB: " + JSON.stringify(dgrp).slice(0, 300));
/* the groups themselves outgrow the budget: 200,000 of them, split by key hash into slices finished one at a time */
await page.evaluate(() => window.PARIS.setBudgetMB(32));    /* 200,000 groups of about 430 bytes is 86 MB of running totals: a few slices at 32 */
const byId = await ask("SELECT id, COUNT(*), SUM(id) FROM sorted GROUP BY id");
if (byId.sums && byId.sums[1] === 200000 && byId.sums[2] === (199999 * 200000) / 2 && !byId.memnote) ok("under 32 MB, 200,000 groups (one per id, 86 MB of running totals) complete in slices: their counts add to " + byId.sums[1] + " and their sums to " + byId.sums[2]);
else bad("GROUP BY id under 1 MB: " + JSON.stringify(byId).slice(0, 300));
const rows = await page.evaluate(() => window.PARIS.state.view.cols[0].rows.length);
if (rows === 200000) ok("with every one of the 200,000 groups in the answer");
else bad("group count in the answer: " + rows);
const last = await ask("SELECT id, COUNT(*) FROM sorted GROUP BY id ORDER BY id DESC LIMIT 3");
if (last.cols && JSON.stringify(last.cols[0]) === "[199999,199998,199997]") ok("ordering and limiting the sliced answer reads it from the kept groups: " + JSON.stringify(last.cols[0]));
else bad("ORDER BY over a sliced answer: " + JSON.stringify(last).slice(0, 200));
await page.evaluate(() => window.PARIS.setBudgetMB(1));
await ask("SELECT MEDIAN(id), QUANTILE_CONT(id, 0.9), QUANTILE_CONT(id, 0.95), QUANTILE_CONT(id, 0.99) FROM sorted");
await page.click("#memnote button");
await idle();
const partial = await text("#qplan");
if (/^Only the 20,000 rows read so far \(10% of the file\), not the whole file\./.test(partial)) ok("and the answer then says how partial it is: " + partial);
else bad("scope line after the fallback: " + partial);

/* a row group that cannot be decoded within the budget at all is refused before anything is read */
await page.evaluate(() => window.PARIS.setBudgetMB(0.0001));
const tiny = await ask("SELECT COUNT(*) FROM sorted");
if (/^Not run over the whole file: one row group of 1 column would take about/.test(tiny.memnote)) ok("a single row group that does not fit is refused up front: " + tiny.memnote.slice(0, 100) + "…");
else bad("aggregate under a 100-byte budget: " + JSON.stringify(tiny));
await page.evaluate(() => window.PARIS.setBudgetMB(null));

/* what is held follows the current query, not the history of queries: two whole-file aggregates over
   different columns, with a budget that fits either column alone but not both at once, must both run */
await page.goto("file://" + appPath);
await open("sorted.parquet");
const two = await page.evaluate(() => {
  const cols = window.PARIS.state.table.cols;
  const numeric = cols.filter((c) => c.spec && c.spec.kind === "number").map((c) => c.name);
  return { a: numeric[0], b: numeric[1], rows: window.PARIS.state.dataset.numRows };
});
if (two.a && two.b) {
  await page.evaluate((rows) => window.PARIS.setBudgetMB((rows * 20 * 2 * 1.5) / 1048576), two.rows);   /* one column and a half */
  const ask = async (col) => {
    await page.fill("#qsql", `SELECT COUNT(${col}), AVG(${col})\nFROM t;`);
    await page.dispatchEvent("#qsql", "input");
    await page.waitForTimeout(450);
    await page.click("#qrun");
    await idle();
    return page.evaluate(() => ({ name: window.PARIS.state.view.cols[0].name, note: document.getElementById("memnote").textContent, plan: document.getElementById("qplan").textContent.replace(/\s+/g, " ").trim() }));
  };
  const first = await ask(two.a), second = await ask(two.b);
  if (first.name === `COUNT(${two.a})` && second.name === `COUNT(${two.b})` && /Searched all 200,000 rows/.test(second.plan) && !/Not run/.test(second.note)) ok(`the second aggregate (over ${two.b}) runs after the first (over ${two.a}) instead of being refused for the history: ${second.plan}`);
  else bad("second aggregate: " + JSON.stringify({ first, second }));
} else console.log("     (no two numeric columns in sorted.parquet: skipped)");
await page.evaluate(() => window.PARIS.setBudgetMB(null));

/* a row-by-row diff needs every column of every row of both files, so it is refused when that cannot fit */
await page.goto("file://" + appPath);
await page.evaluate(() => window.PARIS.setBudgetMB(1));
await open("sorted.parquet");
await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.id = "spare"; document.body.appendChild(i); });
await page.setInputFiles("#spare", path.join(dir, "shuffled.parquet"));
const diffErr = await page.evaluate(async () => {
  const P = window.PARIS;
  const d = await P.readDataset(P.entriesFromFiles([document.getElementById("spare").files[0]]));
  P.diff.b = { dataset: d, table: P.newTable(d) };
  await P.loadAllBoth();
  return (document.getElementById("err") || {}).textContent || "";
});
if (/^Not run: reading every row of both files would take about .* over this page's 1 MB memory budget/.test(diffErr)) ok("a row diff over the memory budget is refused: " + diffErr.slice(0, 100) + "…");
else bad("row diff under a 1 MB budget: " + JSON.stringify(diffErr.slice(0, 160)));

const other = requests.filter((u) => u !== "file://" + appPath);
if (!other.length) ok("the page requested nothing but itself");
else bad("requests: " + JSON.stringify(other.slice(0, 8)));

if (logs.length) { console.log("\nconsole output:"); for (const l of logs) console.log("  " + l); }
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\nthe memory budget and the progress popup work in a real browser");
process.exit(failed || logs.length ? 1 : 0);
