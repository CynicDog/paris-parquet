import { $ } from "./columns.js";
import { isParquetPath } from "./dataset.js";
import { busy, drag, openFile, showError } from "./main.js";
import { esc } from "./view.js";

/**
 * Browsing state for the left-side folder tree. Nothing here is persisted
 * across a reload: `showDirectoryPicker` grants a handle only for this page
 * load, and the `webkitdirectory` fallback is a one-shot file list, never a
 * live handle -- re-opening the tree after a reload always asks again,
 * on purpose (see #14).
 */
export const tree = {
  on: false,
  kind: null,            /* "live" (File System Access) | "snapshot" (webkitdirectory) | null */
  rootName: "",
  rootHandle: null,      /* FileSystemDirectoryHandle, kind === "live" only */
  liveChildren: new Map(), /* dir path ("" for root) -> [{name, kind, handle}], populated lazily */
  nodes: null,            /* kind === "snapshot": the whole tree, built once, up front */
  expanded: new Set(),
  openPath: null,         /* path of the file currently shown in the grid, for highlighting */
};

export function treeSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

function isHidden(name) {
  return !name || name[0] === "." || name[0] === "_";
}

async function listLiveDir(handle) {
  const out = [];
  for await (const [name, h] of handle.entries()) {
    if (isHidden(name)) continue;
    if (h.kind === "directory") out.push({ name, kind: "directory", handle: h });
    else if (isParquetPath(name)) out.push({ name, kind: "file", handle: h });
  }
  out.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === "directory" ? -1 : 1));
  return out;
}

function snapshotNode() {
  return { children: new Map(), file: null };
}
function buildSnapshotTree(files) {
  const root = snapshotNode();
  let rootName = "";
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    const parts = rel.split("/").filter(Boolean);
    if (!rootName && parts.length) rootName = parts[0];
    if (parts.some(isHidden)) continue;
    if (!isParquetPath(rel)) continue;
    let node = root;
    for (let i = 1; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg)) node.children.set(seg, snapshotNode());
      node = node.children.get(seg);
    }
    const leaf = parts[parts.length - 1];
    if (!node.children.has(leaf)) node.children.set(leaf, snapshotNode());
    node.children.get(leaf).file = f;
  }
  return { root, rootName };
}

export async function openTreeLive() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "read" });
  } catch (e) {
    return; /* the user cancelled the native picker -- not an error */
  }
  tree.kind = "live";
  tree.rootHandle = handle;
  tree.rootName = handle.name;
  tree.liveChildren = new Map();
  tree.expanded = new Set();
  showTreePanel(true);
  busy(true, "reading the folder...");
  try {
    tree.liveChildren.set("", await listLiveDir(handle));
  } catch (e) { showError(e); } finally { busy(false); }
  renderTree();
}

export function openTreeSnapshot(fileList) {
  if (!fileList.length) return;
  const { root, rootName } = buildSnapshotTree(fileList);
  tree.kind = "snapshot";
  tree.nodes = root;
  tree.rootName = rootName;
  tree.expanded = new Set();
  showTreePanel(true);
  renderTree();
}

function showTreePanel(on) {
  tree.on = on;
  $("tree").hidden = !on;
  $("treegrip").hidden = !on;
}

export function closeTree() {
  tree.kind = null;
  tree.rootHandle = null;
  tree.rootName = "";
  tree.liveChildren = new Map();
  tree.nodes = null;
  tree.expanded = new Set();
  showTreePanel(false);
}

/** The node data a click needs, shared shape across "live" and "snapshot". */
function nodeIcon(kind, isOpen) {
  return kind === "directory" ? (isOpen ? "▾" : "▸") : "";
}

function renderLiveLevel(dirPath, depth) {
  const children = tree.liveChildren.get(dirPath);
  if (!children) return "";
  let html = "";
  for (const c of children) {
    const path = dirPath ? dirPath + "/" + c.name : c.name;
    const isOpen = tree.expanded.has(path);
    html += treeRow(c.kind, c.name, path, depth, isOpen);
    if (c.kind === "directory" && isOpen) html += renderLiveLevel(path, depth + 1);
  }
  return html;
}

