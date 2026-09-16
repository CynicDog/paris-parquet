/**
 * Drives the file panel in a real browser. Two things live in it: a folder
 * being browsed -- expand a subfolder, click a file, confirm it opens, for
 * both backends (the File System Access API, mocked, since headless
 * Chromium can't drive its native picker dialog; and the webkitdirectory
 * fallback, driven for real) -- and the list of files this page load has
 * been handed, which is what the panel shows by default, before any folder
 * is granted and before the first file is even dropped. Also counts every
 * network request, which must stay at one -- the html itself.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node tools/browser-tree.mjs /tmp/fx/push
 *
 * Any folder with at least one subfolder containing a .parquet file works;
 * tools/fixtures.py's push/ output (folders of parquet files) fits.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const dir = process.argv[2] || "/tmp/fx/push";
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "index.html");

let failed = 0;
const ok = (s) => console.log("ok   " + s);
const bad = (s) => { failed++; console.log("FAIL " + s); };
const idle = (page) => page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 30000 });

function findFirstNested(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(root, entry.name);
    const files = fs.readdirSync(sub).filter((f) => f.endsWith(".parquet"));
    if (files.length) return { subName: entry.name, fileName: files[0] };
  }
  return null;
}
const nested = findFirstNested(dir);
if (!nested) {
  console.log("no subfolder with a .parquet file under " + dir + " -- nothing to drive");
  process.exit(1);
}

function readTree(p, name) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    return { kind: "directory", name, children: fs.readdirSync(p).map((c) => readTree(path.join(p, c), c)) };
  }
  return { kind: "file", name, bytes: fs.readFileSync(p).toString("base64") };
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
  await fn(page, logs);
  const external = requests.filter((u) => !u.startsWith("file://"));
  if (external.length) bad("made a non-file request: " + external[0]);
  else ok("no network request beyond the page itself");
  if (logs.length) bad("console/page errors: " + logs.join(" | "));
  await browser.close();
}

/* -------------------------------------------------- webkitdirectory path */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.setInputFiles("#treepicker", dir);
  await idle(page);
  const rootVisible = await page.evaluate(() => !document.getElementById("tree").hidden);
  if (rootVisible) ok("webkitdirectory: tree opens"); else bad("webkitdirectory: tree did not open");

  const subSel = `.tnode.tdir[data-path$='${nested.subName}']`;
  const sub = await page.$(subSel);
  if (!sub) { bad("webkitdirectory: subfolder row not found"); return; }
  await sub.click();
  await page.waitForTimeout(150);
  const fileSel = `.tnode.tfile[data-path$='${nested.fileName}']`;
  const file = await page.$(fileSel);
  if (!file) { bad("webkitdirectory: file row did not appear after expanding"); return; }
  ok("webkitdirectory: subfolder expands to show its file");
  await file.click();
  await idle(page);
  const fileline = await page.evaluate(() => document.getElementById("fileline").textContent);
  if (fileline.includes(nested.fileName)) ok("webkitdirectory: clicking a tree file opens it");
  else bad("webkitdirectory: fileline after click: " + fileline);

  /* leaving the folder goes back to the session list, which needs no grant
     and holds what has been opened from the folder so far */
  await page.click("#treewho [data-tact='session']");
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => ({
    browse: !!document.querySelector("#treewho [data-tact='browse']"),
    rows: [...document.querySelectorAll("#treebody .tnode.tfile")].map((n) => n.dataset.path),
  }));
  if (back.browse && back.rows.some((r) => r.endsWith(nested.fileName))) {
    ok("webkitdirectory: leaving the folder falls back to the session list");
  } else bad("after leaving the folder: " + JSON.stringify(back));
});

