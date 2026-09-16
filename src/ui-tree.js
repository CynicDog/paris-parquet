import { $ } from "./columns.js";
import { isParquetPath } from "./dataset.js";
import { join, joinHooks, openJoinCompare } from "./join.js";
import { busy, drag, entriesFromFiles, fileHooks, openEntries, openFile, seen, showError } from "./main.js";
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
  kind: null,            /* "live" | "snapshot" | "session" (files seen this load) | null */
  rootName: "",
  rootHandle: null,      /* FileSystemDirectoryHandle, kind === "live" only */
  liveChildren: new Map(), /* dir path ("" for root) -> [{name, kind, handle}], populated lazily */
  nodes: null,            /* kind === "snapshot": the whole tree, built once, up front */
  expanded: new Set(),
  openPath: null,         /* path of the file currently shown in the grid, for highlighting */
  pickPath: null,         /* path picked as the join's side B, while picking */
  autoExpanded: new Set(),/* dirs opened for the user once, so a collapse sticks */
};

/** Marks a drag as one of ours, so a join side can tell a row being dragged
    in from a file being dragged in off the desktop. */
export const TREE_DRAG = "application/x-paris-parquet-path";

/** Looks a path up in whatever the panel is showing, as an entry the reader
    can take: the session list holds them already, a browsed folder has to
    fetch the file first. */
export async function entryForPath(path) {
  if (tree.kind === "live") {
    const parts = path.split("/");
    let dir = tree.rootHandle;
    for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
    const handle = await dir.getFileHandle(parts[parts.length - 1]);
    return entriesFromFiles([await handle.getFile()])[0] || null;
  }
  let node = tree.nodes;
  for (const seg of path.split("/")) {
    if (!node) return null;
    node = node.children.get(seg);
  }
  if (!node) return null;
  if (node.entry) return node.entry;
  return node.file ? entriesFromFiles([node.file])[0] || null : null;
}

/** Clicking a file opens it, unless the join panel is waiting for a side B. */
function picking() {
  return join.on;
}

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
  return { children: new Map(), file: null, entry: null };
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
  } catch (_e) {
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

/**
 * The fallback tree: every parquet seen this load, laid out by its own path.
 * Not a folder -- nothing here was granted -- just what is already in hand,
 * so the join panel has something to click when no folder is being browsed.
 */
export function openTreeSession() {
  tree.kind = "session";
  tree.rootName = "this session";
  buildSessionTree();
  showTreePanel(true);
  renderTree();
  return true;
}

/**
 * Rebuilds the session list from whatever the page has been handed so far.
 * A folder new to the list is expanded once, so a file that has just
 * arrived is visible without hunting for it; collapse it and it stays
 * collapsed, because it is only ever expanded the first time it is seen.
 */
function buildSessionTree() {
  const root = snapshotNode();
  for (const [path, entry] of seen) {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg)) node.children.set(seg, snapshotNode());
      node = node.children.get(seg);
      const dir = parts.slice(0, i + 1).join("/");
      if (!tree.autoExpanded.has(dir)) { tree.autoExpanded.add(dir); tree.expanded.add(dir); }
    }
    const leaf = parts[parts.length - 1];
    if (!node.children.has(leaf)) node.children.set(leaf, snapshotNode());
    node.children.get(leaf).entry = entry;
  }
  tree.nodes = root;
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
  /* closed, the panel leaves a rail on the edge it was on -- the way back
     in belongs where the panel is, not in the header */
  $("treerail").hidden = on;
}

/** The panel is open unless this page's user has closed it before. */
function rememberPanel(on) {
  try { localStorage.setItem("paris-parquet-tree", on ? "open" : "closed"); } catch { /* fine */ }
}
function panelWanted() {
  try { return localStorage.getItem("paris-parquet-tree") !== "closed"; } catch { return true; }
}

export function closeTree() {
  tree.kind = null;
  tree.pickPath = null;
  tree.rootHandle = null;
  tree.rootName = "";
  tree.liveChildren = new Map();
  tree.nodes = null;
  tree.expanded = new Set();
  tree.autoExpanded = new Set();
  showTreePanel(false);
}

/** Stops browsing a folder without closing the panel: back to the session
    list, which needs no grant and is never stale. */
