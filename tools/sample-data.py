#!/usr/bin/env python3
"""Writes the three small parquet files in data/ -- the sample corpus shipped
with the repo so the features have something to be tried on out of the box.

    python3 tools/sample-data.py            # -> data/
    uv run --with pyarrow tools/sample-data.py

Unlike tests/support/fixtures.py, which writes a large corpus covering every codec,
encoding and awkward type, this is a tiny, readable, plausible shop: customers,
products, the orders that reference both, and a partitioned folder of events.
It is deterministic (seeded), so
regenerating it against the same pyarrow produces byte-identical
files and an empty diff (the writer stamps its own version into the footer).

The shapes are chosen for the features, not for volume:
  - two different join keys, one int and one that needs renaming across sides
  - a handful of orders whose customer is not in customers, so an inner join
    visibly drops rows rather than padding them
  - low-cardinality columns (country, category, status) worth grouping and
    pivoting on, nulls in a few columns, a decimal, a date and a timestamp
  - orders written in small row groups, so pushdown has something to skip
  - data/events/, hive-partitioned, for Open folder / the folder tree: several
    parts that read as one table, with year and month as real columns, plus a
    _SUCCESS file that must be ignored
"""
import datetime
import decimal
import os
import random
import shutil
import sys

import pyarrow as pa
import pyarrow.parquet as pq

random.seed(11)

CITIES = [("Paris", "FR"), ("Lyon", "FR"), ("Berlin", "DE"), ("Hamburg", "DE"),
          ("Seoul", "KR"), ("Busan", "KR"), ("Madrid", "ES"), ("Porto", "PT")]
FIRST = ["Alice", "Bruno", "Carla", "Dimitri", "Eun", "Farid", "Greta", "Hugo",
         "Ines", "Jonas", "Kaya", "Luca", "Mina", "Noor", "Olav", "Pia",
         "Quentin", "Rosa", "Sven", "Tara"]
LAST = ["Andrieu", "Bauer", "Costa", "Duval", "Engel", "Ferreira", "Gruber",
        "Han", "Iversen", "Jung", "Klein", "Lemoine", "Moreau", "Novak",
        "Oliveira", "Park", "Quintana", "Rossi", "Silva", "Toussaint"]
TIERS = ["free", "plus", "pro"]
PRODUCTS = [
    ("Espresso machine", "kitchen", "249.00"), ("Milk frother", "kitchen", "39.50"),
    ("Cast iron pan", "kitchen", "62.00"), ("Kettle", "kitchen", "44.90"),
    ("Desk lamp", "office", "58.00"), ("Standing desk", "office", "429.00"),
    ("Ergonomic chair", "office", "312.50"), ("Monitor arm", "office", "89.00"),
    ("Hiking backpack", "outdoor", "134.00"), ("Camping stove", "outdoor", "76.25"),
    ("Headlamp", "outdoor", "28.00"), ("Wool blanket", "home", "95.00"),
]
STATUS = ["paid", "paid", "paid", "pending", "refunded"]


def customers(n=40):
    """Small enough to read whole; the side a join hashes."""
    rows = []
    for i in range(n):
        city, country = CITIES[i % len(CITIES)]
        rows.append({
            "customer_id": 1000 + i,
            "name": "%s %s" % (FIRST[i % len(FIRST)], LAST[(i * 7) % len(LAST)]),
            "city": city,
            "country": country,
            "tier": TIERS[i % 3],
            "signup_date": datetime.date(2023, 1, 1) + datetime.timedelta(days=i * 13),
            # a nullable boolean, so the summary card shows a true/false/null bar
            "newsletter": None if i % 9 == 0 else bool(i % 3),
        })
    return pa.table({
        "customer_id": pa.array([r["customer_id"] for r in rows], pa.int32()),
        "name": pa.array([r["name"] for r in rows], pa.string()),
        "city": pa.array([r["city"] for r in rows], pa.string()),
        "country": pa.array([r["country"] for r in rows], pa.string()),
        "tier": pa.array([r["tier"] for r in rows]).dictionary_encode(),
        "signup_date": pa.array([r["signup_date"] for r in rows], pa.date32()),
        "newsletter": pa.array([r["newsletter"] for r in rows], pa.bool_()),
    })


