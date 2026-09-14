import { $ } from "./columns.js";
import { fmtValue, hex, typeSpec } from "./types.js";
import { bytesHuman, esc, num, state } from "./view.js";

export function rawStat(bytes, leaf) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (leaf.type) {
    case "BOOLEAN": return bytes[0] === 1;
    case "INT32": return dv.getInt32(0, true);
    case "INT64": {
      const v = dv.getBigInt64(0, true);
      return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v;
    }
    case "FLOAT": return dv.getFloat32(0, true);
    case "DOUBLE": return dv.getFloat64(0, true);
    case "INT96": return { int96: true, nanos: dv.getBigUint64(0, true), julian: dv.getUint32(8, true) };
    default: return bytes;
  }
}
/** …shown the way the column's own type would show it. */
export function showStat(raw, spec, max) {
  let t;
  try {
    const elem = spec.nested ? Object.assign({}, spec, { kind: spec.elementKind }) : spec;
    t = fmtValue(spec.convert(raw), elem);
  } catch (e) { t = raw instanceof Uint8Array ? hex(raw, 16) : String(raw); }
  const cut = max || 60;
  return t == null ? null : (t.length > cut ? t.slice(0, cut) + "..." : t);
}
export function statValue(bytes, leaf, spec) {
  if (!bytes || !bytes.length) return null;
  try { return showStat(rawStat(bytes, leaf), spec); } catch (e) { return hex(bytes, 16); }
}

export function schemaTree(meta) {
  const lines = [];
  const walk = (node, depth) => {
    if (depth > 0) {
      const bits = [];
      bits.push(node.type ? node.type + (node.typeLength ? "(" + node.typeLength + ")" : "") : "group");
      const lt = node.logical ? node.logical.name : node.converted;
      if (lt) bits.push(lt.toLowerCase());
      lines.push("  ".repeat(depth - 1) + "<span class='rp'>" + node.rep.toLowerCase().padEnd(8) +
        "</span> <span class='nm'>" + esc(node.name) + "</span> <span class='ty'>" + esc(bits.join(" ")) + "</span>");
    }
    for (const c of node.children) walk(c, depth + 1);
  };
  walk(meta.schema.root, 0);
  return "<div class='tree'>" + lines.join("\n") + "</div>";
}

