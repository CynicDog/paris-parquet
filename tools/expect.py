#!/usr/bin/env python3
"""Dumps a parquet file's values as paris-parquet would display them.

Used as ground truth for tools/check.mjs: pyarrow reads the file, and the
values are rendered with the same rules index.html uses, leaf column by leaf
column in schema order.
"""
import base64
import datetime
import decimal
import json
import math
import re
import sys

import pyarrow as pa
import pyarrow.parquet as pq


def jsnum(x):
    """Formats a float exactly like JavaScript's String(Number)."""
    if isinstance(x, int):
        return str(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    d = decimal.Decimal(repr(float(x)))
    sign, digits, exp = d.as_tuple()
    s = "".join(str(c) for c in digits).rstrip("0") or "0"
    k = len(s)
    n = exp + len(digits)           # value = 0.s * 10**n
    neg = "-" if sign else ""
    if k <= n <= 21:
        return neg + s + "0" * (n - k)
    if 0 < n <= 21:
        return neg + s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return neg + "0." + "0" * (-n) + s
    tail = "" if k == 1 else "." + s[1:]
    e = n - 1
    return neg + s[0] + tail + "e" + ("+" if e >= 0 else "-") + str(abs(e))


def fmt_time(ms):
    t = ms % 86400000
    h, m, sec = int(t // 3600000), int(t // 60000) % 60, int(t // 1000) % 60
    frac = t - math.floor(t / 1000) * 1000
    out = "%02d:%02d:%02d" % (h, m, sec)
    if frac > 0:
        f = ("%.3f" % frac).replace(".", "").rjust(6, "0").rstrip("0")
        if f:
            out += "." + f
    return out


def fmt_date(ms):
    d = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(milliseconds=ms)
    return "%04d-%02d-%02d" % (d.year, d.month, d.day)


def canon(v, t):
    """Renders one arrow value the way index.html renders the same cell."""
    if v is None:
        return None
    if pa.types.is_dictionary(t):
        return canon(v, t.value_type)
    if str(t) == "extension<arrow.uuid>":
        return str(v)
    if isinstance(t, pa.ExtensionType):
        return canon(v, t.storage_type)
    if pa.types.is_boolean(t):
        return "true" if v else "false"
    if pa.types.is_decimal(t):
        return format(v, "." + str(t.scale) + "f") if t.scale > 0 else str(int(v))
    if pa.types.is_integer(t):
        return str(v)
    if pa.types.is_floating(t):
        return jsnum(v)
    if pa.types.is_string(t) or pa.types.is_large_string(t):
        return v
    if pa.types.is_binary(t) or pa.types.is_fixed_size_binary(t) or pa.types.is_large_binary(t):
        return v.hex()
    if pa.types.is_date(t):
        return v.isoformat()
    if pa.types.is_time(t):
        ms = (v.hour * 3600 + v.minute * 60 + v.second) * 1000 + v.microsecond / 1000
        return fmt_time(ms)
    if pa.types.is_timestamp(t):
        if isinstance(v, int):
            ms = v / 1000.0
        else:
            epoch = datetime.datetime(1970, 1, 1, tzinfo=v.tzinfo)
            ms = (v - epoch).total_seconds() * 1000
        ms = round(ms * 1000) / 1000.0
        suffix = "Z" if t.tz is not None else ""
        return fmt_date(ms) + " " + fmt_time(ms) + suffix
    raise SystemExit("canon: unhandled arrow type " + str(t))


def json_scalar(v, t):
    """Value as it appears inside a JSON-rendered nested cell."""
    if v is None:
        return None
    if pa.types.is_boolean(t):
        return bool(v)
    if pa.types.is_floating(t) or pa.types.is_integer(t):
        f = float(v)
        return int(v) if (pa.types.is_integer(t) and abs(int(v)) <= 2 ** 53) else f
    return canon(v, t)


def leaf_columns(t, values):
    """Splits a column of arrow values into parquet leaf columns, in order.

    Each leaf comes back as (arrow type, per-row values, list nesting depth).
    """
    if pa.types.is_struct(t):
        out = []
        for f in t:
            sub = [None if row is None else row.get(f.name) for row in values]
            out.extend(leaf_columns(f.type, sub))
        return out
    if pa.types.is_list(t) or pa.types.is_large_list(t):
        inner = leaf_columns(t.value_type, [x for row in values if row for x in row])
        sizes = [None if row is None else len(row) for row in values]
        return [regroup(col, sizes) for col in inner]
    if pa.types.is_map(t):
        pairs = [x for row in values if row for x in row]
        keys = leaf_columns(t.key_type, [p[0] for p in pairs])
        items = leaf_columns(t.item_type, [p[1] for p in pairs])
        sizes = [None if row is None else len(row) for row in values]
        return [regroup(c, sizes) for c in keys + items]
    return [(t, values, 0)]


def regroup(col, sizes):
    t, flat, depth = col
    out, i = [], 0
    for n in sizes:
        if n is None:
            out.append(None)
        else:
            out.append(flat[i:i + n])
            i += n
    return (t, out, depth + 1)


def render(t, values, nested):
    if not nested:
        return [canon(v, t) for v in values]
    def walk(x):
        if x is None:
            return None
        if isinstance(x, list):
            return [walk(y) for y in x]
        return json_scalar(x, t)
    return [None if v is None else json.dumps(walk(v), separators=(",", ":")) for v in values]


def main(path, out_path):
    table = pq.read_table(path)
    cols = []
    for i, field in enumerate(table.schema):
        values = table.column(i).to_pylist()
        for t, vals, depth in leaf_columns(field.type, values):
            cols.append({"values": render(t, vals, depth > 0)})
    meta = pq.ParquetFile(path).metadata
    doc = {"num_rows": meta.num_rows, "num_columns": meta.num_columns, "columns": cols}
    with open(out_path, "w") as fh:
        json.dump(doc, fh)
    print("%-28s %7d rows x %2d cols" % (path.split("/")[-1], meta.num_rows, meta.num_columns))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
