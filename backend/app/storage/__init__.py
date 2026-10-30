"""Store factory: Dropbox in normal use, a local folder for offline development and tests."""
from app.core.config import Settings
from app.storage.base import BlobStore


def create_store(settings: Settings) -> BlobStore:
    if settings.DATA_SOURCE == "local":
        from app.storage.local_store import LocalStore
        return LocalStore(settings.local_store_dir)
    from app.storage.dropbox_store import DropboxStore
    return DropboxStore(settings)
