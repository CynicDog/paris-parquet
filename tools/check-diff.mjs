/**
 * Checks the diff: schema drift, shape, statistics and the keyed row diff.
 *
 *   python3 tools/fixtures.py /tmp/fx
 *   node tools/check-diff.mjs /tmp/fx/diff [corpus.parquet ...]
 *
 * The fixtures in <dir> are built to differ in exactly known ways, so the
 * diff has to name those and nothing else. Any extra parquet files given are
 * diffed against themselves: whatever their types, a file must come out equal
 * to itself, which is what exercises the per-type cell comparison.
 */
import fs from "node:fs";
import path from "node:path";
import { loadApp, appPath } from "./check.mjs";

const PARIS = loadApp(appPath);
const dir = process.argv[2] || "/tmp/fx/diff";
const extra = process.argv.slice(3);

let failed = 0;
const ok = (name) => console.log("ok   " + name);
const bad = (name, detail) => {
  failed++;
  console.log("FAIL " + name + "\n       " + String(detail).replace(/\n/g, "\n       "));
};
const eq = (name, got, want) =>
  (got === want ? ok(name + "  " + JSON.stringify(got)) : bad(name, "got " + JSON.stringify(got) +
    ", wanted " + JSON.stringify(want)));

function source(file) {
  const buf = fs.readFileSync(file);
  return {
    size: buf.length,
    name: path.basename(file),
    async read(start, end) { return new Uint8Array(buf.subarray(start, end)); },
  };
}
async function read(file) {
  const src = source(file);
  const dataset = await PARIS.readDataset([{ src, path: src.name }]);
  const table = PARIS.newTable(dataset);
  await PARIS.loadMore(dataset, table, Infinity);
  return { dataset, table, name: src.name };
}
const names = (list) => list.map((x) => x.col.name).sort();

/* ------------------------------------------------- a vs b: the drift case */
const A = await read(path.join(dir, "a.parquet"));
const B = await read(path.join(dir, "b.parquet"));

const sd = PARIS.schemaDiff(A.table, B.table);
eq("schema: added", JSON.stringify(names(sd.added)), JSON.stringify(["extra"]));
eq("schema: removed", JSON.stringify(names(sd.removed)), "[]");
eq("schema: renamed", JSON.stringify(sd.renamed.map((r) => r.a.col.name)), "[]");
eq("schema: retyped", JSON.stringify(sd.retyped.map((r) => r.a.col.name)), JSON.stringify(["qty"]));
{
  const r = sd.retyped[0];
  const from = PARIS.colShape(r.a.col), to = PARIS.colShape(r.b.col);
  eq("schema: qty int32 -> int64", from.type + " -> " + to.type, "int32 -> int64");
}
eq("schema: columns in both", sd.common.length, 5);

const shapeA = PARIS.datasetShape(A.dataset, A.table);
const shapeB = PARIS.datasetShape(B.dataset, B.table);
eq("shape: same row count", shapeA.rows === shapeB.rows && shapeA.rows === 1000, true);
eq("shape: one more column in B", shapeB.cols - shapeA.cols, 1);
eq("shape: row groups counted", shapeA.groups > 1 && shapeB.groups > 1, true);
eq("shape: codecs read", shapeA.codecs, "SNAPPY");

/* statistics: only score moved, and it moved by exactly the bump */
{
  const moved = [];
  for (const pair of sd.common) {
    const sa = PARIS.columnStats(A.dataset, pair.a.col);
    const sb = PARIS.columnStats(B.dataset, pair.b.col);
    if (!sa || !sb) continue;
    if (sa.min !== sb.min || sa.max !== sb.max || sa.nulls !== sb.nulls) {
      moved.push(pair.a.col.name + ": " + sa.max + " -> " + sb.max);
    }
  }
  eq("statistics: only score moved", JSON.stringify(moved), JSON.stringify(["score: 100 -> 1100"]));
  const q = PARIS.columnStats(A.dataset, A.table.cols.find((c) => c.name === "qty"));
  eq("statistics: folded over every row group", q.chunks > 1 && q.min === "0" && q.max === "12", true);
  eq("statistics: null counts read", q.nullsKnown && q.nulls === 0, true);
}

