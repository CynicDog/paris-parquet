/**
 * Checks the query engine in index.html against duckdb.
 *
 *   node tools/check-query.mjs file.parquet [...]
 *
 * For each case: the builder's state produces SQL, the engine runs over the
 * decoded columns, duckdb runs the same SQL over the same file, and every cell
 * of the two results is compared.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadApp, appPath } from "./check.mjs";

const PARIS = loadApp(appPath);
const here = path.dirname(new URL(import.meta.url).pathname);

function source(file) {
  const buf = fs.readFileSync(file);
  return {
    size: buf.length,
    name: path.basename(file),
    async read(start, end) { return new Uint8Array(buf.subarray(start, end)); },
  };
}
/** Same rendering rules tools/duck.py uses, so the two sides line up. */
function canon(v, spec) {
  if (v === null || v === undefined) return null;
  switch (spec.kind) {
    case "number": return typeof v === "number" ? String(v) : v.toString();
    case "bool": return v ? "true" : "false";
    case "string": return v;
    case "binary": return Buffer.from(v).toString("hex");
    default: return PARIS.fmtValue(v, spec);
  }
}

/** Query cases, built from column names so they work on any fixture. */
function cases(cols) {
  const hasValues = (c) => { const s = PARIS.summarize(c); return s.n - s.nulls > 0; };
  /* a leaf inside a struct or list is a dotted path here but a nested value in
     SQL, so duckdb cannot be asked the same question about it */
  const simple = (c) => !c.spec.nested && c.name.indexOf(".") < 0;
  const byKind = (k) => cols.map((c, i) => [c, i])
    .filter(([c]) => c.spec.kind === k && simple(c) && hasValues(c));
  /* LIMIT only means something next to a total order, or the two engines are
     free to break ties differently; every column becomes a tiebreak key. */
  const totalOrder = (x, firstCi, dir) => {
    x.sort = [{ id: "s0", ci: firstCi, dir }];
    cols.forEach((c, i) => {
      if (i !== firstCi && simple(c)) x.sort.push({ id: "s" + i, ci: i, dir: "ASC" });
    });
  };
  const nums = byKind("number"), strs = byKind("string"), bools = byKind("bool"), times = byKind("temporal");
  const out = [];
  const q = (name, patch) => out.push({ name, patch });

  if (nums.length) {
    const [col, ci] = nums[0];
    const s = PARIS.summarize(col);
    const mid = s.count ? (s.min + s.max) / 2 : 0;
    q("number >", (x) => { x.filters = [{ id: "a", ci, pred: "gt", value: String(mid), linker: "AND" }]; });
    q("number between", (x) => {
      x.filters = [{ id: "a", ci, pred: "between", value: String(s.min), valueTo: String(mid), linker: "AND" }];
    });
    q("number order desc + limit", (x) => { totalOrder(x, ci, "DESC"); x.limit = 25; });
    q("is null", (x) => { x.filters = [{ id: "a", ci, pred: "null", value: "", linker: "AND" }]; });
    q("is not null + order", (x) => {
      x.filters = [{ id: "a", ci, pred: "notnull", value: "", linker: "AND" }];
      totalOrder(x, ci, "ASC");
      x.limit = 40;
    });
  }
  if (strs.length) {
    const [col, ci] = strs[0];
    const sample = col.rows.find((v) => typeof v === "string" && v.length > 2);
    /* duckdb has no LIKE for its UUID type; the viewer matches it as text */
    if (sample && col.spec.label !== "uuid") {
      q("string =", (x) => { x.filters = [{ id: "a", ci, pred: "eq", value: sample, linker: "AND" }]; });
      q("string like", (x) => {
        x.filters = [{ id: "a", ci, pred: "like", value: sample.slice(1, 4), linker: "AND" }];
      });
    }
    q("select subset + order", (x) => {
      x.select = cols.map((c, i) => i).filter((i) => simple(cols[i])).slice(0, 3);
      totalOrder(x, ci, "ASC");
      x.limit = 30;
    });
  }
  if (nums.length && strs.length) {
    const ci = nums[0][1], cs = strs[0][1];
    const s = PARIS.summarize(nums[0][0]);
    q("and", (x) => {
      x.filters = [
        { id: "a", ci, pred: "gt", value: String(s.min), linker: "AND" },
        { id: "b", ci: cs, pred: "notnull", value: "", linker: "AND" },
      ];
    });
    q("or", (x) => {
      x.filters = [
        { id: "a", ci, pred: "lt", value: String((s.min + s.max) / 2), linker: "AND" },
        { id: "b", ci: cs, pred: "null", value: "", linker: "OR" },
      ];
    });
  }
  if (bools.length) {
    const ci = bools[0][1];
    q("bool =", (x) => { x.filters = [{ id: "a", ci, pred: "eq", value: "true", linker: "AND" }]; });
  }
  if (times.length && times[0][0].spec.sub !== "time") {
    const [col, ci] = times[0];
    const s = PARIS.summarize(col);
    if (s.count) {
      q("timestamp >=", (x) => {
        x.filters = [{ id: "a", ci, pred: "ge", value: PARIS.fmtValue((s.min + s.max) / 2, col.spec), linker: "AND" }];
      });
    }
  }
  /* aggregates */
  if (strs.length && nums.length) {
    const gs = strs[0][1], ci = nums[0][1];
    for (const agg of ["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"]) {
      q("group by + " + agg, (x) => {
        x.mode = "agg";
        x.groupBy = [gs];
        x.metrics = [{ id: "m", ci, agg, alias: "v" }];
        x.sort = [{ id: "s", ci: gs, dir: "ASC" }];
      });
    }
    q("group by two metrics", (x) => {
      x.mode = "agg";
      x.groupBy = [gs];
      x.metrics = [{ id: "m", ci, agg: "COUNT", alias: "n" }, { id: "m2", ci, agg: "AVG", alias: "v" }];
      x.sort = [{ id: "s", ci: gs, dir: "ASC" }];
    });
    q("group by with filter", (x) => {
      x.mode = "agg";
      x.groupBy = [gs];
      x.metrics = [{ id: "m", ci, agg: "COUNT", alias: "n" }];
      x.filters = [{ id: "a", ci, pred: "notnull", value: "", linker: "AND" }];
      x.sort = [{ id: "s", ci: gs, dir: "ASC" }];
    });
  }
  if (bools.length && nums.length) {
    q("group by bool", (x) => {
      x.mode = "agg";
      x.groupBy = [bools[0][1]];
      x.metrics = [{ id: "m", ci: nums[0][1], agg: "COUNT", alias: "n" }];
      x.sort = [{ id: "s", ci: bools[0][1], dir: "ASC" }];
    });
  }
  /* SELECT * would hand duckdb the nested columns too, which have no
     comparable rendering here, so those files always select explicitly */
  const plain = cols.map((c, i) => i).filter((i) => simple(cols[i]));
  if (plain.length !== cols.length) {
    return out.map((c) => ({
      name: c.name,
      patch: (x) => { c.patch(x); if (x.mode === "rows" && !x.select.length) x.select = plain.slice(); },
    }));
  }
  return out;
}

