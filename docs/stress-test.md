# Stress test: how the page behaves on very large files

Measured 2026-09-19 with `tests/stress/stress.mjs` against files written by `tools/big-fixture.py`, on one machine (Apple M4, 16 GB RAM, 10 cores) in Chromium 153 driven by Playwright. Numbers are indicative of that setup, not universal: other browsers and other operating systems were not measured, and macOS-specific memory accounting (below) is part of the method.

## What was tested

| file | rows | columns | row group | size on disk |
|---|---|---|---|---|
| `big_1000000` | 1 M | 200 | 250 k | 0.24 GB |
| `big_5000000` | 5 M | 200 | 250 k | 1.20 GB |
| `big_10000000` | 10 M | 200 | 250 k | 2.39 GB |
| `big_10M_rg1M` | 10 M | 200 | **1 M** | 2.16 GB |

The 200 columns are a warehouse-shaped mix rather than noise, so sizes and timings are not flattered by incompressible random doubles: a sequential `id` and an increasing `ts` (clustered keys pushdown can prove things about), 20 low-cardinality integer and 20 string columns (dictionary-encoded), 40 quantized floats, 40 small-count `int64`s, 20 `float32`, 20 booleans, 4 nearly-unique strings, 4 decimals, 4 dates, and 26 mostly-null columns. Files are compressed with zstd, written one row group at a time so generating never needs the whole table in memory.

The last file exists because row-group size decides what opening a file costs (below), and 1 M-row groups are ordinary in warehouse output.

```sh
uv run --with pyarrow,numpy tools/big-fixture.py /tmp/big.parquet --rows 10000000
node tests/stress/stress.mjs /tmp/big.parquet --scenarios open,grow,scan-narrow,agg,pct-all,cancel --limit-mb 3500
```

