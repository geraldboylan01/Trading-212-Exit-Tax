import typer
from t212_exit_tax.config import load_settings
from t212_exit_tax.instruments import INSTRUMENTS
from pathlib import Path
from t212_exit_tax.snapshot import load_positions, write_snapshot_csv
from t212_exit_tax.exit_tax import compute_exit_tax_from_positions
from t212_exit_tax.instrument_db import InstrumentDB
import json

from t212_exit_tax.t212_client import T212Client

app = typer.Typer(no_args_is_help=True)


@app.command()
def ping():
    settings = load_settings()
    typer.echo("OK – CLI running")
    typer.echo(f"Exit tax rate: {settings.irl_exit_tax_rate}")
    typer.echo(f"Timezone: {settings.local_timezone}")


@app.command()
def calc(symbol: str = "VWCE"):
    symbol = symbol.upper().strip()
    if symbol not in INSTRUMENTS:
        available = ", ".join(sorted(INSTRUMENTS.keys()))
        raise typer.BadParameter(f"Unknown symbol '{symbol}'. Available: {available}")

    typer.echo(f"Phase 1 stub for {symbol}")
    typer.echo(INSTRUMENTS[symbol]["name"])

@app.command()
def sync():
    """
    Pull raw Trading 212 data via API and save into data/raw/.
    """
    settings = load_settings()

    if not settings.t212_api_key or not settings.t212_api_secret:
        raise typer.BadParameter("Missing T212_API_KEY or T212_API_SECRET in .env")

    raw_dir = settings.data_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    client = T212Client(
        base_url=settings.t212_base_url,
        api_key=settings.t212_api_key,
        api_secret=settings.t212_api_secret,
    )

    # Endpoints per T212 Public API v0 history section:
    transactions = client.get_all_pages("/equity/history/transactions")
    # dividends = client.get_all_pages("/equity/history/dividends")

    (raw_dir / "transactions.json").write_text(json.dumps(transactions, indent=2), encoding="utf-8")
    # (raw_dir / "dividends.json").write_text(json.dumps(dividends, indent=2), encoding="utf-8")

    typer.echo(f"Saved {len(transactions)} transactions -> {raw_dir/'transactions.json'}")
    typer.echo(f"Saved {len(transactions)} transactions -> {raw_dir/'transactions.json'}")
    # typer.echo(f"Saved {len(dividends)} dividends -> {raw_dir/'dividends.json'}")

@app.command("probe")
def probe():
    """
    Probe a few likely endpoints and print status codes.
    Helps us discover which endpoints are enabled in the current environment.
    """
    settings = load_settings()

    client = T212Client(
        base_url=settings.t212_base_url,
        api_key=settings.t212_api_key,
        api_secret=settings.t212_api_secret,
    )

    candidates = [
        "/equity/portfolio",
        "/equity/portfolio/positions",
        "/equity/positions",
        "/equity/account/cash",
        "/equity/account",
        "/equity/instruments",
        "/equity/metadata/instruments",
    ]

    for path in candidates:
        try:
            _ = client.get_json(path)
            typer.echo(f"OK 200  {path}")
        except Exception as e:
            msg = str(e)
            # keep it simple: show the path + error summary
            typer.echo(f"FAIL    {path}  -> {msg.splitlines()[0]}")

@app.command()
def holdings():
    settings = load_settings()

    raw_dir = settings.data_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    client = T212Client(
        base_url=settings.t212_base_url,
        api_key=settings.t212_api_key,
        api_secret=settings.t212_api_secret,
    )

    positions = client.get_json("/equity/positions")

    (raw_dir / "positions.json").write_text(
        json.dumps(positions, indent=2),
        encoding="utf-8"
    )

    typer.echo(f"Saved positions -> {raw_dir/'positions.json'}")

@app.command()
def snapshot():
    """
    Create a simple valuation snapshot CSV from data/raw/positions.json
    """
    settings = load_settings()

    raw_dir = settings.data_dir / "raw"
    pos_path = raw_dir / "positions.json"
    if not pos_path.exists():
        raise typer.BadParameter("positions.json not found. Run: t212-exit-tax holdings")

    rows = load_positions(pos_path)

    out_path = settings.output_dir / "snapshot.csv"
    write_snapshot_csv(rows, out_path)

    typer.echo(f"Wrote snapshot -> {out_path} (rows: {len(rows)})")

