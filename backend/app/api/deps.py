"""FastAPI dependencies: sign-in and roles, data access and list parameters."""
from typing import Literal, Optional

from fastapi import Depends, Query, Request

from app.core.config import Settings, get_settings  # noqa: F401  (re-exported for routes)
from app.core.constants import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE
from app.core.errors import ForbiddenError
from app.repositories import get_repository  # noqa: F401
from app.repositories.base import DataRepository
from app.services import auth_service
from app.services.common import ListQuery
from app.services.model import Model, get_model

_READ_METHODS = {"GET", "HEAD", "OPTIONS"}


def current_user(request: Request, repo: DataRepository = Depends(get_repository),
                 settings: Settings = Depends(get_settings)) -> dict:
    """The signed-in user, from 'Authorization: Bearer <token>' (401 when missing, expired or revoked)."""
    header = request.headers.get("Authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else None
    return auth_service.user_for_token(repo.store, settings, token)


def require_access(request: Request, user: dict = Depends(current_user)) -> dict:
    """Every data route: viewers may read and download; changing anything needs an editor or admin."""
    if request.method not in _READ_METHODS and user.get("role") not in ("admin", "editor"):
        raise ForbiddenError("Your role (viewer) can view and download data but not change it.")
    return user


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != "admin":
        raise ForbiddenError("Only an admin can manage users.")
    return user


def current_model(repo: DataRepository = Depends(get_repository)) -> Model:
    """The analytics model for the current data version (cached between requests)."""
    return get_model(repo)


def list_params(
    search: Optional[str] = Query(None, description="Case-insensitive substring search"),
    sort_by: Optional[str] = Query(None, description="Field name as returned by the endpoint, e.g. netAmount"),
    sort_dir: Literal["asc", "desc"] = "asc",
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> ListQuery:
    return ListQuery(search=search, sort_by=sort_by, sort_dir=sort_dir, page=page, page_size=page_size)
