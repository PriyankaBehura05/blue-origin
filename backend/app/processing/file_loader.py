"""File-type detection and a single entry point to read any supported BO file."""
from io import BytesIO
from pathlib import Path
from typing import Optional, Union

import pandas as pd

from app.core.constants import ALLOWED_EXTENSIONS, FileType
from app.core.errors import EmptyFileError, InvalidFileError
from app.processing.csv_reader import read_csv
from app.processing.excel_reader import read_excel

XLSX_MAGIC = b"PK\x03\x04"                      # xlsx = zip container
XLS_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"   # legacy OLE2 workbook

Source = Union[str, Path, bytes]


def detect_file_type(filename: str, content: Optional[bytes] = None) -> FileType:
    """Detect by extension, then confirm against the file signature when bytes are given."""
    ext = Path(filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise InvalidFileError(
            f"Unsupported file type '{ext or 'none'}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}.",
            details={"filename": filename},
        )
    ftype = ALLOWED_EXTENSIONS[ext]
    if content is not None:
        if len(content) == 0:
            raise EmptyFileError("The uploaded file is empty.", details={"filename": filename})
        head = content[:8]
        if ftype == FileType.XLSX and not head.startswith(XLSX_MAGIC):
            raise InvalidFileError("File has .xlsx extension but is not a valid Excel workbook.",
                                   details={"filename": filename})
        if ftype == FileType.XLS and not head.startswith(XLS_MAGIC):
            raise InvalidFileError("File has .xls extension but is not a valid legacy Excel workbook.",
                                   details={"filename": filename})
        if ftype == FileType.CSV and (head.startswith(XLSX_MAGIC) or head.startswith(XLS_MAGIC)):
            raise InvalidFileError("File has .csv extension but looks like an Excel workbook.",
                                   details={"filename": filename})
    return ftype


def read_tabular(source: Source, filename: Optional[str] = None, sheet_name: Optional[str] = None) -> pd.DataFrame:
    """Read .xlsx / .xls / .csv into a DataFrame of raw strings (no type coercion yet)."""
    if isinstance(source, (str, Path)):
        path = Path(source)
        filename = filename or path.name
        content = path.read_bytes()
    else:
        content = source
    if not filename:
        raise InvalidFileError("A filename is required to detect the file type.")

    ftype = detect_file_type(filename, content)
    try:
        if ftype == FileType.CSV:
            df = read_csv(content)
        else:
            df = read_excel(BytesIO(content), file_type=ftype, sheet_name=sheet_name)
    except (InvalidFileError, EmptyFileError):
        raise
    except Exception as exc:  # parser-level failure -> clean API error, no trace
        raise InvalidFileError(f"Could not read '{filename}': the file appears corrupt or malformed.",
                               details={"filename": filename, "reason": type(exc).__name__}) from exc

    if df.empty and len(df.columns) == 0:
        raise EmptyFileError("The file contains no header row or data.", details={"filename": filename})
    return df
