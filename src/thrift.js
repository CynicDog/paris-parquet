// Thrift-compact deserialization and the parquet metadata built on top of
// it: the raw struct/value reader, schema tree construction (folding LIST/
// MAP wrapper levels out of the displayed path), and the footer parse
// (`readFooter`) into row groups, column chunks, and statistics.

import { Cursor, utf8 } from "./bytes.js";

export const TSTOP = 0, TTRUE = 1, TFALSE = 2, TBYTE = 3, TI16 = 4, TI32 = 5, TI64 = 6,
      TDOUBLE = 7, TBINARY = 8, TLIST = 9, TSET = 10, TMAP = 11, TSTRUCT = 12;

/** Reads a thrift-compact struct into a plain object keyed by field id. */
export function thriftStruct(c) {
  const out = {};
  let last = 0;
  for (;;) {
    const head = c.byte();
    const type = head & 0x0f;
    if (type === TSTOP) return out;
    const delta = head >> 4;
    const id = delta ? last + delta : c.zigzag();
    last = id;
    out[id] = thriftValue(c, type);
  }
}
export function thriftValue(c, type) {
  switch (type) {
    case TTRUE: return true;
    case TFALSE: return false;
    case TBYTE: return (c.byte() << 24) >> 24;
    case TI16: case TI32: case TI64: return c.zigzag();
    case TDOUBLE: { const v = c.view.getFloat64(c.p, true); c.p += 8; return v; }
    case TBINARY: return c.bytes(c.uvarint());
    case TLIST: case TSET: {
      const head = c.byte();
      const et = head & 0x0f;
      let n = head >> 4;
      if (n === 15) n = c.uvarint();
      const arr = new Array(n);
      /* compact writes list booleans as one byte each, unlike a struct field
         where the value lives in the type tag */
      const bools = et === TTRUE || et === TFALSE;
      for (let i = 0; i < n; i++) arr[i] = bools ? c.byte() === 1 : thriftValue(c, et);
      return arr;
    }
    case TMAP: {
      const n = c.uvarint();
      if (n === 0) return new Map();
      const kt = c.byte(), vt = kt & 0x0f, ktype = kt >> 4;
      const m = new Map();
      for (let i = 0; i < n; i++) m.set(thriftValue(c, ktype), thriftValue(c, vt));
      return m;
    }
    case TSTRUCT: return thriftStruct(c);
    default: throw new Error("thrift: unknown field type " + type);
  }
}
export const str = (v) => (v == null ? null : utf8.decode(v));

export const PTYPE = ["BOOLEAN", "INT32", "INT64", "INT96", "FLOAT", "DOUBLE", "BYTE_ARRAY", "FIXED_LEN_BYTE_ARRAY"];
export const REP = ["REQUIRED", "OPTIONAL", "REPEATED"];
export const CODEC = ["UNCOMPRESSED", "SNAPPY", "GZIP", "LZO", "BROTLI", "LZ4", "ZSTD", "LZ4_RAW"];
export const ENC = { 0: "PLAIN", 1: "GROUP_VAR_INT", 2: "PLAIN_DICTIONARY", 3: "RLE", 4: "BIT_PACKED",
  5: "DELTA_BINARY_PACKED", 6: "DELTA_LENGTH_BYTE_ARRAY", 7: "DELTA_BYTE_ARRAY", 8: "RLE_DICTIONARY",
  9: "BYTE_STREAM_SPLIT" };
export const PAGE_TYPE = ["DATA_PAGE", "INDEX_PAGE", "DICTIONARY_PAGE", "DATA_PAGE_V2"];
export const CONVERTED = ["UTF8", "MAP", "MAP_KEY_VALUE", "LIST", "ENUM", "DECIMAL", "DATE", "TIME_MILLIS",
  "TIME_MICROS", "TIMESTAMP_MILLIS", "TIMESTAMP_MICROS", "UINT_8", "UINT_16", "UINT_32", "UINT_64",
  "INT_8", "INT_16", "INT_32", "INT_64", "JSON", "BSON", "INTERVAL"];