async function checkFile(file) {
  const src = source(file);
  const meta = await PARIS.readFooter(src);
  const table = PARIS.newTable(meta);
  await PARIS.loadMore(src, table, Infinity);
  if (!table.rowsLoaded) return { skipped: "no rows" };

  PARIS.state.src = src;
  PARIS.state.meta = meta;
  PARIS.state.table = table;
  const tableName = path.basename(file).replace(/\.parquet$/, "").replace(/[^A-Za-z0-9_]/g, "_");

  const problems = [];
  let ran = 0;
  for (const c of cases(table.cols)) {
    const q = { active: false, mode: "rows", select: [], filters: [], sort: [], groupBy: [], metrics: [], limit: null };
    c.patch(q);
    PARIS.state.query = q;
    let sql = PARIS.querySql();
    if (sql.includes("?")) continue;                     /* incomplete by construction */
    sql = sql.replace(/;\s*$/, "").replace(new RegExp("FROM " + tableName + "\\b"), "FROM " + tableName);
    /* a deterministic order so the two row orders can be compared at all */
    const ordered = /ORDER BY/.test(sql) ? sql : sql + "\nORDER BY ALL";
    let duck;
    try {
      duck = JSON.parse(execFileSync("python3", [path.join(here, "duck.py"), file, ordered, tableName],
        { maxBuffer: 512 * 1024 * 1024, encoding: "utf8", cwd: here }));
    } catch (e) {
      problems.push(`${c.name}: duckdb failed — ${String(e.stderr || e.message).split("\n").slice(-3).join(" ")}`);
      continue;
    }
    PARIS.runQuery();
    const view = PARIS.state.view;
    /* the engine keeps input order for ties; sort both sides the same way */
    const mine = [];
    for (let r = 0; r < view.count; r++) {
      const row = [];
      for (let ci = 0; ci < view.cols.length; ci++) {
        row.push(canon(view.index ? view.cols[ci].rows[view.index[r]] : view.cols[ci].rows[r], view.cols[ci].spec));
      }
      mine.push(row);
    }
    const theirs = [];
    for (let r = 0; r < duck.rows; r++) theirs.push(duck.columns.map((c2) => c2.values[r]));
    const key = (row) => JSON.stringify(row);
    mine.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    theirs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    ran++;
    if (mine.length !== theirs.length) {
      problems.push(`${c.name}: ${mine.length} rows, duckdb says ${theirs.length}\n        ${sql.replace(/\n/g, " ")}`);
      continue;
    }
    for (let r = 0; r < mine.length; r++) {
      if (key(mine[r]) !== key(theirs[r])) {
        problems.push(`${c.name}: row ${r}\n        got  ${key(mine[r])}\n        duck ${key(theirs[r])}\n        ${sql.replace(/\n/g, " ")}`);
        break;
      }
    }
  }
  return { problems, ran };
}

let failed = 0;
const files = process.argv.slice(2);
for (const f of files) {
  const name = path.basename(f).padEnd(24);
  let r;
  try {
    r = await checkFile(f);
  } catch (e) {
    console.log(`FAIL ${name} ${e.message}`);
    if (process.env.VERBOSE) console.log(e.stack);
    failed++;
    continue;
  }
  if (r.skipped) { console.log(`skip ${name} ${r.skipped}`); continue; }
  if (r.problems.length) {
    failed++;
    console.log(`FAIL ${name} ${r.problems.length} of ${r.ran} queries differ`);
    for (const p of r.problems.slice(0, 4)) console.log("       " + p);
  } else {
    console.log(`ok   ${name} ${r.ran} queries match duckdb`);
  }
}
console.log(failed ? `\n${failed}/${files.length} files failed` : `\nall ${files.length} files agree with duckdb`);
process.exit(failed ? 1 : 0);
