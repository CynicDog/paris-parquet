/**
 * Every metric, over a whole large file, against DuckDB.
 *
 * The integration tier compares each metric with DuckDB too, but on fixtures of a few hundred
 * to twenty thousand rows and on one column. Spread, sums and percentiles are exactly the
 * numbers whose accuracy depends on how many values are added and in what order, so this asks
 * the same question of millions of rows, across kinds of column (doubles, a lognormal with a
 * long tail, small integers, float32, a decimal, columns that are mostly null), ungrouped and
 * grouped.
 *
 *   uv run --with pyarrow,numpy tools/big-fixture.py /tmp/big.parquet --rows 5000000
 *   PATH=/path/to/venv-with-duckdb/bin:$PATH node tests/stress/metrics-vs-duckdb.mjs /tmp/big.parquet
 *
 * Counts, distinct counts, MIN, MAX, NULLS and MODE must match exactly. A metric that derives a
 * float (sum, mean, spread, percentile) may differ from DuckDB in the last digits because the
 * two add in a different order; the tolerance is stated per column kind and the difference
 * actually seen is printed for every one, so a metric drifting is visible before it fails.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node tests/stress/metrics-vs-duckdb.mjs FILE.parquet"); process.exit(2); }
const appPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "index.html");

/* name, and the relative tolerance for the metrics that derive a float */
const COLUMNS = [
  { c: "metric_f_001", note: "normal doubles", tol: 1e-9 },
  { c: "metric_f_002", note: "lognormal doubles, long tail", tol: 1e-9 },
  { c: "count_l_003", note: "small int64 counts", tol: 1e-9 },
  { c: "ratio_f32_002", note: "float32", tol: 1e-6 },
  { c: "sparse_000", note: "int32, 95% null", tol: 1e-9 },
  { c: "sparse_001", note: "doubles, 92% null", tol: 1e-9 },
  { c: "money_d_000", note: "decimal(12,2)", tol: 1e-9 },
  { c: "cat_i_005", note: "60 distinct integers (mode, distinct)", tol: 1e-9 },
];
/* [label, how the page writes it, DuckDB column alias, exact?] */
const METRICS = [
  ["COUNT", (c) => `COUNT(${c})`, "COUNT", true],
  ["COUNT DISTINCT", (c) => `COUNT(DISTINCT ${c})`, "COUNT_DISTINCT", true],
  ["SUM", (c) => `SUM(${c})`, "SUM", false],
  ["AVG", (c) => `AVG(${c})`, "AVG", false],
  ["MIN", (c) => `MIN(${c})`, "MIN", true],
  ["MAX", (c) => `MAX(${c})`, "MAX", true],
  ["STD", (c) => `STDDEV_SAMP(${c})`, "STD", false],
  ["STDP", (c) => `STDDEV_POP(${c})`, "STDP", false],
  ["VAR", (c) => `VAR_SAMP(${c})`, "VAR", false],
  ["CV", (c) => `STDDEV_SAMP(${c}) / ABS(AVG(${c}))`, "CV", false],
  ["RANGE", (c) => `MAX(${c}) - MIN(${c})`, "RANGE", false],
  ["MED", (c) => `MEDIAN(${c})`, "MED", false],
  ["P90", (c) => `QUANTILE_CONT(${c}, 0.9)`, "P90", false],
  ["P95", (c) => `QUANTILE_CONT(${c}, 0.95)`, "P95", false],
  ["P99", (c) => `QUANTILE_CONT(${c}, 0.99)`, "P99", false],
  ["IQR", (c) => `QUANTILE_CONT(${c}, 0.75) - QUANTILE_CONT(${c}, 0.25)`, "IQR", false],
  ["NULLS", (c) => `COUNT(*) - COUNT(${c})`, "NULLS", true],
  ["MODE", (c) => `MODE(${c})`, "MODE", true],
];

function duck(sql) {
  const py = `import duckdb, json, sys\nr = duckdb.sql(sys.argv[1]).fetchall()\ncols = [d[0] for d in duckdb.sql(sys.argv[1]).description]\nprint(json.dumps([dict(zip(cols, [float(v) if v is not None else None for v in row])) for row in r]))`;
  return JSON.parse(execFileSync(process.env.PYTHON || "python3", ["-c", py, sql], { maxBuffer: 1 << 26 }).toString());
}
const f = JSON.stringify(file);
/* the derived statistics are taken over the column cast to DOUBLE: on a DECIMAL column DuckDB's
   quantile_cont answers with a decimal, which rounds an interpolated percentile to the column's scale
   (94981.05 where the exact interpolation is 94981.0505), and that is DuckDB's rounding, not a difference in the answer */
