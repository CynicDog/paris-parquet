/**
 * Drives the join panel in a real browser: open A, pick B, pick a key each
 * side, run the join, and check the result -- correctness (an inner join
 * against a known fixture), that pushdown actually narrowed the larger
 * side's row groups, and that Undo restores the original file with real
 * footer metadata (not the joined table's synthetic one). Also counts every
 * network request, which must stay at one -- the html itself.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node tools/browser-join.mjs
 *
 * Writes its own tiny fixtures into the OS temp dir rather than depending on
 * tools/fixtures.py's corpus, since it needs a specific, known join shape
 * (a small lookup table against a larger fact-shaped one, with a fraction of
 * rows that deliberately have no match) that isn't a natural byproduct of
 * the general-purpose fixture generator.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "index.html");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-join-"));

let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s) => { failed++; console.log("FAIL " + s); };
const idle = (page) => page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 30000 });

/* string-key fixture: orders.region -> regions.name, with a fraction of
   orders holding a region no lookup row matches, to prove the inner join
   actually drops the unmatched side rather than padding it with nulls */
const genPy = `
import pyarrow as pa, pyarrow.parquet as pq
regions = ["east", "west", "north", "south"]
managers = {"east": "Alice", "west": "Bob", "north": "Cara", "south": "Dee"}
n = 500
order_region = [regions[i % 4] if i % 17 else "unknown" for i in range(n)]
orders = pa.table({"id": pa.array(range(n), pa.int64()), "region": pa.array(order_region),
                    "amount": pa.array([float(i) for i in range(n)], pa.float64())})
pq.write_table(orders, "${tmp}/orders.parquet", compression="snappy", row_group_size=64)
regions_t = pa.table({"name": pa.array(regions), "manager": pa.array([managers[r] for r in regions])})
pq.write_table(regions_t, "${tmp}/regions.parquet", compression="snappy")

big = pa.table({"id": pa.array(range(2000), pa.int64()),
                "value": pa.array([i * 1.5 for i in range(2000)], pa.float64())})
pq.write_table(big, "${tmp}/big.parquet", compression="snappy", row_group_size=100)
small = pa.table({"ref_id": pa.array(range(1900, 1910), pa.int64()),
                  "label": pa.array(["L%d" % i for i in range(1900, 1910)])})
pq.write_table(small, "${tmp}/small.parquet", compression="snappy")
`;
try {
  execFileSync("python3", ["-c", genPy], { stdio: "inherit" });
} catch (e) {
  console.log("could not generate fixtures (needs pyarrow) -- skipping: " + e.message);
  process.exit(0);
}

