/**
 * Runs the reader inside index.html against real parquet files and compares
 * every cell with the ground truth written by tools/expect.py.
 *
 *   python3 tools/expect.py file.parquet file.expect.json
 *   node tools/check.mjs file.parquet [...]
 *
 * The script tag is evaluated as-is against a stub DOM, so this exercises the
 * shipped file rather than a copy of it.
 */
import fs from "node:fs";
import path from "node:path";

function stubElement() {
  const el = {
    hidden: false, innerHTML: "", textContent: "", scrollTop: 0,
    clientHeight: 800, offsetHeight: 24, children: [],
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    querySelector: () => stubElement(), querySelectorAll: () => [],
    appendChild() {}, prepend() {}, remove() {},
  };
  return el;
}

export function loadApp(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const open = html.indexOf("<script>");
  const close = html.lastIndexOf("</script>");
  if (open < 0 || close < 0) throw new Error("no inline <script> in " + htmlPath);
  const js = html.slice(open + "<script>".length, close);

  const doc = {
    readyState: "complete",
    documentElement: stubElement(),
    getElementById: () => stubElement(),
    createElement: () => stubElement(),
    querySelector: () => stubElement(),
    addEventListener() {},
    body: stubElement(),
  };
  const win = { addEventListener() {} };
  const fn = new Function("window", "document", "requestAnimationFrame", js + "\nreturn window.PARIS;");
  return fn(win, doc, (cb) => cb());
}

function source(file) {
  const buf = fs.readFileSync(file);
  return {
    size: buf.length,
    name: path.basename(file),
    async read(start, end) { return new Uint8Array(buf.subarray(start, end)); },
  };
}

/** Same rules as the grid, minus the display truncation. */
function canon(v, spec, PARIS) {
  if (v === null || v === undefined) return null;
  switch (spec.kind) {
    case "number": return typeof v === "number" ? String(v) : v.toString();
    case "bool": return v ? "true" : "false";
    case "string": return v;
    case "binary": return Buffer.from(v).toString("hex");
    default: return PARIS.fmtValue(v, spec);
  }
}

async function checkFile(PARIS, file) {
  const expectPath = file.replace(/\.parquet$/, ".expect.json");
  const expected = JSON.parse(fs.readFileSync(expectPath, "utf8"));
  const src = source(file);
  const t0 = Date.now();
  const dataset = await PARIS.readDataset([{ src, path: src.name }]);
  const meta = dataset.reference;
  const table = PARIS.newTable(dataset);
  await PARIS.loadMore(dataset, table, Infinity);
  const ms = Date.now() - t0;

  const problems = [];
  if (table.rowsLoaded !== expected.num_rows) {
    problems.push(`row count ${table.rowsLoaded} != ${expected.num_rows}`);
  }
  if (table.cols.length !== expected.columns.length) {
    problems.push(`column count ${table.cols.length} != ${expected.columns.length}`);
  }
  const n = Math.min(table.cols.length, expected.columns.length);
  for (let c = 0; c < n; c++) {
    const col = table.cols[c];
    const want = expected.columns[c].values;
    let bad = 0;
    for (let r = 0; r < Math.min(col.rows.length, want.length); r++) {
      const got = canon(col.rows[r], col.spec, PARIS);
      if (got !== want[r]) {
        if (bad === 0) {
          problems.push(`col ${c} (${col.name}, ${col.spec.label}) row ${r}: ` +
            `got ${JSON.stringify(got)} want ${JSON.stringify(want[r])}`);
        }
        bad++;
      }
    }
    if (bad) problems.push(`  -> ${bad}/${want.length} cells differ in ${col.name}`);
    if (col.rows.length !== want.length) {
      problems.push(`col ${col.name}: ${col.rows.length} values, expected ${want.length}`);
    }
  }
  for (const col of table.cols) PARIS.summarize(col);   // must not throw
  return { problems, ms, rows: table.rowsLoaded, cols: table.cols.length };
}

const here = path.dirname(new URL(import.meta.url).pathname);
export const appPath = path.join(here, "..", "index.html");

/* importing this file (fuzz-zstd.mjs does) must not run the CLI */
if (process.argv[1] && process.argv[1].endsWith("check.mjs")) {
const PARIS = loadApp(appPath);
const files = process.argv.slice(2);
let failed = 0;
for (const f of files) {
  let r;
  try {
    r = await checkFile(PARIS, f);
  } catch (e) {
    console.log(`FAIL ${path.basename(f)}: ${e.message}`);
    if (process.env.VERBOSE) console.log(e.stack);
    failed++;
    continue;
  }
  const name = path.basename(f).padEnd(26);
  if (r.problems.length) {
    failed++;
    console.log(`FAIL ${name} ${r.problems.length} problem(s)`);
    for (const p of r.problems.slice(0, 6)) console.log("       " + p);
  } else {
    console.log(`ok   ${name} ${String(r.rows).padStart(7)} rows x ${String(r.cols).padStart(2)} cols  ${r.ms} ms`);
  }
}
console.log(failed ? `\n${failed}/${files.length} files failed` : `\nall ${files.length} files match`);
process.exit(failed ? 1 : 0);
}
