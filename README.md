# paris-parquet

One HTML file that reads a parquet file and shows you what is in it.

No install, no server, no build step, no CDN, no network request of any kind.
Save `index.html`, open it in a browser, drop a `.parquet` file on it. The file
is read locally by the page; nothing is uploaded anywhere.

```
open index.html      # or double-click it, or mail it to someone
```

Drop a file, several files, or a whole partitioned folder: `year=2024/month=01/
part-0.parquet` reads as one table with `year` and `month` as real columns you
can filter and group by. Files the ecosystem leaves lying around (`_SUCCESS`,
`.crc`, dotfiles) are ignored, a part missing a column reads as null there, and
two parts that disagree about a column's type are refused by name.

## What you get

- **A table** of the rows, virtualised so a wide or long file stays responsive.
- **A summary strip above the table**, one card per column, lined up with the
  column underneath it and aware of the column's type: min/max/mean and a
  distribution histogram for numbers and timestamps, distinct count and the top
  values for strings, a true/false/null bar for booleans, length statistics for
  binary and list columns, and a null bar on every one of them.
- **A metadata panel** at the bottom: row counts, row groups and their sizes,
  the schema tree, and per column the physical and logical type, compression
  codec, encodings, compressed and uncompressed size, null count, and the
  min/max recorded in the file's own statistics. Plus file size, format
  version, the writer that produced it, footer size, page encodings, encryption
  status and any key/value metadata.

Click a column header to sort by it — again for descending, again to clear —
and shift-click to add a second key. The header arrows, the query panel's
`ORDER BY` and the SQL are the same thing seen three ways.

Below the grid is a pager: 100 rows a page by default, or 10, 200, 500, 1,000,
3,000 or all of them. Next to it, the current view exports as CSV, TSV,
JSON or a markdown table, or copies to the clipboard as TSV for a spreadsheet
or as markdown for a ticket — either this page or every row of the view,
filters and sorting included. A page that fits in one draw goes into the page whole, so
scrolling it costs nothing at all; larger pages fall back to windowing.

Between the grid and the metadata sits the **query builder**. Drag a column
from the list into `SELECT`, `WHERE`, `ORDER BY` — or switch to Aggregate and
drop into `GROUP BY` and `METRICS` — then Run. Filters offer `=`, `≠`, `<`,
`≤`, `>`, `≥`, `LIKE`, `BETWEEN`, `IS NULL` and `IS NOT NULL`, chained with AND
or OR (AND binds tighter, as in SQL). Aggregates are `COUNT`,
`COUNT(DISTINCT)`, `SUM`, `AVG`, `MIN` and `MAX`. Results replace the grid, and
the summary cards above recompute over them.

The SQL beside the zones is **editable, and edits flow back**. Type a query and
the zones rearrange themselves to match; drag a chip and the text rewrites
itself. It is checked against the file's own schema as you type: unknown
columns (with a suggestion), values that are not of the column's type,
aggregates that do not line up with `GROUP BY`, an `ORDER BY` naming something
unselected. Anything the zones cannot hold — a join, `HAVING`, `NOT`, a
subquery, `(a OR b) AND c` — is named and refused rather than half-applied, and
the last good state stays put. **tidy** rewrites your text the way the builder
would.

The SQL is a record of the query, not how it runs: the engine executes over the
columns already decoded in memory.

**Columns** in the header opens a picker: search by name or type, hide what you
do not need, pin a column so it stays at the left edge while you scroll
sideways, and drag to reorder. Hiding is a display choice only — a hidden
column stays decoded and can still be filtered, grouped and sorted on.

Click any cell to open it in full: the whole string with its length, a hex and
ASCII dump for binary, indented JSON for lists, structs and maps, alongside the
column's full path and type. Escape closes it.

All three splits are draggable: the bars above the query and metadata panels
resize them, and the right edge of any column header resizes that column
(double-click it to go back to the default width). Panel heights and the page
size are remembered; column widths last for the session.

The button in the top right switches the colour theme between `auto` (whatever
the browser is set to), `light` and `dark`. The choice is remembered where the
browser allows storage.

By default the first 20,000 rows are read (rounded up to whole row groups);
buttons load more or all of it. Summaries describe the rows actually read, and
the header says so when that is less than the whole file.

## What it understands

Everything below is decoded inside `index.html` — the thrift footer, the
compression codecs and the encodings are all implemented in the file.

| | |
|---|---|
| **Compression** | uncompressed, snappy, gzip, zstd, lz4 (raw and hadoop-framed), brotli where the browser exposes it |
| **Encodings** | plain, RLE, RLE/plain dictionary, bit-packed, delta binary packed, delta length byte array, delta byte array, byte stream split |
| **Pages** | data page v1, data page v2, dictionary pages |
| **Types** | all physical types including int96, plus string, enum, json, uuid, decimal (int32/int64/fixed/binary, exact — no float rounding), date, time, timestamp (ms/us/ns), float16, unsigned ints, interval |
| **Nesting** | structs, lists, maps and any nesting of them, assembled back from repetition and definition levels; one grid column per leaf, showing the nested value |

Known limits, on purpose: a column chunk must live in the file that describes
it (parquet allows otherwise; nothing writes it), encrypted parquet is reported
and refused, and nanosecond timestamps display at microsecond resolution.

## Tests

The `tools/` directory is for developing the file; none of it ships to a user.
It needs `pyarrow` (to write fixtures and to be the source of truth) and
optionally `playwright`.

```sh
python3 tools/fixtures.py /tmp/fx             # write fixtures + expected values
node tools/check.mjs /tmp/fx/*.parquet        # decode each one, compare every cell
node tools/check-query.mjs /tmp/fx/*.parquet  # run the query engine against duckdb
node tools/check-sql.mjs /tmp/fx/a.parquet    # SQL round trip, execution, refusals
node tools/check-folder.mjs /tmp/fx/folders   # partitioned folders read as one table
node tools/fuzz-zstd.mjs 1000                 # zstd decoder vs node's zstd encoder
node tools/browser.mjs /tmp/fx/a.parquet      # drive the page in real Chromium
```

`check.mjs` pulls the `<script>` out of `index.html` and runs it against a stub
DOM, so the tests exercise the shipped file rather than a copy of it.
`check-query.mjs` builds a query, asks the engine and duckdb the same question
over the same file, and compares every cell of the two answers. `check-sql.mjs`
prints a builder state as SQL, parses it back, and insists it prints the same
again — then runs hand-written SQL past duckdb and checks that malformed
queries are refused with a useful message.
