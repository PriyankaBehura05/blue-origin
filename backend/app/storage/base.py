"""
Blob-store contract.

The application treats its store as a small file database: every dataset, upload and
manifest is one file addressed by a relative path such as ``datasets/sales.csv``.
Dropbox is the production store; a local folder with the same layout is used for
offline development and tests.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional

# Folder layout inside the store root
DATASETS_DIR = "datasets"   # active data, one CSV per dataset
UPLOADS_DIR = "uploads"     # uploaded files, stored unchanged, plus the upload history manifest
META_DIR = "meta"           # small JSON manifests (report generation log, ...)


@dataclass(frozen=True)
class StoredFile:
    path: str                       # relative to the store root
    size: int
    modified: Optional[datetime]
    version: str = ""               # changes whenever the content changes (Dropbox content_hash)


class BlobStore(ABC):
    name: str = "abstract"

    @abstractmethod
    def read(self, path: str) -> Optional[bytes]:
        """File content, or None when the file does not exist."""

    @abstractmethod
    def write(self, path: str, content: bytes) -> None:
        """Create or overwrite a file (parent folders are created as needed)."""

    @abstractmethod
    def delete(self, path: str) -> None:
        """Delete a file; deleting a missing file is not an error."""

    @abstractmethod
    def list(self, folder: str) -> List[StoredFile]:
        """Files directly inside ``folder`` (empty list when the folder does not exist)."""

    @abstractmethod
    def make_folder(self, folder: str) -> None:
        """Create a folder (and parents); an existing folder is not an error."""

    @abstractmethod
    def describe(self) -> str:
        """Human-readable location, e.g. 'dropbox:/blue-origin'."""

    @abstractmethod
    def at(self, folder: str) -> "BlobStore":
        """A store of the same kind rooted at another (absolute) folder, e.g. a source folder to read from."""

    def check(self) -> None:
        """Raise StorageError if the store is unreachable or misconfigured."""
        self.list(DATASETS_DIR)


class SubFolderStore(BlobStore):
    """A view of ``folder`` inside another store: paths are relative to that folder."""

    def __init__(self, store: BlobStore, folder: str):
        self.store, self.folder = store, folder.strip("/")
        self.name = store.name

    def _p(self, path: str) -> str:
        return f"{self.folder}/{path.strip('/')}".rstrip("/")

    def read(self, path: str) -> Optional[bytes]:
        return self.store.read(self._p(path))

    def write(self, path: str, content: bytes) -> None:
        self.store.write(self._p(path), content)

    def delete(self, path: str) -> None:
        self.store.delete(self._p(path))

    def list(self, folder: str) -> List[StoredFile]:
        cut = len(self.folder) + 1
        return [StoredFile(f.path[cut:], f.size, f.modified, f.version) for f in self.store.list(self._p(folder))]

    def make_folder(self, folder: str) -> None:
        self.store.make_folder(self._p(folder))

    def describe(self) -> str:
        return f"{self.store.describe().rstrip('/')}/{self.folder}"

    def at(self, folder: str) -> BlobStore:
        return self.store.at(folder)
