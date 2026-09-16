/**
 * Checks predicate pushdown.
 *
 *   python3 tools/fixtures.py /tmp/fx
 *   node tools/check-push.mjs /tmp/fx/push /tmp/fx/folders/hive
 *
 * The property that matters is that skipping changes nothing: for every
 * query, the rows a scan produces must be the rows a full read produces,
 * cell for cell. On top of that each case says how much it expects to be
 * skipped, so a plan that quietly stops pruning is a failure too — and the
 * bloom filter is checked directly against values known to be in the file
 * and values known not to be.
 */
import fs from "node:fs";
import path from "node:path";
import { appPath, loadApp } from "./check.mjs";

const PARIS = loadApp(appPath);
const dir = process.argv[2] || "/tmp/fx/push";
const hive = process.argv[3] || path.join(dir, "..", "folders", "hive");

let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s, d) => { failed++; console.log("FAIL " + s + (d ? "\n       " + String(d).replace(/\n/g, "\n       ") : "")); };

function source(file) {
  const buf = fs.readFileSync(file);
  return { size: buf.length, name: path.basename(file),
    async read(s, e) { return new Uint8Array(buf.subarray(s, e)); } };
}
function entriesOf(target) {
  if (fs.statSync(target).isFile()) {
    const src = source(target);
    return [{ src, path: src.name }];
  }
  const out = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, prefix + e.name + "/");
      else if (PARIS.isParquetPath(prefix + e.name)) out.push({ src: source(full), path: prefix + e.name });
    }
  };
  walk(target, "");
  return out;
}
async function open(target) {
  const dataset = await PARIS.readDataset(entriesOf(target));
  const table = PARIS.newTable(dataset);
  return { dataset, table };
}
const canon = (v, spec) => {
  if (v === null || v === undefined) return null;
  switch (spec.kind) {
    case "number": return typeof v === "number" ? String(v) : v.toString();
    case "bool": return v ? "true" : "false";
    case "string": return v;
    case "binary": return Buffer.from(v).toString("hex");
    default: return PARIS.fmtValue(v, spec);
  }
};
/** Every cell of the current view, sorted so row order cannot matter. */
function dump() {
  const view = PARIS.state.view;
  const rows = [];
  for (let r = 0; r < view.count; r++) {
    rows.push(view.cols.map((c, ci) => canon(PARIS.viewValue(view, ci, r), c.spec)).join("\u0001"));
  }
  rows.sort();
  return rows;
}
const blank = () => ({ active: false, mode: "rows", select: [], filters: [], sort: [], groupBy: [], metrics: [], limit: null });

/** Runs one query twice: over the whole file, and over only what a plan kept. */
async function both(target, name, build, expect) {
  const full = await open(target);
  await PARIS.loadMore(full.dataset, full.table, Infinity);
  const ci = (col) => full.table.cols.findIndex((c) => c.name === col);
  const q = blank();
  build(q, ci);

  PARIS.state.dataset = full.dataset;
  PARIS.state.table = full.table;
  PARIS.state.meta = full.dataset.reference;
  PARIS.state.display = PARIS.newDisplay(full.table.cols);
  PARIS.state.query = q;
  PARIS.runQuery();
  const wanted = dump();

  const scan = await open(target);
  const plan = await PARIS.planScan(scan.dataset, q, scan.table);
  if (!plan) { bad(name, "nothing was pushed down at all"); return; }
  scan.table.plan = plan.keep;
  scan.table.scan = plan;
  await PARIS.loadMore(scan.dataset, scan.table, Infinity);
  PARIS.state.dataset = scan.dataset;
  PARIS.state.table = scan.table;
  PARIS.state.meta = scan.dataset.reference;
  PARIS.state.display = PARIS.newDisplay(scan.table.cols);
  PARIS.state.query = q;
  PARIS.runQuery();
  const got = dump();

  const where = `${plan.kept}/${plan.total} groups, ${(plan.bytesKept / 1048576).toFixed(1)} of ` +
    `${(plan.bytesTotal / 1048576).toFixed(1)} MB`;
  if (got.length !== wanted.length) {
    bad(name, `scan gave ${got.length} rows, a full read gives ${wanted.length} (${where})`);
    return;
  }
  const at = got.findIndex((row, i) => row !== wanted[i]);
  if (at >= 0) {
    bad(name, `row ${at}\n  scan ${got[at]}\n  full ${wanted[at]}`);
    return;
  }
  const problem = expect && expect(plan, wanted.length);
  if (problem) bad(name, problem + " (" + where + ")");
  else ok(`${name.padEnd(46)} ${String(wanted.length).padStart(6)} rows, read ${where}`);
}