export function datasetName(dataset) {
  const first = dataset.parts[0].path;
  const cut = first.indexOf("/");
  return cut > 0 ? first.slice(0, cut) + "/" : first;
}
export function renderMeta() {
  const meta = state.meta, table = state.table, src = state.src;
  const dataset = state.dataset;
  const leaves = meta.schema.leaves;
  const agg = leaves.map(() => ({ comp: 0, uncomp: 0, values: 0, nulls: 0, statNulls: false,
    enc: new Set(), codec: new Set() }));
  let totalComp = 0, totalUncomp = 0;
  const allGroups = [];
  for (const part of (dataset ? dataset.parts : [{ meta }])) {
    for (const rg of part.meta.rowGroups) allGroups.push({ rg, part });
  }
  for (const { rg } of allGroups) {
    rg.columns.forEach((c, i) => {
      if (!c.meta || i >= agg.length) return;
      const a = agg[i];
      a.comp += c.meta.totalCompressedSize;
      a.uncomp += c.meta.totalUncompressedSize;
      a.values += c.meta.numValues;
      if (c.meta.statistics && c.meta.statistics.nullCount != null) {
        a.nulls += c.meta.statistics.nullCount;
        a.statNulls = true;
      }
      for (const e of c.meta.encodings) a.enc.add(e);
      a.codec.add(c.meta.codec);
      totalComp += c.meta.totalCompressedSize;
      totalUncomp += c.meta.totalUncompressedSize;
    });
  }
  const codecs = new Set(), encs = new Set();
  for (const a of agg) { for (const c of a.codec) codecs.add(c); for (const e of a.enc) encs.add(e); }

  $("mbar").innerHTML = [
    dataset && dataset.parts.length > 1
      ? "<span class='tag'>files <b>" + num(dataset.parts.length) + "</b></span>" : "",
    "<span class='tag'>rows <b>" + num(dataset ? dataset.numRows : meta.numRows) + "</b></span>",
    table.truncated && table.rowsLoaded ? "<span class='tag'>read so far <b>" + num(table.rowsLoaded) +
      "</b> rows &mdash; summaries cover these</span>" : "",
    table.scan ? "<span class='tag'>scanned <b>" + num(table.scan.kept) + "</b> of " +
      num(table.scan.total) + " row groups &mdash; only rows that could match this query</span>" : "",
    "<span class='tag'>columns <b>" + num(table.cols.length) + "</b></span>",
    "<span class='tag'>row groups <b>" + num(dataset ? dataset.numGroups : meta.rowGroups.length) + "</b></span>",
    "<span class='tag'>size <b>" + bytesHuman(dataset ? dataset.size : src.size) + "</b></span>",
    "<span class='tag'>compression <b>" + esc([...codecs].join(", ") || "-") + "</b></span>",
    "<span class='tag'>encryption <b>" + (meta.encryption ? esc(meta.encryption.algorithm) : "none") + "</b></span>",
    "<span class='tag'>format <b>v" + (meta.version == null ? "?" : meta.version) + "</b></span>",
    "<span class='muted'>" + esc(meta.createdBy || "unknown writer") + "</span>",
  ].join("");

  const cards = [];
  const row = (k, v) => "<tr><td class='k'>" + k + "</td><td>" + v + "</td></tr>";
  const partCount = dataset ? dataset.parts.length : 1;
  cards.push("<div class='mcard'><h3>" + (partCount > 1 ? "dataset" : "file") + "</h3><table class='kvt'>" + [
    row("name", esc(dataset && partCount > 1 ? datasetName(dataset) : (src.name || "(dropped file)"))),
    partCount > 1 ? row("files", num(partCount) + " parquet file" + (partCount === 1 ? "" : "s")) : "",
    row("size", bytesHuman(dataset ? dataset.size : src.size) +
      " <span class='muted'>(" + num(dataset ? dataset.size : src.size) + " B)</span>"),
    row("rows", num(dataset ? dataset.numRows : meta.numRows)),
    row("columns", num(leaves.length) + " leaf" +
      (dataset && dataset.partitionCols.length ? " + " + num(dataset.partitionCols.length) + " partition" : "") +
      " <span class='muted'>/ " + num(meta.schema.nodes.length - 1) + " schema nodes</span>"),
    row("row groups", num(dataset ? dataset.numGroups : meta.rowGroups.length)),
    row("format version", "v" + (meta.version == null ? "?" : meta.version)),
    row("created by", esc(meta.createdBy || "-")),
    row("footer size", bytesHuman(meta.footerLength)),
    row("column data", bytesHuman(totalComp) + " <span class='muted'>from " + bytesHuman(totalUncomp) +
      (totalUncomp ? ", " + (totalComp / totalUncomp * 100).toFixed(1) + "%" : "") + "</span>"),
    row("compression", esc([...codecs].join(", ") || "-")),
    row("encodings", esc([...encs].join(", ") || "-")),
    row("encryption", meta.encryption ?
      esc(meta.encryption.algorithm) + " <span class='muted'>(plaintext footer)</span>" : "none"),
    row("loaded here", num(table.rowsLoaded) + " rows <span class='muted'>in " + num(table.groupsLoaded) +
      " row group" + (table.groupsLoaded === 1 ? "" : "s") +
      (table.truncated ? ", more available" : ", complete") + "</span>"),
  ].join("") + "</table></div>");

  cards.push("<div class='mcard'><h3>schema</h3>" + schemaTree(meta) + "</div>");

  if (partCount > 1) {
    let fileRows = "";
    dataset.parts.forEach((part, i) => {
      const pv = part.partition.map((p) => p.key + "=" + (p.value === null ? "(null)" : p.value)).join(" ");
      fileRows += "<tr><td title='" + esc(part.path) + "'>" + esc(part.path) + "</td><td class='n'>" +
        num(part.rows) + "</td><td class='n'>" + bytesHuman(part.size) + "</td><td class='n'>" +
        num(part.meta.rowGroups.length) + "</td><td title='" + esc(pv) + "'>" + esc(pv || "-") +
        "</td><td>" + esc(part.meta.createdBy || "-") + "</td></tr>";
    });
    cards.push("<div class='mcard wide'><h3>files</h3><div class='scrollx'><table class='kvt'>" +
      "<tr><th>path</th><th>rows</th><th>size</th><th>row groups</th><th>partition</th><th>written by</th></tr>" +
      fileRows + "</table></div></div>");
  } else {
    let rgRows = "";
    meta.rowGroups.forEach((rg, i) => {
      const off = rg.fileOffset != null ? rg.fileOffset
        : (rg.columns[0] && rg.columns[0].meta ? rg.columns[0].meta.dataPageOffset : null);
      rgRows += "<tr><td class='n'>" + i + "</td><td class='n'>" + num(rg.numRows) + "</td><td class='n'>" +
        bytesHuman(rg.totalCompressedSize != null ? rg.totalCompressedSize : rg.totalByteSize) +
        "</td><td class='n'>" + bytesHuman(rg.totalByteSize) + "</td><td class='n'>" + num(off) + "</td></tr>";
    });
    cards.push("<div class='mcard wide'><h3>row groups</h3><div class='scrollx'><table class='kvt'>" +
      "<tr><th>#</th><th>rows</th><th>compressed</th><th>uncompressed</th><th>offset</th></tr>" +
      rgRows + "</table></div></div>");
  }
  if (dataset && dataset.skipped.length) {
    cards.push("<div class='mcard wide'><div class='warnbox'>Skipped " + num(dataset.skipped.length) +
      " file(s):<br>" + dataset.skipped.slice(0, 8).map(esc).join("<br>") + "</div></div>");
  }

  let colRows = "";
  const firstGroup = meta.rowGroups[0];
  const partitionNames = dataset ? dataset.partitionCols.map((c) => c.name) : [];
  const byPath = new Map();
  if (firstGroup) firstGroup.columns.forEach((c, i) => { if (c.meta) byPath.set(c.meta.path.join(" "), c); });
  leaves.forEach((leaf, i) => {
    const a = agg[i];
    const spec = table.cols[i] ? table.cols[i].spec : typeSpec(leaf);
    const key = leaf.path.join(" ");
    const first = byPath.has(key) ? byPath.get(key) : (firstGroup && firstGroup.columns[i]);
    const st = first && first.meta ? first.meta.statistics : null;
    const mn = st ? statValue(st.minValue || st.min, leaf, spec) : null;
    const mx = st ? statValue(st.maxValue || st.max, leaf, spec) : null;
    const path = leaf.path.join(".");
    colRows += "<tr><td title='" + esc(path) + "'>" + esc(path) + "</td>" +
      "<td>" + esc(leaf.type + (leaf.typeLength ? "(" + leaf.typeLength + ")" : "")) + "</td>" +
      "<td>" + esc(spec.label) + "</td>" +
      "<td>" + esc([...a.codec].join(",")) + "</td>" +
      "<td title='" + esc([...a.enc].join(", ")) + "'>" + esc([...a.enc].join(", ")) + "</td>" +
      "<td class='n'>" + num(a.values) + "</td>" +
      "<td class='n'>" + (a.statNulls ? num(a.nulls) : "-") + "</td>" +
      "<td class='n'>" + bytesHuman(a.uncomp) + "</td>" +
      "<td class='n'>" + bytesHuman(a.comp) + "</td>" +
      "<td class='n'>" + (a.uncomp ? (a.comp / a.uncomp * 100).toFixed(0) + "%" : "-") + "</td>" +
      "<td title='" + esc(String(mn)) + "'>" + (mn == null ? "<span class='muted'>-</span>" : esc(mn)) + "</td>" +
      "<td title='" + esc(String(mx)) + "'>" + (mx == null ? "<span class='muted'>-</span>" : esc(mx)) + "</td></tr>";
  });
  cards.push("<div class='mcard wide'><h3>columns <span class='muted'>&middot; sizes summed over every row group, " +
    "min/max from the first row group's statistics</span></h3><div class='scrollx'><table class='kvt'>" +
    "<tr><th>path</th><th>physical</th><th>logical</th><th>codec</th><th>encodings</th><th>values</th>" +
    "<th>nulls</th><th>uncompressed</th><th>compressed</th><th>ratio</th><th>min</th><th>max</th></tr>" +
    colRows + "</table></div></div>");

  let pg = "";
  const seen = new Set();
  meta.rowGroups.forEach((rg) => rg.columns.forEach((c, i) => {
    if (!c.meta) return;
    for (const s of c.meta.encodingStats) {
      const name = leaves[i] ? leaves[i].path.join(".") : String(i);
      const key = name + "|" + s.pageType + "|" + s.encoding;
      if (seen.has(key)) continue;
      seen.add(key);
      pg += "<tr><td>" + esc(name) + "</td><td>" + esc(s.pageType) + "</td><td>" + esc(s.encoding) + "</td></tr>";
    }
  }));
  if (pg) {
    cards.push("<div class='mcard'><h3>page encodings</h3><details><summary>per column and page type</summary>" +
      "<table class='kvt'><tr><th>column</th><th>page</th><th>encoding</th></tr>" + pg + "</table></details></div>");
  }

  if (meta.keyValue.length) {
    let kvRows = "";
    for (const kv of meta.keyValue) {
      const v = kv.value == null ? "" : kv.value;
      kvRows += "<tr><td class='k' title='" + esc(kv.key) + "'>" + esc(kv.key) + "</td><td title='" +
        esc(v.slice(0, 2000)) + "'>" + esc(v.length > 160 ? v.slice(0, 160) + "..." : v) +
        " <span class='muted'>(" + num(v.length) + " chars)</span></td></tr>";
    }
    cards.push("<div class='mcard wide'><h3>key/value metadata</h3><div class='scrollx'><table class='kvt'>" +
      kvRows + "</table></div></div>");
  }
  $("mbody").innerHTML = cards.join("");
  $("meta").hidden = false;
  if (!state.metaTouched) {
    /* the query panel takes the room the metadata panel used to have, so the
       metadata starts folded away; one click brings it back */
    $("meta").classList.add("collapsed");
    $("toggleMeta").textContent = "Show metadata";
  }
  $("mgrip").hidden = $("meta").classList.contains("collapsed");
}
