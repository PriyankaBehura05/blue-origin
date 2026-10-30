"""Small helpers shared by services: data-source metadata, server-side list queries and file exports."""
import io
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from app.core.constants import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE
from app.core.errors import InvalidFilterError
from app.processing.data_transformer import to_records
from app.repositories.base import DataRepository
from app.schemas.common import DataSourceInfo


def data_source_info(repo: DataRepository) -> DataSourceInfo:
    return DataSourceInfo(source=repo.source_name, location=repo.location, loaded_at=repo.loaded_at)


@dataclass
class ListQuery:
    """search / filters / sort / paging, as sent by the frontend's ListQuery."""
    search: Optional[str] = None
    sort_by: Optional[str] = None
    sort_dir: str = "asc"
    page: int = 1
    page_size: int = DEFAULT_PAGE_SIZE
    filters: Dict[str, Optional[str]] = field(default_factory=dict)


def text_haystack(df: pd.DataFrame, columns: Sequence[str]) -> pd.Series:
    """Lower-cased concatenation of the given columns (missing columns ignored) for substring search."""
    parts = [df[c].map(lambda v: "" if v is None or v != v else str(v)) for c in columns if c in df]
    if not parts:
        return pd.Series([""] * len(df), index=df.index)
    joined = parts[0]
    for p in parts[1:]:
        joined = joined + " " + p
    return joined.str.casefold()


def filter_frame(df: pd.DataFrame, q: ListQuery, search_fields: Sequence[str]) -> pd.DataFrame:
    """Apply search + exact-match filters (case-insensitive). Unknown filter keys are rejected."""
    if q.search and q.search.strip():
        df = df[text_haystack(df, search_fields).str.contains(q.search.strip().casefold(), regex=False)]
    for col, value in q.filters.items():
        if value is None or str(value).strip() == "":
            continue
        if col not in df:
            raise InvalidFilterError(f"Unknown filter '{col}'.", details={"filter": col})
        target = str(value).strip().casefold()
        df = df[df[col].map(lambda v: v is not None and v == v and str(v).casefold() == target)]
    return df


def _sort_key(s: pd.Series) -> pd.Series:
    def k(v):
        if v is None or (isinstance(v, float) and v != v):
            return np.nan
        return v.casefold() if isinstance(v, str) else v
    return s.map(k)


def sort_frame(df: pd.DataFrame, sort_by: Optional[str], sort_dir: str) -> pd.DataFrame:
    if not sort_by:
        return df
    if sort_by not in df:
        raise InvalidFilterError(f"Cannot sort by '{sort_by}'.", details={"sort_by": sort_by})
    return df.sort_values(sort_by, ascending=sort_dir != "desc", na_position="last", kind="mergesort", key=_sort_key)


def paginate(df: pd.DataFrame, page: int, page_size: int) -> dict:
    if page < 1:
        raise InvalidFilterError("page must be 1 or greater.", details={"page": page})
    if not 1 <= page_size <= MAX_PAGE_SIZE:
        raise InvalidFilterError(f"page_size must be between 1 and {MAX_PAGE_SIZE}.", details={"page_size": page_size})
    chunk = df.iloc[(page - 1) * page_size: page * page_size]
    return {"items": to_records(chunk), "total": len(df), "page": page, "page_size": page_size}


def list_query(df: pd.DataFrame, q: ListQuery, search_fields: Sequence[str]) -> dict:
    """Filter, sort and paginate. Returns the Paged shape {items, total, page, page_size}."""
    df = filter_frame(df, q, search_fields)
    return paginate(sort_frame(df, q.sort_by, q.sort_dir), q.page, q.page_size)


def records(df: pd.DataFrame) -> List[dict]:
    return to_records(df)


def to_file(df: pd.DataFrame, fmt: str, sheet_name: str, notes: str = "", total: bool = False) -> Tuple[bytes, str]:
    """(content, media type) for a CSV or XLSX download. XLSX uses the TechnoSport report format."""
    fmt = fmt.lower()
    if fmt == "csv":
        return df.to_csv(index=False).encode("utf-8-sig"), "text/csv; charset=utf-8"  # BOM: Excel shows ₹
    if fmt != "xlsx":
        raise InvalidFilterError("format must be csv or xlsx.", details={"format": fmt})
    from app.services.excel_report import single
    return single(df, sheet_name, notes, total), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def export_query(df: pd.DataFrame, q: ListQuery, search_fields: Sequence[str],
                 columns: Sequence[Tuple[str, str]]) -> pd.DataFrame:
    """The rows a list view shows (search + filters + sort, all pages) with export column headers."""
    df = sort_frame(filter_frame(df, q, search_fields), q.sort_by, q.sort_dir)
    out = pd.DataFrame({header: df[field] if field in df else None for field, header in columns})
    for c in out.columns:  # dates -> ISO text, NaN -> blank
        out[c] = out[c].map(lambda v: v.isoformat() if hasattr(v, "isoformat") else v)
    return out.where(out.notna(), None)
