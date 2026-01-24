from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any


@dataclass
class ExitTaxRow:
    ticker: str
    isin: str
    name: str
    currency: str

    created_at: datetime
    deemed_disposal_date: date

    total_cost: float
    current_value: float
    unrealised_pl: float

    taxable_gain_today: float
    exit_tax_due_today: float


def _to_float(x: Any, default: float = 0.0) -> float:
    try:
        return float(x)
    except Exception:
        return default


def _add_years(d: date, years: int) -> date:
    """
    Add years to a date safely (handles Feb 29 -> Feb 28).
    """
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        # e.g., 29 Feb -> 28 Feb on non-leap year
        return d.replace(month=2, day=28, year=d.year + years)


def _parse_datetime(s: str) -> datetime:
    """
    Parse ISO strings like:
      2026-01-22T10:05:14.015+02:00
      2020-05-11T17:55:09.000Z
    """
    s = (s or "").strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def compute_exit_tax_from_positions(
    positions_path: Path,
    exit_tax_rate: float,
) -> list[ExitTaxRow]:
    data = json.loads(positions_path.read_text(encoding="utf-8"))
    rows: list[ExitTaxRow] = []

    for p in data:
        inst = p.get("instrument", {}) or {}
        wi = p.get("walletImpact", {}) or {}

        ticker = str(inst.get("ticker", ""))
        isin = str(inst.get("isin", ""))
        name = str(inst.get("name", ""))
        currency = str(wi.get("currency") or inst.get("currency") or "")

        created_at_raw = str(p.get("createdAt", "")).strip()
        created_at = _parse_datetime(created_at_raw) if created_at_raw else datetime.now()
        deemed_date = _add_years(created_at.date(), 8)

        total_cost = _to_float(wi.get("totalCost"), 0.0)
        current_value = _to_float(wi.get("currentValue"), 0.0)
        unrealised_pl = _to_float(wi.get("unrealizedProfitLoss"), current_value - total_cost)

        taxable_gain_today = max(current_value - total_cost, 0.0)
        exit_tax_due_today = taxable_gain_today * float(exit_tax_rate)

        rows.append(
            ExitTaxRow(
                ticker=ticker,
                isin=isin,
                name=name,
                currency=currency,
                created_at=created_at,
                deemed_disposal_date=deemed_date,
                total_cost=total_cost,
                current_value=current_value,
                unrealised_pl=unrealised_pl,
                taxable_gain_today=taxable_gain_today,
                exit_tax_due_today=exit_tax_due_today,
            )
        )

    return rows