function renderSnapshotLevel(node, path, depth) {
  let html = "";
  const entries = [...node.children.entries()].sort((a, b) => {
    const ad = a[1].file ? 1 : 0, bd = b[1].file ? 1 : 0;
    return ad !== bd ? ad - bd : (a[0] < b[0] ? -1 : 1);
  });
  for (const [name, child] of entries) {
    const p = path ? path + "/" + name : name;
    const kind = child.file ? "file" : "directory";
    const isOpen = tree.expanded.has(p);
    html += treeRow(kind, name, p, depth, isOpen);
    if (kind === "directory" && isOpen) html += renderSnapshotLevel(child, p, depth + 1);
  }
  return html;
}

function treeRow(kind, name, path, depth, isOpen) {
  const cssKind = kind === "directory" ? "dir" : "file";
  const on = kind === "file" && path === tree.openPath;
  return "<div class='tnode t" + cssKind + (on ? " ton" : "") + "' data-path='" + esc(path) +
    "' data-kind='" + kind + "' style='padding-left:" + (8 + depth * 14) + "px'>" +
    "<span class='tcaret" + (kind === "file" ? " tleaf" : "") + "'>" + nodeIcon(kind, isOpen) + "</span>" +
    "<span class='tname'>" + esc(name) + "</span></div>";
}

export function renderTree() {
  const body = $("treebody");
  const who = $("treewho");
  if (!tree.kind) { body.innerHTML = ""; who.innerHTML = ""; return; }
  who.innerHTML = "<b title='" + esc(tree.rootName) + "'>" + esc(tree.rootName) + "</b>" +
    "<span class='grow'></span><button data-tact='change'>change</button>";
  const html = tree.kind === "live" ? renderLiveLevel("", 0) : renderSnapshotLevel(tree.nodes, "", 0);
  body.innerHTML = html || "<div class='tempty'>No .parquet files found here.</div>";
}

async function toggleDir(path) {
  if (tree.expanded.has(path)) { tree.expanded.delete(path); renderTree(); return; }
  tree.expanded.add(path);
  if (tree.kind === "live" && !tree.liveChildren.has(path)) {
    const parts = path.split("/");
    let handle = tree.rootHandle;
    for (let i = 0; i < parts.length; i++) handle = await handle.getDirectoryHandle(parts[i]);
    busy(true, "reading the folder...");
    try { tree.liveChildren.set(path, await listLiveDir(handle)); }
    catch (e) { showError(e); tree.expanded.delete(path); }
    finally { busy(false); }
  }
  renderTree();
}

async function pickFile(path) {
  let file;
  if (tree.kind === "live") {
    const parts = path.split("/");
    let dir = tree.rootHandle;
    for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
    file = await fileHandle.getFile();
  } else {
    let node = tree.nodes;
    for (const seg of path.split("/")) node = node.children.get(seg);
    file = node && node.file;
  }
  if (!file) return;
  tree.openPath = path;
  renderTree();
  await openFile(file);
}

export function initTree() {
  $("toggleTree").addEventListener("click", () => {
    if (tree.on) { closeTree(); return; }
    if (treeSupported()) openTreeLive();
    else $("treepicker").click();
  });
  $("treepicker").addEventListener("change", (e) => {
    openTreeSnapshot(e.target.files);
    e.target.value = "";
  });
  $("treeclose").addEventListener("click", closeTree);
  $("treewho").addEventListener("click", (e) => {
    if (!e.target.closest("[data-tact='change']")) return;
    if (tree.kind === "live") openTreeLive();
    else $("treepicker").click();
  });
  $("treebody").addEventListener("click", (e) => {
    const row = e.target.closest(".tnode");
    if (!row) return;
    const path = row.dataset.path;
    if (row.dataset.kind === "directory") toggleDir(path);
    else pickFile(path).catch(showError);
  });
  $("treegrip").addEventListener("pointerdown", (e) =>
    drag(e, "colsizing", (ev) => treeWidth(ev.clientX)));
  try {
    const saved = +localStorage.getItem("paris-parquet-treew");
    if (saved > 0) document.documentElement.style.setProperty("--treew", saved + "px");
  } catch (e) { /* fine */ }
}

export function treeWidth(px) {
  const room = Math.max(160, window.innerWidth - 300);
  const w = Math.max(160, Math.min(Math.round(px), room));
  document.documentElement.style.setProperty("--treew", w + "px");
  try { localStorage.setItem("paris-parquet-treew", String(w)); } catch (e) { /* fine */ }
  return w;
}
