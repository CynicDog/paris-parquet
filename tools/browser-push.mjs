/**
 * Drives the Scan button in a real browser, and times it against reading the
 * whole file, so the claim that pushdown is faster is measured rather than
 * asserted.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node tools/browser-push.mjs /tmp/fx/push
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) || "/tmp/fx/push";
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "index.html");

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

if (await page.isDisabled("#qscan")) ok("Scan is disabled until there is something to push down");
else bad("Scan offered with no WHERE clause");

await typeSql('SELECT * FROM sorted WHERE "id" >= 195000');
if (await page.isEnabled("#qscan")) ok("Scan wakes up once a WHERE clause is in");
else bad("Scan still disabled with a filter typed");

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
await page.click("#qscan");
await idle();
const scanMs = Date.now() - t0;
const plan = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log("     " + plan);
console.log("     reading it all:    " + plainRows.replace(/\s+/g, " ").trim());
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
await page.click("#qscan");
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
if (await page.isHidden("#qplan")) ok("Reset clears the plan");
else bad("the plan line survived a reset");
const after = await page.$eval("#fileline", (el) => el.textContent.replace(/\s+/g, " "));
const back = await page.$$eval("#tbody tr", (rs) => rs.length);
if (back > 0) ok("and the grid is a grid again: " + after);
else bad("nothing on screen after reset");

/* a bloom filter on a shuffled column, where statistics cannot help */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "shuffled.parquet"));
await idle();
await typeSql("SELECT * FROM shuffled WHERE \"sku\" = 'sku-099999'");
await page.click("#qscan");
await idle();
const bloom = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log("     " + bloom);
if (/by bloom filter/.test(bloom)) ok("bloom filters do the pruning where statistics cannot");
else bad("plan: " + bloom);
const bstat = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/^1 rows/.test(bstat)) ok("and the one matching row is found: " + bstat);
else bad("qstat: " + bstat);

/* the page index, narrowing inside a row group */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "pages.parquet"));
await idle();
await typeSql('SELECT * FROM pages WHERE "id" = 150000');
await page.click("#qscan");
await idle();
const narrow = await page.$eval("#qplan", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log("     " + narrow);
if (/narrowed by page to/.test(narrow)) ok("the page index narrows inside the row group it kept");
else bad("plan: " + narrow);
const nstat = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/^1 rows from ([1-9],\d{3}|\d{1,4})\b/.test(nstat)) ok("one row found, out of a few thousand read: " + nstat);
else bad("qstat: " + nstat);

const other = requests.filter((u) => u !== "file://" + appPath);
console.log("\n     requests: " + requests.length + " total, " + other.length + " for anything but index.html");
if (!other.length) ok("the page requested nothing but itself");
else bad("requests: " + JSON.stringify(other.slice(0, 8)));

if (logs.length) {
  console.log("\nconsole output:");
  for (const l of logs) console.log("  " + l);
}
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\nthe scan works in a real browser");
process.exit(failed || logs.length ? 1 : 0);
