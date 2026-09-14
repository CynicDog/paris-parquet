
export function snappyDecompress(src, expected) {
  let p = 0, shift = 0, len = 0, b;
  do { b = src[p++]; len += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
  const out = new Uint8Array(expected != null ? expected : len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    switch (tag & 3) {
      case 0: {                                   // literal
        let n = tag >> 2;
        if (n >= 60) {
          const extra = n - 59;
          n = 0;
          for (let i = 0; i < extra; i++) n |= src[p + i] << (8 * i);
          p += extra;
        }
        n = n + 1;
        out.set(src.subarray(p, p + n), o);
        p += n; o += n;
        break;
      }
      case 1: {                                   // copy, 1-byte offset
        const n = 4 + ((tag >> 2) & 7);
        const off = ((tag >> 5) << 8) | src[p++];
        o = snappyCopy(out, o, off, n);
        break;
      }
      case 2: {                                   // copy, 2-byte offset
        const n = (tag >> 2) + 1;
        const off = src[p] | (src[p + 1] << 8); p += 2;
        o = snappyCopy(out, o, off, n);
        break;
      }
      default: {                                  // copy, 4-byte offset
        const n = (tag >> 2) + 1;
        const off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4;
        o = snappyCopy(out, o, off, n);
      }
    }
  }
  return out;
}
export function snappyCopy(out, o, off, n) {
  if (off <= 0 || off > o) throw new Error("snappy: bad copy offset " + off);
  let s = o - off;
  for (let i = 0; i < n; i++) out[o++] = out[s++];
  return o;
}

/* ----------------------------------------------------------- lz4 block */
export function lz4BlockDecompress(src, expected) {
  const out = new Uint8Array(expected);
  let p = 0, o = 0;
  while (p < src.length) {
    const token = src[p++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[p++]; lit += b; } while (b === 255); }
    for (let i = 0; i < lit; i++) out[o++] = src[p++];
    if (p >= src.length) break;
    const off = src[p] | (src[p + 1] << 8); p += 2;
    let n = (token & 15) + 4;
    if ((token & 15) === 15) { let b; do { b = src[p++]; n += b; } while (b === 255); }
    if (off <= 0 || off > o) throw new Error("lz4: bad match offset " + off);
    let s = o - off;
    for (let i = 0; i < n; i++) out[o++] = out[s++];
  }
  return out;
}
/** Hadoop-framed LZ4 (codec LZ4): repeated [u32 be rawLen][u32 be compLen][block]. */
export function lz4HadoopDecompress(src, expected) {
  try {
    const out = new Uint8Array(expected);
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    let p = 0, o = 0;
    while (p + 8 <= src.length && o < expected) {
      const raw = dv.getUint32(p, false), comp = dv.getUint32(p + 4, false);
      p += 8;
      if (comp > src.length - p || raw > expected - o) throw new Error("frame");
      out.set(lz4BlockDecompress(src.subarray(p, p + comp), raw), o);
      p += comp; o += raw;
    }
    if (o === expected) return out;
    throw new Error("frame");
  } catch (e) {
    return lz4BlockDecompress(src, expected);   // some writers emit a bare block
  }
}

