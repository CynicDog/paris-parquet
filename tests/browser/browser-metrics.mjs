/**
 * Drives the METRICS row in a real browser. Six aggregates sit inline and the
 * rest live behind "more", so the things worth checking are the ones only a
 * browser can answer: that the button opens the rest in place, that picking
 * one closes the row again and pins itself onto the button (a closed row must
 * never misstate what it computes), and that the SQL box follows every press.
 * Also counts every network request, which must stay at one -- the html itself.
 *
 *   node tests/browser/browser-metrics.mjs /tmp/fx/basic_snappy.parquet
 *
 * Any file with a string column and a number column works.
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const file = process.argv[2] || "/tmp/fx/basic_snappy.parquet";
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "..", "index.html");

let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s) => { failed++; console.log("FAIL " + s); };
const is = (got, want, what) => (got === want ? ok(what) : bad(`${what} -- got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

/** What the metric row looks like right now, read off the real DOM. */
const readRow = (page) => page.evaluate(() => {
  const row = document.querySelector("#qzones .qrow");
  const more = row.querySelector(".qmore-btn");
  const text = (el) => el.textContent.trim();
  return {
    inline: [...row.querySelectorAll(".qbtns > .qb")].filter((b) => !b.classList.contains("qmore-btn")).map(text),
    lit: [...row.querySelectorAll(".qb.on")].map(text),
    more: text(more),
    moreOn: more.classList.contains("on"),
    open: !!row.querySelector(".qmore"),
    groups: [...row.querySelectorAll(".qmore .qmlabel")].map(text),
    hidden: [...row.querySelectorAll(".qmore .qb")].map((b) => b.dataset.v),
    /* the expander is a wrapping flex child: same line when it fits, its own
       line when it does not, and never outside the row it belongs to */
    wrapped: (() => {
      const panel = row.querySelector(".qmore");
      if (!panel) return null;
      const r = panel.getBoundingClientRect(), rr = row.getBoundingClientRect();
      return { inside: r.left >= rr.left - 1 && r.right <= rr.right + 1, below: r.top > rr.top + 1 };
    })(),
  };
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const requests = [];
await ctx.route("**/*", (route, req) => {
  requests.push(req.url());
  if (req.url().startsWith("file://")) route.continue(); else route.abort();
});
const page = await ctx.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") logs.push("console: " + m.text()); });

await page.goto("file://" + appPath);
await page.setInputFiles("#picker", file);
await page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 60000 });
/* the panel opens itself on the first file; only press the button if it did not */
await page.evaluate(() => {
  if (document.getElementById("query").hidden) document.getElementById("toggleQuery").click();
});
await page.waitForSelector("#qcols .qcol");

const cols = await page.evaluate(() => [...document.querySelectorAll("#qcols .qcol")].map((c) => ({
  name: c.querySelector(".qcname").textContent, tag: c.querySelector(".qtag").textContent,
})));
const str = cols.find((c) => c.tag === "STR"), num = cols.find((c) => c.tag === "NUM");
if (!str || !num) {
  console.log(`${path.basename(file)} has no string+number pair to group -- nothing to drive`);
  await browser.close();
  process.exit(1);
}

/* the SQL box is the shortest way into aggregate mode, and it doubles as a
   check that a hidden metric is read back out of SQL in the first place */
await page.fill("#qsql", `SELECT ${str.name}, STDDEV_SAMP(${num.name})\nFROM t\nGROUP BY ${str.name};`);
/* blur first: leaving the box re-parses it and rewrites the zones, and a
   click that lands mid-rewrite is swallowed along with the node it hit */
await page.locator("#qsql").blur();
await page.waitForSelector("#qzones .qmore-btn", { timeout: 5000 });

let row = await readRow(page);
is(row.inline.join(" "), "COUNT CNTD SUM AVG MIN MAX", "the six common aggregates stay inline");
is(row.more, "STD ⋯", "a hidden metric pins itself onto the closed more button");
is(row.moreOn, true, "and the button is lit, so a closed row still says what it computes");
is(row.lit.join(" "), "STD ⋯", "none of the six is lit while a hidden one is chosen");
is(row.open, false, "the row starts closed");

await page.click("#qzones .qmore-btn");
row = await readRow(page);
is(row.open, true, "more opens the rest in place");
is(row.groups.join(" "), "spread distribution missing", "grouped into spread, distribution and missing");
is(row.hidden.join(" "), "STD STDP VAR CV RANGE MED P90 P95 P99 IQR MODE NULLS", "all twelve are reachable");
is(row.more, "STD ⌄", "the button turns into a close arrow");
is(row.wrapped && row.wrapped.inside, true, "the panel stays inside its own row -- nothing is clipped or overlaid");

await page.click("#qzones .qmore [data-v='MED']");
row = await readRow(page);
is(row.open, false, "picking one closes the row again");
is(row.more, "MED ⋯", "and the new pick is what the closed button now shows");
let sql = await page.inputValue("#qsql");
is(/MEDIAN\(/.test(sql), true, "the SQL box follows: MEDIAN(...)");

await page.click("#qzones .qmore-btn");
await page.click("#qzones .qmore [data-v='IQR']");
sql = await page.inputValue("#qsql");
is(/QUANTILE_CONT\([^)]+, 0\.75\) - QUANTILE_CONT\([^)]+, 0\.25\)/.test(sql), true,
  "a composite metric writes itself out in full");

/* and back to one of the six: the pin has to come off again */
await page.click("#qzones .qb[data-v='AVG']");
row = await readRow(page);
is(row.more, "⋯", "picking one of the six clears the pin");
is(row.moreOn, false, "and unlights the more button");
is(row.lit.join(" "), "AVG", "AVG is the only lit button now");

await page.click("#qzones .qmore-btn");
await page.click("#qzones .qmore [data-v='STD']");
await page.click("#qrun");
await page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 60000 });
const ran = await page.evaluate(() => ({
  stat: document.getElementById("qstat").textContent,
  head: [...document.querySelectorAll("#grid tr.r-name th")].map((th) => th.textContent),
  first: [...document.querySelectorAll("#tbody tr")][0]?.children[2]?.textContent,
}));
is(/groups/.test(ran.stat), true, `running it groups the rows -- ${ran.stat.split("·")[0].trim()}`);
is(ran.head.some((h) => /^STD\(/.test(h)), true, "the result column is named after the metric");
is(Number.isFinite(parseFloat(ran.first)), true, `and holds a number -- STD = ${ran.first}`);

is(requests.length, 1, "one request, the page itself");
for (const l of logs) bad(l);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nmetric row drives correctly");
process.exit(failed ? 1 : 0);