@app.command("exit-tax")
def exit_tax():
    """
    Computes exit tax due today (as if deemed disposal happened today)
    and prints the next deemed disposal date per holding.
    """
    settings = load_settings()

    db_path = settings.data_dir / "clean" / "exit_tax_instruments_by_isin.json"
    if not db_path.exists():
        raise typer.BadParameter(f"Instrument DB not found at {db_path}")

    db = InstrumentDB.load(db_path)
    if db.count() == 0:
        raise typer.BadParameter(f"Instrument DB at {db_path} is empty.")

    pos_path = settings.data_dir / "raw" / "positions.json"
    if not pos_path.exists():
        raise typer.BadParameter("positions.json not found. Run: t212-exit-tax holdings")

    rows = compute_exit_tax_from_positions(
        positions_path=pos_path,
        exit_tax_rate=settings.irl_exit_tax_rate,
    )

    total_rows = len(rows)
    rows = [r for r in rows if db.is_exit_tax(r.isin)]
    typer.echo(f"Holdings scanned: {total_rows} | exit-tax matched: {len(rows)} | excluded: {total_rows - len(rows)}")

    if not rows:
        typer.echo("No exit-tax (ETF/INDEX) holdings found in positions.")
        raise typer.Exit(code=0)

    typer.echo("")
    typer.echo("Exit tax snapshot (deemed disposal if today)")
    typer.echo("==========================================")

    total_tax = 0.0
    for r in rows:
        total_tax += r.exit_tax_due_today
        typer.echo("")
        typer.echo(f"{r.ticker} | {r.name} | {r.currency}")
        typer.echo(f"ISIN: {r.isin}")
        typer.echo(f"Start date (createdAt): {r.created_at.date().isoformat()}")
        typer.echo(f"Next deemed disposal:   {r.deemed_disposal_date.isoformat()}")
        typer.echo(f"Base cost:              {r.total_cost:.2f}")
        typer.echo(f"Market value:           {r.current_value:.2f}")
        typer.echo(f"Unrealised P/L:         {r.unrealised_pl:.2f}")
        typer.echo(f"Taxable gain today:     {r.taxable_gain_today:.2f}")
        typer.echo(f"Exit tax due today:     {r.exit_tax_due_today:.2f}  (rate={settings.irl_exit_tax_rate:.2f})")

    typer.echo("")
    typer.echo("------------------------------------------")
    typer.echo(f"TOTAL exit tax due today: {total_tax:.2f}")
    typer.echo("")

@app.command("debug-db")
def debug_db():
    """
    Diagnose instrument DB loading and ISIN matching.
    """
    settings = load_settings()
    db_path = settings.data_dir / "clean" / "exit_tax_instruments_by_isin.json"
    pos_path = settings.data_dir / "raw" / "positions.json"

    typer.echo(f"data_dir: {settings.data_dir}")
    typer.echo(f"db_path: {db_path}")
    typer.echo(f"db_exists: {db_path.exists()}")

    raw = None
    if db_path.exists():
        try:
            raw = json.loads(db_path.read_text(encoding="utf-8"))
            raw_type = type(raw).__name__
            raw_count = len(raw) if isinstance(raw, (dict, list)) else 0
            typer.echo(f"db_json_type: {raw_type} ({raw_count} items)")
        except Exception as e:
            typer.echo(f"db_json_error: {e}")
            raw = None

    db = None
    if raw is not None:
        try:
            db = InstrumentDB.load(db_path)
            typer.echo(f"db_isin_sample: {db.sample_isins(5)}")
        except Exception as e:
            typer.echo(f"db_load_error: {e}")

    typer.echo(f"positions_path: {pos_path}")
    typer.echo(f"positions_exists: {pos_path.exists()}")

    if pos_path.exists():
        try:
            rows = compute_exit_tax_from_positions(
                positions_path=pos_path,
                exit_tax_rate=settings.irl_exit_tax_rate,
            )
            sample = []
            for r in rows[:5]:
                norm = InstrumentDB.normalize_isin(r.isin)
                matched = db.is_exit_tax(r.isin) if db else False
                sample.append({"isin": norm, "exit_tax": matched})
            typer.echo(f"positions_isin_sample: {sample}")
        except Exception as e:
            typer.echo(f"positions_error: {e}")

if __name__ == "__main__":
    app()
