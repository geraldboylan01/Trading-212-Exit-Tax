from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import csv


@dataclass
class SnapshotRow:
    ticker: str
    isin: str
    name: str
    currency: str
    quantity: float
    avg_price_paid: float | None
    current_price: float | None
    total_cost: float | None
    current_value: float | None
    unrealized_pl: float | None


def _f(x: Any) -> float | None:
    try:
        return None if x is None else float(x)
    except Exception:
        return None


def load_positions(path: Path) -> list[SnapshotRow]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rows: list[SnapshotRow] = []

    for p in data:
        inst = p.get("instrument", {}) or {}
        wi = p.get("walletImpact", {}) or {}

        rows.append(
            SnapshotRow(
                ticker=str(inst.get("ticker", "")),
                isin=str(inst.get("isin", "")),
                name=str(inst.get("name", "")),
                currency=str(inst.get("currency", "")) or str(wi.get("currency", "")),
                quantity=_f(p.get("quantity")) or 0.0,
                avg_price_paid=_f(p.get("averagePricePaid")),
                current_price=_f(p.get("currentPrice")),
                total_cost=_f(wi.get("totalCost")),
                current_value=_f(wi.get("currentValue")),
                unrealized_pl=_f(wi.get("unrealizedProfitLoss")),
            )
        )

    return rows


def write_snapshot_csv(rows: list[SnapshotRow], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "ticker",
                "isin",
                "name",
                "currency",
                "quantity",
                "avg_price_paid",
                "current_price",
                "total_cost",
                "current_value",
                "unrealized_pl",
                "unrealized_pl_pct",
            ]
        )

        for r in rows:
            pl_pct = None
            if r.total_cost not in (None, 0.0) and r.unrealized_pl is not None:
                pl_pct = r.unrealized_pl / r.total_cost

            w.writerow(
                [
                    r.ticker,
                    r.isin,
                    r.name,
                    r.currency,
                    r.quantity,
                    r.avg_price_paid,
                    r.current_price,
                    r.total_cost,
                    r.current_value,
                    r.unrealized_pl,
                    pl_pct,
                ]
            )