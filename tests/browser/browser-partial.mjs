/**
 * Browsing decodes only as many rows as were asked for, even from the middle of a huge row group, and
 * Load more picks up where it stopped. Whatever the page layout (with and without a page index, v1 and v2
 * data pages, dictionary and delta), the rows read in pieces are exactly the rows a whole-group read gives.
 *
 *   node tests/browser/browser-partial.mjs /tmp/fx      (needs push/pages.parquet, push/pages_v2.parquet, big_snappy.parquet, delta_v2page.parquet)
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) || "/tmp/fx";
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

await page.goto("file://" + appPath);
await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.id = "spare"; document.body.appendChild(i); });

/* what the steps read, against what a whole-group read of the same rows gives */
async function pieces(file, steps) {
  await page.setInputFiles("#spare", path.join(dir, file));
  return page.evaluate(async (steps) => {
    const P = window.PARIS;
    const d = await P.readDataset(P.entriesFromFiles([document.getElementById("spare").files[0]]));
    const whole = P.newTable(d);
    await P.loadMore(d, whole, Infinity);
    const t = P.newTable(d);
    t.slice = true;
    const out = [];
    let want = 0;
    for (const step of steps) {
      want += step;
      await P.loadMore(d, t, step);
      let same = t.rowsLoaded === Math.min(want, whole.rowsLoaded), first = -1;
      for (let c = 0; c < t.cols.length && same; c++) {
        const a = t.cols[c].rows, b = whole.cols[c].rows;
        for (let i = 0; i < a.length; i++) {
          const x = a[i], y = b[i];
          if (x !== y && !(typeof x === "number" && x !== x && y !== y) && JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) !== JSON.stringify(y, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) { same = false; first = c + ":" + i; break; }
        }
      }
      out.push({ step, rows: t.rowsLoaded, group: t.nextGroup, nextRow: t.nextRow, loaded: t.groupsLoaded, truncated: t.truncated, same, first, reads: t.reads.length });
    }
    return { out, total: whole.rowsLoaded, groups: d.numGroups };
  }, steps);
}

for (const [file, steps] of [
  ["push/pages.parquet", [20000, 20000, 15000, 50000, 200000]],        /* page index; two groups of 100,000 */
  ["push/pages_v2.parquet", [20000, 30000, 60000, 100000]],
  ["big_snappy.parquet", [20000, 20000, 80000, 100000]],              /* no page index: the chunk is decoded page by page until enough */
  ["delta_v2page.parquet", [100, 300, 1000]],                          /* delta encoding, v2 pages */
  ["basic_v2page.parquet", [1, 999, 5000]],
]) {
  try {
    const r = await pieces(file, steps);
    const good = r.out.every((s) => s.same);
    if (good) ok(file + ": " + r.out.map((s) => s.rows).join(" → ") + " of " + r.total + " rows in pieces equal the whole-group read");
    else bad(file + ": " + JSON.stringify(r.out.find((s) => !s.same)));
    if (file === "push/pages.parquet") {
      const s0 = r.out[0];
      if (s0.rows === 20000 && s0.group === 0 && s0.nextRow === 20000 && s0.loaded === 1 && s0.truncated) ok("the first 20,000 rows of a 100,000-row group leave it half read: next row " + s0.nextRow);
      else bad("first step of pages: " + JSON.stringify(s0));
      const s2 = r.out[2];
      if (s2.rows === 55000 && s2.nextRow === 55000) ok("Load more continues inside the group, not from its start: " + s2.nextRow);
      else bad("third step of pages: " + JSON.stringify(s2));
      const s3 = r.out[3];
      if (s3.rows === 105000 && s3.group === 1 && s3.nextRow === 5000 && s3.loaded === 2) ok("and crosses into the next group part-way: group " + s3.group + ", row " + s3.nextRow);
      else bad("fourth step of pages: " + JSON.stringify(s3));
      const last = r.out[r.out.length - 1];
      if (last.rows === 200000 && !last.truncated && last.nextRow === 0) ok("reading on to the end finishes the file: " + last.rows);
      else bad("last step of pages: " + JSON.stringify(last));
    }
  } catch (e) { bad(file + " threw: " + e.message); }
}

/* through the page itself: open shows a screenful, and Load more adds one, with no stalls between */
await page.setInputFiles("#picker", path.join(dir, "push/pages.parquet"));
await page.waitForFunction(() => document.getElementById("busy").hidden && window.PARIS.state.table, null, { timeout: 60000 });
const opened = await page.evaluate(() => ({ rows: window.PARIS.state.table.rowsLoaded, hidden: window.PARIS.state.display.hidden.size }));
if (opened.rows === 20000 && opened.hidden === 0) ok("opening a file whose first row group has 100,000 rows reads " + opened.rows + " of them, every column shown");
else bad("open: " + JSON.stringify(opened));
await page.click("#more");
await page.waitForFunction(() => document.getElementById("busy").hidden && window.PARIS.state.table.rowsLoaded > 20000, null, { timeout: 60000 });
const more = await page.evaluate(() => ({ rows: window.PARIS.state.table.rowsLoaded, next: window.PARIS.state.table.nextRow }));
if (more.rows === 40000 && more.next === 40000) ok("Load more adds the next 20,000 of the same group: " + more.rows);
else bad("load more: " + JSON.stringify(more));

if (logs.length) { console.log("\nconsole output:"); for (const l of logs) console.log("  " + l); }
await browser.close();
console.log(failed || logs.length ? `\n${failed} check(s) failed` : "\nbrowsing reads a screenful of a big row group, and continues inside it");
process.exit(failed || logs.length ? 1 : 0);
