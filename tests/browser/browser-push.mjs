/**
 * Drives Run in a real browser, where a WHERE is planned against the footer so only
 * the row groups that could match are read, and times that against reading the
 * whole file, so the claim that pushdown is faster is measured rather than
 * asserted. Run searches the whole file by default: there is no separate Scan
 * button to remember to press.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/browser-push.mjs /tmp/fx/push
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
const idle = () => page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 180000 });

async function typeSql(sql) {
  await page.fill("#qsql", sql);
  await page.dispatchEvent("#qsql", "input");
  await page.waitForTimeout(400);          /* the panel parses as you type */
}

await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
await idle();

if (!(await page.$("#qscan"))) ok("there is no separate Scan button: whole-file search is what Run does");
else bad("the optional Scan button is still there");

/* before anything is run, the page says how much of the file it is showing */
const browsing = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/first 20,000 of 200,000 rows/.test(browsing) && /Run.*searches the whole file/.test(browsing)) ok("the scope line says what is on screen: " + browsing);
else bad("scope line before running: " + browsing);
if ((await page.getAttribute("#qplan", "role")) === "status") ok("and it is a live status region, so a screen reader hears it change");
else bad("the scope line is not a status region");

await typeSql('SELECT * FROM sorted WHERE "id" >= 195000');

/* the answer needs rows the first 20,000 do not contain, so the honest
   baseline is reading the whole file and then querying it */
let t0 = Date.now();
await page.click("#all");
await idle();
await page.click("#qrun");
await idle();
const plainMs = Date.now() - t0;
const plainRows = await page.$eval("#qstat", (el) => el.textContent);

/* and the scan is the same question asked of a freshly opened file */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
await idle();
await typeSql('SELECT * FROM sorted WHERE "id" >= 195000');
t0 = Date.now();
await page.click("#qrun");
await idle();
const scanMs = Date.now() - t0;
const plan = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log("     " + plan);
console.log("     reading it all:    " + plainRows.replace(/\s+/g, " ").trim());
if (/^Whole file\./.test(plan)) ok("the scope line says it searched the whole file");
else bad("scope line after a run: " + plan);
if (/read 1 of 20 row groups/.test(plan)) ok("the plan reads one row group of twenty");
else bad("plan: " + plan);
if (/skipped 19 \(19 by statistics\)/.test(plan)) ok("and says why it skipped the other nineteen");
else bad("plan does not explain itself: " + plan);

const stat = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/^5,000 rows from 10,000/.test(stat)) ok("every matching row is there: " + stat);
else bad("qstat after a scan: " + stat);
console.log(`     scan ${scanMs} ms, against ${plainMs} ms to read all 200,000 rows and query those`);
if (scanMs < plainMs) ok("the scan is the faster way to the same answer");
else bad(`the scan took ${scanMs} ms and reading everything took ${plainMs} ms`);

/* the metadata panel has to say the table on screen is a scan */
const mbar = await page.$eval("#mbar", (el) => el.textContent.replace(/\s+/g, " "));
if (/scanned 1 of 20 row groups/.test(mbar)) ok("the metadata bar says the grid is a scan");
else bad("metadata bar: " + mbar.slice(0, 160));

/* nothing can match: no row group survives, and the grid is empty */
await typeSql('SELECT * FROM sorted WHERE "id" > 1000000');
await page.click("#qrun");
await idle();
const none = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/read 0 of 20 row groups/.test(none)) ok("a query nothing can match reads nothing at all");
else bad("plan: " + none);
const rows = await page.$$eval("#tbody tr", (rs) => rs.length);
if (rows === 0) ok("and the grid is empty");
else bad(rows + " rows drawn for a query with no matches");

/* Reset puts the file back the way it was read */
await page.click("#qclear");
await idle();
const reset = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (!/row groups|Whole file/.test(reset) && /first 20,000 of 200,000 rows/.test(reset)) ok("Reset puts the scope line back to describing what is loaded");
else bad("scope line after a reset: " + reset);
const after = await page.$eval("#fileline", (el) => el.textContent.replace(/\s+/g, " "));
const back = await page.$$eval("#tbody tr", (rs) => rs.length);
if (back > 0) ok("and the grid is a grid again: " + after);
else bad("nothing on screen after reset");

/* a bloom filter on a shuffled column, where statistics cannot help */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "shuffled.parquet"));
await idle();
await typeSql("SELECT * FROM shuffled WHERE \"sku\" = 'sku-099999'");
await page.click("#qrun");
await idle();
const bloom = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log("     " + bloom);
if (/by bloom filter/.test(bloom)) ok("bloom filters do the pruning where statistics cannot");
else bad("plan: " + bloom);
const bstat = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/^1 rows/.test(bstat)) ok("and the one matching row is found: " + bstat);
else bad("qstat: " + bstat);

/* a sorted query is the top of the whole file, not of the rows that happen to be loaded: the first 20,000 rows of a
   shuffled file hold neither the biggest nor the smallest ids */