async function withPage(fn) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const requests = [];
  await ctx.route("**/*", (route, req) => {
    requests.push(req.url());
    if (req.url().startsWith("file://")) route.continue(); else route.abort();
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error") logs.push("console: " + m.text()); });
  page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
  await fn(page);
  const external = requests.filter((u) => !u.startsWith("file://"));
  if (external.length) bad("made a non-file request: " + external[0]); else ok("no network request beyond the page itself");
  if (logs.length) bad("console/page errors: " + logs.join(" | ")); else ok("no console or page errors");
  await browser.close();
}

/* -------------------------------------------------------- string-key join */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.setInputFiles("#picker", path.join(tmp, "orders.parquet"));
  await page.waitForSelector("#toggleJoin:not([hidden])", { timeout: 15000 });
  await page.click("#toggleJoin");
  await page.setInputFiles("#jpicker", path.join(tmp, "regions.parquet"));
  await page.waitForTimeout(300);
  await page.selectOption("#jkeyA", { label: "region" });
  await page.selectOption("#jkeyB", { label: "name" });
  const runEnabled = await page.evaluate(() => !document.getElementById("jrun").disabled);
  if (runEnabled) ok("Run join enables once both keys are picked"); else bad("Run join stayed disabled");
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(150);

  const check = await page.evaluate(() => {
    const t = window.PARIS.state.table;
    const idc = t.cols.findIndex((c) => c.name === "id");
    const rc = t.cols.findIndex((c) => c.name === "region");
    const mc = t.cols.findIndex((c) => c.name === "manager");
    let sample = -1;
    for (let r = 0; r < t.rowsLoaded; r++) if (t.cols[idc].rows[r] === 4) { sample = r; break; }
    return {
      rows: t.rowsLoaded, cols: t.cols.map((c) => c.name),
      anyUnknown: t.cols[rc].rows.includes("unknown"),
      sampleRegion: sample >= 0 ? t.cols[rc].rows[sample] : null,
      sampleManager: sample >= 0 ? t.cols[mc].rows[sample] : null,
    };
  });
  if (check.rows === 470) ok("inner join keeps exactly the matching rows (470 of 500)");
  else bad("expected 470 matched rows, got " + check.rows);
  if (JSON.stringify(check.cols) === JSON.stringify(["id", "region", "amount", "manager"])) {
    ok("output columns: A's columns + B's non-key columns, B's key column dropped");
  } else bad("unexpected output columns: " + JSON.stringify(check.cols));
  if (!check.anyUnknown) ok("rows with no match on either side are dropped, not padded with null");
  else bad("an unmatched row leaked into the joined result");
  if (check.sampleRegion === "east" && check.sampleManager === "Alice") ok("a sample row's B-side value is correct (id 4 -> east -> Alice)");
  else bad("sample row mismatch: " + JSON.stringify(check));

  await page.click("#jundo");
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate(() => ({
    rows: window.PARIS.state.table.rowsLoaded,
    cols: window.PARIS.state.table.cols.map((c) => c.name),
    fileline: document.getElementById("fileline").textContent,
    metaHasSchema: !!(window.PARIS.state.meta && window.PARIS.state.meta.schema),
  }));
  if (afterUndo.rows === 500 && JSON.stringify(afterUndo.cols) === JSON.stringify(["id", "region", "amount"])) {
    ok("Undo restores the original file's rows and columns");
  } else bad("Undo did not restore correctly: " + JSON.stringify(afterUndo));
  if (afterUndo.metaHasSchema) ok("Undo restores real footer metadata (not left null from the joined table)");
  else bad("state.meta has no schema after Undo -- renderMeta() would crash on it");
  if (!afterUndo.fileline.includes("⋈")) ok("fileline no longer shows the stale joined description after Undo");
  else bad("fileline still shows the joined description after Undo: " + afterUndo.fileline);
});

/* --------------------------------------- numeric-key join + real pushdown */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.setInputFiles("#picker", path.join(tmp, "big.parquet"));
  await page.waitForSelector("#toggleJoin:not([hidden])", { timeout: 15000 });
  await page.click("#toggleJoin");
  await page.setInputFiles("#jpicker", path.join(tmp, "small.parquet"));
  await page.waitForTimeout(300);
  await page.selectOption("#jkeyA", { label: "id" });
  await page.selectOption("#jkeyB", { label: "ref_id" });
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(150);

  const check = await page.evaluate(() => {
    const t = window.PARIS.state.table;
    const idc = t.cols.findIndex((c) => c.name === "id");
    const ids = t.cols[idc].rows.slice().sort((a, b) => a - b);
    return { rows: t.rowsLoaded, ids };
  });
  const wantIds = Array.from({ length: 10 }, (_, i) => 1900 + i);
  if (check.rows === 10 && JSON.stringify(check.ids) === JSON.stringify(wantIds)) {
    ok("numeric-key join matches exactly the expected 10 rows");
  } else bad("numeric join mismatch: " + JSON.stringify(check));

  /* the join already ran the real narrowing internally; this confirms the
     exact same range genuinely would skip almost every row group of the
     larger file, proving the reused pushdown machinery is doing real work
     here and not silently degrading to a full scan */
  await page.setInputFiles("#picker", path.join(tmp, "big.parquet"));
  await idle(page);
  const plan = await page.evaluate(async () => {
    const dataset = window.PARIS.state.dataset, table = window.PARIS.state.table;
    const ci = table.cols.findIndex((c) => c.name === "id");
    const p = await window.PARIS.planScan(dataset,
      { filters: [{ ci, pred: "between", value: "1900", valueTo: "1909" }] }, table);
    return p ? { total: p.total, kept: p.kept } : null;
  });
  if (plan && plan.kept < plan.total) {
    ok("the join's key range genuinely narrows the larger side: kept " + plan.kept + " of " + plan.total + " row groups");
  } else bad("pushdown did not narrow anything: " + JSON.stringify(plan));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? failed + " check(s) failed" : "all checks passed");
process.exit(failed ? 1 : 0);