/* rows: the key is found, and exactly 100 rows changed, all in score */
{
  const keys = PARIS.suggestKey(A.table, B.table);
  eq("rows: key suggested", JSON.stringify(keys.map((k) => k.split("\u0001").pop())), JSON.stringify(["id"]));
  const r = PARIS.rowDiff(A.table, B.table, keys);
  if (r.error) bad("rows: a vs b", r.error);
  else {
    eq("rows: only in A", r.onlyA.length, 0);
    eq("rows: only in B", r.onlyB.length, 0);
    eq("rows: changed", r.changed.length, 100);
    eq("rows: identical", r.same, 900);
    const byCol = r.value.map((v, i) => [v.name, r.perCol[i]]).filter((x) => x[1] > 0);
    eq("rows: changed cells by column", JSON.stringify(byCol), JSON.stringify([["score", 100]]));
    eq("rows: every change is one cell", r.changed.every((c) => c.cells.length === 1), true);
    const first = r.changed[0];
    const score = r.value.findIndex((v) => v.name === "score");
    eq("rows: the changed cell reads back",
      r.value[score].A[first.ar] + " -> " + r.value[score].B[first.br], "0 -> 1000");
    eq("rows: a retyped column with equal values is not a change",
      r.value.find((v) => v.name === "qty") !== undefined && r.perCol[r.value.findIndex((v) => v.name === "qty")] === 0,
      true);
  }
}

/* ------------------------------------------------------ e: a renamed column */
{
  const E = await read(path.join(dir, "e.parquet"));
  const d = PARIS.schemaDiff(A.table, E.table);
  eq("rename: spotted", JSON.stringify(d.renamed.map((r) => r.a.col.name + "->" + r.b.col.name)),
    JSON.stringify(["name->label"]));
  eq("rename: not also reported as added/removed", d.added.length + d.removed.length, 0);
}

/* --------------------------------------------------- c vs d: shifted rows */
{
  const C = await read(path.join(dir, "c.parquet"));
  const D = await read(path.join(dir, "d.parquet"));
  const keys = PARIS.suggestKey(C.table, D.table);
  const r = PARIS.rowDiff(C.table, D.table, keys);
  if (r.error) bad("rows: c vs d", r.error);
  else {
    eq("rows: dropped from A", r.onlyA.length, 100);
    eq("rows: new in B", r.onlyB.length, 100);
    eq("rows: changed in the overlap", r.changed.length, 50);
    eq("rows: identical in the overlap", r.same, 50);
  }
}

/* ----------------------------------------------------------- refusals */
{
  const nameKey = A.table.cols.find((c) => c.name === "name").key;
  const r = PARIS.rowDiff(A.table, B.table, [nameKey]);
  if (!r.error) bad("refuse: repeated key", "accepted a key that repeats");
  else if (!/not unique/.test(r.error)) bad("refuse: repeated key", r.error);
  else ok("refuse: repeated key  -> " + r.error.slice(0, 64));
}
{
  const r = PARIS.rowDiff(A.table, B.table, []);
  if (!r.error || !/key column/.test(r.error)) bad("refuse: no key", r.error || "accepted no key at all");
  else ok("refuse: no key  -> " + r.error);
}
{
  const extraKey = B.table.cols.find((c) => c.name === "extra").key;
  const r = PARIS.rowDiff(A.table, B.table, [extraKey]);
  if (!r.error || !/exist in both/.test(r.error)) bad("refuse: key only in B", r.error || "accepted it");
  else ok("refuse: key only in B  -> " + r.error);
}

/* -------------------------------- every file is equal to itself, whatever
   its types: this is where binary, decimal, int96 and nested cells get
   compared, and any of them reading "changed" would be a bug */
for (const file of extra) {
  const label = path.basename(file);
  let X, Y;
  try {
    X = await read(file);
    Y = await read(file);
  } catch (e) { bad("self: " + label, e.message); continue; }
  let keys = PARIS.suggestKey(X.table, Y.table);
  if (!keys.length) {
    /* no single column identifies a row here; every column together might */
    keys = X.table.cols.filter((c) => c.spec.kind !== "nested").map((c) => c.key);
    const probe = PARIS.rowDiff(X.table, Y.table, keys);
    if (probe.error) { console.log("skip " + label.padEnd(26) + " no key identifies a row"); continue; }
  }
  const r = PARIS.rowDiff(X.table, Y.table, keys);
  if (r.error) { bad("self: " + label, r.error); continue; }
  const drift = PARIS.schemaDiff(X.table, Y.table);
  const bits = drift.added.length + drift.removed.length + drift.retyped.length + drift.renamed.length;
  if (r.changed.length || r.onlyA.length || r.onlyB.length || bits) {
    bad("self: " + label, `${r.changed.length} changed, ${r.onlyA.length} only in A, ` +
      `${r.onlyB.length} only in B, ${bits} schema differences — a file must equal itself`);
  } else {
    ok("self: " + label.padEnd(24) + " " + String(r.same).padStart(6) + " rows identical on " +
      keys.length + " key column" + (keys.length === 1 ? "" : "s"));
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\ndiff: schema, shape, statistics and rows all agree");
process.exit(failed ? 1 : 0);
