from io import BytesIO

import pytest
from openpyxl import Workbook

from app.core.constants import FileType
from app.core.errors import EmptyFileError, InvalidFileError
from app.processing.csv_reader import read_csv
from app.processing.file_loader import detect_file_type, read_tabular


def _xlsx_bytes(rows, sheet="Sheet1", extra_sheet=None) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    for r in rows:
        ws.append(r)
    if extra_sheet:
        ws2 = wb.create_sheet(extra_sheet)
        ws2.append(["distributor_name"])
        ws2.append(["Test Dist"])
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_read_csv_keeps_text_and_leading_zeros():
    df = read_csv(b"code,pincode\n007,560001\n")
    assert df.loc[0, "code"] == "007"
    assert df.loc[0, "pincode"] == "560001"


def test_read_csv_cp1252_and_semicolon():
    content = "name;amount\nCaf\xe9 Store;100\n".encode("cp1252")
    df = read_csv(content)
    assert list(df.columns) == ["name", "amount"]
    assert df.loc[0, "name"] == "Café Store"


def test_read_xlsx_first_sheet_and_named_sheet():
    content = _xlsx_bytes([["retailer_name", "amount"], ["Test Store", 1500]], extra_sheet="Dists")
    df = read_tabular(content, filename="file.xlsx")
    assert df.loc[0, "retailer_name"] == "Test Store"
    df2 = read_tabular(content, filename="file.xlsx", sheet_name="Dists")
    assert list(df2.columns) == ["distributor_name"]


def test_read_xlsx_unknown_sheet_raises():
    content = _xlsx_bytes([["a"], [1]])
    with pytest.raises(InvalidFileError):
        read_tabular(content, filename="f.xlsx", sheet_name="Nope")


@pytest.mark.parametrize("name,expected", [("a.xlsx", FileType.XLSX), ("A.CSV", FileType.CSV), ("b.xls", FileType.XLS)])
def test_detect_file_type_by_extension(name, expected):
    assert detect_file_type(name) == expected


def test_detect_rejects_bad_extension_fake_xlsx_and_empty():
    with pytest.raises(InvalidFileError):
        detect_file_type("data.pdf")
    with pytest.raises(InvalidFileError):
        detect_file_type("data.xlsx", b"not,a,workbook\n")
    with pytest.raises(EmptyFileError):
        detect_file_type("data.csv", b"")


def test_corrupt_xlsx_gives_clean_error():
    with pytest.raises(InvalidFileError):
        read_tabular(b"PK\x03\x04garbage", filename="broken.xlsx")