def products():
    """A lookup table: 12 rows, no nulls, a decimal price."""
    return pa.table({
        "product_id": pa.array([1 + i for i in range(len(PRODUCTS))], pa.int32()),
        "product_name": pa.array([p[0] for p in PRODUCTS], pa.string()),
        "category": pa.array([p[1] for p in PRODUCTS]).dictionary_encode(),
        "unit_price": pa.array([decimal.Decimal(p[2]) for p in PRODUCTS], pa.decimal128(9, 2)),
        "in_stock": pa.array([i % 5 != 3 for i in range(len(PRODUCTS))], pa.bool_()),
    })


def orders(n=600, n_customers=40):
    """The fact table: references both lookups, plus ~4% guest orders whose
    customer_id is in neither -- an inner join must drop those."""
    ids, cust, prod, qty, amount, at, status, note = [], [], [], [], [], [], [], []
    start = datetime.datetime(2024, 1, 2, 9, 0)
    for i in range(n):
        guest = i % 23 == 0
        c = 9999 if guest else 1000 + random.randrange(n_customers)
        p = 1 + random.randrange(len(PRODUCTS))
        q = 1 + random.randrange(4)
        ids.append(500000 + i)
        cust.append(c)
        prod.append(p)
        qty.append(q)
        amount.append(decimal.Decimal(PRODUCTS[p - 1][2]) * q)
        at.append(start + datetime.timedelta(minutes=i * 97))
        status.append(STATUS[random.randrange(len(STATUS))])
        note.append(None if i % 4 else random.choice(["gift wrap", "leave at door", "call on arrival"]))
    return pa.table({
        "order_id": pa.array(ids, pa.int64()),
        "customer_id": pa.array(cust, pa.int32()),
        "product_id": pa.array(prod, pa.int32()),
        "quantity": pa.array(qty, pa.int32()),
        "amount": pa.array(amount, pa.decimal128(12, 2)),
        "ordered_at": pa.array(at, pa.timestamp("ms")),
        "status": pa.array(status).dictionary_encode(),
        "note": pa.array(note, pa.string()),
    })


EVENTS = ["view", "view", "view", "add_to_cart", "checkout", "support_ticket"]


def events_part(year, month, n):
    """One partition of data/events/. year and month are deliberately NOT
    columns -- the reader derives them from the directory names."""
    start = datetime.datetime(year, month, 1, 8, 0)
    return pa.table({
        "event_id": pa.array(["%d%02d-%04d" % (year, month, i) for i in range(n)], pa.string()),
        "customer_id": pa.array([1000 + random.randrange(40) for _ in range(n)], pa.int32()),
        "event": pa.array([random.choice(EVENTS) for _ in range(n)]).dictionary_encode(),
        "seconds": pa.array([round(random.uniform(1.5, 600), 1) for _ in range(n)], pa.float64()),
        "at": pa.array([start + datetime.timedelta(minutes=i * 41) for i in range(n)], pa.timestamp("ms")),
    })


def folder(root):
    """A hive-partitioned folder: four parts that read as one 256-row table
    with year and month recovered from the path. The _SUCCESS marker is there
    on purpose -- the ecosystem leaves them lying around and the reader has to
    ignore them rather than choke."""
    shutil.rmtree(root, ignore_errors=True)
    for i, month in enumerate((1, 2, 3, 4)):
        d = os.path.join(root, "year=2024", "month=%02d" % month)
        os.makedirs(d, exist_ok=True)
        pq.write_table(events_part(2024, month, 58 + i * 4),
                       os.path.join(d, "part-0.parquet"), compression="snappy")
    open(os.path.join(root, "_SUCCESS"), "w").close()


def main(out):
    os.makedirs(out, exist_ok=True)
    # a different codec each, so the diff panel and the file card have something
    # to report beyond "snappy" three times over
    pq.write_table(customers(), os.path.join(out, "customers.parquet"), compression="gzip")
    pq.write_table(products(), os.path.join(out, "products.parquet"), compression="none")
    # small row groups: pushdown and the join's range narrowing can skip most of them
    pq.write_table(orders(), os.path.join(out, "orders.parquet"), compression="snappy", row_group_size=100)
    folder(os.path.join(out, "events"))
    for dirpath, dirnames, filenames in os.walk(out):
        dirnames.sort()
        for name in sorted(filenames):
            if not name.endswith(".parquet"):
                continue
            path = os.path.join(dirpath, name)
            f = pq.ParquetFile(path)
            print("%-38s %6d rows  %2d cols  %2d row groups  %6d bytes" %
                  (os.path.relpath(path, out), f.metadata.num_rows, f.metadata.num_columns,
                   f.metadata.num_row_groups, os.path.getsize(path)))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "data"))
