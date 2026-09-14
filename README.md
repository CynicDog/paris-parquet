# paris-parquet

One HTML file that reads a parquet file and shows you what is in it.

No install, no server, no build step, no CDN, no network request of any kind.
Save `index.html`, open it in a browser, drop a `.parquet` file on it. The file
is read locally by the page; nothing is uploaded anywhere.

```
open index.html      # or double-click it, or mail it to someone
```

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

Both splits are draggable: the bar between the grid and the metadata panel
resizes the panel, and the right edge of any column header resizes that column
(double-click it to go back to the default width). The panel height is
remembered; column widths last for the session.

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

Known limits, on purpose: one self-contained file at a time (no partitioned
directories, no multi-file column chunks), encrypted parquet is reported and
refused, and nanosecond timestamps display at microsecond resolution.

## Tests

The `tools/` directory is for developing the file; none of it ships to a user.
It needs `pyarrow` (to write fixtures and to be the source of truth) and
optionally `playwright`.

```sh
python3 tools/fixtures.py /tmp/fx          # write fixtures + expected values
node tools/check.mjs /tmp/fx/*.parquet     # decode each one, compare every cell
node tools/fuzz-zstd.mjs 1000              # zstd decoder vs node's zstd encoder
node tools/browser.mjs /tmp/fx/a.parquet   # drive the page in real Chromium
```

`check.mjs` pulls the `<script>` out of `index.html` and runs it against a stub
DOM, so the tests exercise the shipped file rather than a copy of it.
