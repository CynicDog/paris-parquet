# paris-parquet

A single HTML file that reads a parquet file and shows you what's in it.

No install, no server, no build step, no CDN, no network request of any kind —
everything (footer parsing, compression codecs, encodings) is implemented
inside `index.html`. Save it, open it in a browser, drop a `.parquet` file on
it. Nothing leaves your machine.

That's true for anyone *using* the file. `index.html` is a generated build
artifact now — the source lives in `src/`, split into modules by
responsibility (see **Developing** below) — but the thing you download, save,
or mail is still exactly one HTML file with nothing else required to run it.

```sh
open index.html      # or double-click it, or mail it to someone
```

Drop a file, several files, or a whole partitioned folder — `year=2024/
month=01/part-0.parquet` reads as one table with `year` and `month` as real
columns. Files the ecosystem leaves lying around (`_SUCCESS`, `.crc`,
dotfiles) are ignored; a part missing a column reads as null there; two parts
that disagree about a column's type are refused by name.

## Concepts

- **Single file, no dependencies.** The whole parquet reader — thrift footer,
  codecs, encodings — ships inside `index.html`. Nothing is fetched.
- **Decode only what's asked for.** Hidden columns, columns not in the current
  query, and rows past the read budget aren't decoded until something needs
  them.
- **Prove it before skipping it.** `Scan file` (predicate pushdown) only skips
  a row group or page when the file's own statistics prove it can't match —
  anything that isn't provably impossible gets read, never guessed away.
- **Correctness over guessing.** Two files that disagree on a column's type
  are refused by name rather than silently merged; SQL the query builder
  can't represent (joins, `HAVING`, subqueries) is named and refused rather
  than half-applied.

## Features

**Table & summaries**
- Virtualized grid — stays responsive on wide or long files.
- Click a column header to sort, shift-click to add a second key.
- Per-column summary card above the grid: min/max/mean + histogram for
  numbers and timestamps, distinct count + top values for strings, a
  true/false/null bar for booleans, length stats for binary/list columns, a
  null bar on all of them.
- Pager (100 rows by default, up to 3,000 or all); export the current view as
  CSV, TSV, JSON or Markdown, or copy to the clipboard.

**Query builder**
- Drag columns into `SELECT` / `WHERE` / `ORDER BY` (Rows mode), or `GROUP BY`
  / `METRICS` (Aggregate mode), then Run.
- Filters: `=` `≠` `<` `≤` `>` `≥` `LIKE` `BETWEEN` `IS NULL` `IS NOT NULL`,
  chained with AND/OR.
- Aggregates: `COUNT`, `COUNT(DISTINCT)`, `SUM`, `AVG`, `MIN`, `MAX`.
- **Flat / pivot / rollup / cube** toggle appears once `GROUP BY` has a
  column. *Pivot* reshapes the result Excel-style — the last grouped
  column's values become new output columns. *Rollup* and *cube* add
  SQL-standard subtotal rows instead (rollup nests by position, cube adds
  every combination); a dropped column shows as `null`, same as SQL.
- The SQL panel is **bidirectional**: edit the text and the zones follow,
  drag a chip and the text follows. It's checked against the file's schema
  live, and anything the zones can't hold — a join, `HAVING`, `NOT`, a
  subquery — is named and refused rather than half-applied. **tidy**
  rewrites your SQL the way the builder would.

**Scan file (predicate pushdown)**
- Off by default: the engine runs over columns already decoded in memory.
- On: reads the footer's min/max stats, bloom filters and page index to work
  out which row groups and pages could hold a matching row, and reads only
  those — same answer, less I/O.
- The panel reports what it read and what it skipped, and why.

**Columns picker**
- Search by name/type, hide what you don't need, pin a column to the left
  edge, drag to reorder.
- A hidden column can still be filtered/grouped/sorted on, but isn't
  decoded — a `GROUP BY` on 2 of 60 columns only reads those 2.

**Folder** in the header browses the folder a file lives in, so you can open
a sibling without a picker dialog each time.
- Uses the File System Access API (`showDirectoryPicker`) where the browser
  has it — a live, lazily-expandable tree. Where it doesn't (Safari, Firefox
  as of writing), falls back to the same `webkitdirectory` picker "Open
  folder" already uses, built into a one-time snapshot tree instead.
- This is its own explicit grant, separate from drag-and-drop, which stays
  exactly as frictionless and permission-free as it's always been — dropping
  a file never hands you its folder. The tree panel always names the folder
  it's browsing, with a `change` to pick a different one and `close` to stop;
  nothing is persisted across a reload, so browsing again after one always
  asks again.

**Diff**
- Compare two files: schema changes (added/removed/retyped columns, a
  rename guess), shape (rows, row groups, size, codecs, compression ratio),
  and per-column statistics — all read from the footers, no data page
  touched.
- Row-level diff on a chosen key column(s): rows only in A, only in B, and
  changed cells (`old → new`).
- **swap** flips which file is "open" without re-reading either.

**Join** combines two files into one table on a key — the opened file plus a
second one you pick, similar to Diff's "choose file B".
- Inner join on a single equality key, one column per side (they don't need
  the same name — `region` on one side to `name` on the other is normal).
  One join at a time; the result replaces the open table, and **Undo**
  restores the original file exactly, footer metadata included.