/* ----------------------------------------------- gzip (browser builtin) */
export async function inflate(src, format) {
  const ds = new DecompressionStream(format);
  const stream = new Blob([src]).stream().pipeThrough(ds);
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
export async function gzipDecompress(src) {
  try { return await inflate(src, "gzip"); }
  catch (e) { try { return await inflate(src, "deflate"); } catch (e2) { return await inflate(src, "deflate-raw"); } }
}

export const POW2 = new Float64Array(64);
for (let i = 0; i < 64; i++) POW2[i] = Math.pow(2, i);
export const highbit = (x) => 31 - Math.clz32(x);

/** Backwards, MSB-first bit reader. zstd streams end with a marker bit. */
export class BackBits {
  constructor(b, start, end) {
    let p = end - 1;
    while (p >= start && b[p] === 0) p--;
    if (p < start) throw new Error("zstd: empty bitstream");
    const hb = highbit(b[p]);
    this.b = b; this.start = start;
    this.acc = b[p] & ((1 << hb) - 1);
    this.nbits = hb;
    this.pos = p - 1;
    this.used = 0;
    this.total = (p - start) * 8 + hb;
  }
  fill() {
    while (this.nbits <= 45) {
      const byte = this.pos >= this.start ? this.b[this.pos] : 0;
      this.pos--;
      this.acc = this.acc * 256 + byte;
      this.nbits += 8;
    }
  }
  peek(n) { if (n === 0) return 0; if (this.nbits < n) this.fill(); return Math.floor(this.acc / POW2[this.nbits - n]); }
  skip(n) {
    if (n === 0) return;
    if (this.nbits < n) this.fill();
    const v = Math.floor(this.acc / POW2[this.nbits - n]);
    this.nbits -= n;
    this.acc -= v * POW2[this.nbits];
    this.used += n;
  }
  bits(n) { const v = this.peek(n); this.skip(n); return v; }
  get over() { return this.used > this.total; }
}

/** Reads an FSE table description (normalized counts). */
export function fseReadNCount(b, off, end, maxSV, maxLog) {
  const pad = new Uint8Array(end - off + 8);
  pad.set(b.subarray(off, end));
  const rd32 = (p) => ((pad[p] | (pad[p + 1] << 8) | (pad[p + 2] << 16) | (pad[p + 3] << 24)) >>> 0);
  let bitPos = 0;
  const peek = (n) => (rd32(bitPos >> 3) >>> (bitPos & 7)) & ((1 << n) - 1);
  const accLog = peek(4) + 5;
  bitPos += 4;
  if (accLog > maxLog) throw new Error("zstd: FSE accuracy log " + accLog + " > " + maxLog);
  const norm = new Int16Array(maxSV + 1);
  let remaining = (1 << accLog) + 1, threshold = 1 << accLog, nbBits = accLog + 1;
  let charnum = 0, previous0 = false;
  for (;;) {
    if (previous0) {
      let rep = peek(2); bitPos += 2;
      while (rep === 3) { charnum += 3; rep = peek(2); bitPos += 2; }
      charnum += rep;
      if (charnum > maxSV) break;
    }
    const max = (2 * threshold - 1) - remaining;
    const bs = peek(Math.min(nbBits, 24));
    let count;
    if ((bs & (threshold - 1)) < max) { count = bs & (threshold - 1); bitPos += nbBits - 1; }
    else {
      count = bs & (2 * threshold - 1);
      if (count >= threshold) count -= max;
      bitPos += nbBits;
    }
    count--;
    remaining -= count < 0 ? 1 : count;
    norm[charnum++] = count;
    previous0 = count === 0;
    if (remaining < threshold) {
      if (remaining <= 1) break;
      nbBits = highbit(remaining) + 1;
      threshold = 1 << (nbBits - 1);
    }
    if (charnum > maxSV) break;
  }
  if (remaining !== 1) throw new Error("zstd: corrupt FSE table description");
  return { norm, maxSymbol: charnum - 1, accLog, used: (bitPos + 7) >> 3 };
}

/** Builds an FSE decoding table from normalized counts. */
export function fseBuildTable(norm, maxSymbol, accLog) {
  const size = 1 << accLog, mask = size - 1;
  const tableSymbol = new Uint8Array(size);
  const next = new Int32Array(maxSymbol + 1);
  let high = size - 1;
  for (let s = 0; s <= maxSymbol; s++) {
    if (norm[s] === -1) { tableSymbol[high--] = s; next[s] = 1; }
    else next[s] = norm[s];
  }
  const step = (size >> 1) + (size >> 3) + 3;
  let pos = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    for (let i = 0, n = norm[s]; i < n; i++) {
      tableSymbol[pos] = s;
      do { pos = (pos + step) & mask; } while (pos > high);
    }
  }
  const symbols = new Uint8Array(size), nbBits = new Uint8Array(size), newState = new Uint16Array(size);
  for (let u = 0; u < size; u++) {
    const s = tableSymbol[u];
    const ns = next[s]++;
    const nb = accLog - highbit(ns);
    symbols[u] = s; nbBits[u] = nb; newState[u] = (ns << nb) - size;
  }
  return { symbols, nbBits, newState, accLog };
}
export function fseRleTable(symbol) {
  return { symbols: Uint8Array.of(symbol), nbBits: Uint8Array.of(0), newState: Uint16Array.of(0), accLog: 0 };
}

