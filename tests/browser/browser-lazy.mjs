/**
 * Checks that a column nobody is looking at is not decoded, and that one
 * anybody asks for afterwards is — with the right values in it.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/browser-lazy.mjs /tmp/fx/wide.parquet
 *
 * Reading fewer columns is only worth anything if the ones you do read are
 * still right, so every check here ends at the cells on screen.
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) || "/tmp/corpus/wide.parquet";
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "..", "index.html");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push("console: " + m.text()); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s) => { failed++; console.log("FAIL " + s); };
const idle = () => page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 120000 });
const filled = () => page.evaluate(() => window.PARIS.state.table.cols.filter((c) => c.rows.length).length);
const total = () => page.evaluate(() => window.PARIS.state.table.cols.length);

await page.goto("file://" + appPath);
await page.setInputFiles("#picker", file);
await idle();

const cols = await total();
const shown = await page.$$eval("#grid tr.r-name th", (th) => th.length - 1);
console.log(`     ${cols} columns in the file, ${shown} on screen`);

/* everything is on screen to start with, so everything is decoded */
if (await filled() === cols) ok("all " + cols + " columns decoded while all of them are shown");
else bad("decoded " + await filled() + " of " + cols + " with every column shown");

/* hide all but the first: re-reading the file then decodes one column */
await page.click("#toggleCols");
await page.click("[data-act='cponly']");
await page.keyboard.press("Escape");
await page.click("[data-act='cpclose']").catch(() => {});
await page.click("#toggleCols");
const hidden = await page.evaluate(() => window.PARIS.state.display.hidden.size);
if (hidden === cols - 1) ok("the picker hid " + hidden + " columns");
else bad("hid " + hidden + " of " + cols);

/* a fresh read of the same file now has only the shown column to decode */
await page.evaluate(async () => {
  const P = window.PARIS;
  const t = P.newTable(P.state.dataset);
  t.need = P.neededColumns(t);
  await P.loadMore(P.state.dataset, t, Infinity);
  window.__probe = { need: t.need.size, decoded: t.cols.filter((c) => c.rows.length).length,
    rows: t.rowsLoaded, cols: t.cols.length };
});
const probe = await page.evaluate(() => window.__probe);
console.log("     " + JSON.stringify(probe));
if (probe.decoded === probe.need && probe.decoded < probe.cols) {
  ok(`a read with one column shown decodes ${probe.decoded} of ${probe.cols}`);
} else bad("decoded " + probe.decoded + " of " + probe.cols + ", needed " + probe.need);

/* time the two, on the same file, in the same page */
const times = await page.evaluate(async () => {
  const P = window.PARIS;
  const run = async (need) => {
    const t = P.newTable(P.state.dataset);
    t.need = need;
    const t0 = performance.now();
    await P.loadMore(P.state.dataset, t, Infinity);
    return Math.round(performance.now() - t0);
  };
  const all = await run(null);
  const one = await run(P.neededColumns(P.newTable(P.state.dataset)));
  return { all, one };
});
console.log(`     every column ${times.all} ms, the shown one ${times.one} ms`);
if (times.one < times.all) ok("decoding less takes less time");
else bad(`one column took ${times.one} ms and all of them took ${times.all} ms`);

/* now ask for a hidden column back, and check the cells that appear */
const truth = await page.evaluate(() => {
  const P = window.PARIS;
  const col = P.state.table.cols[5];
  return { name: col.name, values: Array.from(col.rows.slice(0, 5)).map((v) => P.fmtValue(v, col.spec)) };
});
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", file);
await idle();
await page.evaluate(() => {
  /* hide everything but the first column, the way the picker does */
  const P = window.PARIS;
  P.state.display.hidden = new Set(P.state.table.cols.map((_c, i) => i).filter((i) => i !== 0));
});
await page.evaluate(async () => {
  const P = window.PARIS;
  const t = P.newTable(P.state.dataset);
  t.need = P.neededColumns(t);
  await P.loadMore(P.state.dataset, t, Infinity);
  P.state.table = t;
  window.__before = t.cols[5].rows.length;
  /* and now something wants column 5 after all */
  await P.fillColumns(P.state.dataset, t, [5]);
  window.__after = { n: t.cols[5].rows.length,
    values: Array.from(t.cols[5].rows.slice(0, 5)).map((v) => P.fmtValue(v, t.cols[5].spec)) };
});
const before = await page.evaluate(() => window.__before);
const after = await page.evaluate(() => window.__after);
if (before === 0) ok("a column nobody asked for holds nothing");
else bad("an unwanted column already held " + before + " rows");
if (after.n > 0 && JSON.stringify(after.values) === JSON.stringify(truth.values)) {
  ok(`filling "${truth.name}" in afterwards gives the same values: ` + JSON.stringify(after.values.slice(0, 3)));
} else {
  bad("filled values " + JSON.stringify(after.values) + " differ from " + JSON.stringify(truth.values));
}

