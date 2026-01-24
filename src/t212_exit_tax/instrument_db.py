from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class InstrumentInfo:
    isin: str
    ticker: str | None
    name: str | None
    type: str | None  # ETF / INDEX etc.


class InstrumentDB:
    def __init__(self, by_isin: dict[str, dict[str, Any]]):
        self._by_isin = by_isin

    @staticmethod
    def normalize_isin(isin: str) -> str:
        if isin is None:
            return ""
        return "".join(str(isin).strip().upper().split())

    @classmethod
    def load(cls, path: Path) -> "InstrumentDB":
        data = json.loads(path.read_text(encoding="utf-8"))

        # Shape A: dict keyed by ISIN
        if isinstance(data, dict):
            by_isin: dict[str, dict[str, Any]] = {}
            for k, v in data.items():
                norm = cls.normalize_isin(k)
                if not norm:
                    continue
                if isinstance(v, dict):
                    by_isin[norm] = v
                else:
                    # allow bare string values like "ETF"
                    by_isin[norm] = {"TYPE": v}
            return cls(by_isin)

        # Shape B: list of records each containing an ISIN field
        if isinstance(data, list):
            by_isin = {}
            for rec in data:
                if not isinstance(rec, dict):
                    continue
                isin_value = None
                for key in rec.keys():
                    if str(key).lower() == "isin":
                        isin_value = rec[key]
                        break
                norm = cls.normalize_isin(isin_value)
                if not norm:
                    continue
                by_isin[norm] = rec
            return cls(by_isin)

        raise ValueError("Instrument DB JSON must be a dict keyed by ISIN or a list of records with an 'isin' field.")

    def is_exit_tax(self, isin: str) -> bool:
        """
        ETFs + Indexes are exit tax.
        """
        norm = self.normalize_isin(isin)
        if not norm:
            return False

        rec = self._by_isin.get(norm)
        if not rec:
            return False

        t = str(rec.get("TYPE") or rec.get("type") or "").upper().strip()
        return t in {"ETF", "INDEX"}

    def get(self, isin: str) -> InstrumentInfo | None:
        norm = self.normalize_isin(isin)
        if not norm:
            return None

        rec = self._by_isin.get(norm)
        if not rec:
            return None

        return InstrumentInfo(
            isin=norm,
            ticker=rec.get("TICKER") or rec.get("ticker"),
            name=rec.get("NAME") or rec.get("name"),
            type=rec.get("TYPE") or rec.get("type"),
        )

    def count(self) -> int:
        return len(self._by_isin)

    def sample_isins(self, limit: int = 5) -> list[str]:
        if limit <= 0:
            return []
        return list(self._by_isin.keys())[:limit]
