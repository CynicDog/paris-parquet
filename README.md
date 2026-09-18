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

Or try it without downloading anything: **<https://cynicdog.github.io/paris-parquet/>**
— the same one file, served over https instead of opened off disk. It still
makes no request of its own once it has loaded, and a file you open there is
read in the browser and never uploaded. The sample corpus is published beside
it, so [`data/orders.parquet`](https://cynicdog.github.io/paris-parquet/data/orders.parquet)
is one download away if you have no parquet file to hand.

Drop a file, several files, or a whole partitioned folder — `year=2024/
month=01/part-0.parquet` reads as one table with `year` and `month` as real
columns. Files the ecosystem leaves lying around (`_SUCCESS`, `.crc`,
dotfiles) are ignored; a part missing a column reads as null there; two parts
that disagree about a column's type are refused by name.

`data/` holds a small corpus (39 KB in all) to try it on without finding a
parquet file first — `customers`, `products` and the `orders` that reference
both, so a join has two real keys to work with, plus `data/events/`, a
hive-partitioned folder of four parts (and a `_SUCCESS` marker to ignore) for
the folder tree and **Open folder**. `data/README.md` lists what to try on
them; `tools/sample-data.py` regenerates them.

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
- Click a bar in a summary card to scope the result to it: a histogram bin
  becomes `BETWEEN` its smallest and largest value, a top value or a
  true/false/null segment becomes `=` / `IS NULL`. It goes in as an ordinary
  `WHERE` clause, so the zones, the SQL and the grid move together.
- Pager (100 rows by default, up to 3,000 or all); export the current view as
  CSV, TSV, JSON or Markdown, or copy to the clipboard.

**Query builder**
- Drag columns into `SELECT` / `WHERE` / `ORDER BY` (Rows mode), or `GROUP BY`
  / `METRICS` (Aggregate mode), then Run.
- Filters: `=` `≠` `<` `≤` `>` `≥` `LIKE` `BETWEEN` `IS NULL` `IS NOT NULL`,
  chained with AND/OR.
- Aggregates: `COUNT`, `COUNT(DISTINCT)`, `SUM`, `AVG`, `MIN`, `MAX` inline,
  and twelve more behind the row's **⋯** — *spread*: `STD`, `STDP`, `VAR`,
  `CV` (spread over level, so it compares columns of different units),
  `RANGE`; *distribution*: `MED`, `P90`, `P95`, `P99`, `IQR`, `MODE` (which
  reads strings and enums too); *missing*: `NULLS`, the rows `COUNT` skips.
  Picking a hidden one pins it onto the button, so a closed row always says
  what it computes. Spread is accumulated with Welford's method and merged
  with Chan's, so a mean that dwarfs its own spread — epoch millis, prices
  in a tight band — still reports the right standard deviation; percentiles
  are exact rather than sketched, which costs memory in the group.
- **Flat / pivot / rollup / cube** toggle appears once `GROUP BY` has a
  column. *Pivot* reshapes the result Excel-style — the last grouped
  column's values become new output columns. *Rollup* and *cube* add
  SQL-standard subtotal rows instead (rollup nests by position, cube adds
  every combination); a dropped column shows as `null`, same as SQL.
- A joined table says so in its `FROM`: both file names and the key each
  side (`FROM orders` / `INNER JOIN customers ON customer_id =
  customers.customer_id`), one `INNER JOIN` line per join in a chain. The
  clause describes the join the Join panel applied — it reads back, and one
  naming some *other* join is refused by name rather than quietly ignored,
  since editing it there doesn't re-join anything.
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

**The file panel** on the left is open from the start, before the first file
is dropped. It lists every parquet the page has been handed this session —
opened, dropped, or dragged into a join — and it is where **Join** lives.
- A drop shows up in it immediately; clicking a row opens that file; the
  open one is marked; a folder new to the list is expanded once, so a file
  that just arrived is visible without hunting for it. `close` shuts the
  panel down to a thin rail on the same edge — click that to bring it back.
  Open or closed is remembered across a reload.
- **browse a folder** swaps the list for the folder a file lives in, so you
  can open siblings without a picker dialog each time, and **session** goes
  back to the list. Clicking a folder there reads every parquet under it as
  one table — `events/` with its `year=2024/month=01…` parts comes back as
  one 256-row table with `year` and `month` as columns — while the caret
  beside it opens the folder up instead, for looking at a single part on its
  own. A folder drags onto a join side as that same one table. Uses the File System Access API (`showDirectoryPicker`)
  where the browser has it — a live, lazily-expandable tree. Where it
  doesn't (Safari, Firefox as of writing), falls back to the same
  `webkitdirectory` picker **Open folder as one table** uses, built into a
  one-time snapshot tree instead.
- Browsing a folder is its own explicit grant, separate from drag-and-drop,
  which stays exactly as frictionless and permission-free as it's always
  been — dropping a file never hands you its folder. Nothing is persisted
  across a reload beyond whether the panel is open: the session list starts
  empty and a folder has to be granted again.

**Diff**
- Compare two files: schema changes (added/removed/retyped columns, a
  rename guess), shape (rows, row groups, size, codecs, compression ratio),
  and per-column statistics — all read from the footers, no data page
  touched.
- Row-level diff on a chosen key column(s): rows only in A, only in B, and
  changed cells (`old → new`).
- **swap** flips which file is "open" without re-reading either.
- Every card here is read out of the two footers, so a joined table — which
  has no footer of its own — is named and refused rather than half-compared.

**Join** combines two files into one table on a key. Its button is in the
file panel rather than the header, and works with nothing open yet: it gives
an empty workspace with an **A** and a **B** side to fill.
- Every join run is listed back in the file panel under **joined**, beside
  the files. Click one to put that table back on screen, or drag it onto a
  side to join it again — it is already whole and in memory, so nothing is
  re-read to do either.
- **Drag a file from the panel onto a side.** A is whichever table is open,
  so dropping one there opens it; B is the other side of the join. A file
  dragged straight off the desktop lands the same way, and each side keeps a
  `choose a file` picker. While Join is up, clicking a row in the panel sets
  it as B too, and that row stays marked while it is.
- Inner join on a single equality key, one column per side (they don't need
  the same name — `region` on one side to `name` on the other is normal).
  **Run join** closes the panel and shows the table it made — that's what
  the panel was for. Opening it again comes back to the result, where
  **Undo** restores the original file exactly, footer metadata included.
- A result can be joined again: the second join reads its keys off the
  joined table, and since that table is already whole and has no footer,
  neither side is sent back to the reader for row groups it hasn't got.
  However many are chained on, one **Undo** goes back to the file.
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
npm run lint         # biome check against src/, tests/, tools/, scripts/
npm test              # unit tests, plus the integration suite if fixtures exist
```

A push to `main` runs `.github/workflows/pages.yml`: lint, the unit tests, and
a rebuild that has to match the committed `index.html` — a stale build fails
the job rather than publishing a page that looks current and isn't — then it
uploads `index.html` and `data/` and deploys them to
<https://cynicdog.github.io/paris-parquet/>.

`data/` is the one place parquet files are checked in (`.gitignore` ignores
`*.parquet` everywhere else, since fixtures are generated). `python3
tools/sample-data.py` rewrites them; it is seeded, so an unedited run against
the same pyarrow is byte-identical.

`scripts/compose.sh` (via `scripts/compose.mjs`) is a strip-and-concatenate,
not a bundler: it deletes the `import`/`export` statements and concatenates
the module bodies, in a fixed dependency order, into one script sharing one
global scope — the same shape the file has always shipped in. That fixed
order is why the modules use real imports for Biome and editors to check,
but don't need a real module resolver to build.

`biome.json` turns lint on for real, and `npm run lint` is clean — a finding
is a finding, not background noise. It is tuned to the codebase's own style
rather than the defaults wholesale; what is off, and why:

| rule | why |
|---|---|
| `useTemplate` | dense string concatenation is how the HTML here is built |
| `useExponentiationOperator` | `Math.pow` reads better in the bit-packing maths |
| `noSelfCompare` | `x !== x` is the NaN check |
| `noControlCharactersInRegex` | byte and encoding regexes mean those ranges |
| `noGlobalIsFinite` | the coercing `isFinite` is the one meant: it takes the page size (which may be `Infinity`), parsed operands and dataset strings alike, where `Number.isFinite` would answer false for all of them |
| `noCommaOperator` | the SQL parser advances with `(step(), tokAt(p - 1))`, one step-and-read rather than two statements around a temp |
| `useOptionalChain` | `a && a.b` is not `a?.b` — the first yields `a` when `a` is falsy, and call sites pass that on |

Everything else is on, including the correctness rules that actually caught
things: unused imports and variables, suspicious equality, assignment in an
expression, `forEach` callbacks returning a value, and assigning to an
imported binding (which a real module would refuse — the builder's chip ids
come from `nextQid()` now rather than bumping an imported counter). The
formatter is off on purpose: reformatting the existing style is a separate
decision from turning lint on, not bundled into this pass.

## Tests

`tests/` holds everything that verifies the file and nothing that ships:
`tests/unit/` (node:test, straight against the modules in `src/`),
`tests/integration/` (against the built `index.html`), `tests/browser/`
(real Chromium), `tests/fuzz/`, and `tests/support/` for the Python that
writes fixtures and acts as ground truth. `tools/` keeps what is a tool
rather than a test, such as `sample-data.py`. None of it ships to a user.
It needs `pyarrow` (to write fixtures and act as the source of truth) and
optionally `playwright` and `duckdb` (its Python package, for the
query-engine cross-checks).

`npm test` runs the unit tests under `tests/unit/*.test.js` — fast, each one
exercising a single module directly through a real `import`, no file to
decode (the SQL parser against malformed input, `aggregate`'s rollup/pivot/
cube reshaping and its spread metrics against hand-built columns,
`clauseCanMatch`'s pushdown logic against hand-built statistics) — and
then, if a fixture directory exists (`python3 tests/support/fixtures.py
/tmp/fx` first), the integration suite below, which exercises the *built*
`index.html` end to end. Both matter: the unit
tests catch a regression in one module in milliseconds; the integration
suite is the one that would catch the build step itself going wrong.

```sh
python3 tests/support/fixtures.py /tmp/fx                 # write fixtures + expected values
node tests/integration/check.mjs /tmp/fx/*.parquet        # decode each one, compare every cell
node tests/integration/check-query.mjs /tmp/fx/*.parquet  # run the query engine against duckdb
node tests/integration/check-sql.mjs /tmp/fx/a.parquet    # SQL round trip, execution, refusals
node tests/integration/check-folder.mjs /tmp/fx/folders   # partitioned folders read as one table
node tests/integration/check-diff.mjs /tmp/fx/diff /tmp/fx/*.parquet   # diff, and every file vs itself
node tests/integration/check-push.mjs /tmp/fx/push        # pushdown: the same answer, less read
node tests/fuzz/fuzz-zstd.mjs 1000                        # zstd decoder vs node's zstd encoder
node tests/browser/browser.mjs /tmp/fx/a.parquet          # drive the page in real Chromium
node tests/browser/browser-diff.mjs /tmp/fx/diff          # drive the diff panel, and count requests
node tests/browser/browser-push.mjs /tmp/fx/push          # drive the scan, and time it
node tests/browser/browser-lazy.mjs /tmp/fx/wide.parquet  # only decode what is wanted
node tests/browser/browser-workers.mjs /tmp/fx/*.parquet  # the other cores agree, cell for cell
node tests/browser/browser-tree.mjs /tmp/fx/folders       # drive the folder tree, both backends, count requests
node tests/browser/browser-metrics.mjs /tmp/fx/a.parquet  # drive the METRICS row's "more", and the SQL it writes
node tests/browser/browser-join.mjs                       # drive a join from both pickers, chain one, check pushdown narrowed it, and undo
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
