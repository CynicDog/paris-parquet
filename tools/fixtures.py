#!/usr/bin/env python3
"""Writes the parquet test corpus, plus the expected values for each file.

    python3 tools/fixtures.py /tmp/fx
    node tools/check.mjs /tmp/fx/*.parquet

Covers every codec, encoding and page version pyarrow can write, the awkward
types (decimals, int96, float16, unsigned, nanosecond timestamps), nesting, and
files that are empty, tiny, wide or large. duckdb and polars are used as extra
writers when they are installed.
"""
import datetime
import decimal
import os
import random
import sys

import pyarrow as pa
import pyarrow.parquet as pq

import expect

random.seed(7)


def basic(n=1000):
    return pa.table({
        "id": pa.array(range(n), pa.int32()),
        "name": pa.array([f"user_{i % 97}" if i % 13 else None for i in range(n)]),
        "score": pa.array([random.gauss(70, 15) if i % 7 else None for i in range(n)], pa.float64()),
        "active": pa.array([bool(i % 3) if i % 11 else None for i in range(n)]),
        "ts": pa.array([datetime.datetime(2024, 1, 1) + datetime.timedelta(minutes=i * 37) for i in range(n)]),
        "day": pa.array([datetime.date(2020, 1, 1) + datetime.timedelta(days=i % 900) for i in range(n)]),
        "amount": pa.array([decimal.Decimal(f"{i % 100000}.{i % 100:02d}") for i in range(n)], pa.decimal128(12, 2)),
        "big": pa.array([i * 1000000007 for i in range(n)], pa.int64()),
        "cat": pa.array([["alpha", "beta", "gamma", "delta"][i % 4] for i in range(n)]).dictionary_encode(),
        "blob": pa.array([bytes([i % 256] * (i % 17)) for i in range(n)], pa.binary()),
    })


def edge(n=500):
    return pa.table({
        "all_null": pa.array([None] * n, pa.int32()),
        "all_null_str": pa.array([None] * n, pa.string()),
        "u8": pa.array([i % 256 for i in range(n)], pa.uint8()),
        "u16": pa.array([(i * 257) % 65536 for i in range(n)], pa.uint16()),
        "u32": pa.array([(i * 8000000) % 4294967296 for i in range(n)], pa.uint32()),
        "u64": pa.array([18446744073709551615 - i for i in range(n)], pa.uint64()),
        "i64_big": pa.array([9223372036854775807 - i * 1000 for i in range(n)], pa.int64()),
        "f_special": pa.array([float("nan") if i % 50 == 0 else (float("inf") if i % 77 == 0 else i * 1.5)
                               for i in range(n)], pa.float64()),
        "empty_str": pa.array(["" if i % 3 else "x" * (i % 40) for i in range(n)]),
        "unicode": pa.array(["héllo-世界-\U0001F600-%d" % i for i in range(n)]),
        "half": pa.array([i / 7.0 for i in range(n)], pa.float16()),
        "dec_small": pa.array([decimal.Decimal("%d.%02d" % (i, i % 100)) for i in range(n)], pa.decimal128(9, 2)),
        "dec_big": pa.array([decimal.Decimal("%d.%09d" % (i * 10 ** 18, i)) for i in range(n)], pa.decimal128(38, 9)),
        "t32": pa.array([datetime.time(i % 24, i % 60, i % 60, (i * 1000) % 1000000) for i in range(n)], pa.time32("ms")),
        "t64": pa.array([datetime.time(i % 24, i % 60, i % 60, (i * 7) % 1000000) for i in range(n)], pa.time64("us")),
        "ts_tz": pa.array([datetime.datetime(2021, 3, 1, tzinfo=datetime.timezone.utc) +
                           datetime.timedelta(seconds=i * 997) for i in range(n)], pa.timestamp("ms", tz="UTC")),
        "ts_ns": pa.array([1609459200000000000 + i * 1234567 for i in range(n)], pa.timestamp("ns")),
        "b": pa.array([bool(i % 2) for i in range(n)]),
        "fixed": pa.array([bytes([i % 256] * 8) for i in range(n)], pa.binary(8)),
    })


def nested(n=200):
    return pa.table({
        "id": pa.array(range(n), pa.int32()),
        "tags": pa.array([[f"t{j}" for j in range(i % 4)] if i % 9 else None for i in range(n)],
                         pa.list_(pa.string())),
        "addr": pa.array([{"city": f"c{i % 5}", "zip": i % 999} if i % 6 else None for i in range(n)],
                         pa.struct([("city", pa.string()), ("zip", pa.int32())])),
        "meta": pa.array([[("k%d" % (i % 3), i)] for i in range(n)], pa.map_(pa.string(), pa.int64())),
        "mat": pa.array([[[1, 2], [3]] if i % 5 else [] for i in range(n)], pa.list_(pa.list_(pa.int64()))),
    })


