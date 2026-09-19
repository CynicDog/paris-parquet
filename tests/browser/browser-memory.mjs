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
await page.waitForFunction(() => !document.getElementById("progress").open, null, { timeout: 5000 });
ok("and closes once it is");

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

/* a whole-file aggregate that cannot fit is refused with numbers, and the fallback is explicit */
await page.goto("file://" + appPath);
await page.evaluate(() => window.PARIS.setBudgetMB(1));
await open("sorted.parquet");
await page.fill("#qsql", "SELECT COUNT(*), AVG(id) FROM sorted");
await page.dispatchEvent("#qsql", "input");
await page.waitForTimeout(400);
await page.click("#qrun");
await idle();
const refused = await text("#memnote");
if (/^Not run over the whole file: reading 200,000 rows of \d+ columns? would take about/.test(refused)) ok("an aggregate over the whole file that cannot fit is refused: " + refused.slice(0, 120) + "…");
else bad("aggregate under a 1 MB budget: " + refused);
if (/Run on the 20,000 rows already read/.test(await text("#memnote button"))) ok("with an explicit, labelled way to run on what is loaded");
else bad("no fallback action: " + await text("#memnote"));
await page.click("#memnote button");
await idle();
const partial = await text("#qplan");
if (/^Only the 20,000 rows read so far \(10% of the file\), not the whole file\./.test(partial)) ok("and the answer then says how partial it is: " + partial);
else bad("scope line after the fallback: " + partial);

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
    return page.evaluate(() => ({ name: window.PARIS.state.view.cols[0].name, note: document.getElementById("memnote").textContent, rows: window.PARIS.state.table.rowsLoaded }));
  };
  const first = await ask(two.a), second = await ask(two.b);
  if (first.name === `COUNT(${two.a})` && second.name === `COUNT(${two.b})` && second.rows === two.rows && !/Not run/.test(second.note)) ok(`the second aggregate (over ${two.b}) runs after the first (over ${two.a}) instead of being refused for the history: ${second.rows.toLocaleString()} rows`);
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