- The smaller file (by row count) is always read fully and hashed; the
  larger one has its row groups narrowed to the smaller side's key range
  first, the same pushdown (`clauseCanMatch`/the page index) `Scan file`
  already uses for a `WHERE` clause — a join against a small lookup table
  doesn't require reading the whole of the larger file.
- Once run, the result is an ordinary table: `SELECT`/`WHERE`/`GROUP BY`,
  rollup/pivot/cube, sort, export all work over it exactly as they would
  over any opened file, since that's genuinely what it becomes. A column
  name that collides between the two sides is prefixed (`b_name`) rather
  than silently overwritten.

**Cell inspector**
- Click any cell for the full value: string + length, hex/ASCII dump for
  binary, indented JSON for lists/structs/maps.

**Other**
- Panel and column widths are draggable and remembered.
- Colour theme: `auto` / `light` / `dark`, remembered.
- Reads the first 20,000 rows by default (rounded to whole row groups); load
  more or all on demand.
- Uses spare CPU cores where available: workers are started on the page's own
  `<script>` text (still one file), and row-group/column-chunk decoding is
  handed off to them.

## What it understands

| | |
|---|---|
| **Compression** | uncompressed, snappy, gzip, zstd, lz4 (raw and hadoop-framed), brotli where the browser exposes it |
| **Encodings** | plain, RLE, RLE/plain dictionary, bit-packed, delta binary packed, delta length byte array, delta byte array, byte stream split |
| **Pages** | data page v1, data page v2, dictionary pages |
| **Types** | all physical types including int96, plus string, enum, json, uuid, decimal (int32/int64/fixed/binary, exact — no float rounding), date, time, timestamp (ms/us/ns), float16, unsigned ints, interval |
| **Nesting** | structs, lists, maps and any nesting of them, assembled from repetition/definition levels; one grid column per leaf |

**Known limits, on purpose:** a column chunk must live in the file that
describes it (parquet allows otherwise; nothing writes it), encrypted parquet
is reported and refused, nanosecond timestamps display at microsecond
resolution.

## Coming soon

- **A memory budget for large files and joins** ([#16](https://github.com/CynicDog/paris-parquet/issues/16))
  — grouping and, eventually, a join's hash table have no size ceiling
  today. Spilling the largest/coldest partition to OPFS (or IndexedDB where
  OPFS isn't available) once a budget is crossed, the way DuckDB and Polars
  spill sorts/joins to disk.

## Developing

The source lives in `src/`, one module per responsibility (`codecs.js`,
`encoding.js`, `query.js`, `pushdown.js`, `diff.js`, `ui-*.js`, and so on),
using real `import`/`export` so each module's dependencies are explicit and
checkable. `index.html` is generated from it — never edit `index.html` by
hand, it says so at the top of the file.

```sh
npm install        # once, for Biome
npm run build       # src/*.js + src/index.template.html -> index.html
npm run lint         # biome check against src/, tools/, scripts/
npm test              # unit tests, plus the integration suite if fixtures exist
```

`scripts/compose.sh` (via `scripts/compose.mjs`) is a strip-and-concatenate,
not a bundler: it deletes the `import`/`export` statements and concatenates
the module bodies, in a fixed dependency order, into one script sharing one
global scope — the same shape the file has always shipped in. That fixed
order is why the modules use real imports for Biome and editors to check,
but don't need a real module resolver to build.

`biome.json` turns lint on for real, tuned to the codebase's own style
rather than the defaults wholesale (dense string-concatenation over template
literals, the `x !== x` NaN check, deliberate control-character ranges in
byte/encoding regexes are all quieted; genuine correctness rules —
unused imports/variables, suspicious equality, assignment-in-expression —
stay on). The formatter is off on purpose: reformatting the existing style is
a separate decision from turning lint on, not bundled into this pass.

## Tests

The `tools/` directory is for developing the file; none of it ships to a
user. It needs `pyarrow` (to write fixtures and act as the source of truth)
and optionally `playwright` and `duckdb` (its Python package, for the
query-engine cross-checks).

`npm test` runs the unit tests under `src/*.test.js` — fast, each one
exercising a single module directly through a real `import`, no file to
decode (the SQL parser against malformed input, `aggregate`'s rollup/pivot/
cube reshaping against hand-built columns, `clauseCanMatch`'s pushdown logic
against hand-built statistics) — and then, if a fixture directory exists
(`python3 tools/fixtures.py /tmp/fx` first), the integration suite below,
which exercises the *built* `index.html` end to end. Both matter: the unit
tests catch a regression in one module in milliseconds; the integration
suite is the one that would catch the build step itself going wrong.

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
node tools/browser-tree.mjs /tmp/fx/push      # drive the folder tree, both backends, count requests
node tools/browser-join.mjs                   # drive a join, check pushdown narrowed it, and undo
```

- `check.mjs` pulls the `<script>` out of `index.html` and runs it against a
  stub DOM, so tests exercise the shipped file, not a copy of it.
- `check-query.mjs` asks the engine and duckdb the same question over the
  same file and compares every cell.
- `check-sql.mjs` round-trips a builder state through SQL text and checks
  malformed queries are refused with a useful message.
- `check-diff.mjs` diffs a pair of files built to differ in exactly three
  ways and checks the diff finds exactly those three, then diffs every file
  against itself.
- `check-push.mjs` (and the filtered cases in `check-query.mjs`) runs every
  query twice — over the whole file, and over only what a plan kept — and
  checks the rows match cell for cell, with an expected skip count so
  pruning that quietly stops working is a failure too.
