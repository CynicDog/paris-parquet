import { utf8 } from "./bytes.js";
import { readColumnChunk } from "./encoding.js";
import { readFooter } from "./thrift.js";
import { looksUtf8, typeSpec } from "./types.js";

export function fileSource(file) {
  return {
    size: file.size,
    name: file.name,
    file,                              /* a worker opens it again for itself */
    async read(start, end) { return new Uint8Array(await file.slice(start, end).arrayBuffer()); },
  };
}

export function isParquetPath(path) {
  const name = path.split("/").pop();
  if (!name || name[0] === "." || name[0] === "_") return false;   /* _SUCCESS, .crc, hidden */
  return /\.(parquet|parq|pq)$/i.test(name);
}
export const unHive = (s) => { try { return decodeURIComponent(s); } catch (_e) { return s; } };
/** Hive lays partition values in the path: year=2024/month=01/part-0.parquet */
export function hivePartition(path) {
  const out = [];
  const segs = path.split("/");
  for (let i = 0; i < segs.length - 1; i++) {
    const m = /^([^=]+)=(.*)$/.exec(segs[i]);
    if (m) out.push({ key: unHive(m[1]), value: m[2] === "__HIVE_DEFAULT_PARTITION__" ? null : unHive(m[2]) });
  }
  return out;
}
/** A column is the same column across files only if it holds the same shape. */
export function leafSignature(leaf) {
  const lt = leaf.logical ? leaf.logical.name + JSON.stringify(leaf.logical) : leaf.converted || "";
  return leaf.type + "/" + (leaf.typeLength || 0) + "/" + lt + "/" + leaf.maxRep;
}
/** Partition values arrive as text; give the column the narrowest type that fits. */
export function partitionSpec(values) {
  const real = values.filter((v) => v !== null && v !== "");
  const label = "partition";
  if (real.length && real.every((v) => /^-?\d{1,15}$/.test(v))) {
    return { kind: "number", label, physical: "PATH", partition: true, convert: (v) => (v === null ? null : +v) };
  }
  if (real.length && real.every((v) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v))) {
    return { kind: "number", label, physical: "PATH", partition: true, convert: (v) => (v === null ? null : +v) };
  }
  if (real.length && real.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) {
    return { kind: "temporal", sub: "date", label: "partition date", physical: "PATH", partition: true,
      convert: (v) => (v === null ? null : Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10))) };
  }
  return { kind: "string", label, physical: "PATH", partition: true, convert: (v) => v };
}

/**
 * Reads every part's footer, then reconciles them into one column list.
 * Columns are the union across files; a file missing one reads as null.
 * A column that means something different in two files is fatal, and says so.
 */