await page.evaluate(() => window.PARIS.setBudgetMB(1));           /* the ranking must not need the file, or even the columns, in memory */
const view = (sel) => page.evaluate(() => {
  const v = window.PARIS.state.view;
  return v ? { count: v.count, cols: v.cols.map((c) => Array.from({ length: Math.min(8, v.count) }, (_, i) => c.rows[v.index ? v.index[i] : i])), names: v.cols.map((c) => c.name) } : null;
});
await typeSql("SELECT * FROM shuffled ORDER BY id DESC LIMIT 5");
await page.click("#qrun");
await idle();
const top5 = await view();
const ids = top5 && top5.cols[top5.names.indexOf("id")];
const skus = top5 && top5.cols[top5.names.indexOf("sku")];
if (ids && JSON.stringify(ids.slice(0, 5)) === JSON.stringify([199999, 199998, 199997, 199996, 199995])) ok("ORDER BY id DESC LIMIT 5 finds the top five of 200,000 rows under a 1 MB budget: " + ids.slice(0, 5));
else bad("top 5: " + JSON.stringify(top5));
if (skus && skus[0] === "sku-199999" && skus[4] === "sku-199995") ok("with every column of those rows fetched, not just the sort column: " + skus.slice(0, 2));
else bad("top 5 skus: " + JSON.stringify(skus));
const topScope = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/^Whole file\. The 5 first rows by id descending of 200,000 that match, found by reading only the sort columns of \d+ row groups/.test(topScope)) ok("and the scope line says how: " + topScope);
else bad("top scope: " + topScope);
if (await page.$eval("#more", (b) => b.hidden)) ok("there is no Load more on a top-N: the answer is the five rows");
else bad("Load more is offered on a top-N");
const topStat = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/^5 rows from the top of 200,000 matching rows/.test(topStat)) ok("qstat: " + topStat);
else bad("qstat: " + topStat);

await typeSql('SELECT * FROM shuffled WHERE "amt" >= 249 ORDER BY id LIMIT 3');
await page.click("#qrun");
await idle();
const filtered = await view();
const fids = filtered && filtered.cols[filtered.names.indexOf("id")];
if (fids && fids.length === 3 && fids.every((v) => (v % 1000) * 0.25 >= 249)) ok("a WHERE is applied while ranking: the three smallest ids with amt >= 249 are " + fids.slice(0, 3));
else bad("filtered top 3: " + JSON.stringify(filtered));
if (fids && fids[0] === 996 && fids[1] === 997 && fids[2] === 998) ok("and they are the right ones");
else bad("filtered top 3 ids: " + JSON.stringify(fids));

/* no LIMIT: the first screenful of the whole-file order, and a header click sorts the whole file, not what is loaded */
await page.evaluate(() => window.PARIS.setBudgetMB(null));
await page.click("[data-act='qclear']").catch(() => {});
await page.evaluate(() => window.PARIS.state.query && (window.PARIS.state.query.active = false));
await typeSql("SELECT * FROM shuffled ORDER BY id");
await page.click("#qrun");
await idle();
const unl = await view();
const uids = unl && unl.cols[unl.names.indexOf("id")];
if (uids && uids.slice(0, 4).join() === "0,1,2,3" && unl.count === 20000) ok("ORDER BY with no LIMIT gives the first 20,000 of the whole file's order, starting at the true minimum: " + uids.slice(0, 4));
else bad("unlimited sort: " + JSON.stringify(unl && { count: unl.count, ids: uids }));
await page.click("#qclear");
await idle();
await page.click("tr.r-name th:nth-child(2)");                       /* the id header */
await idle();
await page.waitForTimeout(600);                                       /* the popup lingers, non-modal, after it */
await page.click("tr.r-name th:nth-child(2)");                       /* again: descending */
await idle();
const hdr = await view();
const hids = hdr && hdr.cols[hdr.names.indexOf("id")];
if (hids && hids[0] === 199999) ok("clicking a header twice sorts descending across the whole file, not just the loaded rows: " + hids.slice(0, 3));
else bad("header sort: " + JSON.stringify(hids));

/* the page index, narrowing inside a row group */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "pages.parquet"));
await idle();
await typeSql('SELECT * FROM pages WHERE "id" = 150000');
await page.click("#qrun");
await idle();
const narrow = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log("     " + narrow);
if (/narrowed by page to/.test(narrow)) ok("the page index narrows inside the row group it kept");
else bad("plan: " + narrow);
const nstat = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/^1 rows from ([1-9],\d{3}|\d{1,4})\b/.test(nstat)) ok("one row found, out of a few thousand read: " + nstat);
else bad("qstat: " + nstat);

/* an aggregate with no WHERE is a question about the whole file: Run reads every row of the columns it needs */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
await idle();
await typeSql('SELECT COUNT(*) FROM sorted');
await page.click("#qrun");
await idle();
const counted = await page.evaluate(() => window.PARIS.state.view.cols[0].rows[0]);
if (counted === 200000) ok("COUNT(*) with no WHERE is the whole file's 200,000, not the 20,000 that were loaded");
else bad("COUNT(*) answered " + counted);
const aggScope = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/Whole file/.test(aggScope) && /200,000/.test(aggScope)) ok("and the scope line says so: " + aggScope);
else bad("scope line after the aggregate: " + aggScope);

const other = requests.filter((u) => u !== "file://" + appPath);
console.log("\n     requests: " + requests.length + " total, " + other.length + " for anything but index.html");
if (!other.length) ok("the page requested nothing but itself");
else bad("requests: " + JSON.stringify(other.slice(0, 8)));

if (logs.length) {
  console.log("\nconsole output:");
  for (const l of logs) console.log("  " + l);
}
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\nRun searches the whole file in a real browser");
process.exit(failed || logs.length ? 1 : 0);
