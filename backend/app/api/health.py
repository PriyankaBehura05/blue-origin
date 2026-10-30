from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request

from app.api.deps import Settings, get_repository, get_settings
from app.core.errors import AppError
from app.schemas.common import HealthResponse

router = APIRouter(tags=["System"])


@router.get("/health", response_model=HealthResponse, summary="Liveness check, including the data store")
def health(request: Request, settings: Settings = Depends(get_settings)):
    store, ok, error = None, True, None
    try:
        # resolved here (not via Depends) so a misconfigured store reports "degraded" instead of failing
        repo = request.app.dependency_overrides.get(get_repository, get_repository)()
        store = repo.location
        repo.store.check()
    except AppError as exc:
        ok, error = False, exc.message
    return HealthResponse(status="ok" if ok else "degraded", app=settings.APP_NAME, version=settings.APP_VERSION,
                          environment=settings.ENVIRONMENT, data_source=settings.DATA_SOURCE, store=store,
                          store_ok=ok, store_error=error, timestamp=datetime.now(timezone.utc))