/** FSE-decompresses the huffman weight stream (two interleaved states). */
export function fseDecompressWeights(b, off, size) {
  const hdr = fseReadNCount(b, off, off + size, 255, 6);
  const dt = fseBuildTable(hdr.norm, hdr.maxSymbol, hdr.accLog);
  const br = new BackBits(b, off + hdr.used, off + size);
  let s1 = br.bits(dt.accLog), s2 = br.bits(dt.accLog);
  const out = [];
  for (;;) {
    out.push(dt.symbols[s1]);
    s1 = dt.newState[s1] + br.bits(dt.nbBits[s1]);
    if (br.over) { out.push(dt.symbols[s2]); break; }
    out.push(dt.symbols[s2]);
    s2 = dt.newState[s2] + br.bits(dt.nbBits[s2]);
    if (br.over) { out.push(dt.symbols[s1]); break; }
    if (out.length > 255) throw new Error("zstd: too many huffman weights");
  }
  return out;
}

/** Reads a huffman table description, returns {symbol[], nbBits[], maxBits, used}. */
export function hufReadTable(b, off) {
  const iSize = b[off];
  let weights, used;
  if (iSize >= 128) {
    const n = iSize - 127;
    weights = new Array(n);
    for (let i = 0; i < n; i += 2) {
      weights[i] = b[off + 1 + (i >> 1)] >> 4;
      if (i + 1 < n) weights[i + 1] = b[off + 1 + (i >> 1)] & 15;
    }
    used = 1 + ((n + 1) >> 1);
  } else {
    weights = fseDecompressWeights(b, off + 1, iSize);
    used = 1 + iSize;
  }
  let total = 0;
  for (const w of weights) { if (w > 12) throw new Error("zstd: bad huffman weight"); total += (1 << w) >> 1; }
  if (total === 0) throw new Error("zstd: empty huffman table");
  const maxBits = highbit(total) + 1;
  const rest = (1 << maxBits) - total;
  if (rest !== (1 << highbit(rest))) throw new Error("zstd: corrupt huffman weights");
  weights.push(highbit(rest) + 1);

  const size = 1 << maxBits;
  const symbol = new Uint8Array(size), nbBits = new Uint8Array(size);
  const rankCount = new Int32Array(maxBits + 2);
  for (const w of weights) if (w > 0) rankCount[maxBits + 1 - w]++;
  const rankIdx = new Int32Array(maxBits + 2);
  rankIdx[maxBits] = 0;
  for (let i = maxBits; i >= 1; i--) rankIdx[i - 1] = rankIdx[i] + rankCount[i] * (1 << (maxBits - i));
  for (let s = 0; s < weights.length; s++) {
    const w = weights[s];
    if (!w) continue;
    const bits = maxBits + 1 - w;
    const len = 1 << (maxBits - bits);
    const at = rankIdx[bits];
    symbol.fill(s, at, at + len);
    nbBits.fill(bits, at, at + len);
    rankIdx[bits] += len;
  }
  return { symbol, nbBits, maxBits, used };
}

