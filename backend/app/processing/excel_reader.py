"""Excel reading (.xlsx via openpyxl, .xls via xlrd when installed)."""
from typing import BinaryIO, List, Optional, Union

import pandas as pd

from app.core.constants import FileType
from app.core.errors import InvalidFileError


def _engine(file_type: FileType) -> str:
    if file_type == FileType.XLS:
        try:
            import xlrd  # noqa: F401
        except ImportError as exc:
            raise InvalidFileError(
                "Legacy .xls files need the optional 'xlrd' package. Install it or re-save the file as .xlsx."
            ) from exc
        return "xlrd"
    return "openpyxl"


def list_sheets(source: Union[str, BinaryIO], file_type: FileType = FileType.XLSX) -> List[str]:
    return pd.ExcelFile(source, engine=_engine(file_type)).sheet_names


def read_excel(source: Union[str, BinaryIO], file_type: FileType = FileType.XLSX,
               sheet_name: Optional[str] = None) -> pd.DataFrame:
    """Read one sheet as text. Defaults to the first sheet; raises a clear error for an unknown sheet."""
    xls = pd.ExcelFile(source, engine=_engine(file_type))
    if sheet_name is None:
        sheet_name = xls.sheet_names[0]
    elif sheet_name not in xls.sheet_names:
        raise InvalidFileError(f"Sheet '{sheet_name}' not found.", details={"available_sheets": xls.sheet_names})
    df = xls.parse(sheet_name=sheet_name, dtype=str, keep_default_na=False)
    # Drop columns Excel created from stray formatting ("Unnamed: 7") ONLY when completely empty.
    empty_unnamed = [c for c in df.columns
                     if str(c).startswith("Unnamed:") and df[c].astype(str).str.strip().eq("").all()]
    return df.drop(columns=empty_unnamed)
