from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
import httpx


@dataclass(frozen=True)
class T212Client:
    """
    Minimal client for Trading 212 Public API v0.
    Uses Basic Auth: (API_KEY, API_SECRET).
    """
    base_url: str
    api_key: str
    api_secret: str

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.base_url.rstrip("/"),
            auth=(self.api_key, self.api_secret),
            timeout=60.0,
            headers={"Accept": "application/json"},
        )

    def get_json(self, path: str, params: Optional[dict] = None) -> Any:
        with self._client() as c:
            r = c.get(path, params=params)
            r.raise_for_status()
            return r.json()

    def get_all_pages(self, path: str, params: Optional[dict] = None) -> List[Dict[str, Any]]:
        """
        Fetches paginated endpoints that return:
          { "items": [...], "nextPagePath": "/..." }
        and follows nextPagePath until None.

        Returns a flat list of items.
        """
        items: List[Dict[str, Any]] = []
        next_path: Optional[str] = path
        first_params = params

        with self._client() as c:
            while next_path:
                r = c.get(next_path, params=first_params)
                r.raise_for_status()
                payload = r.json()

                page_items = payload.get("items", [])
                items.extend(page_items)

                next_path = payload.get("nextPagePath")
                first_params = None  # only use params on the first request

        return items