def deep(n=120):
    return pa.table({
        "id": pa.array(range(n), pa.int32()),
        "people": pa.array(
            [[{"name": "p%d" % j, "scores": [j, j + 1] if j % 2 else None} for j in range(i % 3)] if i % 7 else None
             for i in range(n)],
            pa.list_(pa.struct([("name", pa.string()), ("scores", pa.list_(pa.int64()))]))),
        "nested_map": pa.array([[("a", [1, 2]), ("b", [])] if i % 4 else [] for i in range(n)],
                               pa.map_(pa.string(), pa.list_(pa.int32()))),
    })


def encodings(n=800):
    return pa.table({
        "i32": pa.array([i * 3 - 400 for i in range(n)], pa.int32()),
        "i64": pa.array([i * 99999999 for i in range(n)], pa.int64()),
        "s": pa.array([f'str-{i:05d}-{"x" * (i % 9)}' for i in range(n)]),
        "sopt": pa.array([f"v{i % 50}" if i % 5 else None for i in range(n)]),
        "f": pa.array([i / 3.0 for i in range(n)], pa.float32()),
    })


def write(out, name, table, **kw):
    path = os.path.join(out, name + ".parquet")
    try:
        pq.write_table(table, path, **kw)
    except Exception as exc:                       # codec not built into this pyarrow
        print("skip %-24s %s" % (name, exc))
        return
    expect.main(path, path[: -len(".parquet")] + ".expect.json")


def folders(root):
    """Folder-shaped datasets: hive partitions, a flat set, a ragged set, a clash."""
    import shutil
    shutil.rmtree(root, ignore_errors=True)
    for year in (2023, 2024):
        for month in (1, 2, 3):
            n = 40 + month
            t = pa.table({
                "id": pa.array([year * 10000 + month * 100 + i for i in range(n)], pa.int64()),
                "name": pa.array(["n%d" % (i % 7) for i in range(n)]),
                "amt": pa.array([round(random.uniform(0, 100), 2) for _ in range(n)]),
                "ts": pa.array([datetime.datetime(year, month, 1) + datetime.timedelta(hours=i) for i in range(n)]),
            })
            d = "%s/hive/year=%d/month=%02d" % (root, year, month)
            os.makedirs(d, exist_ok=True)
            pq.write_table(t, d + "/part-0.parquet", compression="zstd")
    open(root + "/hive/_SUCCESS", "w").write("")          # must be ignored
    open(root + "/hive/year=2024/.hidden.parquet", "wb").write(b"not parquet")

    os.makedirs(root + "/flat", exist_ok=True)
    for k in range(3):
        pq.write_table(pa.table({"a": pa.array(range(k * 10, k * 10 + 10), pa.int32()),
                                 "b": pa.array(["x%d" % i for i in range(10)])}),
                       "%s/flat/chunk-%02d.parquet" % (root, k), compression="snappy")

    os.makedirs(root + "/ragged", exist_ok=True)
    pq.write_table(pa.table({"a": pa.array([1, 2, 3], pa.int32()), "b": pa.array(["p", "q", "r"])}),
                   root + "/ragged/one.parquet")
    pq.write_table(pa.table({"a": pa.array([4, 5], pa.int32())}), root + "/ragged/two.parquet")
    pq.write_table(pa.table({"a": pa.array([6], pa.int32()), "b": pa.array(["z"]), "c": pa.array([9.5])}),
                   root + "/ragged/three.parquet")

    os.makedirs(root + "/conflict", exist_ok=True)
    pq.write_table(pa.table({"a": pa.array([1, 2], pa.int32())}), root + "/conflict/int.parquet")
    pq.write_table(pa.table({"a": pa.array(["x", "y"])}), root + "/conflict/str.parquet")
    print("%-28s hive, flat, ragged and conflicting folders" % "folders/")


def diffpair(root):
    """Pairs of files for the diff: one drifted schema, one shifted row set."""
    import shutil
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root, exist_ok=True)
    n = 1000
    base = {
        "id": pa.array(range(n), pa.int64()),
        "name": pa.array(["user_%d" % (i % 97) for i in range(n)]),
        "score": pa.array([float(i % 101) for i in range(n)], pa.float64()),
        "qty": pa.array([i % 13 for i in range(n)], pa.int32()),
        "ts": pa.array([datetime.datetime(2024, 1, 1) + datetime.timedelta(minutes=i) for i in range(n)]),
    }
    pq.write_table(pa.table(base), root + "/a.parquet", compression="snappy", row_group_size=400)

    # b: one column added, one column retyped, exactly 100 rows with a new score
    scores = list(base["score"].to_pylist())
    for i in range(0, n, 10):
        scores[i] = scores[i] + 1000.0
    b = {
        "id": base["id"],
        "name": base["name"],
        "score": pa.array(scores, pa.float64()),
        "qty": pa.array([i % 13 for i in range(n)], pa.int64()),          # retyped
        "ts": base["ts"],
        "extra": pa.array(["e%d" % i for i in range(n)]),                 # added
    }
    pq.write_table(pa.table(b), root + "/b.parquet", compression="snappy", row_group_size=400)

    # e: the same as a, with one column under a different name
    e = dict(base)
    e["label"] = e.pop("name")
    pq.write_table(pa.table(e), root + "/e.parquet", compression="snappy")

    # c/d: the same shape, overlapping by half, with changes inside the overlap
    def side(lo, hi, bump):
        ids = list(range(lo, hi))
        return pa.table({
            "id": pa.array(ids, pa.int64()),
            "name": pa.array(["n%d" % (i % 11) for i in ids]),
            "v": pa.array([float(i) + bump * (i % 2) for i in ids], pa.float64()),
        })
    pq.write_table(side(0, 200, 0), root + "/c.parquet", compression="zstd")
    pq.write_table(side(100, 300, 7), root + "/d.parquet", compression="zstd")
    print("%-28s a/b (drift), c/d (row sets), e (rename)" % "diff/")


