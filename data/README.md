# data/

Three small parquet files (27 KB in total) so the features have something to
be tried on straight away — open `index.html`, drop `orders.parquet` on it,
then use **Folder** in the header to move between the three.

They are generated, deterministically, by `tools/sample-data.py`, and checked
in rather than generated on demand: the point is that a clone has something to
open without installing pyarrow first.

| file | rows | cols | codec | what it is |
|---|---|---|---|---|
| `customers.parquet` | 40 | 7 | gzip | who ordered — city, country, tier, signup date, a nullable `newsletter` flag |
| `products.parquet` | 12 | 5 | uncompressed | the catalogue — category, `unit_price` as a real decimal, `in_stock` |
| `orders.parquet` | 600 | 8 | snappy, 6 row groups | the fact table — references both, with quantity, amount, timestamp, status and a mostly-null `note` |

## Things to try

**Join** — `orders` is the one to open first, and it joins two ways:

- `orders.customer_id` → `customers.customer_id`. 27 of the 600 orders are
  guest orders (`customer_id` 9999) matching no customer, so the inner join
  returns 573 rows — the drop is the point, it's what makes it visibly an
  inner join and not a pad-with-nulls one.
- `orders.product_id` → `products.product_id`, where every row matches. The
  keys don't have to share a name, so joining `orders.product_id` to a
  renamed column works the same way.

`customers` and `products` are both much smaller than `orders`, so they're the
side that gets hashed and `orders` is the side whose row groups get narrowed —
the join panel reports how many of its 6 it actually read.

**Group by / pivot** — join in `customers`, then `GROUP BY country` with
`SUM(amount)` and `COUNT(*)`; add `status` as a second key and switch to
*pivot* to get one column per status, or *rollup* / *cube* for subtotal rows.
`country` × `category` (via the products join) is the other pairing worth
pivoting.

**Scan file** — `orders` is written in 100-row groups, ordered by
`ordered_at`, so a filter like `ordered_at > '2024-06-01'` prunes most of them
and the panel says which and why. `order_id` works the same way; `status`
doesn't, and that's worth seeing too.

**Diff** — the two lookups have unrelated schemas, so the interesting diff is
a file against itself (every file is expected to diff clean) — or regenerate
after editing `tools/sample-data.py` and diff the result against the copy in
git.

## Regenerating

```sh
python3 tools/sample-data.py              # needs pyarrow; writes data/
uv run --with pyarrow tools/sample-data.py   # or without installing it
```

It is seeded, so an unedited regeneration is byte-identical and leaves
`git status` clean — as long as it is the same pyarrow, which stamps its own
version into the footer.