export async function readDataset(entries, onProgress) {
  const parts = [];
  const skipped = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (onProgress) await onProgress(i, entries.length, e.path);
    let meta;
    try { meta = await readFooter(e.src); }
    catch (err) { skipped.push(e.path + " — " + err.message); continue; }
    parts.push({
      src: e.src, path: e.path, meta,
      partition: hivePartition(e.path),
      byPath: null, leafByPath: null,
    });
  }
  if (!parts.length) {
    throw new Error(entries.length
      ? "None of the " + entries.length + " file(s) could be read:\n" + skipped.join("\n")
      : "No .parquet files here.");
  }

  /* union the leaves, in first-seen order, and refuse real disagreements */
  const columns = [], byKey = new Map(), conflicts = [];
  for (const part of parts) {
    part.leafByPath = new Map();
    for (const leaf of part.meta.schema.leaves) {
      const key = leaf.path.join("\u0001");
      part.leafByPath.set(key, leaf);
      const seen = byKey.get(key);
      if (!seen) {
        const col = { key, leaf, name: leaf.label || leaf.path.join("."), sig: leafSignature(leaf), from: part };
        byKey.set(key, col);
        columns.push(col);
      } else if (seen.sig !== leafSignature(leaf)) {
        conflicts.push('"' + seen.name + '" is ' + seen.leaf.type + " in " + seen.from.path +
          " but " + leaf.type + " in " + part.path);
      }
    }
  }
  if (conflicts.length) {
    throw new Error("These files do not describe the same table:\n" + conflicts.slice(0, 6).join("\n") +
      (conflicts.length > 6 ? "\n…and " + (conflicts.length - 6) + " more" : ""));
  }

  /* partition keys, in the order the paths introduce them */
  const partKeys = [];
  for (const part of parts) {
    for (const p of part.partition) if (partKeys.indexOf(p.key) < 0) partKeys.push(p.key);
  }
  const partitionCols = partKeys.map((key) => {
    const raw = parts.map((part) => {
      const hit = part.partition.find((p) => p.key === key);
      return hit ? hit.value : null;
    });
    const spec = partitionSpec(raw);
    parts.forEach((part, i) => {
      part.partValues = part.partValues || {};
      part.partValues[key] = spec.convert(raw[i]);
    });
    return { key: "\u0000part\u0000" + key, name: key, partKey: key, spec, leaf: null };
  });

  for (const part of parts) {
    part.rows = part.meta.numRows;
    part.size = part.src.size;
  }
  const totalRows = parts.reduce((a, p) => a + p.rows, 0);
  const totalGroups = parts.reduce((a, p) => a + p.meta.rowGroups.length, 0);
  return {
    parts, columns, partitionCols, skipped,
    reference: parts[0].meta,
    numRows: totalRows,
    numGroups: totalGroups,
    size: parts.reduce((a, p) => a + p.size, 0),
  };
}

export function newTable(dataset) {
  const cols = dataset.partitionCols.map((pc) => ({
    leaf: null, partKey: pc.partKey, key: pc.key, name: pc.name, spec: pc.spec, rows: [],
    sniffed: true, filled: 0,
  })).concat(dataset.columns.map((c) => ({
    leaf: c.leaf, key: c.key, name: c.name, spec: typeSpec(c.leaf), rows: [], sniffed: false, filled: 0,
  })));
  return {
    dataset, meta: dataset.reference, cols,
    nextPart: 0, nextGroup: 0, rowsLoaded: 0, groupsLoaded: 0,
    reads: [], need: null,
    truncated: dataset.numGroups > 0,
  };
}

/** An untyped BYTE_ARRAY column that turned out to hold text after all. */
export function becomesText(col) {
  if (col.spec.nested) col.spec.elementKind = "string"; else col.spec.kind = "string";
  col.spec.label = col.spec.label + " (utf-8)";
  col.spec.convert = (v) => utf8.decode(v);
}

/**
 * A BYTE_ARRAY with no logical type is either text or it is bytes, and which
 * one must not depend on which row groups a query happened to read. The
 * answer comes from the first row group of the first file, once, and is
 * remembered on the dataset so every table over it agrees.
 */
export async function sniffUtf8(dataset, col, atHand, isFirstGroup) {
  if (!dataset.utf8) dataset.utf8 = new Map();
  if (dataset.utf8.has(col.key)) return dataset.utf8.get(col.key);
  let values = atHand;
  if (!isFirstGroup) {
    try {
      const part = dataset.parts[0];
      const rg = part.meta.rowGroups[0];
      const leaf = part.leafByPath ? part.leafByPath.get(col.key) : null;
      const chunk = rg && leaf ? rg.columns.find((c) => c.meta && c.meta.path.join("\u0001") === col.key) : null;
      if (chunk && !chunk.filePath) {
        const raw = await readColumnChunk(part.src, chunk, leaf);
        if (raw.values.length) values = raw.values;
      }
    } catch (_e) { /* unreadable there; what is at hand will have to do */ }
  }
  const yes = looksUtf8(values);
  dataset.utf8.set(col.key, yes);
  return yes;
}