export const UNIT = { 1: "MILLIS", 2: "MICROS", 3: "NANOS" };
export const LOGICAL = { 1: "STRING", 2: "MAP", 3: "LIST", 4: "ENUM", 5: "DECIMAL", 6: "DATE", 7: "TIME",
  8: "TIMESTAMP", 10: "INTEGER", 11: "NULL", 12: "JSON", 13: "BSON", 14: "UUID", 15: "FLOAT16",
  16: "VARIANT", 17: "GEOMETRY", 18: "GEOGRAPHY" };

/** Decodes SchemaElement.logicalType (a thrift union) into something usable. */
export function logicalType(raw) {
  if (!raw) return null;
  for (const k in raw) {
    const id = +k, name = LOGICAL[id], body = raw[k] || {};
    if (!name) continue;
    const lt = { name };
    if (id === 5) { lt.scale = body[1] || 0; lt.precision = body[2] || 0; }
    if (id === 7 || id === 8) {
      lt.utc = body[1] === true;
      lt.unit = body[2] ? UNIT[+Object.keys(body[2])[0]] : "MILLIS";
    }
    if (id === 10) { lt.bits = body[1] || 64; lt.signed = body[2] !== false; }
    return lt;
  }
  return null;
}

export const annotation = (n) => (n && (n.logical ? n.logical.name : n.converted)) || null;
/**
 * LIST and MAP wrap their values in two extra schema levels (`list.element`,
 * `key_value.value`). Those names are noise in a column header, so they are
 * dropped from the displayed path.
 */
export function synthetic(node) {
  const parent = node.parent;
  if (!parent) return false;
  const up = annotation(parent);
  if (node.rep === "REPEATED" && (up === "LIST" || up === "MAP" || up === "MAP_KEY_VALUE")) return true;
  return parent.rep === "REPEATED" && parent.children.length === 1 && annotation(parent.parent) === "LIST";
}

/** Rebuilds the flat schema list into a tree; returns {root, leaves}. */
export function buildSchema(elements) {
  const nodes = elements.map((e, i) => ({
    index: i,
    name: str(e[4]) || "",
    type: e[1] == null ? null : PTYPE[e[1]],
    typeLength: e[2] == null ? null : e[2],
    rep: e[3] == null ? (i === 0 ? "REQUIRED" : "REQUIRED") : REP[e[3]],
    numChildren: e[5] || 0,
    converted: e[6] == null ? null : CONVERTED[e[6]],
    scale: e[7] == null ? null : e[7],
    precision: e[8] == null ? null : e[8],
    fieldId: e[9] == null ? null : e[9],
    logical: logicalType(e[10]),
    children: [],
    path: [],
    maxDef: 0,
    maxRep: 0,
  }));
  let i = 0;
  const take = (node, path, maxDef, maxRep) => {
    node.path = path;
    node.maxDef = maxDef;
    node.maxRep = maxRep;
    for (let k = 0; k < node.numChildren; k++) {
      const child = nodes[++i];
      if (!child) throw new Error("schema: truncated (missing children)");
      child.parent = node;
      node.children.push(child);
      take(child, path.concat(child.name),
        maxDef + (child.rep === "REQUIRED" ? 0 : 1),
        maxRep + (child.rep === "REPEATED" ? 1 : 0));
    }
  };
  const root = nodes[0];
  if (!root) throw new Error("schema: empty");
  take(root, [], 0, 0);
  const leaves = nodes.filter((n) => n.numChildren === 0 && n !== root);
  for (const leaf of leaves) {
    const chain = [];
    for (let n = leaf; n && n !== root; n = n.parent) chain.unshift(n);
    leaf.chain = chain;
    leaf.label = chain.filter((n) => !synthetic(n)).map((n) => n.name).join(".") || leaf.name;
  }
  /* if stripping the wrappers made two columns look alike, keep the real paths */
  const seen = new Map();
  for (const leaf of leaves) seen.set(leaf.label, (seen.get(leaf.label) || 0) + 1);
  for (const leaf of leaves) if (seen.get(leaf.label) > 1) leaf.label = leaf.path.join(".");
  return { root, nodes, leaves };
}

export const MAGIC = [0x50, 0x41, 0x52, 0x31];          // "PAR1"
export const MAGIC_ENC = [0x50, 0x41, 0x52, 0x45];      // "PARE" (encrypted footer)
export const eq4 = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

