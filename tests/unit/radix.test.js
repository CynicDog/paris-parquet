import assert from "node:assert/strict";
import { test } from "node:test";
import { digitsOf, newRadix, planRadix, RADIX, radixAdd, radixAdvance, radixOpen, radixQuantile, radixVisit, valueOfDigits } from "../../src/radix.js";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const PS = [0, 0.01, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1];

/** What a full sort gives: QUANTILE_CONT's linear interpolation. */
function reference(values, ps) {
  const v = Float64Array.from(values.filter((x) => x === x)).sort();
  return ps.map((p) => {
    const h = (v.length - 1) * p, lo = Math.floor(h), d = h - lo;
    return d ? v[lo] + (v[lo + 1] - v[lo]) * d : v[lo];
  });
}
/** The counting pass, then narrowing passes over the same values in a different order each time. */
function select(values, ps, gather = RADIX.gather) {
  const saved = RADIX.gather;
  RADIX.gather = gather;
  try {
    const r = newRadix();
    for (const x of values) if (x === x) radixAdd(r, x);
    planRadix(r, ps);
    let passes = 1;
    const rnd = rng(9);
    while (radixOpen(r)) {
      passes++;
      const order = values.map((_x, i) => i).sort(() => rnd() - 0.5);       /* the visiting order must not matter */
      for (const i of order) if (values[i] === values[i]) radixVisit(r, values[i]);
      radixAdvance(r);
    }
    return { got: ps.map((p) => radixQuantile(r, p)), passes };
  } finally { RADIX.gather = saved; }
}

const dist = {
  uniform: (r) => r(),
  normal: (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()),
  lognormal: (r) => Math.exp(2 * Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r())),
  integers: (r) => Math.floor(r() * 1000),
  mixedSigns: (r) => (r() - 0.5) * 1e6,
  clustered: (r) => 1000 + r() * 1e-4,
  constant: () => 42.5,
};

test("the key's order is the numeric order, across every kind of float", () => {
  const specials = [-Infinity, -1e308, -1e10, -1, -1e-10, -5e-324, -0, 0, 5e-324, 1e-10, 1, 1e10, 1e308, Infinity, 2 ** 52, -(2 ** 52), 0.1, -0.1];
  const cmp = (a, b) => { const x = digitsOf(a, [0, 0, 0, 0]).slice(), y = digitsOf(b, [0, 0, 0, 0]).slice(); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  for (const a of specials) for (const b of specials) {
    if (a < b) assert.ok(cmp(a, b) < 0, `${a} < ${b}`);
    if (a > b) assert.ok(cmp(a, b) > 0, `${a} > ${b}`);
  }
  const r = rng(3);
  for (let i = 0; i < 5000; i++) {
    const a = (r() - 0.5) * 10 ** Math.floor(r() * 40 - 20), b = (r() - 0.5) * 10 ** Math.floor(r() * 40 - 20);
    assert.equal(Math.sign(cmp(a, b)), Math.sign(a - b), `${a} vs ${b}`);
  }
});

test("digits round-trip to the exact double", () => {
  for (const x of [0, -0, 1, -1, 0.1, 1e-320, 1.7976931348623157e308, -Infinity, Infinity, Math.PI]) {
    assert.ok(Object.is(valueOfDigits(digitsOf(x, [0, 0, 0, 0])), x), String(x));
  }
});

test("exactly the quantiles a full sort gives, on every kind of distribution, in one pass or several", () => {
  for (const [name, f] of Object.entries(dist)) {
    const r = rng(11), values = Array.from({ length: 6000 }, () => f(r));
    const want = reference(values, PS);
    for (const gather of [1 << 20, 64, 1]) {          /* the last two force the digit-by-digit refinement */
      const { got, passes } = select(values, PS, gather);
      assert.deepEqual(got, want, `${name}, gather ${gather}, ${passes} passes`);
    }
  }
});

test("infinities, denormals, extremes and NaN are ordered and skipped as a full sort would", () => {
  const specials = [0, Infinity, -Infinity, 5e-324, -5e-324, 1.7976931348623157e308, -1.7976931348623157e308, NaN, 1, -1, 2 ** 52, 0.1, -0.1];
  const r = rng(5), values = Array.from({ length: 4000 }, () => (r() < 0.3 ? specials[Math.floor(r() * specials.length)] : (r() - 0.5) * 10 ** Math.floor(r() * 40 - 20)));
  assert.deepEqual(select(values, PS, 32).got, reference(values, PS));
});

test("one value, two values, and nothing but duplicates", () => {
  for (const values of [[3], [3, -3], [7, 7, 7, 7, 7], [1, 1, 2, 2, 2, 3]]) {
    assert.deepEqual(select(values, PS, 1).got, reference(values, PS), JSON.stringify(values));
  }
});

test("a typical column needs two passes, and a bucket that is too large is refined a digit at a time", () => {
  const r = rng(2), values = Array.from({ length: 50000 }, () => r() * 1000);
  assert.equal(select(values, [0.5, 0.99]).passes, 2, "counted, then the small bucket gathered");
  const tight = Array.from({ length: 50000 }, () => 1000 + r() * 1e-4);
  const many = select(tight, [0.5], 16);
  assert.ok(many.passes >= 3 && many.passes <= 5, `refined across ${many.passes} passes`);
  assert.deepEqual(many.got, reference(tight, [0.5]));
});
