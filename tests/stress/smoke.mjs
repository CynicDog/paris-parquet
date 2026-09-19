/**
 * A reduced stress run, small enough for CI: generates two files of the same shape a few times apart in
 * rows, runs the harness's open and mergeable-aggregate scenarios on both, and fails if the aggregate's
 * memory follows the row count. That is the property the whole-file aggregate exists to have (it folds one
 * row group at a time), and the one that would quietly go if something started holding the column again.
 *
 *   node tests/stress/smoke.mjs [--rows 100000] [--factor 4]
 *
 * Needs python3 with pyarrow and numpy (tools/big-fixture.py) and Playwright's chromium.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i < 0 ? d : argv[i + 1]; };
const small = +opt("rows", 250000), factor = +opt("factor", 4), large = small * factor;
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, "..", "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "paris-smoke-"));

const python = process.env.PYTHON || "python3";
const make = (rows) => {
  const out = path.join(tmp, "t_" + rows + ".parquet");
  execFileSync(python, [path.join(root, "tools", "big-fixture.py"), out, "--rows", String(rows), "--columns", "130", "--row-group", "50000"], { stdio: ["ignore", "ignore", "inherit"] });
  return out;
};
const run = (file, budget) => {
  const json = path.join(tmp, path.basename(file) + ".json");
  const r = spawnSync(process.execPath, [path.join(here, "stress.mjs"), file, "--scenarios", "open,agg-mergeable", "--limit-mb", "6000", "--json", json, ...(budget ? ["--budget-mb", String(budget)] : []), ...argv.filter((a) => a === "--allow-rss")], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) { console.error("stress run failed for " + file); process.exit(1); }
  return JSON.parse(readFileSync(json, "utf8")).results;
};

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };
try {
  /* the larger file's five aggregated columns would take about 200 MB held whole; the page is given 64 */
  const a = run(make(small)), b = run(make(large), 64);
  const peak = (rs) => rs.find((r) => /COUNT\/AVG/.test(r.label));
  const pa = peak(a), pb = peak(b);
  check(pa && pb && pa.outcome === "ok" && pb.outcome === "ok", "the aggregate ran on both files: " + (pa && pa.outcome) + ", " + (pb && pb.outcome));
  /* a run that did not really cover the file (a query that failed to parse, say) would trivially look flat */
  check(pa && pb && /Whole file\. Searched all 250,000 rows/.test(pa.note) && /Whole file\. Searched all 1,000,000 rows/.test(pb.note), "and each really covered the whole file: " + (pb && pb.note));
  if (pa && pb) {
    /* the larger file has `factor` times the rows; if memory followed the rows it would be about `factor` times the smaller peak */
    const limit = pa.peakRssMB * 1.3 + 80;
    check(pb.peakRssMB <= limit, `whole-file aggregate peak: ${pa.peakRssMB} MB at ${small.toLocaleString()} rows, ${pb.peakRssMB} MB at ${large.toLocaleString()} (${factor}x the rows), allowed up to ${Math.round(limit)} MB`);
  }
  /* the invariant that does not depend on how the OS or the garbage collector feels: under a budget too small to hold the
     columns, the aggregate over every row still ran, so it folded one row group at a time */
  check(pb && !/Not run/.test(pb.note) && /Searched all 1,000,000 rows/.test(pb.note), "and it ran over all 1,000,000 rows under a 64 MB page budget, which holding its columns would not fit");
  const open = (rs) => rs.find((r) => /open/.test(r.label));
  check(open(a) && open(b) && open(a).outcome === "ok" && open(b).outcome === "ok", "opening both files worked");
} finally { rmSync(tmp, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
