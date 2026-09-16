/**
 * Checks the SQL panel's two-way editing.
 *
 *   node tools/check-sql.mjs file.parquet
 *
 * Three things:
 *  1. round trip — a builder state prints as SQL, parses back, and prints the
 *     same SQL again. Anything the zones can hold must survive the text.
 *  2. hand-written SQL parses, runs, and agrees with duckdb.
 *  3. bad SQL is refused with the message it deserves, not silently applied.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appPath, loadApp } from "./check.mjs";

const PARIS = loadApp(appPath);
const here = path.dirname(new URL(import.meta.url).pathname);
const file = process.argv[2] || "/tmp/corpus/basic_snappy.parquet";

const buf = fs.readFileSync(file);
const src = {
  size: buf.length,
  name: path.basename(file),
  async read(start, end) { return new Uint8Array(buf.subarray(start, end)); },
};
const dataset = await PARIS.readDataset([{ src, path: src.name }]);
const meta = dataset.reference;
const table = PARIS.newTable(dataset);
await PARIS.loadMore(dataset, table, Infinity);
PARIS.state.src = src;
  PARIS.state.dataset = dataset;
PARIS.state.meta = meta;
PARIS.state.table = table;
const cols = table.cols;
const ix = (name) => cols.findIndex((c) => c.name === name);
const tableName = path.basename(file).replace(/\.parquet$/, "");

let failed = 0;
const ok = (name) => console.log("ok   " + name);
const bad = (name, detail) => { failed++; console.log("FAIL " + name + "\n       " + detail.replace(/\n/g, "\n       ")); };

/* ---------------------------------------------------------- round trip */
const blank = () => ({ active: false, mode: "rows", select: [], filters: [], sort: [], groupBy: [], metrics: [], limit: null });
const states = [
  ["select all", (_q) => {}],
  ["select some", (q) => { q.select = [0, 2, 1]; }],
  ["one filter", (q) => { q.filters = [{ id: "a", ci: ix("score"), pred: "gt", value: "70", linker: "AND" }]; }],
  ["every predicate", (q) => {
    q.filters = [
      { id: "a", ci: ix("score"), pred: "ge", value: "10", linker: "AND" },
      { id: "b", ci: ix("score"), pred: "le", value: "90", linker: "AND" },
      { id: "c", ci: ix("id"), pred: "ne", value: "5", linker: "AND" },
      { id: "d", ci: ix("name"), pred: "like", value: "user", linker: "AND" },
      { id: "e", ci: ix("amount"), pred: "between", value: "1", valueTo: "9", linker: "AND" },
      { id: "f", ci: ix("name"), pred: "null", value: "", linker: "OR" },
      { id: "g", ci: ix("cat"), pred: "notnull", value: "", linker: "AND" },
      { id: "h", ci: ix("active"), pred: "eq", value: "true", linker: "AND" },
    ];
  }],
  ["or groups", (q) => {
    q.filters = [
      { id: "a", ci: ix("score"), pred: "gt", value: "80", linker: "AND" },
      { id: "b", ci: ix("cat"), pred: "eq", value: "alpha", linker: "AND" },
      { id: "c", ci: ix("id"), pred: "lt", value: "10", linker: "OR" },
    ];
  }],
  ["sort and limit", (q) => {
    q.sort = [{ id: "s", ci: ix("score"), dir: "DESC" }, { id: "t", ci: ix("id"), dir: "ASC" }];
    q.limit = 25;
  }],
  ["group by count", (q) => {
    q.mode = "agg";
    q.groupBy = [ix("cat")];
    q.metrics = [{ id: "m", ci: ix("id"), agg: "COUNT", alias: "" }];
  }],
  ["group by, aliases, every aggregate", (q) => {
    q.mode = "agg";
    q.groupBy = [ix("cat"), ix("active")];
    q.metrics = [
      { id: "m1", ci: ix("id"), agg: "COUNT", alias: "n" },
      { id: "m2", ci: ix("name"), agg: "COUNT_DISTINCT", alias: "names" },
      { id: "m3", ci: ix("score"), agg: "SUM", alias: "total" },
      { id: "m4", ci: ix("score"), agg: "AVG", alias: "mean" },
      { id: "m5", ci: ix("ts"), agg: "MIN", alias: "first" },
      { id: "m6", ci: ix("ts"), agg: "MAX", alias: "last" },
    ];
  }],
  ["group, filter, order by a metric, limit", (q) => {
    q.mode = "agg";
    q.groupBy = [ix("cat")];
    q.metrics = [{ id: "m", ci: ix("score"), agg: "AVG", alias: "mean" }];
    q.filters = [{ id: "a", ci: ix("score"), pred: "notnull", value: "", linker: "AND" }];
    q.sort = [{ id: "s", ci: ix("score"), mid: "m", dir: "DESC" }];
    q.limit = 3;
  }],
  ["quoted names", (q) => { q.select = [ix("amount"), ix("big")]; q.sort = [{ id: "s", ci: ix("big"), dir: "ASC" }]; }],
];
for (const [name, patch] of states) {
  const q = blank();
  patch(q);
  PARIS.state.query = q;
  const sql1 = PARIS.querySql();
  const res = PARIS.parseSql(sql1, cols);
  if (!res.query) { bad("round trip: " + name, sql1 + "\n-> " + res.errors.map((e) => e.msg).join("; ")); continue; }
  PARIS.state.query = res.query;
  const sql2 = PARIS.querySql();
  if (sql1 !== sql2) bad("round trip: " + name, "first:\n" + sql1 + "\nsecond:\n" + sql2);
  else ok("round trip: " + name);
}

