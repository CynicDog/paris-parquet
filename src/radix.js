// Exact percentiles without sorting a copy of the column.
//
// A percentile is a selection problem, not a sorting one, and selection can be done out of memory by
// counting: map every value to an unsigned 64-bit key whose order is the numeric order, count how many
// values fall in each of the 65,536 buckets of its top 16 bits (256 KB, however many values there
// are), and read off which bucket each wanted rank lands in. If that bucket is small, one more pass
// over the data collects just its values and the rank is picked from them; if it is large, the pass
// counts the next 16 bits within it instead. Typically two passes, at most four, and the answer is
// exactly the one a full sort would give. docs/bounded-memory-statistics.md has the theory and the
// measurements from a prototype.
//
// One value's state is a `Radix`; the caller (query.js) owns the passes over the data:
//
//   const r = newRadix();  radixAdd(r, x) ...          the pass that counts
//   planRadix(r, [0.99]);                              which buckets the wanted ranks fall in
//   while (radixOpen(r)) { radixVisit(r, x) ...; radixAdvance(r); }    the passes that narrow it
//   radixQuantile(r, 0.99)
//
// The key is built from the double's bits through a typed-array view, which assumes a little-endian
// machine: every browser this runs in is.

/**
 * Tunables, exported so a test can force the multi-pass paths on a few dozen values. `promote` is how many
 * values a group keeps before it counts them instead: a histogram costs 256 KB and a kept value 16 bytes,
 * so counting is only the cheaper of the two beyond about 16,000 values.
 */
export const RADIX = { promote: 16384, gather: 1 << 20 };
/** What a counting histogram costs, in bytes. */
export const RADIX_BYTES = 65536 * 4;

const F = new Float64Array(1);
const U = new Uint32Array(F.buffer);
const D = [0, 0, 0, 0];

/** The four 16-bit digits of a double's order-preserving key: comparing digit by digit is comparing the numbers. */
export function digitsOf(x, out) {
  F[0] = x;
  let hi = U[1], lo = U[0];
  if (hi >>> 31) { hi = ~hi >>> 0; lo = ~lo >>> 0; } else hi = (hi ^ 0x80000000) >>> 0;
  out[0] = hi >>> 16; out[1] = hi & 0xffff; out[2] = lo >>> 16; out[3] = lo & 0xffff;
  return out;
}
/** The double a full set of digits stands for. */
export function valueOfDigits(d) {
  let hi = ((d[0] << 16) | d[1]) >>> 0, lo = ((d[2] << 16) | d[3]) >>> 0;
  if (hi >>> 31) hi = (hi ^ 0x80000000) >>> 0; else { hi = ~hi >>> 0; lo = ~lo >>> 0; }
  U[1] = hi; U[0] = lo;
  return F[0];
}

export function newRadix() {
  return { h: new Uint32Array(65536), n: 0, targets: null, rv: null };
}
/** Counts one value (the first pass). NaN must not be added: it has no place in the order. */
export function radixAdd(r, x) {
  F[0] = x;
  const hi = U[1];
  r.h[(hi >>> 31 ? ~hi >>> 0 : (hi ^ 0x80000000) >>> 0) >>> 16]++;
  r.n++;
}

/** The bucket, among `counts`, that holds rank `t.rel`; leaves the target one digit more resolved. */
function resolve(t, counts) {
  let cum = 0, b = 0;
  for (; b < 65536; b++) {
    if (cum + counts[b] > t.rel) break;
    cum += counts[b];
  }
  t.rel -= cum;
  t.digits.push(b);
  t.count = counts[b];
  if (t.digits.length === 4) { t.value = valueOfDigits(t.digits); t.done = true; }
}
/** Sets up how the next pass will treat this target: gather its bucket if it is small, count its next digits if not. */
function prepare(t) {
  if (t.done) return;
  if (t.count <= RADIX.gather) { t.gather = new Float64Array(t.count); t.fill = 0; t.counts = null; }
  else { t.counts = new Uint32Array(65536); t.gather = null; }
}

/** After the counting pass: the ranks the wanted quantiles need (the value at a rank and the next one, to interpolate), and where they fall. */
export function planRadix(r, quantiles) {
  const ranks = new Set();
  for (const p of quantiles) {
    const h = (r.n - 1) * p, lo = Math.floor(h);
    ranks.add(lo);
    if (h - lo) ranks.add(lo + 1);
  }
  r.targets = [...ranks].sort((a, b) => a - b).map((rank) => ({ rank, rel: rank, digits: [], count: 0, counts: null, gather: null, fill: 0, done: false, value: 0 }));
  for (const t of r.targets) { resolve(t, r.h); prepare(t); }
  if (!radixOpen(r)) finish(r);
}
export function radixOpen(r) {
  return !!r.targets && r.targets.some((t) => !t.done);
}
/** One value during a narrowing pass: it counts toward, or is gathered by, whichever targets its digits still match. */
export function radixVisit(r, x) {
  digitsOf(x, D);
  for (const t of r.targets) {
    if (t.done) continue;
    const L = t.digits.length;
    let same = true;
    for (let j = 0; j < L; j++) if (D[j] !== t.digits[j]) { same = false; break; }
    if (!same) continue;
    if (t.gather) t.gather[t.fill++] = x; else t.counts[D[L]]++;
  }
}
/** After a narrowing pass over all the data: settle what it collected. */
export function radixAdvance(r) {
  for (const t of r.targets) {
    if (t.done) continue;
    if (t.gather) { t.gather.sort(); t.value = t.gather[t.rel]; t.done = true; t.gather = null; }
    else { resolve(t, t.counts); t.counts = null; prepare(t); }
  }
  if (!radixOpen(r)) finish(r);
}
function finish(r) {
  r.rv = new Map(r.targets.map((t) => [t.rank, t.value]));
  r.targets = null;
  r.h = null;
}
/** The exact quantile, linearly interpolated between neighbouring values the way QUANTILE_CONT does it. */
export function radixQuantile(r, p) {
  if (!r.n || !r.rv) return null;
  const h = (r.n - 1) * p, lo = Math.floor(h), d = h - lo;
  const a = r.rv.get(lo);
  return d ? a + (r.rv.get(lo + 1) - a) * d : a;
}
/** What the passes still to come will hold, in bytes: buckets to gather and digit counters. */
export function radixPending(r) {
  let bytes = 0;
  if (r.targets) for (const t of r.targets) if (!t.done) bytes += t.gather ? t.gather.byteLength : RADIX_BYTES;
  return bytes;
}
