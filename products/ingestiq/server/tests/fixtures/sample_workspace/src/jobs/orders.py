"""Sample order-processing tasks.

Each function receives its YAML ``parameters`` as keyword arguments and, if it
declares a ``ctx`` argument, a TaskContext with ``ctx.log()`` and
``ctx.workspace``. The return value must be JSON-serializable; it becomes the
task output available as ``${tasks.<key>.output}``.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path


def _out_dir(ctx, run_date: str | None = None) -> Path:
    path = ctx.workspace / "data" / "output" / (run_date or ctx.root_run_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _rel(ctx, path: Path) -> str:
    return str(path.relative_to(ctx.workspace))


def extract(source_file: str, run_date: str, ctx) -> dict:
    src = ctx.workspace / source_file
    with src.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    out = _out_dir(ctx, run_date) / "raw_orders.json"
    out.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    ctx.log(f"Extracted {len(rows)} rows from {source_file}")
    return {"path": _rel(ctx, out), "row_count": len(rows)}


def validate_orders(path: str, ctx, min_rows: int = 1) -> dict:
    rows = json.loads((ctx.workspace / path).read_text(encoding="utf-8"))
    valid, invalid = [], []
    for row in rows:
        try:
            ok = bool(row["order_id"].strip()) and float(row["amount"]) >= 0
        except (KeyError, ValueError):
            ok = False
        (valid if ok else invalid).append(row)
    for row in invalid:
        ctx.log(f"Rejected row: {row}")
    if len(valid) < min_rows:
        raise ValueError(f"Only {len(valid)} valid rows, expected at least {min_rows}")
    out = (ctx.workspace / path).with_name("valid_orders.json")
    out.write_text(json.dumps(valid, indent=2), encoding="utf-8")
    return {"path": _rel(ctx, out), "valid": len(valid), "invalid": len(invalid)}


def clean(input_path: str, ctx) -> dict:
    if not input_path:
        raise ValueError("input_path is required")
    rows = json.loads((ctx.workspace / input_path).read_text(encoding="utf-8"))
    cleaned = [
        {
            "order_id": int(r["order_id"]),
            "customer": r["customer"].strip().title(),
            "country": r["country"].strip().upper(),
            "amount": round(float(r["amount"]), 2),
            "status": r["status"].strip().lower(),
        }
        for r in rows
    ]
    out = (ctx.workspace / input_path).with_name("clean_orders.json")
    out.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")
    ctx.log(f"Cleaned {len(cleaned)} orders")
    return {"path": _rel(ctx, out), "count": len(cleaned)}


def aggregate(input_path: str, ctx) -> dict:
    rows = json.loads((ctx.workspace / input_path).read_text(encoding="utf-8"))
    by_country: dict[str, float] = defaultdict(float)
    for r in rows:
        if r["status"] == "paid":
            by_country[r["country"]] += r["amount"]
    summary = {k: round(v, 2) for k, v in sorted(by_country.items())}
    total = round(sum(summary.values()), 2)
    out = (ctx.workspace / input_path).with_name("summary.json")
    out.write_text(json.dumps({"total": total, "by_country": summary}, indent=2), encoding="utf-8")
    ctx.log(f"Total paid revenue: {total}")
    return {"summary_path": _rel(ctx, out), "total_revenue": total, "revenue_by_country": summary}