/* ------------------------------------------- hand-written SQL vs duckdb */
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
const handWritten = [
  `select id, name from ${tableName} where score > 90 order by id`,
  `SELECT * FROM ${tableName} WHERE name IS NULL ORDER BY id`,
  `SELECT * FROM ${tableName} WHERE score BETWEEN 60 AND 70 AND active = TRUE ORDER BY id`,
  `SELECT * FROM ${tableName} WHERE cat = 'alpha' OR id < 5 ORDER BY id`,
  `SELECT * FROM ${tableName} WHERE (cat = 'beta' AND score > 80) OR id = 3 ORDER BY id`,
  `SELECT * FROM ${tableName} WHERE name LIKE '%user_1%' ORDER BY id`,
  `SELECT cat, COUNT(id) AS n, AVG(score) AS mean FROM ${tableName} GROUP BY cat ORDER BY cat`,
  `SELECT cat, COUNT(DISTINCT name) AS d FROM ${tableName} GROUP BY cat ORDER BY cat`,
  `SELECT active, MIN(ts) AS first, MAX(ts) AS last FROM ${tableName} GROUP BY active ORDER BY active`,
  `SELECT cat, AVG(score) AS mean FROM ${tableName} WHERE score IS NOT NULL GROUP BY cat ORDER BY mean DESC`,
  `-- a comment\nSELECT id FROM ${tableName} WHERE id >= 10 AND id <= 20 ORDER BY id;`,
];
for (const sql of handWritten) {
  const label = sql.replace(/\s+/g, " ").slice(0, 62);
  const res = PARIS.parseSql(sql, cols);
  if (!res.query) { bad("parse: " + label, res.errors.map((e) => e.msg).join("; ")); continue; }
  PARIS.state.query = res.query;
  PARIS.runQuery();
  const view = PARIS.state.view;
  const mine = [];
  for (let r = 0; r < view.count; r++) {
    mine.push(view.cols.map((c, ci) => canon(PARIS.viewValue(view, ci, r), c.spec)));
  }
  let duck;
  try {
    duck = JSON.parse(execFileSync("python3", [path.join(here, "duck.py"), file, sql.replace(/;\s*$/, ""), tableName],
      { maxBuffer: 256 * 1024 * 1024, encoding: "utf8", cwd: here }));
  } catch (e) {
    bad("duckdb: " + label, String(e.stderr || e.message).split("\n").slice(-3).join(" "));
    continue;
  }
  const theirs = [];
  for (let r = 0; r < duck.rows; r++) theirs.push(duck.columns.map((c) => c.values[r]));
  /* SUM and AVG over floats depend on summation order, so the last bit or two
     may differ from duckdb's; everything else must match exactly. (Checked
     against math.fsum: this engine's compensated sum is the exactly-rounded
     one, and duckdb is the side that is 1 ulp out.) */
  const soft = view.cols.map((_c, i) => {
    const q2 = res.query;
    if (!q2 || q2.mode !== "agg") return false;
    const m = q2.metrics[i - q2.groupBy.length];
    return !!m && (m.agg === "SUM" || m.agg === "AVG");
  });
  const near = (a, b, i) => {
    if (a === b) return true;
    if (!soft[i] || a === null || b === null) return false;
    const x = parseFloat(a), y = parseFloat(b);
    return isFinite(x) && isFinite(y) && Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x), Math.abs(y));
  };
  const key = (row) => JSON.stringify(row);
  mine.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  theirs.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  if (mine.length !== theirs.length) bad("vs duckdb: " + label, `${mine.length} rows, duckdb ${theirs.length}`);
  else {
    const at = mine.findIndex((row, i) => row.some((v, j) => !near(v, theirs[i][j], j)));
    if (at >= 0) bad("vs duckdb: " + label, `row ${at}\n  got  ${key(mine[at])}\n  duck ${key(theirs[at])}`);
    else ok("vs duckdb: " + label + "  (" + mine.length + " rows)");
  }
}