def main(out):
    os.makedirs(out, exist_ok=True)
    b, e, enc = basic(), edge(), encodings()

    for codec in ["none", "snappy", "gzip", "zstd", "brotli", "lz4"]:
        write(out, "basic_" + codec, b, compression=codec, row_group_size=300)
    write(out, "basic_v2page", b, compression="zstd", data_page_version="2.0", row_group_size=250)
    write(out, "basic_nodict", b, compression="snappy", use_dictionary=False, row_group_size=400)
    write(out, "basic_int96", b, compression="snappy", use_deprecated_int96_timestamps=True)
    write(out, "basic_bss", b, compression="none", use_dictionary=False,
          use_byte_stream_split=["score"], row_group_size=400)

    delta = {"i32": "DELTA_BINARY_PACKED", "i64": "DELTA_BINARY_PACKED", "s": "DELTA_BYTE_ARRAY",
             "sopt": "DELTA_LENGTH_BYTE_ARRAY", "f": "BYTE_STREAM_SPLIT"}
    write(out, "delta", enc, compression="none", use_dictionary=False, column_encoding=delta, version="2.6")
    write(out, "delta_v2page", enc, compression="zstd", use_dictionary=False, data_page_version="2.0",
          column_encoding=delta, version="2.6", row_group_size=333)

    for codec in ["none", "snappy", "zstd", "gzip"]:
        write(out, "edge_" + codec, e, compression=codec, row_group_size=128, version="2.6")
    write(out, "edge_v2page", e, compression="zstd", data_page_version="2.0", row_group_size=77, version="2.6")
    write(out, "edge_nodict", e, compression="zstd", use_dictionary=False, row_group_size=200, version="2.6")

    write(out, "empty", e.slice(0, 0), compression="snappy")
    write(out, "one_row", e.slice(0, 1), compression="zstd")
    write(out, "nested", nested(), compression="snappy", row_group_size=64)
    write(out, "deep", deep(), compression="zstd", row_group_size=40)
    write(out, "wide", pa.table({("c%03d" % i): pa.array([i * j for j in range(200)], pa.int32())
                                for i in range(120)}), compression="snappy")

    m = 300000
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    big = pa.table({
        "id": pa.array(range(m), pa.int64()),
        "txt": pa.array(["%s-%d" % ("".join(random.choice(alphabet) for _ in range(20)), i) for i in range(m)]),
        "x": pa.array([random.gauss(0, 1) for _ in range(m)]),
        "k": pa.array([i % 997 for i in range(m)], pa.int32()),
    })
    write(out, "big_zstd", big, compression="zstd", row_group_size=100000)
    write(out, "big_snappy", big, compression="snappy", row_group_size=100000)

    folders(os.path.join(out, "folders"))
    diffpair(os.path.join(out, "diff"))

    try:
        import polars as pl
        df = pl.DataFrame({"a": list(range(5000)), "b": [f"row{i % 777}" for i in range(5000)],
                           "c": [i * 0.5 for i in range(5000)]})
        for name, codec in [("polars_default", "zstd"), ("polars_lz4", "lz4")]:
            path = os.path.join(out, name + ".parquet")
            df.write_parquet(path, compression=codec)
            expect.main(path, path[: -len(".parquet")] + ".expect.json")
    except ImportError:
        print("skip polars fixtures (not installed)")

    try:
        import duckdb
        for name, sql in [
            ("duckdb", "select i as id, i%7 as m, 'txt'||i as t, random() as r from range(20000) t(i)"),
            ("duckdb_uuid", "select i as id, uuid() as u, now() as n from range(100) t(i)"),
        ]:
            path = os.path.join(out, name + ".parquet")
            duckdb.sql("copy (%s) to '%s' (format parquet, compression zstd, row_group_size 5000)" % (sql, path))
            expect.main(path, path[: -len(".parquet")] + ".expect.json")
    except ImportError:
        print("skip duckdb fixtures (not installed)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/fx")
