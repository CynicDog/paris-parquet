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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

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

  /* the panel steps out of the way once it has run: the joined table is
     what there is to look at, and the grid is where that is looked at */
  const afterRun = await page.evaluate(() => ({
    join: document.getElementById("joinwrap").hidden,
    grid: !document.getElementById("gridwrap").hidden,
  }));
  if (afterRun.join && afterRun.grid) ok("running the join closes the panel and shows the joined table");
  else bad("panel after running: " + JSON.stringify(afterRun));

  /* and opening it again comes back to the result, Undo and all */
  await page.click("#toggleJoin");
  await page.waitForTimeout(200);
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

/* ------------------------------------------ picking B from the folder panel */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.setInputFiles("#picker", path.join(tmp, "orders.parquet"));
  await page.waitForSelector("#toggleJoin:not([hidden])", { timeout: 15000 });
  await page.click("#toggleJoin");
  await page.waitForTimeout(200);

  /* the panel is already open -- it is open by default -- and opening the
     join turns it into the picker rather than opening anything new */
  const onOpen = await page.evaluate(() => ({
    hidden: document.getElementById("tree").hidden,
    banner: document.querySelector("#treebody .tpick")?.textContent || "",
  }));
  if (!onOpen.hidden && /click a file to join against/.test(onOpen.banner)) {
    ok("the panel that is already open becomes the join's picker");
  } else bad("panel on opening the join: " + JSON.stringify(onOpen));

  /* a B picked by dialog is one more file the panel can offer, and the one
     it should show as picked */
  await page.setInputFiles("#jpicker", path.join(tmp, "regions.parquet"));
  await idle(page);
  await page.waitForTimeout(300);
  const listed = await page.evaluate(() => ({
    hidden: document.getElementById("tree").hidden,
    rows: [...document.querySelectorAll("#treebody .tnode")].map((n) => n.dataset.path).sort(),
    banner: document.querySelector("#treebody .tpick")?.textContent || "",
    picked: [...document.querySelectorAll("#treebody .tnode.ton")].map((n) => n.dataset.path),
  }));
  if (!listed.hidden && JSON.stringify(listed.rows) === '["orders.parquet","regions.parquet"]') {
    ok("the folder panel lists the files this session has been handed");
  } else bad("panel listing: " + JSON.stringify(listed));
  if (/click a file to join against/.test(listed.banner)) ok("the panel says what a click will do there");
  else bad("no pick banner: " + JSON.stringify(listed.banner));
  if (JSON.stringify(listed.picked) === '["regions.parquet"]') ok("side B is marked in the panel");
  else bad("B not marked: " + JSON.stringify(listed.picked));

  /* clicking a file there sets B -- it must not replace the open file, the
     way the same click does when the join panel is closed */
  await page.click("#treebody .tnode[data-path='orders.parquet']");
  await idle(page);
  await page.waitForTimeout(300);
  const afterSelf = await page.evaluate(() => ({
    aRows: window.PARIS.state.table.rowsLoaded,
    sides: [...document.querySelectorAll(".jside .jname")].map((n) => n.textContent),
  }));
  if (afterSelf.aRows === 500 && afterSelf.sides[1] === "orders.parquet") {
    ok("clicking in the panel picks B and leaves the open file alone");
  } else bad("panel click changed the wrong side: " + JSON.stringify(afterSelf));

  /* switch back and run: a panel-picked B must join exactly like a dialog one */
  await page.click("#treebody .tnode[data-path='regions.parquet']");
  await idle(page);
  await page.waitForTimeout(300);
  await page.selectOption("#jkeyA", { label: "region" });
  await page.selectOption("#jkeyB", { label: "name" });
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => window.PARIS.state.table.rowsLoaded);
  if (rows === 470) ok("a join run off a panel-picked B matches the dialog-picked one (470 rows)");
  else bad("panel-picked join rows: " + rows);

  /* the run closed the panel, so the file panel is back to opening files
     rather than picking a side B */
  await page.waitForTimeout(200);
  const afterClose = await page.evaluate(() => ({
    hidden: document.getElementById("tree").hidden,
    banner: document.querySelector("#treebody .tpick")?.textContent || "",
  }));
  if (!afterClose.hidden && !afterClose.banner) ok("closing the join leaves the panel open, no longer picking");
  else bad("panel after closing the join: " + JSON.stringify(afterClose));

  /* the join is opened from inside the panel, so closing the panel takes
     the way into it with them -- the join's own close is the way out */
  await page.click("#treeclose");
  await page.waitForTimeout(200);
  const gone = await page.evaluate(() => {
    const b = document.getElementById("toggleJoin");
    return { panelHidden: document.getElementById("tree").hidden,
      railShown: !document.getElementById("treerail").hidden, buttonReachable: !!b.offsetParent };
  });
  if (gone.panelHidden && gone.railShown && !gone.buttonReachable) {
    ok("closing the panel takes its Join button with it, leaving the rail");
  } else bad("panel closed: " + JSON.stringify(gone));
});

