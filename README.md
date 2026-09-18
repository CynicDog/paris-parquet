# paris-parquet

**A single HTML file that reads a parquet file and shows you what's in it.**

[**Try it →**](https://cynicdog.github.io/paris-parquet/) · no install, no server, no build step, no CDN, and no network request of any kind. Drop a `.parquet` on it and nothing leaves your machine.

```sh
open index.html      # or double-click it, or mail it to someone
```

The whole reader — thrift footer, codecs, encodings, query engine — is inside that one file. `index.html` is generated from `src/`, but the thing you download, save or mail is still exactly one file with nothing else required to run it.

No parquet to hand? [`data/`](data/) is a 39 KB corpus — `customers`, `products` and the `orders` that reference both (two real join keys), plus `events/`, a hive-partitioned folder. It is [published beside the page](https://cynicdog.github.io/paris-parquet/data/orders.parquet) too.

## Principles

- **Decode only what's asked for.** Hidden columns, columns outside the query and rows past the read budget are never decoded.
- **Prove it before skipping it.** Pushdown skips a row group only when the file's own statistics prove it cannot match. Never guessed away.
- **Refuse rather than half-apply.** Files that disagree on a column's type, SQL the builder can't represent, a diff of a table with no footer — each is named and refused.

## Features

**Grid** — virtualized; sort by clicking a header (shift-click adds a key); pager from 100 rows to all; export CSV/TSV/JSON/Markdown.

**Summary card per column**, above the grid — min/max/mean + histogram for numbers and timestamps, distinct count + top values (three at a time, pageable) for strings, a true/false/null bar for booleans, length stats for binary and lists, a null bar on everything. **Click any bar to scope the table to it**: a histogram bin becomes `BETWEEN`, a top value or a bool segment becomes `=` / `IS NULL`, as an ordinary `WHERE` clause.

**Query builder** — drag columns into `SELECT` / `WHERE` / `ORDER BY`, or `GROUP BY` / `METRICS`.

- Filters `=` `≠` `<` `≤` `>` `≥` `LIKE` `BETWEEN` `IS NULL` `IS NOT NULL`, chained with AND/OR.
- Aggregates `COUNT` `CNTD` `SUM` `AVG` `MIN` `MAX`, and twelve more behind **⋯** — `STD` `STDP` `VAR` `CV` `RANGE`, `MED` `P90` `P95` `P99` `IQR` `MODE`, `NULLS`. Spread uses Welford (merged with Chan's) so a mean that dwarfs its spread still reports the right deviation; percentiles are exact, not sketched.
- **flat / pivot / rollup / cube.** Pivot reshapes Excel-style; rollup and cube add SQL-standard subtotal rows.
- The **SQL panel is bidirectional** — edit the text and the zones follow, drag a chip and the text follows. Checked live against the schema; anything the zones can't hold is named, not half-applied.

**Scan file** (predicate pushdown) — off by default. On, it reads the footer's min/max statistics, bloom filters and page index to find which row groups and pages *could* match, reads only those, and reports what it skipped and why.

**Columns picker** — search, hide, pin, reorder. A hidden column can still be filtered and grouped on without being decoded: `GROUP BY` on 2 of 60 columns reads 2.

**File panel** — every parquet the page has been handed this session, plus **browse a folder** to open siblings without a picker each time (File System Access API where available, `webkitdirectory` snapshot where not). Clicking a folder reads every parquet under it as one table; the caret opens it up instead. Nothing persists across a reload.

**Join** — inner join on one equality key per side, from two files or a folder. The smaller side is hashed; the larger has its row groups narrowed to the smaller's key range first, so a lookup-table join doesn't read the whole file. Results are listed in the file panel, can be joined again, and behave as an ordinary table. One **Undo** restores the original, footer and all.

**Diff** — schema changes, shape and per-column statistics straight from the two footers, no data page touched; plus a row-level diff on a chosen key (only in A, only in B, `old → new`).

**Also** — cell inspector (full string, hex/ASCII, indented JSON); draggable, remembered panel and column widths; `auto`/`light`/`dark` theme; 20,000 rows read up front, more on demand; decoding handed to spare cores via workers started from the page's own `<script>` text.

## Format support

| | |
|---|---|
| **Compression** | uncompressed, snappy, gzip, zstd, lz4 (raw and hadoop-framed), brotli where the browser exposes it |
| **Encodings** | plain, RLE, RLE/plain dictionary, bit-packed, delta binary packed, delta length byte array, delta byte array, byte stream split |
| **Pages** | data page v1, data page v2, dictionary pages |
| **Types** | every physical type including int96, plus string, enum, json, uuid, decimal (exact — no float rounding), date, time, timestamp ms/us/ns, float16, unsigned ints, interval |
| **Nesting** | structs, lists, maps and any nesting of them, from repetition/definition levels; one grid column per leaf |

**Limits, on purpose:** a column chunk must live in the file that describes it; encrypted parquet is reported and refused; nanosecond timestamps display at microsecond resolution. A [memory budget with spill-to-disk](https://github.com/CynicDog/paris-parquet/issues/16) for large files and joins is still open.

## Developing

```sh
npm install     # once, for Biome
npm run build   # src/*.js + src/index.template.html -> index.html
npm run lint    # biome, clean
npm test        # unit tests, plus the integration suite if fixtures exist
```

`src/` is one module per responsibility, using real `import`/`export` so dependencies stay explicit. `scripts/compose.mjs` strips those statements and concatenates the bodies in a fixed order into one script sharing one global scope — a concatenator, not a bundler. **Never edit `index.html` by hand.**

A push to `main` runs [`pages.yml`](.github/workflows/pages.yml): lint, unit tests, and a rebuild that must match the committed `index.html` — a stale build fails rather than publishing a page that looks current and isn't.

<details>
<summary>Why some lint rules are off</summary>

| rule | why |
|---|---|
| `useTemplate` | dense string concatenation is how the HTML here is built |
| `useExponentiationOperator` | `Math.pow` reads better in the bit-packing maths |
| `noSelfCompare` | `x !== x` is the NaN check |
| `noControlCharactersInRegex` | byte and encoding regexes mean those ranges |
| `noGlobalIsFinite` | the coercing `isFinite` is the one meant — it takes `Infinity`, parsed operands and strings alike |
| `noCommaOperator` | the SQL parser advances with `(step(), tokAt(p - 1))` |
| `useOptionalChain` | `a && a.b` is not `a?.b` — the first yields `a` when `a` is falsy, and call sites pass that on |

Everything else is on, including the rules that caught real things. The formatter is off on purpose.
</details>

## Tests

`tests/` holds everything that verifies the file and nothing that ships — `unit/` (node:test, against `src/`), `integration/` (against the built `index.html`), `browser/` (real Chromium), `fuzz/`, and `support/` for the Python that writes fixtures and acts as ground truth. Needs `pyarrow`; `playwright` and `duckdb` are optional.

`npm test` runs the unit tier in milliseconds, then the integration tier if a fixture directory exists — `python3 tests/support/fixtures.py /tmp/fx` first.

<details>
<summary>Running one suite at a time</summary>

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
node tests/browser/browser-diff.mjs /tmp/fx/diff          # the diff panel, and count requests
node tests/browser/browser-push.mjs /tmp/fx/push          # the scan, and time it
node tests/browser/browser-lazy.mjs /tmp/fx/wide.parquet  # only decode what is wanted
node tests/browser/browser-workers.mjs /tmp/fx/*.parquet  # the other cores agree, cell for cell
node tests/browser/browser-tree.mjs /tmp/fx/folders       # the folder tree, both backends
node tests/browser/browser-metrics.mjs /tmp/fx/a.parquet  # the METRICS row's "more", and its SQL
node tests/browser/browser-join.mjs                       # a join from both pickers, chained, undone
```

`check.mjs` pulls the `<script>` out of `index.html` and runs it against a stub DOM, so the tests exercise the shipped file rather than a copy. `check-query.mjs` asks the engine and duckdb the same question and compares every cell. `check-push.mjs` runs every query twice — whole file, and only what a plan kept — with an expected skip count, so pruning that quietly stops working is a failure too.
</details>
