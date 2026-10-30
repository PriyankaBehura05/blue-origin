from datetime import date

import pandas as pd
import pytest

from app.processing import data_cleaner as dc


@pytest.mark.parametrize("raw,expected", [
    ("  Retailer  Name ", "retailer_name"),
    ("Net Sales (₹)", "net_sales"),
    ("PIN-Code", "pin_code"),
    ("ASM/RSM", "asm_rsm"),
])
def test_normalize_column_name(raw, expected):
    assert dc.normalize_column_name(raw) == expected


def test_normalize_columns_applies_aliases_and_dedupes():
    df = pd.DataFrame(columns=["Retailer", "Store Name", "Amount"])
    out, mapping = dc.normalize_columns(df, {"retailer": "retailer_name", "store_name": "retailer_name"})
    assert list(out.columns) == ["retailer_name", "retailer_name__1", "amount"]
    assert mapping["Retailer"] == "retailer_name"


@pytest.mark.parametrize("raw,expected", [
    ("₹1,23,456.50", 123456.5), ("Rs. 2,000/-", 2000.0), ("(500)", -500.0), ("-75", -75.0),
    ("1200-", -1200.0), (3000, 3000.0), ("", None), ("NA", None),
])
def test_parse_amount_valid_and_blank(raw, expected):
    value, err = dc.parse_amount(raw)
    assert err is None and value == expected


def test_parse_amount_invalid():
    value, err = dc.parse_amount("12 lakh")
    assert value is None and err


@pytest.mark.parametrize("raw,expected", [
    ("05-04-2025", date(2025, 4, 5)), ("05/04/2025", date(2025, 4, 5)), ("2025-04-05", date(2025, 4, 5)),
    ("05-Apr-2025", date(2025, 4, 5)), ("45752", date(2025, 4, 5)),
])
def test_parse_date_formats(raw, expected):
    value, err = dc.parse_date(raw)
    assert err is None and value == expected


def test_parse_date_invalid():
    value, err = dc.parse_date("31-02-2025")
    assert value is None and err


@pytest.mark.parametrize("d,fy,q", [
    (date(2025, 4, 1), "FY26", "Q1"), (date(2025, 9, 30), "FY26", "Q2"),
    (date(2025, 12, 31), "FY26", "Q3"), (date(2026, 3, 31), "FY26", "Q4"), (date(2026, 4, 1), "FY27", "Q1"),
])
def test_fiscal_labels(d, fy, q):
    assert dc.fiscal_year_label(d) == fy
    assert dc.fiscal_quarter(d) == q


def test_text_cleaning_and_name_key():
    assert dc.clean_text("  Mock   Store  ") == "Mock Store"
    assert dc.clean_text(" - ") is None
    assert dc.name_match_key("M/s. Mock & Co.") == dc.name_match_key("MOCK AND CO")