Not part of `npm test`: the files are gigabytes. Scenarios: `open`, `grow` (press Load more until the page stops), `filter`, `scan-narrow` (a `WHERE` on the clustered key), `scan-broad`, `agg` (a grouped percentile), `pct-all` (one column's P99), `cancel` (Escape mid-run), and `calibrate` (memory per column kind).

## Platforms, the smoke, and recorded results

`tests/stress/memory.mjs` measures each platform by what the process really holds, including memory the OS has compressed or swapped: macOS `footprint`, Linux `/proc/<pid>/smaps_rollup` (Pss plus Swap), Windows `PrivateMemorySize64`. On a platform with none of these it **refuses to run** unless `--allow-rss` is given, and then says the numbers cannot be trusted under pressure. The macOS and Linux paths have been run (Linux by CI, `.github/workflows/smoke.yml`); the Windows path is written from the commands' documented behaviour and **has not been run on Windows**.

`node tests/stress/smoke.mjs` is the reduced run CI does on every push: it generates a 250,000-row and a 1,000,000-row file of the same shape, and fails if the whole-file aggregate over the larger one (a) does not cover every row, (b) is not answered under a 64 MB page budget that holding its columns would not fit (the invariant that does not depend on the garbage collector), or (c) peaks at more than 1.3x the smaller file's peak plus 80 MB. Run against the build from before streaming aggregation (`52e9470`), it fails (a) and (b). The rest of the workflow runs the integration corpus and the browser suites that exercise the budget, popup, sorting, joins and cards.

Results of the large runs are kept in [`stress-results/`](stress-results/) as the harness's `--json` output, so a regression shows in a diff: `open-1M-rowgroup.json` (opening a 1 M-row row group), `agg-highcard-10M.json`, `topn-10M.json`, `cards-10M.json` (10 M rows, 200 columns) and `calibrate-extra-500k.json` (estimate against measurement per column kind). `--dim` and `--budget-mb` select the join and budgeted-aggregate scenarios.

## How memory is measured, and a mistake in it

The harness sums the **physical footprint** (macOS `footprint`) of every process the browser started, every 150 ms, and kills the browser at a limit (default 3.5 GB). It does not use resident size. An earlier version did, and the first unguarded run showed why that is wrong: the renderer's resident size read about 2 GB while its physical footprint was **13 GB** (peak 14) on a 16 GB machine, because the OS had compressed and swapped the rest. The guard never fired, the machine was pushed into heavy compression for about ten minutes before the run was stopped by hand, and it recovered afterwards. Anything that watches memory by resident size under pressure is blind in exactly the case that matters.

## Before: what the page did

With every column shown (the default), opening decoded **the whole first row group**, whatever `FIRST_ROWS` said. `loadMore` reads whole groups until it has added at least the requested rows, so "20,000 rows up front" meant 250,000 here and 1,000,000 for the other file.

| step | result |
|---|---|
| open, 250 k-row groups | 2.9 s, **1.3 GB** for 50 M cells (about 25 B per cell) |
| press Load more, one group at a time | 0.5 M rows = 2.5 GB; the second press reached the 3.5 GB limit. Ceiling about 0.7 M of the 10 M rows, **7%** |
| open, **1 M-row groups** | stopped at 3.5 GB after 5.9 s, **before the first screen**; extrapolating from the other file it would need about 5 GB |
| whole-file P99 of one column, 10 M rows | worked, 2.1 GB, 3.6 s of sorting; equal to DuckDB |
| plain **Run** on a filter or aggregate | over the rows already read only. The status said "49,970 rows from 250,000 read" and never that the file has 10 million |
| **Scan file** | the only whole-file path; needed a `WHERE`; a second Run-like button named after the mechanism |

That last row is the design problem. An `AVG` on a huge file was silently an answer about its first 0.2 to 2.5%, and the control that fixed it was opt-in and disabled unless a `WHERE` existed.

## Calibration: what a decoded cell costs

One row group of one column kind, decoded through the page's own reader with nothing else resident, then forced garbage collection. The fixed cost of a fresh page (about 35 MB) is removed from the small samples.

| kind | bytes per cell (retained) | note |
|---|---|---|
| dictionary-encoded integers and strings | 7 | rows hold references to strings the dictionary owns |
| `float64`, `int64`, mostly-null | 6 to 14 | |
| booleans | 8 | |
| `float32` | 18 | |
| dates | 20 | |
| decimals | about 115 | objects |
| plain strings (8 characters) | about 260 | the expensive kind, about 20 times the bytes on disk |

What takes a tab down is the **peak**, when a row group's buffers and the arrays built from them are alive together, and on a 200-column file that was about twice the retained estimate (25 to 33 B per cell). `src/budget.js` therefore uses rounded-up per-kind costs and multiplies by 2. With that, the peak footprint lands at about 1.25 times the page's budget (the rest is the browser's own baseline).

## What changed

- **Run searches the whole file.** There is no Scan button. A `WHERE` is planned against the footer (min/max, bloom filters, page index) so only row groups that could match are read. An aggregate reads every row of the columns it needs. A line under the query bar states what the answer covers, every time.
- **A memory budget** (default about 2 GB of estimated decoded data on a machine reporting 8 GB or more; less on smaller ones). A file that would not fit opens with fewer columns and says so; Load more and Load all stop at the budget; columns shown from the picker that would not fit stay hidden; a whole-file aggregate that cannot fit is **refused with the numbers** and an explicit "run on the N rows already read"; a join or a row diff that cannot fit is refused before reading anything.
- **A progress popup** for anything that lasts more than about a quarter of a second: the steps it will take, the one in progress explained in a sentence, a real progressbar, Cancel and Escape. It never flashes for instant work.
- **Freed before replaced.** A whole-file run releases the decoded rows of the table it is about to replace, so the old and new are not in memory together; if the run is cancelled or fails, the view is read back.

## After

| file | open | shown | Run: `WHERE` on `id` | Run: grouped P99, all rows | Run: P99 of one column | P99 vs DuckDB |
|---|---|---|---|---|---|---|
| 1 M, 250 k groups | 3.0 s, 1.3 GB | 200 of 200 | 0.28 s, read 1 of 4 groups | 0.6 s, 1.3 GB | 0.6 s | 989.97 = 989.97 |
| 5 M, 250 k groups | 2.9 s, 1.3 GB | 200 of 200 | 0.28 s, read 1 of 20 | 2.6 s, 1.8 GB | 2.3 s | 989.94 = 989.94 |
| 10 M, 250 k groups | 3.2 s, 1.3 GB | 200 of 200 | 0.29 s, read 1 of 40 (57 MB of 2.23 GB) | 5.8 s, 1.8 GB | 5.1 s, 1.9 GB | 990 = 990 |
| **10 M, 1 M groups** | **5.8 s, 2.6 GB** | **67 of 200** | 0.6 s, read 1 of 10 (206 MB of 2.02 GB) | 5.4 s, 2.6 GB | 4.9 s, 2.9 GB | 990.07 = 990.07 |

The last row was killed at the limit before the first screen; it now opens showing the 67 columns that fit, with a note and a button to choose others. Every whole-file percentile equals DuckDB's `quantile_cont`. Cancel, pressed the moment the popup opens on a whole-file aggregate, stopped the run, said so, and restored the original rows on both 10 M-row files (repeated three times on the 1 M-group file).

Load more, pressed on the 250 k-group files, is refused ("the next row group would take about 1.7 GB"), since all 200 columns are already shown and fill the budget: the page tells you to hide columns or filter, instead of continuing.

## Every metric, at scale

The integration tier compares each metric with DuckDB, but on fixtures of a few hundred to twenty thousand rows and on one column. `tests/stress/metrics-vs-duckdb.mjs` asks the same question of **5 million rows**: all 18 metrics (`COUNT`, `COUNT DISTINCT`, `SUM`, `AVG`, `MIN`, `MAX`, `STD`, `STDP`, `VAR`, `CV`, `RANGE`, `MED`, `P90`, `P95`, `P99`, `IQR`, `NULLS`, `MODE`) over eight kinds of column, run in the page over the whole file and compared with DuckDB, then grouped.

| column | kind | worst relative difference on a derived metric |
|---|---|---|
| `metric_f_001` | normal doubles | 3e-15 |
| `metric_f_002` | lognormal doubles, long tail | 4e-14 |
| `count_l_003` | small `int64` counts | 2e-13 |
| `ratio_f32_002` | `float32` | 1e-13 |
| `sparse_000` | `int32`, 95% null | 7e-15 |
| `sparse_001` | doubles, 92% null | 1e-14 |
| `money_d_000` | `decimal(12,2)` | 4e-14 |
| `cat_i_005` | 60 distinct integers | 1e-14 |

192 comparisons, no disagreements; the largest relative difference on any derived metric was 1.6e-13, which is two accumulation orders disagreeing in the last digits. Counts, distinct counts, `MIN`, `MAX` and `NULLS` matched exactly. Grouped by a string column (4 groups, six metrics, on two columns), all 48 agreed.

Two things the comparison taught, both about the check rather than the page:

- **A DECIMAL column's percentile.** DuckDB's `quantile_cont` on `DECIMAL(12,2)` answers with a decimal, so it rounds an interpolated percentile to cents (94981.05) where the exact interpolation is 94981.0505, which is what the page returns. Compared in `DOUBLE` they agree exactly. For `SUM` on that column the page (250052905941.86, exact) is closer to the true total than DuckDB's double sum (250052905941.85806).
- **MODE and ties.** On a column with 3.9 million distinct values in 5 million rows, many values tie for most frequent, and DuckDB does not say which one wins. That is why the integration tier leaves `MODE` out. Here the page's answer is accepted if it occurs as often as any value does (7 times, the maximum), which it did.

It also found a real flaw, described next.

## Bugs this found

1. **The guard measured the wrong thing** (resident size), described above.
2. **The first estimate under-predicted the peak.** It opened the 1 M-group file showing 107 columns at a 2.9 GB footprint against a 2 GB budget. Raising the safety factor from 1.25 to 2 (it now covers the peak, not the retained size) gave 67 columns at 2.6 GB.
3. **A cancelled run left an empty screen.** The view was read back after the `try/finally`, but a cancelled run leaves the `try` by `return`, which skips everything after the block. Found only by cancelling a real run on a real file; moved into the `finally`.
4. **The scope line kept describing a scanned table after Reset** ("the first 0 of 200,000 rows"), because the file is re-read asynchronously. Found by the browser test.
5. **An expected refusal was logged as a console error**, so the tests treated it as a defect. Refusals are now their own type and are shown, not logged.
6. **What the page held grew with the history of queries.** After a whole-file query the table holds every row of the columns it needed; the next query then filled *its* columns into that same table, so six successive aggregates over different columns left six columns of five million rows in memory, and the seventh was refused by the budget for what earlier queries had used. Found by the metrics comparison, whose seventh column produced a stale answer. A table is now reused only if it already holds every column the query needs; otherwise it is rebuilt with just those, which also frees the old columns. A browser test fails with the old behavior and passes with the new.

## What is still not bounded

The plan for each item below, with issues, is in [`docs/bounded-memory-plan.md`](bounded-memory-plan.md).

- **The first screen still decodes a whole row group** of the columns that fit. A 1 M-row group means 1 M rows just to draw 100. Decoding pages until enough rows exist is the next memory win for such files.
- **Percentiles still sort a full copy** of the column (`quantileOf`), and `COUNT_DISTINCT` and `GROUP BY` still keep every distinct value or group. A whole-file percentile on one column works to at least 10 M rows here, but not a grouped one with millions of groups. Radix selection and mergeable summaries ([#36](https://github.com/CynicDog/paris-parquet/issues/36), `docs/bounded-memory-statistics.md`) address it; partitioning by re-reading and spill as a last resort are [#16](https://github.com/CynicDog/paris-parquet/issues/16).
- **A whole-file row query with no `WHERE`** is browsing: it shows the first row group and the scope line says so. A sort or top-N over the whole file needs a bounded heap or a selection pass, not yet built.
- **Header summary cards** still describe the rows read. String columns build a `Map` of every distinct value read, unbounded at high cardinality.
- **The join result and the diff's row comparison** are refused if reading their inputs cannot fit, but the size of a join's *output* is not estimated.
- Estimates are heuristics: they will be wrong for unusual files, which is why they are rounded up and reported as "about".

## Related

`src/budget.js`, `src/progress.js`, `src/pushdown.js` (`runWhole`, `describeScope`), `tests/browser/browser-memory.mjs`, `tests/stress/stress.mjs`, `tools/big-fixture.py`.