const expectedFor = (c) => duck(`select count(${c}) as COUNT, count(distinct ${c}) as COUNT_DISTINCT, sum(${c}::double) as SUM, avg(${c}::double) as AVG,
  min(${c})::double as MIN, max(${c})::double as MAX, stddev_samp(${c}::double) as STD, stddev_pop(${c}::double) as STDP, var_samp(${c}::double) as VAR,
  (stddev_samp(${c}::double) / abs(avg(${c}::double))) as CV, (max(${c}) - min(${c}))::double as RANGE, median(${c}::double) as MED,
  quantile_cont(${c}::double, 0.9) as P90, quantile_cont(${c}::double, 0.95) as P95, quantile_cont(${c}::double, 0.99) as P99,
  (quantile_cont(${c}::double, 0.75) - quantile_cont(${c}::double, 0.25)) as IQR, (count(*) - count(${c})) as NULLS, mode(${c})::double as MODE
  from read_parquet(${f.replace(/"/g, "'")})`)[0];

const dir = mkdtempSync(path.join(os.tmpdir(), "paris-metrics-"));
const context = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1500, height: 950 } });
const page = context.pages()[0] || await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("file://" + appPath);
await page.setInputFiles("#picker", file);
const idle = () => page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 600000, polling: 200 });
await idle();
const rowsInFile = await page.evaluate(() => window.PARIS.state.dataset.numRows);
console.log(`${path.basename(file)}: ${rowsInFile.toLocaleString()} rows; every metric over all of them, in the page, against DuckDB\n`);

/**
 * Runs a query in the page and returns what is on screen. The result columns are named after the
 * column they were computed over, so a view that belongs to an earlier query is recognised and
 * waited out (a big decimal aggregate blocks the page for many seconds) rather than mistaken for
 * the answer; it is a failure only if the right one never arrives.
 */
async function run(sql, expectName) {
  await page.fill("#qsql", sql);
  const atFill = await page.evaluate(() => ({ dialogOpen: document.getElementById("progress").open, busy: !document.getElementById("busy").hidden, at: Math.round(performance.now()) }));
  const afterFill = await page.inputValue("#qsql");
  await page.dispatchEvent("#qsql", "input");
  await page.waitForTimeout(450);
  const afterWait = await page.inputValue("#qsql");
  if (afterFill !== sql || afterWait !== sql) {
    const focus = await page.evaluate(() => ({ active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), ro: document.getElementById("qsql").readOnly, dis: document.getElementById("qsql").disabled, dlg: document.getElementById("progress").open, pages: 0 }));
    console.log(`  (the SQL box is not what the script typed; expected ${expectName}; after fill: ${JSON.stringify(afterFill.slice(0, 70))}; after the wait: ${JSON.stringify(afterWait.slice(0, 70))}; ${JSON.stringify(focus)}; pages open: ${context.pages().length}; state just after the fill: ${JSON.stringify(atFill)})`);
  }
  await page.click("#qrun");
  await idle();
  const problem = await page.evaluate(() => { const m = document.getElementById("qsqlmsg"); return m && !m.hidden ? m.textContent.trim() : ""; });
  if (problem) throw new Error("the page did not accept the query: " + problem.slice(0, 200));
  const read = () => page.evaluate(() => {
    const v = window.PARIS.state.view;
    const num = (x) => (typeof x === "bigint" ? Number(x) : typeof x === "string" && x !== "" && !Number.isNaN(+x) ? +x : x);
    return { rows: v.cols[0].rows.length, names: v.cols.map((c) => c.name), get: v.cols.map((c) => c.rows.map(num)),
      covered: window.PARIS.state.agg ? window.PARIS.state.agg.rows : window.PARIS.state.table.rowsLoaded,   /* a streamed aggregate says how many rows it folded */ busy: !document.getElementById("busy").hidden,
      err: (document.getElementById("err") || {}).textContent || "",
      note: (document.getElementById("memnote") || {}).textContent || "", plan: (document.getElementById("qplan") || {}).textContent || "" };
  });
  let got = await read(), waited = 0;
  while (expectName && got.names[0] !== expectName && waited < 120000) {
    await page.waitForTimeout(500); waited += 500; await idle(); got = await read();
  }
  if (expectName && got.names[0] !== expectName) {
    const state = await page.evaluate(() => ({ dirty: window.PARIS.state.sqlDirty, sql: document.getElementById("qsql").value.slice(0, 60), metrics: window.PARIS.state.query.metrics.length, active: window.PARIS.state.query.active, disabled: document.getElementById("qrun").disabled, filling: !!window.PARIS.state.filling }));
    console.log("  (view stale after the first click; page state: " + JSON.stringify(state) + "; clicking Run again)");
    await page.click("#qrun");
    await idle();
    await page.waitForTimeout(1500);
    got = await read();
    if (got.names[0] === expectName) console.log("  (the second click ran it: the first click was lost)");
  }
  if (expectName && got.names[0] !== expectName) throw new Error(`the view never became this query's (showing ${got.names[0]}); page error: ${got.err.slice(0, 160)}; note: ${got.note.slice(0, 300)}; scope: ${got.plan.slice(0, 120)}`);
  got.waitedMs = waited;
  return got;
}
const rel = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(1e-300, Math.abs(a), Math.abs(b)));