export function hufDecodeStream(table, b, start, end, out, o, count) {
  const br = new BackBits(b, start, end);
  const { symbol, nbBits, maxBits } = table;
  for (let i = 0; i < count; i++) {
    const s = br.peek(maxBits);
    out[o++] = symbol[s];
    br.skip(nbBits[s]);
  }
  return o;
}

/* predefined sequence tables (from the zstd spec) */
export const LL_BITS = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,2,2,3,3,4,6,7,8,9,10,11,12,13,14,15,16];
export const LL_BASE = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,20,22,24,28,32,40,48,64,128,256,512,
  1024,2048,4096,8192,16384,32768,65536];
export const LL_DEFAULT = [4,3,2,2,2,2,2,2,2,2,2,2,2,1,1,1,2,2,2,2,2,2,2,2,2,3,2,1,1,1,1,1,-1,-1,-1,-1];
export const ML_BITS = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,2,2,3,3,4,4,5,7,8,9,10,11,12,13,14,15,16];
export const ML_BASE = [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
  33,34,35,37,39,41,43,47,51,59,67,83,99,131,259,515,1027,2051,4099,8195,16387,32771,65539];
export const ML_DEFAULT = [1,4,3,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,-1,-1,-1,-1,-1,-1,-1];
export const OF_DEFAULT = [1,1,1,1,1,1,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,-1,-1,-1,-1,-1];
export const OF_BASE = [0, 1];
for (let c = 2; c <= 31; c++) OF_BASE[c] = Math.pow(2, c) - 3;

export let LL_PRE = null, ML_PRE = null, OF_PRE = null;
export function predefined() {
  if (!LL_PRE) {
    LL_PRE = fseBuildTable(LL_DEFAULT, 35, 6);
    ML_PRE = fseBuildTable(ML_DEFAULT, 52, 6);
    OF_PRE = fseBuildTable(OF_DEFAULT, 28, 5);
  }
}

/** Decompresses a zstd frame stream. Returns a Uint8Array. */
export function zstdDecompress(src, expected) {
  predefined();
  let out = new Uint8Array(expected > 0 ? expected : Math.max(1024, src.length * 4));
  let o = 0;
  const grow = (need) => {
    if (o + need <= out.length) return;
    let cap = out.length || 1024;
    while (cap < o + need) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, o));
    out = bigger;
  };
  let p = 0;
  while (p < src.length) {
    const magic = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {            // skippable frame
      const len = (src[p + 4] | (src[p + 5] << 8) | (src[p + 6] << 16) | (src[p + 7] << 24)) >>> 0;
      p += 8 + len;
      continue;
    }
    if (magic !== 0xfd2fb528) {
      if (p === 0) throw new Error("zstd: bad magic 0x" + magic.toString(16));
      break;                                                    // trailing junk
    }
    p = zstdFrame(src, p + 4, grow, () => out, (n) => { o = n; }, () => o);
  }
  return out.subarray(0, o);
}