/* ------------------------------------------------ statistics on a sorted file */
const sorted = path.join(dir, "sorted.parquet");
await both(sorted, "sorted: id BETWEEN 50000 AND 50100",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "between", value: "50000", valueTo: "50100", linker: "AND" }]; },
  (p) => (p.kept > 2 ? `kept ${p.kept} row groups, expected at most 2` : null));
await both(sorted, "sorted: id < 100",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "lt", value: "100", linker: "AND" }]; },
  (p) => (p.kept !== 1 ? `kept ${p.kept} row groups, expected 1` : null));
await both(sorted, "sorted: id >= 195000",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "ge", value: "195000", linker: "AND" }]; },
  (p) => (p.kept !== 1 ? `kept ${p.kept} row groups, expected 1` : null));
await both(sorted, "sorted: id = 123456",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "eq", value: "123456", linker: "AND" }]; },
  (p) => (p.kept !== 1 ? `kept ${p.kept} row groups, expected 1` : null));
await both(sorted, "sorted: id > 1000000 (nothing can match)",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "gt", value: "1000000", linker: "AND" }]; },
  (p) => (p.kept !== 0 ? `kept ${p.kept} row groups, expected none` : null));
await both(sorted, "sorted: sku BETWEEN 'sku-000100' AND 'sku-000200'",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("sku"), pred: "between", value: "sku-000100", valueTo: "sku-000200", linker: "AND" }]; },
  (p) => (p.kept > 2 ? `kept ${p.kept} row groups on a text range, expected at most 2` : null));
await both(sorted, "sorted: id < 100 OR id >= 199900",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("id"), pred: "lt", value: "100", linker: "AND" },
      { id: "b", ci: ci("id"), pred: "ge", value: "199900", linker: "OR" },
    ];
  },
  (p) => (p.kept !== 2 ? `kept ${p.kept} row groups for two disjoint ranges, expected 2` : null));
await both(sorted, "sorted: id > 50000 AND id < 50500 AND grp = 3",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("id"), pred: "gt", value: "50000", linker: "AND" },
      { id: "b", ci: ci("id"), pred: "lt", value: "50500", linker: "AND" },
      { id: "c", ci: ci("grp"), pred: "eq", value: "3", linker: "AND" },
    ];
  },
  (p) => (p.kept !== 1 ? `kept ${p.kept} row groups, expected 1` : null));
/* a clause the statistics cannot help with must not stop the one that can */
await both(sorted, "sorted: id < 20000 AND sku LIKE 000123",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("id"), pred: "lt", value: "20000", linker: "AND" },
      { id: "b", ci: ci("sku"), pred: "like", value: "000123", linker: "AND" },
    ];
  },
  (p) => (p.kept !== 2 ? `kept ${p.kept} row groups, expected 2` : null));
await both(sorted, "sorted: amt >= 249 (every group holds the full range)",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("amt"), pred: "ge", value: "249", linker: "AND" }]; },
  (p) => (p.kept !== p.total ? `kept ${p.kept} of ${p.total}, expected all of them` : null));

/* ------------------------------------- the page index, inside a row group */
const pages = path.join(dir, "pages.parquet");
{
  const f = await open(pages);
  const c0 = f.dataset.parts[0].meta.rowGroups[0].columns[0];
  const locs = await PARIS.readOffsetIndex(f.dataset.parts[0].src, c0);
  if (!locs) console.log("skip page index checks — this pyarrow did not write one");
  else ok(`page index: ${locs.length} pages in the first row group of ${f.dataset.parts[0].meta.rowGroups.length}`);
}
await both(pages, "pages: id BETWEEN 100 AND 200",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "between", value: "100", valueTo: "200", linker: "AND" }]; },
  (p) => (p.rows > 20000 ? `read ${p.rows} rows; the page index should have cut that far further` : null));
