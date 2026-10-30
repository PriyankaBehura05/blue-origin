"""
Derived fields and JSON-safe conversion.

TECHNICAL IDs: `internal_id` is a temporary processing key, NOT an official retailer or
distributor ID. Its `internal_id_basis` says how it was built:
  * "source_code"   - hashed from the code column in the file (stable if codes are stable)
  * "row_position"  - no code available; tied to the row number and NOT stable across files
The official identity strategy will be decided after real BO files are inspected.
"""
import hashlib
import math
from datetime import date, datetime
from typing import Any, Dict, List

import pandas as pd

from app.core.constants import DatasetType
from app.processing.data_cleaner import fiscal_quarter, fiscal_year_label

_ENTITY = {DatasetType.RETAILERS: ("RET", "retailer_code"),
           DatasetType.DISTRIBUTORS: ("DIST", "distributor_code")}


def internal_id_for_code(prefix: str, code: str) -> str:
    """Technical id derived from a source code. Sales rows use it to link to the master rows."""
    digest = hashlib.sha1(f"{prefix}|{str(code).strip().upper()}".encode()).hexdigest()[:10]
    return f"tmp-{prefix.lower()}-{digest}"


def internal_id_for_name(prefix: str, name_key: str) -> str:
    """Technical id for a party known only by name (no code, no master row)."""
    digest = hashlib.sha1(f"{prefix}|NAME|{name_key}".encode()).hexdigest()[:10]
    return f"tmp-{prefix.lower()}-n{digest}"


def assign_internal_ids(df: pd.DataFrame, dataset: DatasetType) -> pd.DataFrame:
    if dataset not in _ENTITY:
        return df
    prefix, code_col = _ENTITY[dataset]
    out = df.copy()
    ids, basis = [], []
    for _, row in out.iterrows():
        code = row.get(code_col)
        if code:
            ids.append(internal_id_for_code(prefix, code))
            basis.append("source_code")
        else:
            ids.append(f"tmp-{prefix.lower()}-row{int(row['_source_row'])}")
            basis.append("row_position")
    out["internal_id"] = ids
    out["internal_id_basis"] = basis
    return out


def add_period_fields(df: pd.DataFrame, date_col: str = "invoice_date") -> pd.DataFrame:
    """Adds fy ('FY26'), fiscal_quarter ('Q1'..'Q4') and month ('2025-04')."""
    if date_col not in df:
        return df
    out = df.copy()
    out["fy"] = out[date_col].map(lambda d: fiscal_year_label(d) if isinstance(d, date) else None)
    out["fiscal_quarter"] = out[date_col].map(lambda d: fiscal_quarter(d) if isinstance(d, date) else None)
    out["month"] = out[date_col].map(lambda d: d.strftime("%Y-%m") if isinstance(d, date) else None)
    return out


def transform(df: pd.DataFrame, dataset: DatasetType) -> pd.DataFrame:
    dataset = DatasetType(dataset)
    if dataset == DatasetType.SALES:
        return add_period_fields(df)
    return assign_internal_ids(df, dataset)


def _json_safe(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if hasattr(v, "item"):  # numpy scalar
        return _json_safe(v.item())
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


def to_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    return [{k: _json_safe(v) for k, v in row.items()} for row in df.to_dict(orient="records")]