export async function readFooter(src) {
  if (src.size < 12) throw new Error("Not a parquet file: only " + src.size + " bytes.");
  const head = await src.read(0, 4);
  const tail = await src.read(src.size - 8, src.size);
  const endMagic = tail.subarray(4, 8);
  const encryptedFooter = eq4(endMagic, MAGIC_ENC);
  if (!eq4(endMagic, MAGIC) && !encryptedFooter) {
    throw new Error('Not a parquet file: the last 4 bytes are not "PAR1" (found "' +
      [...endMagic].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("") + '").');
  }
  if (!eq4(head, MAGIC) && !eq4(head, MAGIC_ENC)) throw new Error('Not a parquet file: missing "PAR1" header.');
  if (encryptedFooter) {
    throw new Error("This file has an encrypted footer (PARE).\n" +
      "paris-parquet cannot decrypt it — no keys, no crypto material, nothing to ask.");
  }
  const len = new DataView(tail.buffer, tail.byteOffset, 4).getUint32(0, true);
  const start = src.size - 8 - len;
  if (start < 4) throw new Error("Corrupt footer: metadata length " + len + " does not fit the file.");
  const buf = await src.read(start, src.size - 8);
  const meta = thriftStruct(new Cursor(buf, 0));
  return parseFileMetadata(meta, len);
}

export function parseFileMetadata(m, footerLen) {
  const schema = buildSchema(m[2] || []);
  const enc = m[8] ? { algorithm: m[8][1] ? "AES_GCM_V1" : m[8][2] ? "AES_GCM_CTR_V1" : "UNKNOWN" } : null;
  return {
    version: m[1] ?? null,
    schema,
    numRows: m[3] ?? 0,
    rowGroups: (m[4] || []).map(parseRowGroup),
    keyValue: (m[5] || []).map((kv) => ({ key: str(kv[1]), value: str(kv[2]) })),
    createdBy: str(m[6]),
    columnOrders: m[7] || null,
    encryption: enc,
    footerSigned: !!m[9],
    footerLength: footerLen,
  };
}
export function parseRowGroup(g) {
  return {
    columns: (g[1] || []).map(parseColumnChunk),
    totalByteSize: g[2] ?? 0,
    numRows: g[3] ?? 0,
    fileOffset: g[5] ?? null,
    totalCompressedSize: g[6] ?? null,
    ordinal: g[7] ?? null,
  };
}
export function parseColumnChunk(c) {
  const md = c[3];
  return {
    filePath: str(c[1]),
    fileOffset: c[2] ?? 0,
    columnIndexOffset: c[6] ?? null,
    columnIndexLength: c[7] ?? null,
    offsetIndexOffset: c[4] ?? null,
    offsetIndexLength: c[5] ?? null,
    cryptoMetadata: !!c[8],
    encryptedMetadata: !!c[9],
    meta: md ? {
      type: PTYPE[md[1]],
      encodings: (md[2] || []).map((e) => ENC[e] || "ENC_" + e),
      path: (md[3] || []).map(str),
      codec: CODEC[md[4]] ?? "CODEC_" + md[4],
      numValues: md[5] ?? 0,
      totalUncompressedSize: md[6] ?? 0,
      totalCompressedSize: md[7] ?? 0,
      dataPageOffset: md[9] ?? 0,
      indexPageOffset: md[10] ?? null,
      dictionaryPageOffset: md[11] ?? null,
      statistics: md[12] ? parseStatistics(md[12]) : null,
      encodingStats: (md[13] || []).map((s) => ({
        pageType: PAGE_TYPE[s[1]] || "?", encoding: ENC[s[2]] || "?", count: s[3] || 0 })),
      bloomFilterOffset: md[14] ?? null,
      bloomFilterLength: md[15] ?? null,
    } : null,
  };
}
export function parseStatistics(s) {
  return {
    max: s[1] ?? null, min: s[2] ?? null,
    nullCount: s[3] ?? null, distinctCount: s[4] ?? null,
    maxValue: s[5] ?? null, minValue: s[6] ?? null,
    /* set false when a writer truncated the blob: it then bounds the value */
    maxExact: s[7] ?? null, minExact: s[8] ?? null,
  };
}