await both(pages, "pages: id = 150000",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "eq", value: "150000", linker: "AND" }]; },
  (p) => (p.kept !== 1 || p.rows > 20000 ? `kept ${p.kept} groups and ${p.rows} rows for one id` : null));
await both(pages, "pages: id < 50 OR id > 199950",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("id"), pred: "lt", value: "50", linker: "AND" },
      { id: "b", ci: ci("id"), pred: "gt", value: "199950", linker: "OR" },
    ];
  },
  (p) => (p.rows > 30000 ? `read ${p.rows} rows for two ends of the file` : null));
await both(pages, "pages: id > 90000 AND id < 110000 (across the row group edge)",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("id"), pred: "gt", value: "90000", linker: "AND" },
      { id: "b", ci: ci("id"), pred: "lt", value: "110000", linker: "AND" },
    ];
  },
  (p) => (p.kept !== 2 || p.rows > 60000 ? `kept ${p.kept} groups and ${p.rows} rows` : null));
/* two columns whose pages do not line up: the rows they agree on are what
   every column has to come back with */
await both(pages, "pages: id > 40000 AND sku < 'sku-045000'",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("id"), pred: "gt", value: "40000", linker: "AND" },
      { id: "b", ci: ci("sku"), pred: "lt", value: "sku-045000", linker: "AND" },
    ];
  },
  (p) => (p.rows > 40000 ? `read ${p.rows} rows where two columns overlap on 5,000` : null));
await both(pages, "pages: grp = 5 (one value in every page)",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("grp"), pred: "eq", value: "5", linker: "AND" }]; },
  (p) => (p.rows !== p.rowsTotal ? `narrowed to ${p.rows} rows for a value every page holds` : null));

/* ----------------------------------- v2 pages, nulls, and a list column that
   the page index cannot be used to split, all in one row group */
const pagesV2 = path.join(dir, "pages_v2.parquet");
await both(pagesV2, "v2 pages: id BETWEEN 1000 AND 1100",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "between", value: "1000", valueTo: "1100", linker: "AND" }]; },
  (p) => (p.rows > 20000 ? `read ${p.rows} rows, so the v2 page index did not narrow` : null));
await both(pagesV2, "v2 pages: maybe IS NULL AND id < 3000",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("maybe"), pred: "null", value: "", linker: "AND" },
      { id: "b", ci: ci("id"), pred: "lt", value: "3000", linker: "AND" },
    ];
  },
  (p) => (p.rows > 20000 ? `read ${p.rows} rows` : null));
/* half the file matches here, so there is little to narrow — what matters is
   that a list column, whose pages do not split on rows, still lines up */
await both(pagesV2, "v2 pages: id > 99000 (a list column comes along for the ride)",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "gt", value: "99000", linker: "AND" }]; },
  (p, matched) => (p.rows > matched + 20000 ? `read ${p.rows} rows for ${matched} matching` : null));

/* ------------------------------------------------------------- bloom filters */
const shuffled = path.join(dir, "shuffled.parquet");
{
  const f = await open(shuffled);
  const rg0 = f.dataset.parts[0].meta.rowGroups[0];
  const idChunk = rg0.columns.find((c) => c.meta && c.meta.path.join(".") === "id");
  if (!idChunk || idChunk.meta.bloomFilterOffset == null) {
    console.log("skip bloom filter checks — this pyarrow did not write one");
  } else {
    /* every value really in the first row group has to come back "maybe" */
    const one = await open(shuffled);
    one.table.plan = new Map([["0:0", null]]);
    await PARIS.loadMore(one.dataset, one.table, Infinity);
    const ids = one.table.cols.find((c) => c.name === "id").rows;
    const data = await PARIS.readBloom(f.dataset.parts[0].src, idChunk);
    if (!data) { bad("bloom: filter read", "the header did not parse"); }
    else {
      const bytesOf = (v) => {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
        return b;
      };
      let missed = 0;
      for (const v of ids) if (!PARIS.bloomHas(data, PARIS.xxh64(bytesOf(v)))) missed++;
      if (missed) bad("bloom: every value present says maybe", `${missed} of ${ids.length} said no`);
      else ok(`bloom: all ${ids.length} values in the row group said maybe`);

      const present = new Set(ids);
      let hits = 0, tried = 0;
      for (let v = 1000000; v < 1020000; v++) {
        if (present.has(v)) continue;
        tried++;
        if (PARIS.bloomHas(data, PARIS.xxh64(bytesOf(v)))) hits++;
      }
      const rate = hits / tried;
      if (rate > 0.2) bad("bloom: absent values", `${(rate * 100).toFixed(1)}% false positives — the hash is probably wrong`);
      else ok(`bloom: ${tried} absent values, ${(rate * 100).toFixed(2)}% false positives`);
    }
  }
}
await both(shuffled, "shuffled: id = 12345 (only a bloom filter can prune)",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "eq", value: "12345", linker: "AND" }]; },
  (p) => (p.kept > 3 ? `kept ${p.kept} of ${p.total} row groups; the bloom filters are not being used` : null));
