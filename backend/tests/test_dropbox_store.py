"""DropboxStore against an in-memory fake of the Dropbox client (no network)."""
from datetime import datetime
from types import SimpleNamespace

import pytest
from dropbox import exceptions, files

from app.core.config import Settings
from app.core.errors import StorageError
from app.repositories.store_repository import StoreRepository
from app.storage.dropbox_store import DropboxStore


def _not_found(path: str):
    err = files.DownloadError.path(files.LookupError.not_found)
    return exceptions.ApiError("req-1", err, None, None)


class FakeDropbox:
    def __init__(self):
        self.files = {}

    def files_download(self, path):
        if path not in self.files:
            raise _not_found(path)
        return SimpleNamespace(), SimpleNamespace(content=self.files[path])

    def files_upload(self, content, path, mode=None, mute=False):
        self.files[path] = content

    # upload sessions (files over 4 MB)
    def files_upload_session_start(self, content):
        self.sessions = getattr(self, "sessions", {})
        sid = f"s{len(self.sessions)}"
        self.sessions[sid] = bytearray(content)
        return SimpleNamespace(session_id=sid)

    def files_upload_session_append_v2(self, content, cursor):
        if getattr(self, "drop_next", 0):           # simulate a dropped connection
            self.drop_next -= 1
            raise ConnectionError("Connection aborted.")
        assert len(self.sessions[cursor.session_id]) == cursor.offset
        self.sessions[cursor.session_id] += content

    def files_upload_session_finish(self, content, cursor, commit):
        data = self.sessions.pop(cursor.session_id) + content
        assert len(data) == cursor.offset + len(content)
        self.files[commit.path] = bytes(data)

    def files_delete_v2(self, path):
        if path not in self.files:
            raise exceptions.ApiError("req-2", files.DeleteError.path_lookup(files.LookupError.not_found), None, None)
        del self.files[path]

    def files_create_folder_v2(self, path):
        if path in getattr(self, "folders", set()):
            err = files.CreateFolderError.path(files.WriteError.conflict(files.WriteConflictError.folder))
            raise exceptions.ApiError("req-4", err, None, None)
        self.folders = getattr(self, "folders", set()) | {path}

    def files_list_folder(self, folder):
        prefix = folder.rstrip("/") + "/"
        if not any(p.startswith(prefix) for p in self.files):
            raise exceptions.ApiError("req-3", files.ListFolderError.path(files.LookupError.not_found), None, None)
        entries = [files.FileMetadata(name=p.rsplit("/", 1)[1], path_display=p, size=len(c),
                                      server_modified=datetime(2026, 1, 1), client_modified=datetime(2026, 1, 1),
                                      id="id:x", rev="0123456789", content_hash="0" * 64)
                   for p, c in self.files.items() if p.startswith(prefix) and "/" not in p[len(prefix):]]
        return SimpleNamespace(entries=entries, has_more=False, cursor=None)


@pytest.fixture
def dbx_store():
    store = DropboxStore(Settings(DROPBOX_ACCESS_TOKEN="test-token", DROPBOX_ROOT="blue-origin/"))
    store._dbx = FakeDropbox()
    return store


def test_requires_credentials():
    with pytest.raises(StorageError):
        DropboxStore(Settings(DROPBOX_ACCESS_TOKEN="", DROPBOX_REFRESH_TOKEN=""))
    with pytest.raises(StorageError):
        DropboxStore(Settings(DROPBOX_REFRESH_TOKEN="r", DROPBOX_APP_KEY="", DROPBOX_APP_SECRET=""))


def test_roundtrip_under_root(dbx_store):
    assert dbx_store.describe() == "dropbox:/blue-origin"
    assert dbx_store.read("datasets/sales.csv") is None
    dbx_store.write("datasets/sales.csv", b"a,b\n")
    assert dbx_store._dbx.files == {"/blue-origin/datasets/sales.csv": b"a,b\n"}
    assert dbx_store.read("datasets/sales.csv") == b"a,b\n"
    listed = dbx_store.list("datasets")
    assert [f.path for f in listed] == ["datasets/sales.csv"] and listed[0].size == 4
    assert dbx_store.list("nothing-here") == []
    dbx_store.delete("datasets/sales.csv")
    dbx_store.delete("datasets/sales.csv")  # deleting a missing file is fine
    assert dbx_store.read("datasets/sales.csv") is None


def test_other_errors_become_storage_errors(dbx_store):
    def boom(*a, **k):
        raise exceptions.AuthError("req", None)
    dbx_store._dbx.files_download = boom
    with pytest.raises(StorageError) as exc:
        dbx_store.read("datasets/sales.csv")
    assert exc.value.code == "STORAGE_AUTH_FAILED"


def test_repository_on_dropbox(dbx_store):
    repo = StoreRepository(dbx_store)
    assert len(repo.get_sales()) == 0  # empty Dropbox folder -> empty dataset, not an error
    dbx_store.write("datasets/distributors.csv", b"distributor_name,status\nAlpha,Active\n")
    repo.reload()
    assert repo.get_distributors()["distributor_name"].tolist() == ["Alpha"]
    info = {i.dataset: i for i in repo.dataset_info()}
    assert info["distributors"].stored and info["distributors"].rows == 1 and not info["sales"].stored
    assert info["distributors"].modified == datetime(2026, 1, 1)


def test_make_folder_tolerates_existing(dbx_store):
    dbx_store.make_folder("inbox/sales")
    dbx_store.make_folder("inbox/sales")  # conflict -> ignored
    assert dbx_store._dbx.folders == {"/blue-origin/inbox/sales"}


def test_sync_against_dropbox(dbx_store, tmp_path):
    from app.core.config import Settings
    from app.services.sync_service import SyncRunner
    from tests.conftest import DISTRIBUTORS_CSV
    repo = StoreRepository(dbx_store)
    dbx_store.write("inbox/distributors/d.csv", DISTRIBUTORS_CSV.encode())
    run = SyncRunner(repo, Settings(SYNC_INTERVAL_MINUTES=0)).run("test")
    assert run["ok"] and run["results"][0]["rows"] == 2
    assert "/blue-origin/datasets/distributors.csv" in dbx_store._dbx.files


def test_large_files_upload_in_pieces_and_survive_a_dropped_connection(dbx_store, monkeypatch):
    import app.storage.dropbox_store as ds
    monkeypatch.setattr(ds, "UPLOAD_CHUNK", 10)
    monkeypatch.setattr(ds.time, "sleep", lambda s: None)
    big = bytes(range(256)) * 2                       # 512 bytes -> 52 pieces of 10
    dbx_store._dbx.drop_next = 2
    dbx_store.write("datasets/retailers.csv", big)
    assert dbx_store.read("datasets/retailers.csv") == big
    assert dbx_store._dbx.drop_next == 0              # the two dropped pieces were sent again
