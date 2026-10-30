"""
Store-backed repository: Dropbox (or a local folder) used as the database.

Every dataset lives at ``datasets/<dataset>.csv`` in the store, as text with canonical column
names. Reads run the stored table through the same processing pipeline as an uploaded file
(normalise -> clean -> validate -> transform), so stored data and uploads are treated alike.

Datasets are cached in memory for CACHE_TTL_SECONDS; writes made through this repository
refresh the cache immediately. Edits made directly in Dropbox show up after the TTL or
after POST /api/datasets/reload.
"""
import io
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import pandas as pd

from app.core.constants import EDITABLE_DATASET_ID_PREFIX, DatasetType, RecordStatus
from app.core.errors import DataNotAvailableError
from app.processing.csv_reader import read_csv
from app.processing.data_cleaner import normalize_columns
from app.processing.dataset_specs import get_spec
from app.processing.pipeline import run_pipeline
from app.repositories.base import DataRepository, DatasetInfo
from app.storage.base import DATASETS_DIR, BlobStore

# Columns the transformer adds, so an empty dataset has the same shape as a loaded one
_DERIVED = {
    DatasetType.SALES: ["fy", "fiscal_quarter", "month"],
    DatasetType.RETAILERS: ["internal_id", "internal_id_basis"],
    DatasetType.DISTRIBUTORS: ["internal_id", "internal_id_basis"],
}


def dataset_path(dataset: DatasetType) -> str:
    return f"{DATASETS_DIR}/{DatasetType(dataset).value}.csv"


def empty_frame(dataset: DatasetType) -> pd.DataFrame:
    spec = get_spec(dataset)
    cols = spec.all_columns + _DERIVED.get(dataset, []) + ["_source_row", "_row_status"]
    return pd.DataFrame({c: pd.Series(dtype=object) for c in cols})


def table_to_csv(table: pd.DataFrame) -> bytes:
    buf = io.StringIO()
    table.to_csv(buf, index=False)
    return buf.getvalue().encode("utf-8")


def assign_missing_ids(dataset: DatasetType, table: pd.DataFrame) -> pd.DataFrame:
    """Give every row of an editable dataset a stable `id` (PREFIX-0001, ...), keeping existing ids."""
    prefix = EDITABLE_DATASET_ID_PREFIX.get(DatasetType(dataset))
    if prefix is None:
        return table
    out = table.copy()
    if "id" not in out:
        out.insert(0, "id", "")
    ids = out["id"].fillna("").astype(str).str.strip()
    used = set(ids[ids != ""])
    nums = [int(i.split("-")[-1]) for i in used if i.upper().startswith(prefix + "-") and i.split("-")[-1].isdigit()]
    nxt = max(nums, default=0) + 1
    new_ids, taken = [], set()
    for current in ids:
        if current and current not in taken:
            new_ids.append(current)
            taken.add(current)
            continue
        while f"{prefix}-{nxt:04d}" in used:
            nxt += 1
        new_id = f"{prefix}-{nxt:04d}"
        used.add(new_id)
        taken.add(new_id)
        new_ids.append(new_id)
        nxt += 1
    out["id"] = new_ids
    return out


class StoreRepository(DataRepository):
    def __init__(self, store: BlobStore, cache_ttl_seconds: int = 300):
        self.store = store
        self.source_name = store.name
        self.location = store.describe()
        self.ttl = cache_ttl_seconds
        self._lock = threading.RLock()
        self._cache: Dict[DatasetType, Tuple[float, int, pd.DataFrame, str]] = {}  # (checked, version no, df, file version)
        self._counter = 0

    # ------------------------------------------------------------------ reads
    def _versions(self) -> Dict[str, str]:
        return {f.path: f.version for f in self.store.list(DATASETS_DIR)}

    def _fresh(self, dataset: DatasetType) -> bool:
        hit = self._cache.get(dataset)
        return bool(hit) and time.monotonic() - hit[0] < self.ttl

    def _load(self, dataset: DatasetType, versions: Optional[Dict[str, str]] = None) -> Tuple[int, pd.DataFrame]:
        dataset = DatasetType(dataset)
        with self._lock:
            hit = self._cache.get(dataset)
            if self._fresh(dataset):
                return hit[1], hit[2]
            # Cache period over: re-read only if the file in the store actually changed (one listing call).
            version = (versions if versions is not None else self._versions()).get(dataset_path(dataset), "")
            if hit and hit[3] == version:
                self._cache[dataset] = (time.monotonic(), hit[1], hit[2], version)
                return hit[1], hit[2]
            content = self.store.read(dataset_path(dataset)) if version else None
            if content is None or b"\n" not in content.strip():   # missing, or headings only (e.g. no fulfilments)
                df = empty_frame(dataset)
            else:
                result = run_pipeline(content, dataset, filename=f"{dataset.value}.csv")
                if not result.validation.can_process:
                    raise DataNotAvailableError(
                        f"The stored {dataset.value} dataset cannot be processed. Upload a corrected file.",
                        details={"path": dataset_path(dataset),
                                 "errors": [i.message for i in result.validation.file_errors]})
                df = result.data
            self._counter += 1
            self._cache[dataset] = (time.monotonic(), self._counter, df, version)
            self.loaded_at = datetime.now(timezone.utc)
            return self._counter, df

    def get(self, dataset: DatasetType) -> pd.DataFrame:
        return self._load(dataset)[1].copy()

    def snapshot(self) -> Tuple[Tuple, Dict[DatasetType, pd.DataFrame]]:
        with self._lock:
            versions = None if all(self._fresh(d) for d in DatasetType) else self._versions()
            loaded = {d: self._load(d, versions) for d in DatasetType}
        token = tuple(v[0] for v in loaded.values())
        return token, {d: v[1] for d, v in loaded.items()}

    def raw_table(self, dataset: DatasetType) -> pd.DataFrame:
        content = self.store.read(dataset_path(dataset))
        spec = get_spec(dataset)
        if content is None:
            return pd.DataFrame({c: pd.Series(dtype=object) for c in spec.all_columns})
        table = read_csv(content)
        table, _ = normalize_columns(table, spec.aliases)
        return table.fillna("")

    # ------------------------------------------------------------------ writes
    def save_table(self, dataset: DatasetType, table: pd.DataFrame) -> None:
        dataset = DatasetType(dataset)
        table = assign_missing_ids(dataset, table)
        with self._lock:
            self.store.write(dataset_path(dataset), table_to_csv(table))
            self._cache.pop(dataset, None)

    def delete_dataset(self, dataset: DatasetType) -> None:
        with self._lock:
            self.store.delete(dataset_path(dataset))
            self._cache.pop(DatasetType(dataset), None)

    def reload(self) -> None:
        with self._lock:
            self._cache.clear()

    # ------------------------------------------------------------------ status
    def dataset_info(self) -> List[DatasetInfo]:
        files = {f.path: f for f in self.store.list(DATASETS_DIR)}
        out = []
        for d in DatasetType:
            path = dataset_path(d)
            f: Optional[object] = files.get(path)
            df = self.get(d) if f else None
            valid = 0 if df is None else int((df["_row_status"] == RecordStatus.VALID.value).sum())
            out.append(DatasetInfo(dataset=d.value, stored=f is not None, rows=0 if df is None else len(df),
                                   valid_rows=valid, modified=getattr(f, "modified", None), path=path))
        return out
