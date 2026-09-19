#!/usr/bin/env python3
"""Writes one large, wide parquet file for stress-testing the reader.

    uv run --with pyarrow,numpy tools/big-fixture.py OUT.parquet --rows 10000000
    uv run --with pyarrow,numpy tools/big-fixture.py OUT.parquet --rows 1000000 --columns 50

The data is not in the repo and is never meant to be: 10M rows by 200 columns
is gigabytes. This is a generator, deterministic for a given seed and pyarrow,
so a result can be reproduced anywhere.

It is written one row group at a time, so generating never needs the whole
table in memory, and shaped like real warehouse data rather than noise -- pure
random doubles would compress to nothing and make the file, and the timings,
unrepresentative:

  - `id` is sequential and `ts` increases with jitter: clustered keys that
    pushdown can prove things about (a WHERE on them skips most row groups)
  - low-cardinality integer and string columns: dictionary-encoded
  - quantized floats and small counts: the way money and metrics really look
  - a few high-cardinality string columns: plain-encoded, the expensive ones
  - booleans, decimals, dates
  - columns that are mostly null

Column names carry their kind (`cat_i_003`, `metric_f_017`, ...) so a stress
run can pick a column of the kind it wants without guessing.
"""
import argparse
import datetime
import decimal
import os
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

COUNTRIES = ["country-%02d" % i for i in range(50)]
WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
         "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa"]

# (prefix, count) in the order columns are laid out; the first two are fixed
KINDS = [
    ("cat_i", 20),      # int32, 5-200 distinct   -> dictionary
    ("cat_s", 20),      # string, 4-50 distinct   -> dictionary
    ("hi_s", 4),        # string, ~unique         -> plain, incompressible
    ("metric_f", 40),   # float64, quantized to cents
    ("count_l", 40),    # int64, small counts
    ("ratio_f32", 20),  # float32
    ("flag_b", 20),     # bool
    ("money_d", 4),     # decimal(12,2)
    ("day_d", 4),       # date32
    ("sparse", 26),     # mostly null, mixed types
]


def schema_plan(limit):
    """The ordered (name, kind, index) of every column, cut to `limit`."""
    plan = [("id", "id", 0), ("ts", "ts", 0)]
    for kind, n in KINDS:
        for i in range(n):
            plan.append(("%s_%03d" % (kind, i), kind, i))
    return plan[:limit]


def column(rng, kind, i, start, n):
    """One column's values for rows [start, start + n)."""
    if kind == "id":
        return pa.array(np.arange(start, start + n, dtype=np.int64))
    if kind == "ts":
        base = 1_600_000_000_000_000 + start * 1_000_000
        jitter = rng.integers(0, 900_000, n)
        return pa.array((base + np.arange(n) * 1_000_000 + jitter).astype("datetime64[us]"), pa.timestamp("us"))
    if kind == "cat_i":
        return pa.array(rng.integers(0, 5 + (i * 11) % 196, n, dtype=np.int32))
    if kind == "cat_s":
        k = 4 + (i * 3) % 47
        idx = rng.integers(0, k, n)
        return pa.array(np.array(COUNTRIES[:k], dtype=object)[idx])
    if kind == "hi_s":
        # eight hex digits per value: nearly unique, and not compressible
        return pa.array(np.char.mod("%08x", rng.integers(0, 2**32, n, dtype=np.uint64)))
    if kind == "metric_f":
        m = i % 3
        v = rng.random(n) * 1000 if m == 0 else rng.normal(50, 15, n) if m == 1 else rng.lognormal(3, 1, n)
        return pa.array(np.round(v, 2))
    if kind == "count_l":
        return pa.array(rng.poisson(3 + i % 20, n).astype(np.int64))
    if kind == "ratio_f32":
        return pa.array(np.round(rng.random(n), 3).astype(np.float32))
    if kind == "flag_b":
        return pa.array(rng.random(n) < (0.1 + 0.04 * (i % 20)))
    if kind == "money_d":
        cents = rng.integers(0, 10_000_000, n)
        return pa.array([decimal.Decimal(int(c)).scaleb(-2) for c in cents], pa.decimal128(12, 2))
    if kind == "day_d":
        return pa.array((rng.integers(17000, 20000, n)).astype("datetime64[D]"), pa.date32())
    if kind == "sparse":
        keep = rng.random(n) < (0.05 + 0.03 * (i % 10))
        m = i % 3
        if m == 0:
            vals = pa.array(rng.integers(0, 1000, n, dtype=np.int32))
        elif m == 1:
            vals = pa.array(np.round(rng.random(n) * 100, 1))
        else:
            vals = pa.array(np.array(WORDS, dtype=object)[rng.integers(0, len(WORDS), n)])
        return pa.compute.if_else(pa.array(keep), vals, pa.scalar(None, vals.type))
    raise ValueError(kind)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--rows", type=int, default=1_000_000)
    ap.add_argument("--columns", type=int, default=200)
    ap.add_argument("--row-group", type=int, default=250_000, help="rows per row group")
    ap.add_argument("--compression", default="zstd")
    ap.add_argument("--seed", type=int, default=20260919)
    a = ap.parse_args()

    import pyarrow.compute  # noqa: F401  (pa.compute is used above)

    plan = schema_plan(a.columns)
    if len(plan) < a.columns:
        sys.exit("only %d columns are defined" % len(plan))
    t0 = time.time()
    writer = None
    written = 0
    batch = 0
    while written < a.rows:
        n = min(a.row_group, a.rows - written)
        rng = np.random.default_rng([a.seed, batch])
        arrays = [column(rng, kind, i, written, n) for _, kind, i in plan]
        table = pa.table(arrays, names=[name for name, _, _ in plan])
        if writer is None:
            writer = pq.ParquetWriter(a.out, table.schema, compression=a.compression, use_dictionary=True,
                                      write_statistics=True, data_page_version="2.0")
        writer.write_table(table, row_group_size=n)
        written += n
        batch += 1
        el = time.time() - t0
        print("\r%s / %s rows  %d row groups  %.0fs  (%s so far)" % (
            format(written, ","), format(a.rows, ","), batch, el,
            "%.2f GB" % (os.path.getsize(a.out) / 1e9)), end="", file=sys.stderr, flush=True)
    writer.close()
    size = os.path.getsize(a.out)
    print("\n%s: %s rows x %d columns, %d row groups, %.2f GB, %.0fs" % (
        a.out, format(a.rows, ","), len(plan), batch, size / 1e9, time.time() - t0), file=sys.stderr)


if __name__ == "__main__":
    main()