function leaveFolder() {
  tree.rootHandle = null;
  tree.liveChildren = new Map();
  openTreeSession();
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

function isLeaf(node) {
  return !!(node.file || node.entry);
}

function renderSnapshotLevel(node, path, depth) {
  let html = "";
  const entries = [...node.children.entries()].sort((a, b) => {
    const ad = isLeaf(a[1]) ? 1 : 0, bd = isLeaf(b[1]) ? 1 : 0;
    return ad !== bd ? ad - bd : (a[0] < b[0] ? -1 : 1);
  });
  for (const [name, child] of entries) {
    const p = path ? path + "/" + name : name;
    const kind = isLeaf(child) ? "file" : "directory";
    const isOpen = tree.expanded.has(p);
    html += treeRow(kind, name, p, depth, isOpen);
    if (kind === "directory" && isOpen) html += renderSnapshotLevel(child, p, depth + 1);
  }
  return html;
}

function treeRow(kind, name, path, depth, isOpen) {
  const cssKind = kind === "directory" ? "dir" : "file";
  const on = kind === "file" && path === (picking() ? tree.pickPath : tree.openPath);
  /* a file can be dragged onto either side of the join panel; a folder
     cannot, since a side is one file or one folder-read-as-one-table and
     the tree has no way to say which is meant */
  return "<div class='tnode t" + cssKind + (on ? " ton" : "") + "' data-path='" + esc(path) +
    "' data-kind='" + kind + "'" + (kind === "file" ? " draggable='true'" : "") +
    " style='padding-left:" + (8 + depth * 14) + "px'>" +
    "<span class='tcaret" + (kind === "file" ? " tleaf" : "") + "'>" + nodeIcon(kind, isOpen) + "</span>" +
    "<span class='tname'>" + esc(name) + "</span></div>";
}

export function renderTree() {
  const body = $("treebody");
  const who = $("treewho");
  if (!tree.kind) { body.innerHTML = ""; who.innerHTML = ""; return; }
  const session = tree.kind === "session";
  who.innerHTML = "<b title='" + esc(tree.rootName) + "'>" + esc(tree.rootName) + "</b>" +
    "<span class='grow'></span>" +
    (session ? "<button data-tact='browse' title='Browse a folder on disk'>browse a folder</button>"
             : "<button data-tact='change'>change</button>" +
               "<button data-tact='session' title='Back to the files opened this session'>session</button>");
  const html = tree.kind === "live" ? renderLiveLevel("", 0) : renderSnapshotLevel(tree.nodes, "", 0);
  const empty = session
    ? "<div class='tempty'>Nothing opened yet.<br>Drop a .parquet file anywhere on the page, " +
      "or use <b>Open .parquet</b> — whatever you open shows up here.</div>"
    : "<div class='tempty'>No .parquet files found here.</div>";
  body.innerHTML = (picking() ? "<div class='tpick'>click a file to join against</div>" : "") +
    (html || empty);
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
    if (!node) return;
    if (node.entry) {                       /* already in hand: no File to fetch */
      if (picking()) {
        tree.pickPath = path;
        renderTree();
        await openJoinCompare([node.entry], path);
        return;
      }
      tree.openPath = path;
      renderTree();
      await openEntries([node.entry], null);
      return;
    }
    file = node.file;
  }
  if (!file) return;
  if (picking()) {
    tree.pickPath = path;
    renderTree();
    await openJoinCompare(entriesFromFiles([file]), path);
    return;
  }
  tree.openPath = path;
  renderTree();
  await openFile(file);
}

/**
 * While the join panel is up, this one is its file list: clicking a file
 * picks it as side B instead of opening it, and the picked row is marked.
 */
function syncTreeForJoin() {
  /* the join is opened from a button inside this panel, so the panel is
     always already up: all that changes is what clicking a file does */
  tree.pickPath = null;
  if (tree.on) renderTree();
}

/** A side B picked by dialog or drop is one more file the panel can offer,
    and the one it should be showing as picked. */
function syncTreeAfterPick(path) {
  if (!join.on) return;
  tree.pickPath = path || null;
  if (!tree.on) openTreeSession(); else renderTree();
}

/** Files arrive by drop, by picker, from the tree itself: the list follows. */
function syncTreeAfterSeen() {
  if (!tree.on || tree.kind !== "session") return;
  buildSessionTree();
  renderTree();
}
function syncTreeAfterOpen(path) {
  tree.openPath = path || null;
  if (tree.on && tree.kind === "session") { buildSessionTree(); renderTree(); }
  else if (tree.on) renderTree();
}

export function initTree() {
  joinHooks.onShow = syncTreeForJoin;
  joinHooks.onPick = syncTreeAfterPick;
  fileHooks.onSeen = syncTreeAfterSeen;
  fileHooks.onOpen = syncTreeAfterOpen;
  $("treerail").addEventListener("click", () => {
    openTreeSession();               /* never a folder grant: that is a click inside */
    rememberPanel(true);
  });
  $("treepicker").addEventListener("change", (e) => {
    openTreeSnapshot(e.target.files);
    e.target.value = "";
  });
  $("treeclose").addEventListener("click", () => { closeTree(); rememberPanel(false); });
  $("treewho").addEventListener("click", (e) => {
    if (e.target.closest("[data-tact='session']")) { leaveFolder(); return; }
    if (!e.target.closest("[data-tact='change'],[data-tact='browse']")) return;
    if (treeSupported() && tree.kind !== "snapshot") openTreeLive();
    else $("treepicker").click();
  });
  /* dragging a row is how a file reaches a join side: the path is all the
     other end needs, since every file here is one this page already holds */
  $("treebody").addEventListener("dragstart", (e) => {
    const row = e.target.closest(".tnode[draggable='true']");
    if (!row) return;
    e.dataTransfer.setData("text/plain", row.dataset.path);
    e.dataTransfer.setData(TREE_DRAG, row.dataset.path);
    e.dataTransfer.effectAllowed = "copy";
    row.classList.add("tdragging");
  });
  $("treebody").addEventListener("dragend", (e) => {
    const row = e.target.closest(".tnode");
    if (row) row.classList.remove("tdragging");
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
  } catch (_e) { /* fine */ }
  /* open from the start, with nothing in it yet: the panel is where files
     turn up, so it is there before the first one does */
  if (panelWanted()) openTreeSession(); else showTreePanel(false);
}

export function treeWidth(px) {
  const room = Math.max(160, window.innerWidth - 300);
  const w = Math.max(160, Math.min(Math.round(px), room));
  document.documentElement.style.setProperty("--treew", w + "px");
  try { localStorage.setItem("paris-parquet-treew", String(w)); } catch (_e) { /* fine */ }
  return w;
}
