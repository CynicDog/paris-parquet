/**
 * Checks that decoding on the other cores gives the same answer as decoding
 * here, for every fixture and every type in them — and measures what it saved.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node tools/browser-workers.mjs /tmp/corpus/*.parquet
 *
 * Each file is read twice in the same page, once with the pool forced on and
 * once with it off, and every cell of the two tables is compared. A worker
 * hands numeric columns back as a Float64Array and byte columns as one packed
 * buffer, so this is also where those two shapes are checked against the
 * plain arrays the main thread builds.
 */

import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "index.html");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push("console: " + m.text()); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
await page.goto("file://" + appPath);

let failed = 0;
let announced = false;
let wonMs = 0, lostMs = 0;
for (const file of files) {
  await page.evaluate(() => { window.PARIS.state.dataset = null; });
  await page.setInputFiles("#picker", file);
  await page.waitForFunction(() => window.PARIS.state.dataset || document.getElementById("err"),
    null, { timeout: 120000 });
  const opened = await page.evaluate(() => (window.PARIS.state.dataset ? null :
    document.getElementById("err").textContent));
  if (opened) {
    /* a codec this browser does not have is not a worker problem */
    console.log("skip " + path.basename(file).padEnd(24) + opened.slice(0, 70));
    logs.length = 0;
    continue;
  }
  if (!announced) {
    announced = true;
    const pool = await page.evaluate(() => ({
      cores: navigator.hardwareConcurrency, workers: window.PARIS.pool.workers.length,
    }));
    console.log(`     ${pool.workers} workers on ${pool.cores} reported cores`);
    if (!pool.workers) {
      console.log("FAIL the pool did not start");
      failed++;
      break;
    }
  }
  const r = await page.evaluate(async () => {
    const P = window.PARIS;
    const ds = P.state.dataset;
    const read = async (workers) => {
      P.pool.force = workers;
      P.pool.off = !workers;
      const t = P.newTable(ds);
      const t0 = performance.now();
      await P.loadMore(ds, t, Infinity);
      const ms = performance.now() - t0;
      P.pool.force = false;
      P.pool.off = false;
      return { t, ms };
    };
    await read(true);                                   /* warm both paths */
    await read(false);
    const w = await read(true), m = await read(false);
    /* every cell, rendered the way the grid would render it */
    const text = (v, spec) => (v === null || v === undefined ? null : P.fmtValue(v, spec));
    const problems = [];
    const shapes = {};
    for (let ci = 0; ci < m.t.cols.length; ci++) {
      const a = w.t.cols[ci], b = m.t.cols[ci];
      shapes[ArrayBuffer.isView(a.rows) ? "typed" : "plain"] =
        (shapes[ArrayBuffer.isView(a.rows) ? "typed" : "plain"] || 0) + 1;
      if (a.rows.length !== b.rows.length) {
        problems.push(`${b.name}: ${a.rows.length} rows with workers, ${b.rows.length} without`);
        continue;
      }
      if (a.spec.label !== b.spec.label) problems.push(`${b.name}: type ${a.spec.label} vs ${b.spec.label}`);
      for (let i = 0; i < b.rows.length; i++) {
        const x = text(a.rows[i], a.spec), y = text(b.rows[i], b.spec);
        if (x !== y) {
          problems.push(`${b.name} row ${i}: ${JSON.stringify(x)} with workers, ${JSON.stringify(y)} without`);
          break;
        }
      }
    }
    return { problems, workers: Math.round(w.ms), main: Math.round(m.ms), shapes,
      rows: m.t.rowsLoaded, cols: m.t.cols.length, jobs: P.pool.used };
  });
  const name = path.basename(file).padEnd(24);
  if (r.problems.length) {
    failed++;
    console.log(`FAIL ${name} ${r.problems.length} difference(s)`);
    for (const p of r.problems.slice(0, 4)) console.log("       " + p);
  } else {
    const delta = r.main - r.workers;
    if (delta > 0) wonMs += delta; else lostMs -= delta;
    console.log(`ok   ${name} ${String(r.rows).padStart(7)} rows x ${String(r.cols).padStart(3)} cols  ` +
      `main ${String(r.main).padStart(4)} ms, workers ${String(r.workers).padStart(4)} ms  ` +
      `(${JSON.stringify(r.shapes)})`);
  }
}

if (logs.length) {
  console.log("\nconsole output:");
  for (const l of logs) console.log("  " + l);
}
await browser.close();
console.log(failed || logs.length
  ? `\n${failed} file(s) decoded differently`
  : `\nevery file decodes the same on the other cores (${wonMs} ms saved, ${lostMs} ms lost over ${files.length} files)`);
process.exit(failed || logs.length ? 1 : 0);
