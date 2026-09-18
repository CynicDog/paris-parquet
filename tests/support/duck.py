#!/usr/bin/env python3
"""Runs SQL over a parquet file with duckdb and prints the rows as JSON.

Ground truth for tests/integration/check-query.mjs: the query builder generates SQL, the
engine in index.html executes it over the decoded columns, and duckdb answers
the same question independently. Values are rendered with expect.py's rules so
the two sides are comparable.

    python3 tests/support/duck.py file.parquet "SELECT ..." [table_name]
"""
import json
import sys

import duckdb
import pyarrow as pa

import expect


def main(path, sql, table):
    con = duckdb.connect()
    con.execute("CREATE VIEW %s AS SELECT * FROM read_parquet('%s')" % (table, path))
    reader = con.sql(sql).arrow()
    tbl = pa.Table.from_batches(list(reader), reader.schema)   # schema for empty results
    cols = []
    for i, field in enumerate(tbl.schema):
        values = tbl.column(i).to_pylist()
        rendered = []
        for v in values:
            if isinstance(v, float) and v != v:
                rendered.append("NaN")
            else:
                rendered.append(expect.canon(v, field.type))
        cols.append({"name": field.name, "values": rendered})
    json.dump({"columns": cols, "rows": tbl.num_rows}, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "t")
