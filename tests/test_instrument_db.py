import json

from t212_exit_tax.instrument_db import InstrumentDB


def test_load_dict_shape_and_normalization(tmp_path):
    payload = {
        "ie00  b3": {"TYPE": "ETF"},
        "GB00 0000": {"TYPE": "EQUITY"},
    }
    path = tmp_path / "db.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    db = InstrumentDB.load(path)
    assert db.count() == 2
    assert db.is_exit_tax("ie00 b3") is True
    assert db.is_exit_tax("gb00 0000") is False


def test_load_list_shape_and_isin_key_variants(tmp_path):
    payload = [
        {"isin": " ie00b3 ", "type": "index"},
        {"ISIN": "GB00 0000", "TYPE": "Equity"},
        {"foo": "bar"},
    ]
    path = tmp_path / "db.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    db = InstrumentDB.load(path)
    assert db.count() == 2
    assert db.is_exit_tax("IE00 B3") is True
    assert db.is_exit_tax("gb00 0000") is False
