/**
 * Checks that a folder of parquet files reads as one table.
 *
 *   python3 tools/fixtures.py /tmp/fx        # writes /tmp/fx/folders/...
 *   node tools/check-folder.mjs /tmp/fx/folders
 *
 * Hive partition values must land on the right rows, files the reader should
 * ignore must be ignored, a missing column must read as null, and two files
 * that disagree about a column's type must be refused by name.
 */
import fs from "node:fs";
import path from "node:path";
import { appPath, loadApp } from "./check.mjs";

const PARIS = loadApp(appPath);
const root = process.argv[2] || "/tmp/fx/folders";

let failed = 0;
const ok = (m) => console.log("ok   " + m);
const bad = (m, d) => { failed++; console.log("FAIL " + m + "\n       " + String(d).replace(/\n/g, "\n       ")); };

/** Walks a directory the way a dropped folder arrives: relative paths kept. */
function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, base));
    else {
      const rel = path.relative(path.dirname(base), full);
      if (!PARIS.isParquetPath(rel)) continue;
      const buf = fs.readFileSync(full);
      out.push({
        src: { size: buf.length, name, async read(a, b) { return new Uint8Array(buf.subarray(a, b)); } },
        path: rel,
      });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
async function open(dir) {
  const dataset = await PARIS.readDataset(walk(dir, dir));
  const table = PARIS.newTable(dataset);
  await PARIS.loadMore(dataset, table, Infinity);
  return { dataset, table };
}
const colNames = (t) => t.cols.map((c) => c.name).join(",");

/* ------------------------------------------------ hive partitions */
try {
  const { dataset, table } = await open(path.join(root, "hive"));
  const counted = dataset.parts.reduce((a, p) => a + p.rows, 0);
  if (dataset.parts.length !== 6) bad("hive: part count", dataset.parts.length);
  else if (table.rowsLoaded !== counted) bad("hive: rows", `${table.rowsLoaded} != ${counted}`);
  else if (colNames(table) !== "year,month,id,name,amt,ts") bad("hive: columns", colNames(table));
  else {
    /* every row must carry the partition values of the file it came from */
    let wrong = 0, at = 0;
    for (const p of dataset.parts) {
      const y = +/year=(\d+)/.exec(p.path)[1], m = +/month=(\d+)/.exec(p.path)[1];
      for (let i = 0; i < p.rows; i++, at++) {
        if (table.cols[0].rows[at] !== y || table.cols[1].rows[at] !== m) wrong++;
      }
    }
    if (wrong) bad("hive: partition values", `${wrong} of ${at} rows carry the wrong values`);
    else ok(`hive: ${dataset.parts.length} parts, ${at} rows, partition values correct on all of them`);
    if (dataset.parts.some((p) => /_SUCCESS|\.hidden/.test(p.path))) bad("hive: ignored files", "read one it should not");
    else ok("hive: _SUCCESS and dotfiles ignored");
    const partSpec = table.cols[0].spec;
    if (partSpec.kind !== "number") bad("hive: partition type", "year came out as " + partSpec.label);
    else ok("hive: numeric partition values typed as numbers");
  }
} catch (e) { bad("hive", e.message); }

/* ------------------------------------------------ a plain folder */
try {
  const { dataset, table } = await open(path.join(root, "flat"));
  const a = table.cols[0].rows.join(",");
  if (dataset.parts.length !== 3) bad("flat: part count", dataset.parts.length);
  else if (a !== Array.from({ length: 30 }, (_, i) => i).join(",")) bad("flat: order", a);
  else ok("flat: 3 files concatenated in path order, no partition columns");
} catch (e) { bad("flat", e.message); }

/* ------------------------------------------------ ragged schemas */
try {
  const { table } = await open(path.join(root, "ragged"));
  if (colNames(table) !== "a,b,c") bad("ragged: columns", colNames(table));
  else {
    const rows = [];
    for (let r = 0; r < table.rowsLoaded; r++) rows.push(table.cols.map((c) => String(c.rows[r])).join("|"));
    const want = ["1|p|null", "2|q|null", "3|r|null", "6|z|9.5", "4|null|null", "5|null|null"].join(" ; ");
    if (rows.join(" ; ") !== want) bad("ragged: values", rows.join(" ; ") + "\nwant: " + want);
    else ok("ragged: union of columns, absent ones read as null");
  }
} catch (e) { bad("ragged", e.message); }

/* ------------------------------------------------ a real disagreement */
try {
  await open(path.join(root, "conflict"));
  bad("conflict", "two files disagreeing about a column's type were accepted");
} catch (e) {
  if (/do not describe the same table/.test(e.message) && /int\.parquet/.test(e.message)) {
    ok("conflict: refused, naming both files — " + e.message.split("\n")[1]);
  } else bad("conflict: wrong message", e.message);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nfolders read as one table");
process.exit(failed ? 1 : 0);