/* the whole way round in the UI: hide a column, filter on it, get it back */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", file);
await idle();
const name = await page.evaluate(() => window.PARIS.state.table.cols[3].name);
await page.evaluate((_n) => {
  const P = window.PARIS;
  P.state.display.hidden = new Set(P.state.table.cols.map((_c, i) => i).filter((i) => i !== 0 && i !== 1));
}, name);
await page.fill("#qsql", `SELECT * FROM x WHERE "${name}" IS NOT NULL`);
await page.dispatchEvent("#qsql", "input");
await page.waitForTimeout(300);
await page.click("#qrun");
await idle();
await page.waitForTimeout(200);
const stat = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
const rows = await page.$$eval("#tbody tr", (rs) => rs.length);
if (/\d/.test(stat) && rows > 0) ok(`a filter on a hidden column still runs: ${stat}, ${rows} rows drawn`);
else bad("qstat " + stat + ", " + rows + " rows");

/* end to end on a wide, long file: an aggregate is on screen, so loading the
   rest of the rows has only the columns it names to decode */
const long = args[1];
if (long) {
  await page.goto("file://" + appPath);
  let t0 = Date.now();
  await page.setInputFiles("#picker", long);
  await idle();
  const openMs = Date.now() - t0;
  const n = await total();
  console.log(`     ${path.basename(long)}: ${n} columns, opened in ${openMs} ms`);

  await page.fill("#qsql", 'SELECT "grp", COUNT("id") AS n FROM widelong GROUP BY "grp"');
  await page.dispatchEvent("#qsql", "input");
  await page.waitForTimeout(300);
  await page.click("#qrun");
  await idle();
  const need = await page.evaluate(() => window.PARIS.neededColumns(window.PARIS.state.table).size);
  if (need === 2) ok("with an aggregate on screen, 2 of " + n + " columns are needed");
  else bad("needed " + need + " of " + n + " columns for a two-column aggregate");

  const beforeRows = await page.evaluate(() => window.PARIS.state.table.rowsLoaded);
  t0 = Date.now();
  await page.click("#all");
  await idle();
  const allMs = Date.now() - t0;
  const after = await page.evaluate(() => ({
    rows: window.PARIS.state.table.rowsLoaded,
    grew: window.PARIS.state.table.cols.filter((c) => c.rows.length === window.PARIS.state.table.rowsLoaded).length,
    stat: document.getElementById("qstat").textContent.replace(/\s+/g, " ").trim(),
  }));
  console.log(`     ${beforeRows} rows -> ${after.rows} in ${allMs} ms; ${after.grew} of ${n} columns came with them`);
  if (after.grew <= 3) ok("loading the rest of the rows decoded only what the query names");
  else bad(after.grew + " columns grew for a two-column aggregate");
  if (/groups from/.test(after.stat)) ok("and the aggregate is right there: " + after.stat);
  else bad("qstat: " + after.stat);

  /* and Reset fills the grid back in rather than showing holes */
  await page.click("#qclear");
  await idle();
  await page.waitForTimeout(400);
  await idle();
  const back = await page.evaluate(() => {
    const tds = [...document.querySelectorAll("#tbody tr")][0];
    return { cells: tds ? [...tds.children].slice(1, 6).map((td) => td.textContent) : [],
      filled: window.PARIS.state.table.cols.filter((c) => c.rows.length).length };
  });
  console.log("     after Reset: " + back.filled + " columns decoded, first row " + JSON.stringify(back.cells));
  if (back.cells.length && back.cells.every((c) => c !== "" && c !== "null")) {
    ok("Reset fills the grid back in rather than leaving holes");
  } else bad("first row after reset: " + JSON.stringify(back.cells));
}

if (logs.length) {
  console.log("\nconsole output:");
  for (const l of logs) console.log("  " + l);
}
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\ncolumns are decoded when something wants them");
process.exit(failed || logs.length ? 1 : 0);
