"""Local-folder store with the same layout as the Dropbox store (offline development and tests)."""
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from app.core.errors import StorageError
from app.storage.base import BlobStore, StoredFile


class LocalStore(BlobStore):
    name = "local"

    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, path: str) -> Path:
        full = (self.root / path).resolve()
        if self.root.resolve() not in full.parents and full != self.root.resolve():
            raise StorageError("Path escapes the data store root.", details={"path": path})
        return full

    def read(self, path: str) -> Optional[bytes]:
        p = self._path(path)
        return p.read_bytes() if p.is_file() else None

    def write(self, path: str, content: bytes) -> None:
        p = self._path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(content)
        tmp.replace(p)  # atomic swap

    def delete(self, path: str) -> None:
        p = self._path(path)
        if p.is_file():
            p.unlink()

    def list(self, folder: str) -> List[StoredFile]:
        d = self._path(folder)
        if not d.is_dir():
            return []
        out = []
        for f in sorted(d.iterdir()):
            if f.is_file() and not f.name.endswith(".tmp"):
                st = f.stat()
                out.append(StoredFile(f"{folder.strip('/')}/{f.name}".lstrip("/"), st.st_size,
                                      datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                                      f"{st.st_size}-{st.st_mtime_ns}"))
        return out

    def make_folder(self, folder: str) -> None:
        self._path(folder).mkdir(parents=True, exist_ok=True)

    def at(self, folder: str) -> "LocalStore":
        # offline/tests: absolute Dropbox-style folders live under this store's root
        return LocalStore(self.root / folder.strip("/"))

    def describe(self) -> str:
        return f"local:{self.root}"
