from datetime import date

import pandas as pd

from app.core.constants import DatasetType
from app.processing.data_validator import validate_dataframe
from app.processing.dataset_specs import get_spec

TODAY = date(2026, 10, 6)


def _issue_codes(result):
    return {i.code for i in result.issues}


def test_missing_required_columns_blocks_processing():
    df = pd.DataFrame({"retailer_name": ["A"]})
    r = validate_dataframe(df, get_spec(DatasetType.SALES), today=TODAY)
    assert not r.can_process
    assert set(r.missing_required_columns) == {"invoice_date", "distributor_name", "net_sales_amount"}


def test_header_only_file_is_reported():
    df = pd.DataFrame(columns=["distributor_name"])
    r = validate_dataframe(df, get_spec(DatasetType.DISTRIBUTORS), today=TODAY)
    assert not r.can_process and r.file_errors[0].code == "NO_DATA_ROWS"


def test_row_statuses_and_nothing_deleted():
    df = pd.DataFrame({
        "Invoice Date": ["05-04-2025", "bad", "05-04-2025", "06-04-2025", "07-04-2025", "05-04-2025"],
        "Retailer": ["A", "B", "", "D", "E", "A"],
        "Distributor": ["X", "X", "X", "X", "X", "X"],
        "Net Sales": ["100", "200", "300", "0", "abc", "100"],
    })
    r = validate_dataframe(df, get_spec(DatasetType.SALES), today=TODAY)
    statuses = r.clean["_row_status"].tolist()
    assert len(r.clean) == 6                      # never deletes rows
    assert statuses == ["valid", "invalid", "missing", "needs_review", "invalid", "duplicate"]
    assert r.clean["_source_row"].tolist() == [2, 3, 4, 5, 6, 7]
    assert {"INVALID_DATE", "REQUIRED_VALUE_MISSING", "ZERO_VALUE", "INVALID_NUMBER",
            "DUPLICATE_ROW"} <= _issue_codes(r)


def test_negative_net_sales_is_a_counted_credit_note():
    df = pd.DataFrame({"Invoice Date": ["05-04-2025"], "Retailer": ["A"], "Distributor": ["X"], "Net Sales": ["-50"]})
    r = validate_dataframe(df, get_spec(DatasetType.SALES), today=TODAY)
    assert r.clean["_row_status"].tolist() == ["valid"] and r.clean["net_sales_amount"].tolist() == [-50.0]


def test_geography_checks():
    df = pd.DataFrame({
        "retailer_name": ["A", "B", "C", "D"],
        "distributor_name": ["X"] * 4,
        "state": ["Karnataka", "Orissa", "Atlantis", "Karnataka"],
        "pincode": ["560001", "751001", "560001", "600001"],
    })
    r = validate_dataframe(df, get_spec(DatasetType.RETAILERS), today=TODAY)
    assert r.clean["state"].tolist()[:2] == ["Karnataka", "Odisha"]    # alias normalised
    assert r.clean["_row_status"].tolist() == ["valid", "valid", "needs_review", "needs_review"]
    assert {"UNRECOGNISED_STATE", "PINCODE_STATE_MISMATCH"} <= _issue_codes(r)


def test_invalid_pincode_and_excel_float_pincode():
    df = pd.DataFrame({"retailer_name": ["A", "B"], "distributor_name": ["X", "X"],
                       "pincode": ["560001.0", "12345"]})
    r = validate_dataframe(df, get_spec(DatasetType.RETAILERS), today=TODAY)
    assert r.clean["pincode"].tolist() == ["560001", "12345"]
    assert r.clean["_row_status"].tolist() == ["valid", "invalid"]


def test_repeated_retailer_name_is_flagged_not_merged():
    df = pd.DataFrame({"retailer_code": ["R1", "R2"], "retailer_name": ["Mock Store", "MOCK  STORE"],
                       "distributor_name": ["X", "Y"]})
    r = validate_dataframe(df, get_spec(DatasetType.RETAILERS), today=TODAY)
    assert r.clean["_row_status"].tolist() == ["needs_review", "needs_review"]
    assert len(r.clean) == 2


def test_unrecognised_columns_kept_with_warning():
    df = pd.DataFrame({"distributor_name": ["X"], "gst_no": ["29ABCDE"]})
    r = validate_dataframe(df, get_spec(DatasetType.DISTRIBUTORS), today=TODAY)
    assert "gst_no" in r.unrecognised_columns and "gst_no" in r.clean.columns
    assert r.can_process