export function zstdFrame(src, p, grow, getOut, setO, getO) {
  const fhd = src[p++];
  const fcsFlag = fhd >> 6, singleSegment = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  if ((fhd >> 3) & 1) throw new Error("zstd: reserved frame header bit set");
  if (!singleSegment) p++;                                       // window descriptor
  p += [0, 1, 2, 4][dictFlag];                                   // dictionary id
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  p += fcsSize;
  if (dictFlag) throw new Error("zstd: dictionary-compressed frames are not supported");

  let huf = null;                                                // shared across blocks
  let prevLL = null, prevML = null, prevOF = null;
  const reps = [1, 4, 8];
  let literals = new Uint8Array(0);

  for (;;) {
    const h = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16);
    p += 3;
    const last = h & 1, type = (h >> 1) & 3, size = h >> 3;
    if (type === 0) {                                            // raw
      grow(size);
      const out = getOut(); let o = getO();
      out.set(src.subarray(p, p + size), o);
      setO(o + size); p += size;
    } else if (type === 1) {                                     // rle
      grow(size);
      const out = getOut(); let o = getO();
      out.fill(src[p], o, o + size);
      setO(o + size); p += 1;
    } else if (type === 2) {
      const blockEnd = p + size;
      const lh = src[p];
      const ltype = lh & 3, lfmt = (lh >> 2) & 3;
      let regen = 0, comp = 0, streams = 1, lp = p;
      if (ltype === 0 || ltype === 1) {
        if (lfmt === 1) { regen = ((src[lp] | (src[lp + 1] << 8)) >>> 4) & 0xfff; lp += 2; }
        else if (lfmt === 3) { regen = ((src[lp] | (src[lp + 1] << 8) | (src[lp + 2] << 16)) >>> 4) & 0xfffff; lp += 3; }
        else { regen = lh >> 3; lp += 1; }
        literals = new Uint8Array(regen);
        if (ltype === 0) { literals.set(src.subarray(lp, lp + regen)); lp += regen; }
        else { literals.fill(src[lp]); lp += 1; }
      } else {
        const w = (src[lp] | (src[lp + 1] << 8) | (src[lp + 2] << 16) | (src[lp + 3] << 24) | 0) >>> 0;
        const w5 = src[lp + 4];
        if (lfmt === 0 || lfmt === 1) {
          regen = (w >>> 4) & 0x3ff; comp = (w >>> 14) & 0x3ff; lp += 3;
          streams = lfmt === 0 ? 1 : 4;
        } else if (lfmt === 2) {
          regen = (w >>> 4) & 0x3fff; comp = (w >>> 18) & 0x3fff; lp += 4;
          streams = 4;
        } else {
          regen = (w >>> 4) & 0x3ffff;
          comp = ((w >>> 22) & 0x3ff) + (w5 * 1024); lp += 5;
          streams = 4;
        }
        const sectionEnd = lp + comp;
        if (ltype === 2) {
          huf = hufReadTable(src, lp);
          lp += huf.used;
        } else if (!huf) throw new Error("zstd: treeless literals without a huffman table");
        literals = new Uint8Array(regen);
        if (streams === 1) {
          hufDecodeStream(huf, src, lp, sectionEnd, literals, 0, regen);
        } else {
          const s1 = src[lp] | (src[lp + 1] << 8);
          const s2 = src[lp + 2] | (src[lp + 3] << 8);
          const s3 = src[lp + 4] | (src[lp + 5] << 8);
          let q = lp + 6;
          const seg = (regen + 3) >> 2;
          const sizes = [s1, s2, s3, sectionEnd - (q + s1 + s2 + s3)];
          let outPos = 0;
          for (let i = 0; i < 4; i++) {
            const n = i === 3 ? regen - 3 * seg : seg;
            outPos = hufDecodeStream(huf, src, q, q + sizes[i], literals, outPos, n);
            q += sizes[i];
          }
        }
        lp = sectionEnd;
      }

      let nbSeq = 0;
      if (lp < blockEnd) {
        const b0 = src[lp++];
        if (b0 < 128) nbSeq = b0;
        else if (b0 < 255) { nbSeq = ((b0 - 128) << 8) + src[lp++]; }
        else { nbSeq = (src[lp] | (src[lp + 1] << 8)) + 0x7f00; lp += 2; }
      }
      let litPos = 0;
      if (nbSeq === 0) {
        grow(literals.length);
        const out = getOut(); const o = getO();
        out.set(literals, o); setO(o + literals.length);
        p = blockEnd;
        if (last) break; else continue;
      }
      const modes = src[lp++];
      const pick = (mode, pre, prev, maxSV, maxLog) => {
        if (mode === 0) return { t: pre, keep: pre };
        if (mode === 1) { const t = fseRleTable(src[lp++]); return { t, keep: t }; }
        if (mode === 2) {
          const hdr = fseReadNCount(src, lp, blockEnd, maxSV, maxLog);
          lp += hdr.used;
          const t = fseBuildTable(hdr.norm, hdr.maxSymbol, hdr.accLog);
          return { t, keep: t };
        }
        if (!prev) throw new Error("zstd: repeat mode without a previous table");
        return { t: prev, keep: prev };
      };
      const a = pick(modes >> 6, LL_PRE, prevLL, 35, 9); prevLL = a.keep;
      const b = pick((modes >> 4) & 3, OF_PRE, prevOF, 31, 8); prevOF = b.keep;
      const c = pick((modes >> 2) & 3, ML_PRE, prevML, 52, 9); prevML = c.keep;
      const LL = a.t, OF = b.t, ML = c.t;

      const br = new BackBits(src, lp, blockEnd);
      let llState = br.bits(LL.accLog), ofState = br.bits(OF.accLog), mlState = br.bits(ML.accLog);

      for (let n = 0; n < nbSeq; n++) {
        const llCode = LL.symbols[llState], mlCode = ML.symbols[mlState], ofCode = OF.symbols[ofState];
        const ofBits = ofCode;
        let matchLength = ML_BASE[mlCode], litLength = LL_BASE[llCode];
        let offset;
        if (ofBits > 1) {
          offset = OF_BASE[ofCode] + br.bits(ofBits);
          reps[2] = reps[1]; reps[1] = reps[0]; reps[0] = offset;
        } else {
          const ll0 = litLength === 0 ? 1 : 0;
          if (ofBits === 0) {
            offset = reps[ll0];
            reps[1] = reps[ll0 ? 0 : 1];
            reps[0] = offset;
          } else {
            const sel = 1 + ll0 + br.bits(1);
            const temp = sel === 3 ? reps[0] - 1 : reps[sel];
            if (sel !== 1) reps[2] = reps[1];
            reps[1] = reps[0];
            reps[0] = offset = temp;
          }
        }
        matchLength += br.bits(ML_BITS[mlCode]);
        litLength += br.bits(LL_BITS[llCode]);
        if (n < nbSeq - 1) {
          llState = LL.newState[llState] + br.bits(LL.nbBits[llState]);
          mlState = ML.newState[mlState] + br.bits(ML.nbBits[mlState]);
          ofState = OF.newState[ofState] + br.bits(OF.nbBits[ofState]);
        }
        grow(litLength + matchLength);
        const out = getOut(); let o = getO();
        for (let i = 0; i < litLength; i++) out[o++] = literals[litPos++];
        if (offset <= 0 || offset > o) throw new Error("zstd: bad match offset " + offset);
        let s = o - offset;
        for (let i = 0; i < matchLength; i++) out[o++] = out[s++];
        setO(o);
      }
      const rest = literals.length - litPos;
      if (rest > 0) {
        grow(rest);
        const out = getOut(); const o = getO();
        out.set(literals.subarray(litPos), o);
        setO(o + rest);
      }
      p = blockEnd;
    } else {
      throw new Error("zstd: reserved block type");
    }
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

/* ------------------------------------------------------- codec dispatch */
export async function decompress(codec, src, uncompressedSize) {
  switch (codec) {
    case "UNCOMPRESSED": return src;
    case "SNAPPY": return snappyDecompress(src, uncompressedSize);
    case "GZIP": return await gzipDecompress(src);
    case "ZSTD": return zstdDecompress(src, uncompressedSize);
    case "LZ4_RAW": return lz4BlockDecompress(src, uncompressedSize);
    case "LZ4": return lz4HadoopDecompress(src, uncompressedSize);
    case "BROTLI":
      try { return await inflate(src, "brotli"); }
      catch (e) { throw new Error("BROTLI pages need a brotli decoder this browser does not expose."); }
    default:
      throw new Error("Unsupported compression codec: " + codec + ".");
  }
}

export const bitWidth = (max) => (max === 0 ? 0 : 32 - Math.clz32(max));
export const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/** RLE / bit-packing hybrid (parquet's level + dictionary-index encoding). */
