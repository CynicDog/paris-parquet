/**
 * Accessibility, checked by axe against the page in a real browser: the open-file, query, column-picker, metadata, diff
 * and join views, in the light and the dark theme. Fails on any serious or critical violation, so the list comes from
 * the page and cannot rot. Also asserts the semantics that axe cannot see (roles and states on toggles, dialogs that
 * take and return focus) and that the core flow can be done with the keyboard alone.
 *
 *   node tests/browser/browser-a11y.mjs /tmp/fx/push      (needs sorted.parquet and shuffled.parquet)
 */

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { AxeBuilder } = require("@axe-core/playwright");
const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) || "/tmp/fx/push";
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "..", "index.html");
const verbose = process.argv.includes("--verbose");

const browser = await chromium.launch();
let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s) => { failed++; console.log("FAIL " + s); };

async function newPage(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
  await ctx.route("**/*", (route, req) => { if (req.url().startsWith("file://")) route.continue(); else route.abort(); });
  const page = await ctx.newPage();
  await page.goto("file://" + appPath);
  return page;
}
const idle = (page) => page.waitForFunction(() => document.getElementById("busy").hidden && window.PARIS.state.table, null, { timeout: 60000 });

async function scan(page, label) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad_ = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (!bad_.length) { ok(label + ": no serious or critical violations" + (r.violations.length ? " (" + r.violations.length + " minor)" : "")); return; }
  bad(label + ": " + bad_.map((v) => v.id + " x" + v.nodes.length).join(", "));
  if (verbose) for (const v of bad_) { console.log("     " + v.id + ": " + v.help); for (const n of v.nodes.slice(0, 3)) console.log("       " + n.target.join(" ") + "  " + (n.failureSummary || "").split("\n").slice(0, 2).join(" ").slice(0, 160)); }
}

for (const scheme of ["light", "dark"]) {
  const page = await newPage(scheme);
  await scan(page, scheme + " / empty page");
  await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
  await idle(page);
  await page.waitForFunction(() => window.PARIS.cardsIdle && !document.querySelector("#cardprog:not([hidden])"), null, { timeout: 60000 }).catch(() => {});
  await scan(page, scheme + " / file open (grid, cards, query bar)");
  await page.click("#toggleCols");
  await scan(page, scheme + " / column picker open");
  await page.click("#toggleCols");
  const hidden = await page.$eval("#toggleMeta", (b) => b.textContent);
  if (/Show metadata/.test(hidden)) await page.click("#toggleMeta");
  await scan(page, scheme + " / metadata panel");
  await page.click("#toggleDiff");
  await scan(page, scheme + " / diff panel");
  await page.click("#toggleDiff");
  await page.click("#toggleJoin");
  await scan(page, scheme + " / join panel");
  await page.context().close();
}
/* ---- what axe cannot see: roles and states, focus, and the core flow with the keyboard alone ---- */
{
  const page = await newPage("light");
  await page.setInputFiles("#picker", path.join(dir, "sorted.parquet"));
  await idle(page);
  const sem = await page.evaluate(() => ({
    mode: [...document.querySelectorAll("#qmode button")].map((b) => b.getAttribute("aria-pressed")),
    colsPopup: document.getElementById("toggleCols").getAttribute("aria-haspopup"),
    rowcount: document.getElementById("grid").getAttribute("aria-rowcount"), colcount: document.getElementById("grid").getAttribute("aria-colcount"),
    firstRow: document.querySelector("#tbody tr").getAttribute("aria-rowindex"),
    headers: [...document.querySelectorAll("tr.r-name th.sortable")].every((t) => t.tabIndex === 0 && t.hasAttribute("aria-sort")),
    scope: document.getElementById("qplan").getAttribute("role"),
  }));
  if (sem.mode.join() === "true,false") ok("the Rows / Aggregate switch says which is on (aria-pressed)"); else bad("mode switch: " + JSON.stringify(sem.mode));
  if (sem.rowcount === "20002" && sem.colcount === "5" && sem.firstRow === "3") ok("the grid states its size (" + sem.rowcount + " rows, " + sem.colcount + " columns) and numbers the rows it draws");
  else bad("grid semantics: " + JSON.stringify(sem));
  if (sem.headers) ok("every sortable header can be reached with Tab and says its sort state"); else bad("headers are not focusable");

  /* the picker is a dialog: it takes focus, and Escape gives it back */
  await page.click("#toggleCols");
  const open = await page.evaluate(() => ({ focus: document.activeElement.id, exp: document.getElementById("toggleCols").getAttribute("aria-expanded"), role: document.getElementById("colpick").getAttribute("role") }));
  await page.keyboard.press("Escape");
  const closed = await page.evaluate(() => ({ focus: document.activeElement.id, hidden: document.getElementById("colpick").hidden, exp: document.getElementById("toggleCols").getAttribute("aria-expanded") }));
  if (open.focus === "cpsearch" && open.exp === "true" && closed.hidden && closed.focus === "toggleCols" && closed.exp === "false") ok("the column picker takes focus when it opens and Escape returns it to the button");
  else bad("picker focus: " + JSON.stringify({ open, closed }));

  /* keyboard only: type a query, run it with Enter, sort by a header with Enter, read the result */
  await page.focus("#qsql");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('SELECT * FROM sorted WHERE "id" >= 100000');
  await page.keyboard.press("ControlOrMeta+Enter");                 /* Enter is a new line in the SQL box; Ctrl or Cmd with it runs */
  await page.waitForFunction(() => document.getElementById("busy").hidden && window.PARIS.state.table.scan, null, { timeout: 60000 });
  await page.focus("tr.r-name th:nth-child(2)");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("busy").hidden && window.PARIS.state.query.sort.length === 1, null, { timeout: 60000 });
  const res = await page.evaluate(() => ({ sort: window.PARIS.state.query.sort[0].dir, plan: document.getElementById("qplan").textContent.replace(/\s+/g, " ").trim(), first: window.PARIS.state.view.cols[0].rows[window.PARIS.state.view.index ? window.PARIS.state.view.index[0] : 0] }));
  if (res.sort === "ASC" && res.first === 100000 && /Whole file/.test(res.plan)) ok("a query typed and run, then sorted from a focused header, all with the keyboard: first id " + res.first + ", " + res.plan.slice(0, 40));
  else bad("keyboard flow: " + JSON.stringify(res));
  /* Alt with the arrows moves a column, the keyboard's way of dragging it */
  const before = await page.evaluate(() => [...document.querySelectorAll("tr.r-name th.sortable .cname")].map((e) => e.textContent).join());
  await page.focus("tr.r-name th:nth-child(2)");
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ order: [...document.querySelectorAll("tr.r-name th.sortable .cname")].map((e) => e.textContent).join(), focus: document.activeElement.querySelector && (document.activeElement.querySelector(".cname") || {}).textContent }));
  const b = before.split(",");
  if (after.order === [b[1], b[0], ...b.slice(2)].join() && after.focus === b[0]) ok("Alt+Right moves the focused column one place, and focus stays on it: " + after.order);
  else bad("keyboard reorder: " + JSON.stringify({ before, after }));
  await page.context().close();
}
await browser.close();
console.log(failed ? `\n${failed} view(s) with serious or critical accessibility violations` : "\nno serious or critical accessibility violations in any view");
process.exit(failed ? 1 : 0);
