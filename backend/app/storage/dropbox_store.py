"""
Dropbox store - Dropbox is the application's database.

Every dataset is a file under ``DROPBOX_ROOT`` (default ``/blue-origin``)::

    /blue-origin/datasets/sales.csv           active data (one CSV per dataset)
    /blue-origin/uploads/<stamp>_<id>_<name>  uploaded files, stored unchanged
    /blue-origin/uploads/_upload_history.json upload manifest
    /blue-origin/meta/reports.json            report generation log

Authentication (pick one, see README "Dropbox setup"):
  * DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN  (recommended, never expires)
  * DROPBOX_ACCESS_TOKEN                                          (short-lived, for quick tests)
"""
import copy
import logging
import re
import time
from typing import Callable, List, Optional, TypeVar

from app.core.config import Settings
from app.core.errors import StorageError
from app.storage.base import BlobStore, StoredFile

log = logging.getLogger("blue_origin.dropbox")
T = TypeVar("T")

UPLOAD_CHUNK = 4 * 1024 * 1024   # larger files go up in pieces (an upload session), each piece retried on its own
UPLOAD_ATTEMPTS = 4


class DropboxStore(BlobStore):
    name = "dropbox"

    def __init__(self, settings: Settings):
        try:
            import dropbox
            from dropbox import exceptions, files
        except ImportError as exc:  # pragma: no cover - dependency is in requirements.txt
            raise StorageError("The 'dropbox' package is not installed. Run: pip install -r requirements.txt") from exc
        self._exceptions = exceptions
        self._files = files
        self.root = settings.DROPBOX_ROOT

        common = dict(timeout=settings.DROPBOX_TIMEOUT_SECONDS)
        if settings.DROPBOX_REFRESH_TOKEN:
            if not (settings.DROPBOX_APP_KEY and settings.DROPBOX_APP_SECRET):
                raise StorageError("DROPBOX_REFRESH_TOKEN needs DROPBOX_APP_KEY and DROPBOX_APP_SECRET as well.")
            self._dbx = dropbox.Dropbox(oauth2_refresh_token=settings.DROPBOX_REFRESH_TOKEN,
                                        app_key=settings.DROPBOX_APP_KEY,
                                        app_secret=settings.DROPBOX_APP_SECRET, **common)
        elif settings.DROPBOX_ACCESS_TOKEN:
            self._dbx = dropbox.Dropbox(oauth2_access_token=settings.DROPBOX_ACCESS_TOKEN, **common)
        else:
            raise StorageError(
                "Dropbox is not configured. Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN "
                "(or DROPBOX_ACCESS_TOKEN) in backend/.env, or set DATA_SOURCE=local for offline use.")

    # ------------------------------------------------------------------ helpers
    def _full(self, path: str) -> str:
        p = path.strip("/")
        return f"{self.root}/{p}" if p else self.root

    def _relative(self, full: str) -> str:
        return full[len(self.root):].lstrip("/") if full.lower().startswith(self.root.lower()) else full.lstrip("/")

    def _fail(self, action: str, path: str, exc: Exception) -> StorageError:
        log.error("Dropbox %s failed for %s: %r", action, path, exc)
        if isinstance(exc, self._exceptions.AuthError):
            return StorageError("Dropbox rejected the credentials. Check the DROPBOX_* settings.",
                                details={"action": action}, code="STORAGE_AUTH_FAILED")
        if isinstance(exc, self._exceptions.BadInputError) and "scope" in str(exc.message):
            missing = re.search(r"scope '([\w.]+)'", str(exc.message))
            return StorageError(
                f"The Dropbox app is missing the permission '{missing.group(1) if missing else 'files.*'}'. "
                "In the Dropbox App Console > Permissions, tick files.metadata.read, files.content.read and "
                "files.content.write, click Submit, then create a NEW token (old tokens keep the old permissions).",
                details={"action": action}, code="STORAGE_PERMISSION_MISSING")
        if isinstance(exc, self._exceptions.BadInputError):
            return StorageError(f"Dropbox rejected the request: {exc.message}", details={"action": action, "path": path})
        return StorageError(f"Dropbox {action} failed for '{path}' ({type(exc).__name__}).",
                            details={"action": action, "path": path, "reason": type(exc).__name__})

    def _is_not_found(self, exc: Exception) -> bool:
        if not isinstance(exc, self._exceptions.ApiError):
            return False
        err = exc.error
        for attr in ("is_path", "is_path_lookup"):
            if getattr(err, attr, lambda: False)():
                lookup = err.get_path() if attr == "is_path" else err.get_path_lookup()
                return lookup.is_not_found()
        return False

    # ------------------------------------------------------------------ BlobStore
    def read(self, path: str) -> Optional[bytes]:
        try:
            _, res = self._dbx.files_download(self._full(path))
            return res.content
        except Exception as exc:
            if self._is_not_found(exc):
                return None
            raise self._fail("download", path, exc) from exc

    def _retry(self, what: str, fn: Callable[[], T]) -> T:
        """Retry a dropped or timed-out connection (slow uploads of big dataset files); API errors are not retried."""
        for attempt in range(1, UPLOAD_ATTEMPTS + 1):
            try:
                return fn()
            except Exception as exc:
                if isinstance(exc, self._exceptions.DropboxException) or attempt == UPLOAD_ATTEMPTS:
                    raise
                log.warning("Dropbox %s: connection problem (%r), retry %d of %d", what, exc, attempt,
                            UPLOAD_ATTEMPTS - 1)
                time.sleep(2 * attempt)
        raise AssertionError("unreachable")

    def write(self, path: str, content: bytes) -> None:
        full, mode = self._full(path), self._files.WriteMode.overwrite
        try:
            if len(content) <= UPLOAD_CHUNK:
                self._retry(f"upload {path}", lambda: self._dbx.files_upload(content, full, mode=mode, mute=True))
                return
            start = self._retry(f"upload {path}", lambda: self._dbx.files_upload_session_start(content[:UPLOAD_CHUNK]))
            cursor = self._files.UploadSessionCursor(session_id=start.session_id, offset=UPLOAD_CHUNK)
            while len(content) - cursor.offset > UPLOAD_CHUNK:
                piece = content[cursor.offset:cursor.offset + UPLOAD_CHUNK]
                self._append(path, piece, cursor)
                cursor.offset += len(piece)
            commit = self._files.CommitInfo(path=full, mode=mode, mute=True)
            self._retry(f"upload {path}",
                        lambda: self._dbx.files_upload_session_finish(content[cursor.offset:], cursor, commit))
        except Exception as exc:
            raise self._fail("upload", path, exc) from exc

    def _append(self, path: str, piece: bytes, cursor) -> None:
        try:
            self._retry(f"upload {path}", lambda: self._dbx.files_upload_session_append_v2(piece, cursor))
        except self._exceptions.ApiError as exc:
            # a retried piece that Dropbox had already received: it reports where it is, carry on from there
            err = getattr(exc, "error", None)
            if err is not None and hasattr(err, "is_incorrect_offset") and err.is_incorrect_offset():
                if err.get_incorrect_offset().correct_offset == cursor.offset + len(piece):
                    return
            raise

    def delete(self, path: str) -> None:
        try:
            self._dbx.files_delete_v2(self._full(path))
        except Exception as exc:
            if self._is_not_found(exc):
                return
            raise self._fail("delete", path, exc) from exc

    def list(self, folder: str) -> List[StoredFile]:
        try:
            res = self._dbx.files_list_folder(self._full(folder))
            entries = list(res.entries)
            while res.has_more:
                res = self._dbx.files_list_folder_continue(res.cursor)
                entries.extend(res.entries)
        except Exception as exc:
            if self._is_not_found(exc):
                return []
            raise self._fail("list", folder, exc) from exc
        return sorted(
            (StoredFile(self._relative(e.path_display), e.size, e.server_modified, e.content_hash or e.rev)
             for e in entries if isinstance(e, self._files.FileMetadata)),
            key=lambda f: f.path)

    def make_folder(self, folder: str) -> None:
        try:
            self._dbx.files_create_folder_v2(self._full(folder))
        except Exception as exc:
            err = getattr(exc, "error", None)
            if (isinstance(exc, self._exceptions.ApiError) and err is not None and err.is_path()
                    and err.get_path().is_conflict()):
                return  # already exists
            raise self._fail("create folder", folder, exc) from exc

    def at(self, folder: str) -> "DropboxStore":
        other = copy.copy(self)
        other.root = "" if folder.strip("/") == "" else "/" + folder.strip("/")
        return other

    def describe(self) -> str:
        return f"dropbox:{self.root or '/'}"