/* ------------------------------------------------------- refusals */
const refusals = [
  [`SELECT nosuchcol FROM t`, /no column named/],
  [`SELECT scoree FROM t`, /did you mean/],
  /* a join is set up in the Join panel; SQL describes one that is applied,
     and over a plain file there is none to describe */
  [`SELECT * FROM t JOIN u ON t.a = u.a`, /joins are set up in the Join panel/],
  [`SELECT * FROM t WHERE (cat = 'a' OR cat = 'b') AND score > 1`, /cannot be held/],
  [`SELECT * FROM t WHERE NOT score > 1`, /NOT cannot be held/],
  [`SELECT cat, score FROM t GROUP BY cat`, /not grouped/],
  [`SELECT cat, COUNT(id) FROM t GROUP BY cat HAVING COUNT(id) > 2`, /HAVING is not supported/],
  [`SELECT * FROM t WHERE score > 'abc'`, /is not a double value/],
  [`SELECT * FROM t LIMIT 0`, /positive whole number/],
  [`SELECT UPPER(name) FROM t`, /not one of COUNT/],
  [`SELECT * FROM t WHERE score = NULL`, /IS NULL/],
  [`SELECT DISTINCT cat FROM t`, /DISTINCT is not supported/],
  [`SELECT * FROM t OFFSET 5`, /OFFSET is not supported/],
  [`SELECT * FROM t ORDER BY nope`, /no column named/],
  [`SELECT cat, COUNT(id) AS n FROM t GROUP BY cat ORDER BY score`, /not selected/],
  [`SELECT * FROM t WHERE`, /expected a column/],
  [`SELECT * FROM t WHERE id >`, /expected a value/],
];
for (const [sql, want] of refusals) {
  const res = PARIS.parseSql(sql, cols);
  const msgs = res.errors.map((e) => e.msg).join(" | ");
  const label = sql.replace(/\s+/g, " ").slice(0, 56);
  if (res.query) bad("refuse: " + label, "accepted it");
  else if (!want.test(msgs)) bad("refuse: " + label, "wanted " + want + "\n  got: " + msgs);
  else ok("refuse: " + label + "  -> " + msgs.split(" | ")[0].slice(0, 60));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nSQL round trip, execution and refusals all pass");
process.exit(failed ? 1 : 0);
