# Bounded-memory statistics: academic background and implementation approach

**Status: research note.** Nothing here is implemented in the page. It records the theory behind computing statistics over files far larger than memory, how it maps onto Parquet and this codebase, and a way to build it. The results in [A prototype](#a-prototype-what-was-measured) come from a throwaway script that is not in the repo; they are one machine, one runtime and no Parquet decoding, and are reported as such. Tracked in [#36](https://github.com/CynicDog/paris-parquet/issues/36); its companion, memory budgets and spilling for what cannot be bounded, is [#16](https://github.com/CynicDog/paris-parquet/issues/16).

## The problem, and what the code does today

A file of 10 million rows and 200 columns is 2 billion cells: 16 GB if every cell were an 8-byte number, before strings and JavaScript object overhead. The page cannot hold that, so anything that needs a whole column at once has to be replaced by something that reads it in pieces.

What holds a whole column today (read from the source):

- Loaded columns are materialized JS arrays (`col.rows`), and the summary cards are computed over the loaded rows (20,000 up front, more on demand).
- `quantileOf` (behind `MED`, `P90`, `P95`, `P99`, `IQR`) keeps every value of the group and sorts it in place with `v.sort((x, y) => x - y)`. Its own comment says so: an exact percentile "costs memory in the group that a streaming one does not". It computes `QUANTILE_CONT`, a linear interpolation between the two neighbouring order statistics.
- `COUNT_DISTINCT` keeps a `Set` of the distinct values.
- `decodeValues` expands a dictionary-encoded page into values (`out.push(dict[idx[i]])`), so the dictionary's compactness is lost immediately.
- Footer statistics are read (`minValue`/`maxValue`, `nullCount`, `distinctCount`, and the exactness flags as `minExact`/`maxExact`) and used by pushdown and the diff view, but not to answer summary statistics. `nan_count` is not read.

## The academic map

### Models of computation

- **External-memory model** (Aggarwal and Vitter, 1988): cost is counted in block reads from a slow store, with a small fast memory. Sorting is the yardstick; selection is cheaper.
- **Streaming model** (Munro and Paterson 1980; Alon, Matias and Szegedy 1996; Muthukrishnan's survey, 2005): data arrives in one pass, or a few, with memory far smaller than the input.
- **Mergeable summaries** (Agarwal, Cormode, Huang, Phillips, Wei and Yi, 2012): a summary is *mergeable* if two summaries of two datasets combine into a summary of their union with the same error and size guarantees. This is the formal version of "summarize each batch, then combine": it makes the answer independent of batch order and lets workers summarize in parallel.

### Selection without sorting

A percentile is a *selection* problem, not a sorting one. Quickselect (Hoare, 1961) is linear on average and the median-of-medians method (Blum, Floyd, Pratt, Rivest and Tarjan, 1973) is linear in the worst case, both in memory. The question here is doing it *out of* memory.

Munro and Paterson (1980) settled the trade-off between memory and passes for exact selection over data on a read-only tape: an exact median in two passes needs between `Ω(√N)` and `O(√N log N)` memory, and in `p` passes about `N^(1/p)` up to logarithmic factors. Two consequences:

1. **A single exact pass needs memory proportional to N.** Exact percentiles in bounded memory must make several passes; "second pass, third pass" is theory, not a workaround.
2. **The bound is for adversarial order.** For randomly ordered streams the bounds differ (Chakrabarti, Jayram and Pătraşcu, 2008). Parquet files are often clustered or sorted by design, so random order cannot be assumed.

### Approximate quantiles in one pass: the "pyramid"

Buffer hierarchies keep a pyramid of small sorted buffers that are repeatedly merged and halved as data arrives; the top of the pyramid summarizes everything seen.

| sketch | idea | guarantee |
|---|---|---|
| Manku–Rajagopalan–Lindsay, 1998 | a tree of buffers collapsed upward | deterministic rank error ε with limited memory |
| Greenwald–Khanna, 2001 | tuples with rank bounds, compressed | deterministic ε, `O((1/ε) log εN)` space |
| KLL (Karnin, Lang and Liberty, 2016) | compactor levels; halve a level at random when full | near-optimal space, randomized, fully mergeable |
| t-digest (Dunning and Ertl) | clusters, finer near the tails | very accurate at P1 and P99; no worst-case bound |
| DDSketch (Masson, Rim and Lee, 2019) | logarithmic buckets | relative error on the *value* |

Production systems use them: DuckDB's `approx_quantile` is a t-digest (its `quantile_cont` is exact), Spark's `percentile_approx` implements Greenwald–Khanna with an accuracy parameter (rank error `1/accuracy`), and Apache DataSketches offers KLL.

A rank-error guarantee is the wrong shape for tail percentiles: with ε = 1%, a "P99" could be anything between P98 and P100. That is the case for refining a sketch's answer exactly rather than trusting it.

### Other statistics

| statistic | technique | note |
|---|---|---|
| count, sum, mean, variance | running accumulator; Welford (1962), parallel merge by Chan, Golub and LeVeque (1979); higher moments by Pébay (2008) | already used here |
| min, max, count, nulls | *zone maps* / small materialized aggregates (Moerkotte, 1998) | in Parquet: the footer statistics |
| arg-min, arg-max | carry `(value, row)`; tie to the lowest row | O(1), mergeable |
| top-K rows | bounded heap of K | `O(N log K)` time, O(K) memory |
| distinct count | Flajolet–Martin (1985), HyperLogLog (2007), HyperLogLog++ (Heule, Nunkesser and Hall, 2013) | exact distinct needs memory proportional to the number of distinct values |
| frequent items, `MODE` | Misra–Gries (1982), Lossy Counting (Manku and Motwani, 2002), Space-Saving (Metwally et al., 2005); survey by Cormode and Hadjieleftheriou (2008) | finds items above `N/k`; a second pass gives their exact counts |
| operating on compressed data | Abadi, Madden and Ferreira (SIGMOD 2006) | dictionary and run-length encodings can be aggregated without decoding |

## What Parquet already provides

From the specification (`parquet.thrift`):

- **Chunk statistics:** `min_value`/`max_value`, `null_count`, `distinct_count`, `nan_count` (floating point), and `is_min_value_exact` / `is_max_value_exact`. Without the exactness flags the bounds may be "more compact values that do not exist on a page" (truncated strings), so they bound the answer but are not the answer.
- **Floating point ordering:** NaNs are ignored in min/max; if the minimum is `+0`, the group may contain `-0`; if `nan_count` is absent, readers must assume NaNs may be present.
- **Column and offset indexes:** per page `min_values`, `max_values`, `null_pages`, `null_counts` (and `nan_counts`), plus a `boundary_order` saying whether page bounds ascend or descend. The offset index gives each page's first row and byte range.
- **Dictionary pages** with an optional `is_sorted` flag.

Levels of the same idea: footer statistics per row group, then per page, are the cheapest tier of the pyramid.

## The pyramid, concretely

| level | what | cost |
|---|---|---|
| 0 | footer and page-index statistics | no decoding |
| 1 | one summary per batch (a row group, or a page range), folded in and discarded | one decode of the column |
| 2 | refinement passes, restricted to the row groups and value ranges that can still change the answer | further decodes, shrinking |

Every summary implements the same contract, so it can be merged across batches and across the existing decode workers:

```
init()            -> empty summary
add(batch)        -> fold one decoded batch in
merge(a, b)       -> a summary of both      (associative; commutative where the statistic is)
result(summary)   -> the statistic
```

The result must not depend on batch order or worker count, so ties (arg-min, top values) need a fixed rule.

## Exact quantiles by radix selection

This is the multi-pass exact method, made concrete. It is the classic counting-based selection (the first steps of an MSD radix sort, without the sort), and it is what GPU k-selection implementations use (Alabi et al., 2012).

1. **Order-preserving key.** Map every value to an unsigned 64-bit integer whose numeric order equals the value order. For a float64: if the sign bit is set, invert all 64 bits; otherwise flip the sign bit. Integers, dates and timestamps are offset.
2. **Pass 1.** Count values by the top 16 bits of the key: 65,536 counters, 256 KB, fixed regardless of N. Counters merge by addition. The total gives N.
3. **Locate the ranks.** For a quantile `p`, `h = (N-1)·p`; the two order statistics `floor(h)` and `floor(h)+1` are the ones `QUANTILE_CONT` interpolates. Walk the counters to find the bucket that contains each rank, and the rank's offset inside it. All requested quantiles share pass 1.
4. **Pass 2.** If a bucket holds at most `M` values (a million, say), gather exactly those values and select inside them in memory. Otherwise count the *next* 16 bits within the bucket and repeat. A 64-bit key needs at most four passes.
5. **Interpolate** with the same formula as today, so results match.

Optimizations worth having:

- **Skip row groups** whose footer `[min, max]` cannot intersect a target bucket in every pass after the first. On clustered or sorted columns this skips nearly everything.
- **Per-bucket min and max** (2 more 512 KB arrays) let a bucket whose values are all identical be answered at once, and let a narrow bucket be re-binned over its actual range instead of by bits.
- **Zero-pass case:** when the column index shows page bounds ascending and non-overlapping, the page holding a given rank follows from cumulative non-null counts, and one page decoded and selected within answers it.
- **Counters** as `Uint32Array` overflow past about 4.29 billion values in one bucket; use `Float64Array` beyond that.

The alternative to bit-based digits is an equal-width histogram over the footer's `[min, max]`, which gives a guaranteed value interval for every quantile after one pass. It behaves badly on heavy-tailed data (almost everything lands in the lowest bins); bit-based digits are scale-free, which is why they suit floating point.

## A prototype: what was measured

A throwaway script (not committed) implemented the method above for float64 with four 16-bit digits, a one-million-value gather threshold, and batches of 2^20 values. "Feeding" the algorithm a pass re-reads the column in batches, standing in for decoding it again.

**Correctness.** Seven quantiles (0, P1, P25, median, P90, P99, 1) on 11 datasets of up to 1 million values were compared, bit for bit, against a full sort: uniform, normal, log-normal, integers 0-999 (heavy duplicates), mixed signs, a clustered narrow range, all-equal, a sorted ramp, `n = 1`, `n = 2`, and a set full of `±0`, `±Infinity`, denormals, extreme magnitudes and NaN. All 11 matched.

**Passes and memory (10 million values).**

| distribution | passes | extra memory |
|---|---|---|
| uniform, normal, log-normal, integers, mixed signs | 2 | 256 KB of counters plus at most 2.4 MB gathered |
| clustered in a narrow range (`1000 + tiny`), all-equal | 4 | at most 1 MB of counters |

The column itself is 76 MB as one typed array. The narrow-range and all-equal cases are the worst case: the top digits are identical, so every pass narrows nothing until the low digits. The per-bucket min/max optimization above is aimed at exactly these.

**Speed (10 million values, in memory; Apple M4, Node 26.8.1).** The selection took about 60-85 ms per pass, 120-230 ms in total for three quantiles, against 355-740 ms for copying and sorting a `Float64Array`, so 3-5 times faster. For reference, the page's current approach (a JS array sorted with a comparator) took roughly 2-4 s on uniform and small-integer data in the same environment (a first, less controlled run that also includes building the array), and held the whole array.

**What this does not show.** Parquet decoding is not included, and in the real page it is the dominant cost: each pass is another decode of the column's chunks, which is why two passes versus one matters, and why row-group skipping and reading only the needed column pay off. It is single-threaded, has no null handling, no `int64`/decimal keys, and is not integrated with anything.

## Dictionary-encoded columns

A dictionary is small, and Parquet stores the indices as RLE/bit-packed runs. Counting per dictionary index, without materializing values, gives:

- exact top values, `MODE` and distinct count (per chunk; merge dictionaries by value across row groups);
- **exact quantiles in one pass**: sort the dictionary (or use `is_sorted`), accumulate the counts, read off the rank. Memory is the dictionary size;
- work proportional to the number of *runs*, not rows, since an RLE run contributes its length at once.

This needs a decoder path that keeps the indices instead of expanding them (`decodeValues` currently does `dict[idx[i]]` per row).

## Approximate answers, and when they are worth it

Exact stays the default, in line with the README ("percentiles are exact, not sketched"). Sketches earn a place in two cases:

- an **instant approximate answer** while the exact passes run, clearly labelled with its error;
- **sketch then verify**: a sketch bounds the answer to `[lo, hi]`; a second pass counts the values below `lo` and gathers those inside the band (about `2εN` values), giving the exact answer in two passes.

The radix method's first pass already yields a guaranteed interval for every quantile at no extra cost, so a sketch is optional. Which sketch (KLL for guarantees and mergeability, t-digest for tails) is a decision for after measurement.

## Scheduling, in a browser

- **Batch by row group**, the natural unit (finer with the page index), with the working set capped by a byte budget shared with #16, not a row count.
- **Visible first.** The cards are virtualized; compute what is on screen, the rest in the background, and cancel on navigation.
- **One decode, many statistics.** Statistics on the same column share a decode; all requested quantiles share the radix passes.
- **Workers.** The decode pool already returns typed arrays as transferables; a summary per batch is small enough to send back and merge on the main thread.
- **Say what was done,** as `Scan file` does: passes used, row groups skipped, and whether the figure is exact or approximate.
- **Memory accounting** is the page's own, tracking bytes it allocates: `performance.measureUserAgentSpecificMemory()` needs cross-origin isolation, which a `file://` page does not have.

## What summaries cannot bound

A **high-cardinality `GROUP BY`** (memory is the number of groups), **exact distinct counts** on high-cardinality columns, **joins**, an **unbounded full sort**, and **per-group percentiles** with many groups (one sketch per group). These need external-memory algorithms, partitioned hash aggregation and joins (Kitsuregawa et al.'s Grace hash join; Graefe's 1993 survey of query evaluation techniques) and a spill target: [#16](https://github.com/CynicDog/paris-parquet/issues/16). The aim of this work is to take the statistics off that list so far less needs spilling.

## How to verify it

The project checks against ground truth, and this fits.

1. **Oracle:** exact results equal today's `quantileOf` on data that fits, and DuckDB's `QUANTILE_CONT` in `check-query.mjs`, across the fixture corpus.
2. **Properties:** merge is associative and commutative; the key mapping is strictly monotonic across all float classes (`-0`, denormals, `±Infinity`, NaN excluded); results do not depend on batch size, batch order or worker count.
3. **Fuzz** the key mapping and the radix loop with adversarial distributions (clustered, duplicate-heavy, sorted, reverse-sorted).
4. **A generator** for a 10M x 200 fixture (mixed types; dictionary and plain; sorted, clustered and random; heavy nulls) in `tools/`, and a browser test recording peak memory and time for open, the summary cards and P99, before and after.
5. **Determinism** test: the same input gives byte-identical output over many runs.

## References

- Aggarwal and Vitter, "The input/output complexity of sorting and related problems", *CACM* 31(9), 1988.
- Alon, Matias and Szegedy, "The space complexity of approximating the frequency moments", STOC 1996.
- Muthukrishnan, "Data Streams: Algorithms and Applications", *Foundations and Trends in TCS*, 2005.
- Munro and Paterson, "Selection and sorting with limited storage", *Theoretical Computer Science* 12, 1980. <https://www.sciencedirect.com/science/article/pii/0304397580900614>
- Chakrabarti, Jayram and Pătraşcu, "Tight lower bounds for selection in randomly ordered streams", SODA 2008.
- Hoare, "Algorithm 65: Find", *CACM* 1961; Blum, Floyd, Pratt, Rivest and Tarjan, "Time bounds for selection", 1973.
- Agarwal, Cormode, Huang, Phillips, Wei and Yi, "Mergeable summaries", PODS 2012 / *ACM TODS* 2013. <https://dl.acm.org/doi/abs/10.1145/2500128>
- Manku, Rajagopalan and Lindsay, "Approximate medians and other quantiles in one pass and with limited memory", SIGMOD 1998.
- Greenwald and Khanna, "Space-efficient online computation of quantile summaries", SIGMOD 2001.
- Karnin, Lang and Liberty, "Optimal quantile approximation in streams", FOCS 2016.
- Dunning and Ertl, "Computing extremely accurate quantiles using t-digests"; Masson, Rim and Lee, "DDSketch: a fast and fully-mergeable quantile sketch with relative-error guarantees", VLDB 2019.
- Flajolet and Martin, 1985; Flajolet, Fusy, Gandouet and Meunier, "HyperLogLog", 2007; Heule, Nunkesser and Hall, "HyperLogLog in practice", EDBT 2013.
- Misra and Gries, "Finding repeated elements", 1982; Manku and Motwani, "Approximate frequency counts over data streams", VLDB 2002; Metwally, Agrawal and El Abbadi, "Efficient computation of frequent and top-k elements in data streams", ICDT 2005; Cormode and Hadjieleftheriou, "Finding frequent items in data streams", VLDB 2008.
- Welford, 1962; Chan, Golub and LeVeque, "Algorithms for computing the sample variance", *The American Statistician* 1983; Pébay, "Formulas for robust, one-pass parallel computation of covariances and arbitrary-order statistical moments", 2008.
- Moerkotte, "Small materialized aggregates: a light weight index structure for data warehousing", VLDB 1998.
- Abadi, Madden and Ferreira, "Integrating compression and execution in column-oriented database systems", SIGMOD 2006.
- Alabi, Blanchard, Gordon and Steinbach, "Fast k-selection algorithms for graphics processing units", *ACM J. Experimental Algorithmics* 2012.
- Kitsuregawa, Tanaka and Moto-oka, 1983 (Grace hash join); Graefe, "Query evaluation techniques for large databases", *ACM Computing Surveys* 1993.
- Apache Parquet format specification, `parquet.thrift`: <https://github.com/apache/parquet-format>
- DuckDB aggregate functions (`approx_quantile`, `quantile_cont`): <https://duckdb.org/docs/current/sql/functions/aggregates>; Spark `percentile_approx`: <https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.percentile_approx.html>
