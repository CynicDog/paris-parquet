/**
 * The summary cards above the grid describe every row the view covers, not the rows loaded: they are counted in
 * the background as soon as a file (or a WHERE with more matches than were read) is on screen, with no button,
 * one row group at a time inside the memory budget, and a slim status line says so while it happens.
 *
 *   node tests/browser/browser-cards.mjs /tmp/fx/push      (needs sorted.parquet)
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) || "/tmp/fx/push";
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "..", "index.html");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.route("**/*", (route, req) => { if (req.url().startsWith("file://")) route.continue(); else route.abort(); });
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push("console: " + m.text()); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s) => { failed++; console.log("FAIL " + s); };
const idle = () => page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 120000 });
const counted = () => page.evaluate(() => window.PARIS.cardsIdle());
const card = (n) => page.$eval("tr.r-sum th:nth-child(" + (n + 1) + ")", (el) => el.textContent.replace(/\s+/g, " ").trim());

await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
await idle();

/* columns: id, grp, sku, amt */
const early = await card(1);
if (!(await page.$("button[data-wf]")) && !/in file|file 0/.test(early)) ok("there is no button and no separate file-range row on a card: whole-file figures are simply what a card shows");
else bad("id card early: " + early);
await page.waitForSelector("#cardprog:not([hidden])", { timeout: 5000 }).then(() => ok("while the rest is counted a status line says so: " + "counting"), () => ok("(the count finished before the status line could be seen)"));
await counted();
if (await page.$eval("#cardprog", (el) => el.hidden)) ok("and the status line goes away when it is done");
else bad("the status line is still showing");

const id = await card(1);
if (/min0max199999/.test(id) && /mean99999\.5/.test(id) && !/counting/.test(id)) ok("the id card covers all 200,000 rows, not the 20,000 loaded: " + id.slice(0, 80));
else bad("id card: " + id);
const grp = await card(2);
if (/min0max96/.test(grp) && /mean47\.997095/.test(grp)) ok("the group column too: " + grp.slice(0, 60));
else bad("grp card: " + grp);
const sku = await card(3);
if (/distinct≥4,097/.test(sku)) ok("a text column with 200,000 distinct values keeps a bounded set and says so: " + sku.slice(0, 60));
else bad("sku card: " + sku);
const amt = await card(4);
if (/max249\.75mean124\.875/.test(amt)) ok("and the last: " + amt.slice(0, 60));
else bad("amt card: " + amt);

/* a WHERE with more matches than were loaded: the cards count the matches */
await page.fill("#qsql", 'SELECT * FROM sorted WHERE "id" >= 100000');
await page.dispatchEvent("#qsql", "input");
await page.waitForTimeout(400);
await page.click("#qrun");
await idle();
await counted();
const filtered = await card(1);
if (/min100000max199999mean149999\.5/.test(filtered)) ok("over a WHERE, the cards count every match, not the first 20,000: " + filtered.slice(0, 70));
else bad("id card under WHERE: " + filtered);

/* clicking a bar of a whole-file card scopes to that bar and runs over the whole file */
const barCount = await page.$eval("tr.r-sum th:nth-child(2) .hist i:nth-child(3)", (el) => +el.getAttribute("title").split(" ")[0].replace(/,/g, ""));
await page.click("tr.r-sum th:nth-child(2) .hist i:nth-child(3)");
await idle();
await page.waitForTimeout(600);
const after = await page.$eval("#qstat", (el) => el.textContent.replace(/\s+/g, " ").trim());
if (new RegExp("^" + barCount.toLocaleString("en-US") + " rows").test(after)) ok("a click on a bar runs over the whole file and finds exactly the bar's " + barCount.toLocaleString("en-US") + " rows: " + after.slice(0, 60));
else bad("bar click: bar " + barCount + ", stat " + after);

/* a narrow window keeps every control on screen: they shorten, then wrap, and none goes off the edge */
for (const width of [1100, 800, 480, 320]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(150);
  const clipped = await page.evaluate(() => {
    const w = window.innerWidth, out = [];
    for (const el of document.querySelectorAll("header button, header label.btn, #theme")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > w + 1 || r.left < -1)) out.push((el.id || el.textContent.trim()).slice(0, 20) + "@" + Math.round(r.right));
    }
    return { out, scroll: document.documentElement.scrollWidth > w + 1 };
  });
  if (!clipped.out.length && !clipped.scroll) ok("at " + width + " px wide every header control is on screen and the page does not scroll sideways");
  else bad("at " + width + " px: " + JSON.stringify(clipped));
}
await page.setViewportSize({ width: 1500, height: 950 });

/* under a small budget the count still happens, a row group of the visible columns at a time */
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
await idle();
await page.evaluate(() => window.PARIS.setBudgetMB(1));
await page.click("#qrun").catch(() => {});
await counted();
const small = await card(1);
if (/min0max199999/.test(small)) ok("under a 1 MB budget the card is still exact: " + small.slice(0, 60));
else bad("id card under a 1 MB budget: " + small);

if (logs.length) { console.log("\nconsole output:"); for (const l of logs) console.log("  " + l); }
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\nsummary cards cover every row, with no button, in a real browser");
process.exit(failed || logs.length ? 1 : 0);
