/**
 * Drives the folder-tree panel in a real browser: open it, expand a
 * subfolder, click a file, confirm it opens -- for both backends (the File
 * System Access API, mocked, since headless Chromium can't drive its native
 * picker dialog; and the webkitdirectory fallback, driven for real). Also
 * counts every network request, which must stay at one -- the html itself.
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
  await page.click("#toggleTree");
  await page.waitForTimeout(200);
  const rootVisible = await page.evaluate(() => !document.getElementById("tree").hidden);
  if (rootVisible) ok("File System Access: tree opens"); else bad("File System Access: tree did not open");

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

console.log(failed ? failed + " check(s) failed" : "all checks passed");
process.exit(failed ? 1 : 0);
