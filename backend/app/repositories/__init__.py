"""Repository factory. Routes get the repository through FastAPI dependency injection."""
from functools import lru_cache

from app.core.config import get_settings
from app.repositories.base import DataRepository
from app.repositories.store_repository import StoreRepository
from app.storage import create_store


@lru_cache
def _repository() -> StoreRepository:
    settings = get_settings()
    return StoreRepository(create_store(settings), settings.CACHE_TTL_SECONDS)


def get_repository() -> DataRepository:
    return _repository()