let bad = 0, checks = 0, worst = 0;
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;   // e.g. ONLY=count_l_003,ratio_f32_002
for (const { c, note, tol } of COLUMNS.filter((x) => !ONLY || ONLY.includes(x.c))) {
  const want = expectedFor(c);
  const got = await run("SELECT " + METRICS.map(([, sql]) => sql(c)).join(", ") + "\nFROM t;", `COUNT(${c})`);
  if (got.waitedMs) console.log(`  (the page took ${got.waitedMs / 1000}s longer to replace the previous answer than the script expected)`);
  if (got.covered !== rowsInFile) { bad++; console.log(`FAIL ${c}: the query covered ${got.covered} of ${rowsInFile} rows`); }
  const lines = [];
  METRICS.forEach(([label, , key, exact], i) => {
    const a = got.get[i][0], b = want[key];
    checks++;
    let verdict, diff = 0;
    if (label === "MODE") {
      /* several values can share the greatest frequency and DuckDB does not say which one wins,
         so the page's answer is right if it occurs as often as any value does */
      const fr = duck(`select (select count(*) from read_parquet(${f.replace(/"/g, "'")}) where ${c}::double = ${a}) as got,
        (select max(n) from (select count(*) as n from read_parquet(${f.replace(/"/g, "'")}) where ${c} is not null group by ${c})) as best`)[0];
      verdict = fr.got === fr.best ? "ok" : "FAIL";
      lines.push(`  ${label.padEnd(15)} ${String(a).padStart(24)}  ${String(b).padStart(24)}  ${("freq " + fr.got + "/" + fr.best).padStart(8)}  ${verdict}${a === b ? "" : " (a tie: DuckDB picked another)"}`);
      if (verdict === "FAIL") bad++;
      return;
    }
    if (a === null || b === null || a === undefined) { verdict = a === b || (a == null && b == null) ? "ok" : "FAIL"; }
    else if (exact) { verdict = a === b ? "ok" : "FAIL"; }
    else { diff = rel(a, b); verdict = diff <= tol ? "ok" : "FAIL"; worst = Math.max(worst, diff); }
    if (verdict === "FAIL") bad++;
    lines.push(`  ${label.padEnd(15)} ${String(a).padStart(24)}  ${String(b).padStart(24)}  ${exact ? "exact" : diff.toExponential(1).padStart(8)}  ${verdict}`);
  });
  console.log(`${c}  (${note}, tolerance ${tol})`);
  console.log(`  ${"metric".padEnd(15)} ${"page".padStart(24)}  ${"duckdb".padStart(24)}  ${"rel diff".padStart(8)}`);
  console.log(lines.join("\n") + "\n");
}

/* grouped: every group of a metric column, compared group by group */
for (const c of ["metric_f_002", "count_l_003"]) {
  const g = "cat_s_000";
  const list = ["COUNT", "SUM", "AVG", "STD", "MED", "P99"];
  const sqlFor = { COUNT: `COUNT(${c})`, SUM: `SUM(${c})`, AVG: `AVG(${c})`, STD: `STDDEV_SAMP(${c})`, MED: `MEDIAN(${c})`, P99: `QUANTILE_CONT(${c}, 0.99)` };
  const got = await run(`SELECT ${g}, ${list.map((m) => sqlFor[m]).join(", ")}\nFROM t\nGROUP BY ${g};`, g);
  // group keys are strings in the page and in DuckDB; DuckDB's json gave floats only for numbers, so read it as text
  const expText = JSON.parse(execFileSync(process.env.PYTHON || "python3", ["-c", "import duckdb, json, sys\nprint(json.dumps({str(r[0]): list(r[1:]) for r in duckdb.sql(sys.argv[1]).fetchall()}))",
    `select ${g}, count(${c}), sum(${c})::double, avg(${c})::double, stddev_samp(${c})::double, median(${c})::double, quantile_cont(${c}, 0.99)::double from read_parquet(${f.replace(/"/g, "'")}) group by ${g}`], { maxBuffer: 1 << 26 }).toString());
  let ok = 0, groups = got.rows;
  for (let r = 0; r < got.rows; r++) {
    const key = String(got.get[0][r]);
    const want = expText[key];
    if (!want) { bad++; console.log(`FAIL ${c}: group ${key} is not in DuckDB's answer`); continue; }
    list.forEach((m, k) => {
      checks++;
      const a = got.get[k + 1][r], b = want[k];
      const d = m === "COUNT" ? (a === b ? 0 : Infinity) : rel(a, b);
      if (m !== "COUNT") worst = Math.max(worst, d);
      if (d > 1e-9) { bad++; console.log(`FAIL ${c} group ${key} ${m}: ${a} vs ${b} (${d.toExponential(1)})`); } else ok++;
    });
  }
  console.log(`grouped by ${g}: ${c}, ${groups} groups x ${list.length} metrics: ${ok} of ${groups * list.length} agree with DuckDB\n`);
}

await context.close();
rmSync(dir, { recursive: true, force: true });
if (errors.length) { console.log("page errors:\n  " + errors.join("\n  ")); bad += errors.length; }
console.log(`${checks} comparisons, ${bad} disagreements; the largest relative difference on a derived metric was ${worst.toExponential(2)}`);
process.exit(bad ? 1 : 0);
