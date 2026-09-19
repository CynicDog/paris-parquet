# Bounded memory: the plan for what is not yet bounded

**Status: plan.** Nothing here is built. It follows [`stress-test.md`](stress-test.md), which measured the page on 10-million-row, 200-column files and listed what still grows with the data; [`bounded-memory-statistics.md`](bounded-memory-statistics.md) is the theory. Tracked as [#38](https://github.com/CynicDog/paris-parquet/issues/38); the two earlier issues it builds on are [#36](https://github.com/CynicDog/paris-parquet/issues/36) (bounded-memory statistics) and [#16](https://github.com/CynicDog/paris-parquet/issues/16) (budget, re-reading, spill).

## Where things stand

The page keeps what it decodes inside a memory budget and says so when something will not fit. That makes it safe; it does not make it *bounded*. What is held is still proportional to rows times columns for anything that needs values, and several paths still cost memory in proportion to how many distinct values or groups the data has. The goal of this plan is that, for as many operations as possible, **memory stops depending on the number of rows**.

| operation | what it costs today | why | item |
|---|---|---|---|
| a whole-file aggregate | every row of the columns it needs (a 10 M-row column is about 2 GB peak) | it loads the columns, then aggregates | [#39](https://github.com/CynicDog/paris-parquet/issues/39) |
| the first screen | a whole row group of the columns that fit (1 M rows to show 100) | the row group is the unit of decoding | [#40](https://github.com/CynicDog/paris-parquet/issues/40) |
| a percentile | a full sorted copy of the column | `quantileOf` sorts | [#41](https://github.com/CynicDog/paris-parquet/issues/41) |
| a high-cardinality `GROUP BY`, `COUNT DISTINCT` | one map or set entry per distinct value | unbounded `Map` and `Set` | [#42](https://github.com/CynicDog/paris-parquet/issues/42) |
| sort, top-N, paging | every row, or only the rows read (labelled) | needs an order over the whole file | [#43](https://github.com/CynicDog/paris-parquet/issues/43) |
| header summary cards | the rows read; a string `Map` of distinct values | computed from decoded rows | [#44](https://github.com/CynicDog/paris-parquet/issues/44) |
| a join | both sides' rows and the whole output | hash build, then materialize | [#45](https://github.com/CynicDog/paris-parquet/issues/45) |
| the estimate itself | fixed measured constants | not fed back from reality | [#46](https://github.com/CynicDog/paris-parquet/issues/46) |
| how any of this is verified | one macOS machine, by hand | the harness is macOS-only and not in CI | [#47](https://github.com/CynicDog/paris-parquet/issues/47) |

## The items

### 1. A streaming aggregate executor ([#39](https://github.com/CynicDog/paris-parquet/issues/39))

**Approach.** Split `aggregate` into `start(query)`, `feed(state, batch)` and `finish(state)`, and run it over one row group at a time: decode the query's columns for that group, fold them into the accumulators, drop them. The accumulators for count, sum, mean, variance, min, max, arg-min/max and nulls already exist (Welford, Chan's merge, compensated sums), so memory becomes the number of groups times the metrics, plus one row group. A whole-file `AVG` over 10 M rows then costs the same as over 1 M.
**Not in scope here.** Percentiles, distinct counts and mode need the values, not a running total; they keep today's load-the-column path, with its budget check, until items 3 and 4 replace it.
**Done when** the stress `agg` scenario's peak is flat between 1 M and 10 M rows for the mergeable metrics, results equal today's to the last digits the metrics-versus-DuckDB check tolerates (1e-12), and cancel still restores the view. The popup declares "fold row group *i* of *n*".

### 2. Partial decoding of the first row group ([#40](https://github.com/CynicDog/paris-parquet/issues/40))

**Approach.** Today a row group is decoded whole. A column chunk is a sequence of pages, so decode pages in order and stop once enough rows exist; where a page index gives each page's first row, jump straight to the pages needed (the row-range path, `readRowsRanges`, already reads a list of ranges). `loadMore` then needs to remember how far into a row group it got, so "Load more" continues inside it instead of restarting.
**Done when** opening the 1 M-row-group file decodes about 20,000 rows and uses a small fraction of today's 2.6 GB, with every column visible where it now shows 67 of 200.

### 3. Percentiles without a full copy ([#41](https://github.com/CynicDog/paris-parquet/issues/41))

**Approach.** Radix selection over an order-preserving key: count values by the top 16 bits (256 KB of counters), find the bucket holding each requested rank, then either gather that bucket or count the next 16 bits. Typically two passes; four in the worst case. A throwaway prototype was bit-identical to a full sort on 11 datasets including `±0`, `±Infinity`, denormals and NaN, and took 60 to 85 ms per pass per 10 M values in memory ([`bounded-memory-statistics.md`](bounded-memory-statistics.md)). Dictionary-encoded columns need one pass (count per dictionary index, then read off the rank); row groups whose footer range cannot intersect the target bucket are skipped in later passes.
**Care.** `int64`, timestamps and decimals need their own key mappings (no fast unsigned 64-bit in JS: use two 32-bit halves). All requested quantiles share the passes. The interpolation stays `QUANTILE_CONT`'s, so results equal today's.
**Done when** `MED`, `P90`, `P95`, `P99` and `IQR` equal `quantileOf` on every fixture and DuckDB at 5 M rows, and peak memory no longer includes a sorted copy of the column.

### 4. High-cardinality `GROUP BY` and `COUNT DISTINCT` ([#42](https://github.com/CynicDog/paris-parquet/issues/42))

**Approach.** A first pass estimates cardinality (HyperLogLog, or a dictionary's size or the footer's `distinct_count` where they exist), and the number of passes is `P = ceil(estimated groups x bytes per group / budget)`. Pass `k` reads the source again and keeps only the groups (or values) whose hash falls in slice `k`. The source file is a read-only random-access store, so **re-reading replaces spilling**: no temporary files, and it works from `file://`. If `P` is unreasonable the query is refused with the estimate. An approximate distinct count (HyperLogLog) is offered only as an explicit, labelled choice.
**Done when** a `GROUP BY` over a column with millions of distinct values completes within the budget or is refused with its numbers, never by crashing; and the passes and slices are named in the popup.

### 5. Sorting, top-N and paging whole files ([#43](https://github.com/CynicDog/paris-parquet/issues/43))

**Approach.** `ORDER BY ... LIMIT k` streams row groups through a bounded heap of `k` entries (memory `O(k)`), which also prunes row groups whose footer range cannot beat the heap's current worst. A sorted page of an unlimited sort is the rank range `[p, p+n)`: select those ranks with the radix machinery of item 3, then gather and sort only those rows. A full sort of every row is not attempted; the result says it is sorted within the rows read, as it does now.
**Done when** the top 100 by a numeric column of a 10 M-row file is correct against DuckDB and its peak memory does not depend on the file's row count.

### 6. Header summary cards over the whole file ([#44](https://github.com/CynicDog/paris-parquet/issues/44))

**Approach.** Min, max and null counts come from the footer immediately, exactly where the writer marked the statistics exact. The rest (mean, spread, histogram, distinct and top values) is computed by the streaming machinery of item 1, progressively and for the visible columns first, under the budget. The unbounded string `Map` becomes a bounded heavy-hitters summary (Space-Saving) with an exact recount of just the candidates. Each card says whether it describes the rows read or the whole file.
**Done when** a card's figures for a 10 M-row column equal DuckDB's and opening a 200-column file does not compute 200 cards eagerly.

### 7. Joins ([#45](https://github.com/CynicDog/paris-parquet/issues/45))

**Approach.** Estimate the output before materializing it: hash the smaller side's keys, then count matches by streaming the larger side's key column only. Stream the larger side by row group (its key and needed columns) instead of loading it whole. When both sides are large, use the hash-sliced passes of item 4. Refuse with the estimated output size when it will not fit.
**Done when** a join whose output would not fit is refused with its estimated size before any of it is built.

### 8. Feeding the estimate with reality ([#46](https://github.com/CynicDog/paris-parquet/issues/46))

**Approach.** The per-cell costs are constants measured on one file mix. After the first row group is decoded, measure what it actually took where the browser allows (Chromium exposes an approximate heap size) and correct the constants for that file; keep the stress harness's `calibrate` scenario as the check that the constants still hold, and extend it to long strings, nested columns and wider decimals.
**Done when** the estimate is within a stated factor of the measured peak on files unlike the ones it was calibrated on.

### 9. A harness that runs anywhere, and a smoke in CI ([#47](https://github.com/CynicDog/paris-parquet/issues/47))

**Approach.** The stress harness measures physical footprint through macOS's `footprint`; add Linux (`/proc/<pid>/smaps_rollup` and swap) and Windows (private working set) so the same numbers exist on the machines people use, and refuse to run with a measure that cannot see swapped memory (the mistake in `stress-test.md`). Add a reduced stress smoke (a few hundred thousand rows, generated on the fly) to CI with assertions on the budget's behaviour, and record the large runs' results in the repository so a regression is visible.
**Done when** the harness runs on Linux and Windows, and CI fails if a whole-file aggregate's memory starts depending on the row count.

## Order

1. **First, measurement (9, then 8).** Each item below gets a stress scenario and a "before" number before it is changed.
2. **Then the two largest wins (1, 2).** Streaming aggregates remove `rows x columns` from the most common operation; partial decoding fixes the first screen on the row-group sizes warehouses actually write.
3. **Then what streaming enables (3, 4).** They reuse its pass structure.
4. **Then (5, 6), then 7.** Sorting and cards build on 1 and 3; joins are the largest and rarest.

Spilling to browser storage ([#16](https://github.com/CynicDog/paris-parquet/issues/16)) stays last: OPFS does not work from `file://`, and re-reading the source covers most of what spilling would.

## Risks and open questions

- **Results move in the last digits.** Adding in a different order changes floating-point sums; the metrics-versus-DuckDB check showed 1e-13 between two correct orders. Tests already allow 1e-12 for derived metrics; a stricter promise would need a fixed reduction order.
- **Exact stays exact.** Anything approximate (a distinct count, a heavy-hitters list) is labelled and opt-in; the default answer is exact or refused.
- **Cancel and progress.** A multi-pass operation needs the popup to say which pass, and Cancel to stop between row groups with the view restored, as it does now.
- **Workers.** Folding row groups in the decode workers (with merged partial states) would use spare cores but must give the same answer regardless of worker count.
- **Which of these do people need first?** The order above is by memory saved per effort; usage may reorder it.
