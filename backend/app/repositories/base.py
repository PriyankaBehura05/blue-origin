"""
Data Access Layer contract.

Services depend ONLY on this interface. It is implemented by StoreRepository, which keeps
every dataset as a CSV file in a BlobStore (Dropbox in normal use, a local folder offline).
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import pandas as pd

from app.core.constants import DatasetType
from app.storage.base import BlobStore


@dataclass(frozen=True)
class DatasetInfo:
    dataset: str
    stored: bool
    rows: int
    valid_rows: int
    modified: Optional[datetime]
    path: str


class DataRepository(ABC):
    store: BlobStore
    source_name: str = "abstract"
    location: str = ""
    loaded_at: Optional[datetime] = None

    @abstractmethod
    def get(self, dataset: DatasetType) -> pd.DataFrame:
        """Cleaned rows of one dataset (every source row kept, with `_row_status` / `_source_row`).
        An empty frame with the spec's columns when the dataset has never been stored."""

    @abstractmethod
    def snapshot(self) -> Tuple[Tuple, Dict[DatasetType, pd.DataFrame]]:
        """(version token, all datasets). The token changes whenever any dataset is reloaded or saved,
        so callers can cache values derived from the whole data set."""

    @abstractmethod
    def raw_table(self, dataset: DatasetType) -> pd.DataFrame:
        """The stored table as text with canonical column names (used for edits)."""

    @abstractmethod
    def save_table(self, dataset: DatasetType, table: pd.DataFrame) -> None:
        """Replace the stored table (text, canonical column names) and refresh caches."""

    @abstractmethod
    def dataset_info(self) -> List[DatasetInfo]:
        """Stored state of every dataset."""

    def get_sales(self) -> pd.DataFrame:
        return self.get(DatasetType.SALES)

    def get_retailers(self) -> pd.DataFrame:
        return self.get(DatasetType.RETAILERS)

    def get_distributors(self) -> pd.DataFrame:
        return self.get(DatasetType.DISTRIBUTORS)

    def reload(self) -> None:
        """Drop any cached data so the next call re-reads the store."""
