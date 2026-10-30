"""
Create / update / delete single rows of an editable dataset (benefits, fulfilments).

Each change is a read-modify-write of datasets/<dataset>.csv in the store. A process-wide
lock serialises edits from this API instance; run one backend instance per Dropbox folder.
"""
import threading
from datetime import date
from typing import Dict, Optional

from app.core.constants import DatasetType
from app.core.errors import NotFoundError
from app.repositories.base import DataRepository
from app.repositories.store_repository import assign_missing_ids

_LOCK = threading.Lock()


def to_cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _row_index(table, record_id: str) -> Optional[int]:
    if "id" not in table:
        return None
    hits = table.index[table["id"].astype(str).str.casefold() == record_id.strip().casefold()]
    return hits[0] if len(hits) else None


def create(repo: DataRepository, dataset: DatasetType, values: Dict[str, object]) -> str:
    with _LOCK:
        table = repo.raw_table(dataset)
        row = {c: "" for c in table.columns}
        row.update({k: to_cell(v) for k, v in values.items()})
        row["id"] = ""
        for c in row:
            if c not in table:
                table[c] = ""
        table = table.reset_index(drop=True)
        table.loc[len(table)] = [row.get(c, "") for c in table.columns]
        table = assign_missing_ids(dataset, table)
        new_id = table.iloc[-1]["id"]
        repo.save_table(dataset, table)
    return new_id


def update(repo: DataRepository, dataset: DatasetType, record_id: str, values: Dict[str, object]) -> None:
    with _LOCK:
        table = repo.raw_table(dataset)
        idx = _row_index(table, record_id)
        if idx is None:
            raise NotFoundError(f"{dataset.value} record '{record_id}' was not found.", details={"id": record_id})
        for k, v in values.items():
            if k not in table:
                table[k] = ""
            table.at[idx, k] = to_cell(v)
        repo.save_table(dataset, table)


def delete(repo: DataRepository, dataset: DatasetType, record_id: str) -> None:
    with _LOCK:
        table = repo.raw_table(dataset)
        idx = _row_index(table, record_id)
        if idx is None:
            raise NotFoundError(f"{dataset.value} record '{record_id}' was not found.", details={"id": record_id})
        repo.save_table(dataset, table.drop(index=idx).reset_index(drop=True))
