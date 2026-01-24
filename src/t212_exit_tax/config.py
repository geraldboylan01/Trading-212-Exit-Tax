from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    # Trading 212 API (Public API v0)
    t212_api_key: str
    t212_api_secret: str
    t212_base_url: str

    # Ireland
    irl_exit_tax_rate: float
    local_timezone: str

    # Paths
    data_dir: Path
    output_dir: Path


def load_settings(env_path: str | None = None) -> Settings:
    """
    Loads settings from .env + environment variables.

    env_path:
      - None => loads ".env" if present in current working directory
      - or a specific path to an env file
    """
    if env_path:
        load_dotenv(env_path)
    else:
        load_dotenv()

    # Trading 212
    t212_api_key = os.getenv("T212_API_KEY", "").strip()
    t212_api_secret = os.getenv("T212_API_SECRET", "").strip()
    t212_base_url = os.getenv("T212_BASE_URL", "https://live.trading212.com/api/v0").strip()

    # Ireland
    irl_exit_tax_rate = float(os.getenv("IRL_EXIT_TAX_RATE", "0.38"))
    local_timezone = os.getenv("LOCAL_TIMEZONE", "Europe/Dublin").strip()

    # Project paths
    data_dir = Path(os.getenv("DATA_DIR", "data")).resolve()
    output_dir = Path(os.getenv("OUTPUT_DIR", "output")).resolve()

    data_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    return Settings(
        t212_api_key=t212_api_key,
        t212_api_secret=t212_api_secret,
        t212_base_url=t212_base_url,
        irl_exit_tax_rate=irl_exit_tax_rate,
        local_timezone=local_timezone,
        data_dir=data_dir,
        output_dir=output_dir,
    )