/* ------------------------------------------------------- chained joins */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.setInputFiles("#picker", path.join(tmp, "orders.parquet"));
  await page.waitForSelector("#toggleJoin:not([hidden])", { timeout: 15000 });
  await page.click("#toggleJoin");
  await page.setInputFiles("#jpicker", path.join(tmp, "regions.parquet"));
  await idle(page);
  await page.selectOption("#jkeyA", { label: "region" });
  await page.selectOption("#jkeyB", { label: "name" });
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(200);

  /* joining the result again: the joined table is already whole and has no
     footer, so neither side may be sent back to the reader for more */
  await page.click("#toggleJoin");
  await page.waitForTimeout(200);
  await page.setInputFiles("#jpicker", path.join(tmp, "small.parquet"));
  await idle(page);
  await page.waitForTimeout(300);
  const aOpts = await page.evaluate(() =>
    [...document.querySelectorAll("#jkeyA option")].map((o) => o.text));
  if (aOpts.includes("manager")) ok("a second join picks keys off the joined table, not the file it came from");
  else bad("A key options after a join: " + JSON.stringify(aOpts));

  await page.selectOption("#jkeyA", { label: "id" });
  await page.selectOption("#jkeyB", { label: "ref_id" });
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(200);
  const chained = await page.evaluate(() => {
    const t = window.PARIS.state.table;
    const ci = (n) => t.cols.findIndex((c) => c.name === n);
    return { rows: t.rowsLoaded, hasManager: ci("manager") >= 0, hasLabel: ci("label") >= 0,
      undo: document.getElementById("jundo")?.textContent || "" };
  });
  if (chained.hasManager && chained.hasLabel) ok("the chained result carries columns from both joins");
  else bad("chained columns: " + JSON.stringify(chained));
  if (/orders\.parquet/.test(chained.undo)) ok("Undo still offers the original file, not the first join's result");
  else bad("undo label after chaining: " + JSON.stringify(chained.undo));

  await page.click("#toggleJoin");
  await page.waitForTimeout(200);
  await page.click("#jundo");
  await idle(page);
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    rows: window.PARIS.state.table.rowsLoaded, cols: window.PARIS.state.table.cols.length,
    groups: window.PARIS.state.meta ? window.PARIS.state.meta.rowGroups.length : 0,
  }));
  if (back.rows === 500 && back.cols === 3 && back.groups > 1) {
    ok("one Undo goes all the way back to the file, footer and all");
  } else bad("after undo: " + JSON.stringify(back));
});