await both(shuffled, "shuffled: sku = 'sku-099999'",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("sku"), pred: "eq", value: "sku-099999", linker: "AND" }]; },
  (p) => (p.kept > 3 ? `kept ${p.kept} of ${p.total} row groups on a string equality` : null));
await both(shuffled, "shuffled: sku = 'nothing like this'",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("sku"), pred: "eq", value: "nothing like this", linker: "AND" }]; },
  (p) => (p.kept > 1 ? `kept ${p.kept} row groups for a value in none of them` : null));
/* shuffling spreads every group over most of the range, but a group whose own
   minimum is above 9 still cannot hold a 5..9 — so some pruning is right here,
   and the row comparison is what proves it did not prune too much */
await both(shuffled, "shuffled: id BETWEEN 5 AND 9",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "between", value: "5", valueTo: "9", linker: "AND" }]; },
  (p) => (p.kept < 1 ? "kept nothing at all for a range five rows do match" : null));

/* ------------------------------------------ a file written without statistics */
const nostats = path.join(dir, "nostats.parquet");
await both(nostats, "no statistics: id < 100 reads everything",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("id"), pred: "lt", value: "100", linker: "AND" }]; },
  (p) => (p.kept !== p.total ? `skipped ${p.total - p.kept} row groups on a file with no statistics` : null));

/* ------------------------------------------------------------ null counts */
const nulls = path.join(dir, "nulls.parquet");
await both(nulls, "nulls: maybe IS NOT NULL skips the all-null groups",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("maybe"), pred: "notnull", value: "", linker: "AND" }]; },
  (p) => (p.kept !== p.total / 2 ? `kept ${p.kept} of ${p.total}, expected half` : null));
await both(nulls, "nulls: maybe IS NULL skips the groups with none",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("maybe"), pred: "null", value: "", linker: "AND" }]; },
  (p) => (p.kept !== p.total / 2 ? `kept ${p.kept} of ${p.total}, expected half` : null));
await both(nulls, "nulls: maybe > 0 skips the all-null groups too",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("maybe"), pred: "gt", value: "0", linker: "AND" }]; },
  (p) => (p.kept !== p.total / 2 ? `kept ${p.kept} of ${p.total}, expected half` : null));

/* ----------------------------------------- a partition value rules out a file */
await both(hive, "hive: year = 2024 rules out the other year's files",
  (q, ci) => { q.filters = [{ id: "a", ci: ci("year"), pred: "eq", value: "2024", linker: "AND" }]; },
  (p) => (p.byPartition !== p.total / 2 ? `skipped ${p.byPartition} of ${p.total} by partition, expected half` : null));
await both(hive, "hive: month = 02 AND id > 0",
  (q, ci) => {
    q.filters = [
      { id: "a", ci: ci("month"), pred: "eq", value: "2", linker: "AND" },
      { id: "b", ci: ci("id"), pred: "gt", value: "0", linker: "AND" },
    ];
  },
  (p) => (p.kept !== 2 ? `kept ${p.kept} of ${p.total} files for one month` : null));

console.log(failed ? `\n${failed} check(s) failed` : "\npushdown skips only what cannot match, and says how much");
process.exit(failed ? 1 : 0);
