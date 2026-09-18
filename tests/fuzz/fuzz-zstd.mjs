/**
 * Cross-checks the zstd decoder in index.html against Node's zstd encoder.
 *
 *   node tests/fuzz/fuzz-zstd.mjs [iterations]
 *
 * Varies size, entropy and compression level so that raw blocks, RLE blocks,
 * huffman and treeless literals, repeated FSE tables and long match offsets
 * all get exercised.
 */

import path from "node:path";
import zlib from "node:zlib";
import { loadApp } from "../integration/check.mjs";

const PARIS = loadApp(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "index.html"));

let seed = 0x2f6fdd;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
}

const shapes = {
  zeros: (n) => Buffer.alloc(n),
  constant: (n) => Buffer.alloc(n, 0x41),
  random: (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (rnd() * 256) | 0; return b; },
  text: (n) => {
    const words = ["parquet", "row", "group", "zstd", "column", "page", "dictionary", "null", "a", "the"];
    let s = "";
    while (s.length < n) s += words[(rnd() * words.length) | 0] + (rnd() < 0.2 ? "\n" : " ");
    return Buffer.from(s.slice(0, n));
  },
  repeated: (n) => {
    const unit = Buffer.from("the quick brown fox jumps over the lazy dog 0123456789");
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i += unit.length) unit.copy(b, i, 0, Math.min(unit.length, n - i));
    return b;
  },
  skewed: (n) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = rnd() < 0.7 ? 0x20 : (rnd() * 12) | 0;
    return b;
  },
  numbers: (n) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i + 8 <= n; i += 8) b.writeDoubleLE(Math.floor(rnd() * 1e6) / 100, i);
    return b;
  },
};

const sizes = [0, 1, 2, 7, 63, 64, 255, 1024, 5000, 65535, 131072, 400000, 1500000];
const levels = [1, 2, 3, 5, 9, 12, 17, 19, 22];
const names = Object.keys(shapes);

const iterations = +(process.argv[2] || 400);
let fail = 0, bytes = 0;
for (let it = 0; it < iterations; it++) {
  const shape = names[it % names.length];
  const size = sizes[(rnd() * sizes.length) | 0];
  const level = levels[(rnd() * levels.length) | 0];
  const checksum = rnd() < 0.3;
  const input = shapes[shape](size);
  const packed = zlib.zstdCompressSync(input, {
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: level,
      [zlib.constants.ZSTD_c_checksumFlag]: checksum ? 1 : 0,
    },
  });
  let out;
  try {
    out = PARIS.zstdDecompress(new Uint8Array(packed), input.length);
  } catch (e) {
    console.log(`FAIL ${shape} size=${size} level=${level} checksum=${checksum}: ${e.message}`);
    fail++;
    continue;
  }
  if (Buffer.compare(Buffer.from(out), input) !== 0) {
    let at = 0;
    while (at < input.length && out[at] === input[at]) at++;
    console.log(`FAIL ${shape} size=${size} level=${level} checksum=${checksum}: ` +
      `differs at byte ${at} (got ${out[at]}, want ${input[at]}), lengths ${out.length}/${input.length}`);
    fail++;
    continue;
  }
  bytes += input.length;
}
console.log(fail
  ? `\n${fail}/${iterations} zstd round-trips failed`
  : `\nall ${iterations} zstd round-trips match (${(bytes / 1048576).toFixed(1)} MB)`);
process.exit(fail ? 1 : 0);
