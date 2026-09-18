/**
 * Drives the diff panel in a real browser, the way a user would: open a file,
 * press Diff, choose the other file, pick a key, compare. Also counts every
 * network request the page makes, which must stay at one — the html itself.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/browser-diff.mjs /tmp/fx/diff
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) || "/tmp/fx/diff";
const shotAt = args.indexOf("--shot");
const shot = shotAt >= 0 ? args[shotAt + 1] : null;
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

await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "a.parquet"));
await idle();

/* the button only appears once a file is open */
if (await page.isVisible("#toggleDiff")) ok("Diff button shown once a file is open");
else bad("Diff button missing");

await page.click("#toggleDiff");
if (await page.isVisible("#dropb")) ok("diff opens asking for the other side");
else bad("no drop zone for file B");
if (await page.isHidden("#gridwrap")) ok("the grid gives way to the diff");
else bad("grid still showing behind the diff");

await page.setInputFiles("#bpicker", path.join(dir, "b.parquet"));
await idle();

const cards = await page.$$eval("#diffbody .mcard h3", (hs) => hs.map((h) => h.textContent));
console.log("     cards: " + JSON.stringify(cards));
if (cards.length === 4) ok("four cards: shape, schema, statistics, rows");
else bad("expected 4 cards, got " + cards.length);

const schema = await page.$eval("#diffbody .mcard:nth-of-type(2)", (el) => el.textContent.replace(/\s+/g, " "));
for (const want of ["extra", "qty", "int32", "int64"]) {
  if (schema.includes(want)) ok("schema card names " + want);
  else bad("schema card does not mention " + want + ": " + schema.slice(0, 200));
}

const stats = await page.$eval("#diffbody .mcard:nth-of-type(3)", (el) => el.textContent.replace(/\s+/g, " "));
if (/score/.test(stats)) ok("statistics card names the column that moved");
else bad("statistics card missing score: " + stats.slice(0, 200));

/* the key should already be picked; run the row diff */
const chips = await page.$$eval(".chip.on", (els) => els.map((e) => e.textContent));
if (chips.length === 1 && chips[0] === "id") ok("id suggested as the key");
else bad("key chips: " + JSON.stringify(chips));

await page.click("[data-dact='run']");
await idle();
const tally = await page.$eval(".dtally", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log("     " + tally);
if (/only in A 0/.test(tally) && /only in B 0/.test(tally) && /changed 100/.test(tally) && /identical 900/.test(tally)) {
  ok("tally reads 0 / 0 / 100 / 900");
} else bad("tally: " + tally);

const rowsDrawn = await page.$$eval("table.dr tr", (rs) => rs.length);
if (rowsDrawn === 101) ok("100 differing rows drawn, plus the header");
else bad("drew " + rowsDrawn + " rows");
const marked = await page.$$eval("table.dr td.moved", (ts) => ts.length);
if (marked === 100) ok("exactly the differing cells are marked");
else bad(marked + " cells marked, expected 100");

/* a key that repeats must be refused rather than half-applied */
await page.click(".chip.on");                                  /* turn id off */
await page.click("[data-dact='key'][title='string']");         /* turn name on */
await page.click("[data-dact='run']");
await idle();
const warn = await page.$eval("#diffbody .warnbox", (el) => el.textContent.replace(/\s+/g, " ").trim())
  .catch(() => "");
if (/not unique/.test(warn)) ok("a repeating key is refused: " + warn.slice(0, 60));
else bad("no refusal for a repeating key: " + warn);

/* swap, and A becomes what B was */
await page.click("[data-dact='key'][title='string']");
await page.click("[data-dact='key'][title='int64']");
await page.click("[data-dact='swap']");
await idle();
const sides = await page.$$eval(".dside", (els) => els.map((e) => e.textContent.trim()));
if (sides[0] === "A b.parquet" && sides[1] === "B a.parquet") ok("swap exchanges the two sides");
else bad("after swap: " + JSON.stringify(sides));
const fileline = await page.$eval("#fileline", (el) => el.textContent);
if (fileline.startsWith("b.parquet")) ok("the header follows the swap");
else bad("header still says " + fileline);

/* back to the table, and the grid is a grid again */
await page.click("#toggleDiff");
if (await page.isVisible("#gridwrap") && await page.isHidden("#diffwrap")) ok("Table returns to the grid");
else bad("grid did not come back");
if (await page.isVisible("#pager")) ok("the pager comes back with it");
else bad("pager stayed hidden");

/* a partitioned folder, keyed on its partition columns: those carry a NUL in
   their internal key, which must survive the trip through the chip markup */
const hive = path.join(dir, "..", "folders", "hive");
await page.goto("file://" + appPath);
await page.setInputFiles("#dirpicker", hive);
await idle();
await page.click("#toggleDiff");
await page.setInputFiles("#bdirpicker", hive);
await idle();
for (const name of ["year", "month", "id"]) {
  const at = await page.$(`[data-dact='key'][data-ci]:text-is("${name}")`);
  if (!at) { bad("no key chip for " + name); continue; }
  const on = await at.evaluate((el) => el.classList.contains("on"));
  if (!on) await at.click();
}
await page.click("[data-dact='run']");
await idle();
const hiveTally = await page.$eval(".dtally", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (/matched on \((?=[^)]*year)(?=[^)]*month)(?=[^)]*\bid\b)/.test(hiveTally) && /changed 0/.test(hiveTally) &&
    /only in A 0/.test(hiveTally) && /only in B 0/.test(hiveTally) && /identical [1-9]/.test(hiveTally)) {
  ok("a partitioned folder keys on its partition columns: " + hiveTally.slice(0, 74));
} else bad("hive tally: " + hiveTally);

if (shot) {
  await page.click("[data-dact='run']").catch(() => {});
  await idle();
  await page.screenshot({ path: shot });
  console.log("     screenshot -> " + shot);
}

/* the page is loaded a couple of times over this run; what matters is that
   every request it ever makes is for that one file and nothing else */
const other = requests.filter((u) => u !== "file://" + appPath);
console.log("\n     requests: " + requests.length + " total, " + other.length + " for anything but index.html");
if (!other.length) ok("the page requested nothing but itself, " + requests.length + " time(s)");
else bad("requests: " + JSON.stringify(other.slice(0, 8)));

if (logs.length) {
  console.log("\nconsole output:");
  for (const l of logs) console.log("  " + l);
}
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\nthe diff panel works in a real browser");
process.exit(failed || logs.length ? 1 : 0);