/* ------------------------------------- dragging a file onto a join side */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.waitForTimeout(200);

  /* the button is in the file panel now, and works with nothing open */
  const button = await page.evaluate(() => {
    const b = document.getElementById("toggleJoin");
    return { inPanel: !!b && !!b.closest("#tree"), hidden: !b || b.hidden,
      inHeader: [...document.querySelectorAll("header button, header label.btn")]
        .some((x) => /join/i.test(x.textContent)) };
  });
  if (button.inPanel && !button.hidden && !button.inHeader) {
    ok("Join sits in the file panel, reachable before anything is open");
  } else bad("where the join button is: " + JSON.stringify(button));

  await page.click("#toggleJoin");
  await page.waitForTimeout(200);
  const blank = await page.evaluate(() => ({
    shown: !document.getElementById("joinwrap").hidden,
    dropHidden: document.getElementById("drop").hidden,
    sides: [...document.querySelectorAll(".jside")].map((s) => s.dataset.jside),
  }));
  if (blank.shown && blank.dropHidden && blank.sides.join() === "A,B") {
    ok("with no file open the panel is a blank A / B workspace");
  } else bad("blank workspace: " + JSON.stringify(blank));
  await page.click("#toggleJoin");
  await page.waitForTimeout(150);

  /* two files in the list, then drag each onto a side */
  await page.setInputFiles("#picker", path.join(tmp, "regions.parquet"));
  await idle(page);
  await page.setInputFiles("#picker", path.join(tmp, "orders.parquet"));
  await idle(page);
  await page.click("#toggleJoin");
  await page.waitForTimeout(250);

  const dragTo = async (rowPath, side) => {
    await page.evaluate(([p, sd]) => {
      const row = document.querySelector("#treebody .tnode[data-path='" + p + "']");
      const zone = document.querySelector(".jside[data-jside='" + sd + "']");
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [rowPath, side]);
    await idle(page);
    await page.waitForTimeout(350);
  };
  await dragTo("regions.parquet", "B");
  await dragTo("orders.parquet", "A");
  const filled = await page.evaluate(() => ({
    names: [...document.querySelectorAll(".jside .jname")].map((n) => n.textContent),
    aRows: window.PARIS.state.table.rowsLoaded,
    stillOpen: !document.getElementById("joinwrap").hidden,
  }));
  if (filled.names.join(" / ") === "orders.parquet / regions.parquet" && filled.aRows === 500 && filled.stillOpen) {
    ok("a file dragged from the panel fills the side it is dropped on");
  } else bad("sides after dragging: " + JSON.stringify(filled));

  await page.selectOption("#jkeyA", { label: "region" });
  await page.selectOption("#jkeyB", { label: "name" });
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => window.PARIS.state.table.rowsLoaded);
  if (rows === 470) ok("a join over two dragged-in sides matches the picked one (470 rows)");
  else bad("dragged-in join rows: " + rows);
});

/* --------------------------------- results listed back in the file panel */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.setInputFiles("#picker", path.join(tmp, "regions.parquet"));
  await idle(page);
  await page.setInputFiles("#picker", path.join(tmp, "orders.parquet"));
  await idle(page);
  await page.click("#toggleJoin");
  await page.waitForTimeout(200);
  await page.setInputFiles("#jpicker", path.join(tmp, "regions.parquet"));
  await idle(page);
  await page.selectOption("#jkeyA", { label: "region" });
  await page.selectOption("#jkeyB", { label: "name" });
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(300);

  /* the result is a table like any other, so it is listed like one -- under
     its own heading, since it has no file behind it */
  const listed = await page.evaluate(() => ({
    section: document.querySelector("#treebody .tsect")?.textContent || "",
    rows: [...document.querySelectorAll("#treebody .tnode.tjoined")].map((n) => n.textContent.trim()),
    marked: [...document.querySelectorAll("#treebody .tnode.tjoined.ton")].length,
    files: [...document.querySelectorAll("#treebody .tnode.ton:not(.tjoined)")].length,
  }));
  if (/joined/i.test(listed.section) && listed.rows.length === 1) {
    ok("a join run is listed under a joined heading: " + listed.rows[0]);
  } else bad("joined section: " + JSON.stringify(listed));
  if (listed.marked === 1 && listed.files === 0) ok("and it is the one marked as open, not the file it came from");
  else bad("marks: " + JSON.stringify(listed));

  /* open a file again, then click the result to bring it back */
  await page.click("#treebody .tnode[data-path='orders.parquet']");
  await idle(page);
  await page.waitForTimeout(250);
  const away = await page.evaluate(() => window.PARIS.state.table.rowsLoaded);
  await page.click("#treebody .tnode.tjoined");
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => ({
    rows: window.PARIS.state.table.rowsLoaded,
    cols: window.PARIS.state.table.cols.map((c) => c.name),
  }));
  if (away === 500 && back.rows === 470 && back.cols.includes("manager")) {
    ok("clicking it puts the joined table back on screen, whole");
  } else bad("reopening a result: " + JSON.stringify({ away, back }));

  /* and it can be the other side of the next join, dragged in like a file */
  await page.click("#toggleJoin");
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const row = document.querySelector("#treebody .tnode.tjoined");
    const zone = document.querySelector(".jside[data-jside='B']");
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
    zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await idle(page);
  await page.waitForTimeout(300);
  const asB = await page.evaluate(() =>
    [...document.querySelectorAll(".jside .jname")].map((n) => n.textContent));
  if (/⋈/.test(asB[1] || "")) ok("a result drags into a side like a file does: " + asB.join(" / "));
  else bad("joined result as B: " + JSON.stringify(asB));
});

