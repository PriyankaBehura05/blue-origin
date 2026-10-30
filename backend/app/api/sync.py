from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query

from app.api.deps import DataRepository, Settings, get_repository, get_settings
from app.schemas.common import ApiResponse, BaseSchema
from app.services.sync_service import SyncRunner, scheduler

router = APIRouter(prefix="/sync", tags=["Pipeline"])


class SyncStatus(BaseSchema):
    inbox: str
    interval_minutes: int
    running: bool
    next_run_at: Optional[str] = None
    last_run: Optional[Dict[str, Any]] = None
    datasets: Dict[str, Any]
    recent_runs: List[Dict[str, Any]]


@router.get("", response_model=ApiResponse[SyncStatus], summary="Automatic pipeline status (Dropbox inbox -> datasets)")
def status(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    runner = SyncRunner(repo, settings)
    state = runner.load_state()
    runs = state.get("runs", [])
    last = runs[0] if runs else scheduler.last_run
    if scheduler.last_run and runs and scheduler.last_run["started_at"] > runs[0]["started_at"]:
        last = scheduler.last_run
    return ApiResponse(data=SyncStatus(
        inbox=f"{repo.location}/{runner.inbox}", interval_minutes=settings.SYNC_INTERVAL_MINUTES,
        running=scheduler.running,
        next_run_at=scheduler.next_run_at.isoformat() if scheduler.next_run_at else None,
        last_run=last, datasets=state.get("datasets", {}), recent_runs=runs[:10]))


@router.post("", response_model=ApiResponse[Dict[str, Any]],
             summary="Run the pipeline now: fetch new/changed inbox files, validate, rebuild datasets")
def run_now(force: bool = Query(False, description="Rebuild every dataset that has inbox files, even if unchanged"),
            repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    run = SyncRunner(repo, settings).run("manual", force=force)
    scheduler.last_run = run
    return ApiResponse(data=run)
