/**
 * The summary cards above the grid say which rows they describe, and one click makes a card describe the
 * whole file, computed a row group at a time inside the memory budget.
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
const card = (n) => page.$eval("tr.r-sum th:nth-child(" + (n + 1) + ")", (el) => el.textContent.replace(/\s+/g, " ").trim());

await page.goto("file://" + appPath);
await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
await idle();
await page.evaluate(() => window.PARIS.setBudgetMB(1));                 /* the whole column of 200,000 rows does not fit; a row group of it does */

/* columns: id, grp, sku, amt */
const before = await card(1);
if (/^first 20,000 of 200,000/.test(before) && /file 0/.test(before) && /in file0 – 199999/.test(before)) ok("a card says which rows it describes, and shows what the footer knows of the whole file: " + before.slice(0, 120));
else bad("id card before: " + before);

await page.click("tr.r-sum th:nth-child(2) button[data-wf]");
await idle();
await page.waitForTimeout(600);
const after = await card(1);
if (/^whole file · 200,000 rows/.test(after) && /min0max199999/.test(after) && /mean99999\.5/.test(after)) ok("one click recomputes it over all 200,000 rows under a 1 MB budget: " + after.slice(0, 120));
else bad("id card after: " + after);
if (!(await page.$("tr.r-sum th:nth-child(2) button[data-wf]"))) ok("and the button is gone from it");
else bad("the button is still there");

/* a text column of few distinct values is exact in one pass; one of many is recounted */
await page.click("tr.r-sum th:nth-child(3) button[data-wf]");
await idle();
await page.waitForTimeout(600);
const grp = await card(2);
if (/^whole file · 200,000 rows/.test(grp)) ok("the group column's card: " + grp.slice(0, 100));
else bad("grp card: " + grp);
await page.click("tr.r-sum th:nth-child(4) button[data-wf]");
await idle();
await page.waitForTimeout(600);
const sku = await card(3);
if (/^whole file · 200,000 rows/.test(sku) && /distinct≥4,097/.test(sku)) ok("a text column with 200,000 distinct values keeps a bounded set and says so: " + sku.slice(0, 100));
else bad("sku card: " + sku);

/* cancelling leaves the card as it was */
await page.click("tr.r-sum th:nth-child(5) button[data-wf]");
await page.waitForFunction(() => document.getElementById("progress").open, null, { timeout: 5000 }).catch(() => {});
await page.keyboard.press("Escape");
await idle();
await page.waitForTimeout(600);
const amt = await card(4);
if (/whole file/.test(amt) || /^first 20,000/.test(amt)) ok("cancel or finish leaves a consistent card: " + amt.slice(0, 60));
else bad("amt card: " + amt);

if (logs.length) { console.log("\nconsole output:"); for (const l of logs) console.log("  " + l); }
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\nsummary cards can describe the whole file in a real browser");
process.exit(failed || logs.length ? 1 : 0);