/* ------------------------------------------------ File System Access path */
await withPage(async (page, logs) => {
  const tree = readTree(dir, path.basename(dir));
  await page.addInitScript((treeData) => {
    function b64ToBytes(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    function makeHandle(node) {
      if (node.kind === "file") {
        return { kind: "file", name: node.name, async getFile() { return new File([b64ToBytes(node.bytes)], node.name); } };
      }
      const childHandles = new Map(node.children.map((c) => [c.name, makeHandle(c)]));
      return {
        kind: "directory",
        name: node.name,
        async *entries() { for (const [n, h] of childHandles) yield [n, h]; },
        async getDirectoryHandle(name) {
          const h = childHandles.get(name);
          if (!h || h.kind !== "directory") throw new Error("not a directory: " + name);
          return h;
        },
        async getFileHandle(name) {
          const h = childHandles.get(name);
          if (!h || h.kind !== "file") throw new Error("not a file: " + name);
          return h;
        },
      };
    }
    window.showDirectoryPicker = async () => makeHandle(treeData);
  }, tree);

  await page.goto("file://" + appPath);
  /* the panel is already open on the session list; browsing a folder is a
     click inside it, since that is the one that needs a grant */
  await page.click("#treewho [data-tact='browse']");
  await page.waitForTimeout(250);
  const rootVisible = await page.evaluate(() => !document.getElementById("tree").hidden &&
    !!document.querySelector("#treewho [data-tact='change']"));
  if (rootVisible) ok("File System Access: browsing a folder opens it in the panel");
  else bad("File System Access: the folder did not open");

  const subSel = `.tnode.tdir[data-path$='${nested.subName}']`;
  const sub = await page.$(subSel);
  if (!sub) { bad("File System Access: subfolder row not found"); return; }
  await sub.click();
  await page.waitForTimeout(200);
  const fileSel = `.tnode.tfile[data-path$='${nested.fileName}']`;
  const file = await page.$(fileSel);
  if (!file) { bad("File System Access: file row did not appear after expanding"); return; }
  ok("File System Access: subfolder expands lazily to show its file");
  await file.click();
  await idle(page);
  const fileline = await page.evaluate(() => document.getElementById("fileline").textContent);
  if (fileline.includes(nested.fileName)) ok("File System Access: clicking a tree file opens it");
  else bad("File System Access: fileline after click: " + fileline);
});

/* ------------------------------------------- the panel before any file */
await withPage(async (page) => {
  await page.goto("file://" + appPath);
  await page.waitForTimeout(300);
  const start = await page.evaluate(() => ({
    hidden: document.getElementById("tree").hidden,
    empty: document.querySelector("#treebody .tempty")?.textContent || "",
    folderButtons: [...document.querySelectorAll("header button, header label.btn")]
      .map((b) => b.textContent.trim()).filter((t) => /folder/i.test(t)),
  }));
  if (!start.hidden) ok("the panel is open before anything has been opened");
  else bad("the panel started closed");
  if (/Drop a \.parquet file/.test(start.empty)) ok("its empty state says how files get there");
  else bad("empty state: " + JSON.stringify(start.empty.slice(0, 60)));
  if (start.folderButtons.length === 1) ok("one folder button in the header: " + start.folderButtons[0]);
  else bad("folder buttons in the header: " + JSON.stringify(start.folderButtons));

  /* a real drop, the way a file actually arrives */
  const bytes = [...fs.readFileSync(path.join(dir, nested.subName, nested.fileName))];
  const drop = async (b, name) => {
    await page.evaluate(([bb, nn]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bb)], nn, { type: "application/octet-stream" }));
      document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [b, name]);
    await idle(page);
    await page.waitForTimeout(250);
  };
  await drop(bytes, nested.fileName);
  const after = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("#treebody .tnode")].map((n) => n.dataset.path),
    marked: [...document.querySelectorAll("#treebody .tnode.ton")].map((n) => n.dataset.path),
  }));
  if (after.rows.join() === nested.fileName) ok("a dropped file appears in the panel straight away");
  else bad("panel after a drop: " + JSON.stringify(after.rows));
  if (after.marked.join() === nested.fileName) ok("the open file is marked there");
  else bad("open file not marked: " + JSON.stringify(after.marked));

  /* a second one is added to the list, not swapped for it */
  await drop(bytes, "second.parquet");
  const two = await page.evaluate(() =>
    [...document.querySelectorAll("#treebody .tnode")].map((n) => n.dataset.path).sort());
  if (two.length === 2) ok("a second drop is added to the list: " + two.join(", "));
  else bad("list after a second drop: " + JSON.stringify(two));

  /* clicking one opens it, with no join waiting for a side B */
  await page.click("#treebody .tnode[data-path='" + nested.fileName + "']");
  await idle(page);
  await page.waitForTimeout(250);
  const line = await page.textContent("#fileline");
  if (line.includes(nested.fileName)) ok("clicking a listed file opens it");
  else bad("fileline after clicking the list: " + line);

  /* and the toggle hides and shows it again without asking for a folder */
  await page.click("#toggleTree");
  await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => document.getElementById("tree").hidden);
  await page.click("#toggleTree");
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => ({
    hidden: document.getElementById("tree").hidden,
    rows: [...document.querySelectorAll("#treebody .tnode")].length,
  }));
  if (hidden && !back.hidden && back.rows === 2) ok("the header button hides and shows the panel, list intact");
  else bad("toggling the panel: " + JSON.stringify({ hidden, back }));
});

console.log(failed ? failed + " check(s) failed" : "all checks passed");
process.exit(failed ? 1 : 0);
