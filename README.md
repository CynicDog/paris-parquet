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
columns already decoded in memory — unless you press **Scan file**, which
turns that around. A parquet file says a lot about itself before any of it is
decoded: min, max and a null count per column chunk, often a bloom filter, and
sometimes the same per page. Scan reads the footers, works out which row groups
and which pages could hold a row your `WHERE` matches, and reads only those.
The answer is identical to reading the whole file; the difference is how much
came off disk. `id >= 195000` over 200,000 rows reads one row group of twenty,
130 KB of 2.5 MB; `id = 150000` narrows further to a single page, 8,192 rows.
An equality test on an unsorted column, where min and max span everything, is
what the bloom filters are for, and a partition value rules out whole files at
once. The panel says what it read and why it skipped the rest, because skipping
is only worth trusting when it is visible.

Anything that cannot be *proved* impossible is read: a column with no
statistics, a byte array carrying only the pre-2.8 min/max some writers wrote
in signed order, text outside ASCII where parquet's byte order and JavaScript's
disagree. Those cost time, never the answer. A scanned table holds only the
rows that could match, so the metadata bar says so, and Reset reads the file
again the ordinary way.

**Chart** in the header draws the current result instead of tabulating it —
column, horizontal bar, line or scatter, picked automatically from the data (a
date dimension gets a line and a time axis) or chosen by hand. Pick the axis,
tick the series, stack them. Every mark carries a tooltip; lines get a crosshair
that snaps to the nearest x and reads out every series at once. One category and
one measure is a number, not a chart, so it renders as one. There is never a
second y-axis: two measures of different scale get series toggles, not a scale
that invents a correlation. The colours are a validated categorical order with
its own steps for dark mode, and a series keeps its colour when its neighbours
are switched off. The chart downloads as SVG.

**Columns** in the header opens a picker: search by name or type, hide what you
do not need, pin a column so it stays at the left edge while you scroll
sideways, and drag to reorder. A hidden column can still be filtered, grouped
and sorted on — but it is no longer decoded when more rows are read, and
neither is anything else nobody is looking at. With a `GROUP BY` on screen,
only the columns it names are read: loading the rest of a 60-column file that
way costs two columns, not sixty. Ask for one of the others — unhide it, drop
it into the query, run a diff — and it is decoded over exactly the row groups
already read, and joins the ones that were there all along.

**Diff** puts a second file beside the open one and says what moved. The
schema first: columns added, removed or retyped, and the pair that is probably
a rename rather than both — one column gone and one arrived holding the same
type. Then the shape: rows, row groups, size, codecs, encodings, compression
ratio, format version, who wrote it. Then what the two files claim about
themselves — each column's null count and min/max, folded over every row group
and compared in the column's own sort order, so an unsigned or decimal column
is not ordered by the bytes it happens to be stored in. None of that reads a
data page; it is all in the two footers.

The row diff is the part that reads data. Pick the column, or columns, whose
value identifies a row — a unique one is picked for you where there is one —
and it reports the rows only in A, only in B, and the rows in both whose values
differ, with the changed cells marked `old → new` and a count per column of how
many cells moved. A key that repeats is refused by name rather than half
applied, because rows cannot be matched one to one on it. Both sides are held
to the same row budget, and the panel says what it compared when that is less
than the whole of either file. **swap** turns the comparison around without
re-reading anything.

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

Where the browser has cores to spare, the page uses them: it starts a few
workers on **its own `<script>` text**, so they know every codec and encoding
the page does and there is still only one file. A row group's column chunks
are read together in one go, and the columns that can come back as one buffer
— runs of numbers, runs of bytes — are decoded on the other cores and handed
over rather than copied. Text and anything nested stay here, which is no loss:
that work happens while the workers are busy with the rest. Small files skip
all of it, because a round trip costs more than they do.

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
node tools/check-diff.mjs /tmp/fx/diff /tmp/fx/*.parquet   # diff, and every file vs itself
node tools/check-push.mjs /tmp/fx/push        # pushdown: the same answer, less read
node tools/fuzz-zstd.mjs 1000                 # zstd decoder vs node's zstd encoder
node tools/browser.mjs /tmp/fx/a.parquet      # drive the page in real Chromium
node tools/browser-diff.mjs /tmp/fx/diff      # drive the diff panel, and count requests
node tools/browser-push.mjs /tmp/fx/push      # drive the scan, and time it
node tools/browser-lazy.mjs /tmp/fx/wide.parquet   # only decode what is wanted
node tools/browser-workers.mjs /tmp/fx/*.parquet   # the other cores agree, cell for cell
```

`check.mjs` pulls the `<script>` out of `index.html` and runs it against a stub
DOM, so the tests exercise the shipped file rather than a copy of it.
`check-query.mjs` builds a query, asks the engine and duckdb the same question
over the same file, and compares every cell of the two answers. `check-sql.mjs`
prints a builder state as SQL, parses it back, and insists it prints the same
again — then runs hand-written SQL past duckdb and checks that malformed
queries are refused with a useful message. `check-diff.mjs` reads a pair of
files built to differ in exactly three ways and insists the diff names those
three and nothing else, then diffs every other file against itself: whatever
its types, a file has to come out equal to itself. `check-push.mjs` runs every
query twice — over the whole file, and over only what a plan kept — and insists
on the same rows cell for cell, with an expected skip per case so pruning that
quietly stops is a failure too; `check-query.mjs` does that second run for
every filtered case it already had.