/* ------------------------------------------- what the SQL panel writes */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.setInputFiles("#picker", path.join(tmp, "orders.parquet"));
  await page.waitForSelector("#toggleJoin:not([hidden])", { timeout: 15000 });
  const plain = await page.evaluate(() => window.PARIS.querySql());
  if (/FROM orders/.test(plain)) ok("a plain file reads FROM <the file>");
  else bad("plain FROM: " + plain);

  await page.click("#toggleJoin");
  await page.setInputFiles("#jpicker", path.join(tmp, "regions.parquet"));
  await idle(page);
  await page.selectOption("#jkeyA", { label: "region" });
  await page.selectOption("#jkeyB", { label: "name" });
  await page.click("#jrun");
  await idle(page);
  await page.waitForTimeout(200);

  /* the FROM clause must name both files and the key each side, rather than
     a single table that nothing on disk corresponds to */
  const sql = await page.evaluate(() => window.PARIS.querySql());
  if (/FROM orders\nINNER JOIN regions ON region = regions\.name/.test(sql)) {
    ok("a joined table writes both file names and the join key");
  } else bad("joined SQL: " + JSON.stringify(sql));

  /* and it must read back: the panel is bidirectional, so what it writes
     has to parse, join clause included */
  const round = await page.evaluate(() => {
    const t = window.PARIS.state.table;
    const parsed = window.PARIS.parseSql(window.PARIS.querySql(), t.cols);
    return { ok: !!parsed.query, errors: parsed.errors.map((e) => e.msg) };
  });
  /* the grid is showing the joined table by now, not the panel */
  if (round.ok && !round.errors.length) ok("the SQL a joined table writes parses back cleanly");
  else bad("round trip: " + JSON.stringify(round.errors));

  /* a join clause that is not the applied one is refused by name, the same
     way an unrepresentable WHERE is, instead of quietly being ignored */
  const wrong = await page.evaluate(() => window.PARIS.parseSql(
    "SELECT *\nFROM orders\nINNER JOIN small ON id = small.ref_id",
    window.PARIS.state.table.cols).errors.map((e) => e.msg));
  if (wrong.length && /not the join this table came from/.test(wrong[0])) {
    ok("a join clause that is not the applied one is refused");
  } else bad("made-up join clause accepted: " + JSON.stringify(wrong));

  /* with no join applied, a join is still refused outright */
  await page.setInputFiles("#picker", path.join(tmp, "orders.parquet"));
  await idle(page);
  const onPlain = await page.evaluate(() => window.PARIS.parseSql(
    "SELECT *\nFROM orders\nJOIN regions ON region = regions.name",
    window.PARIS.state.table.cols).errors.map((e) => e.msg));
  if (onPlain.length && /Join panel/.test(onPlain[0])) ok("a join over a plain file is still refused");
  else bad("join over a plain file: " + JSON.stringify(onPlain));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? failed + " check(s) failed" : "all checks passed");
process.exit(failed ? 1 : 0);
