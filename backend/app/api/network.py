from typing import Optional

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.deps import DataRepository, Settings, get_repository, get_settings
from app.schemas.common import ApiResponse
from app.schemas.network import NetworkStatus
from app.services import consolidated_export, network_service, sheets_download
from app.services.sync_service import scheduler

router = APIRouter(prefix="/network", tags=["BO Retailer Network"])


@router.get("/data", summary="Consolidated retailer data for the dashboard pages (gzip JSON envelope)",
            response_description="{success, data: dashboard_data.json, meta}; served gzipped with an ETag")
def data(request: Request, repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    body, etag, source = network_service.payload(repo.store, settings)
    headers = {"ETag": etag, "Cache-Control": "private, no-cache", "X-Data-Source": source}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})


@router.get("/status", response_model=ApiResponse[NetworkStatus], summary="Where the dashboard data comes from and the last build")
def status(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    nxt = scheduler.next_run_at.isoformat() if scheduler.next_run_at else None
    return ApiResponse(data={**network_service.status(repo.store, settings), "next_check_at": nxt,
                             "sheets": sheets_download.status(repo.store, settings)})


@router.post("/rebuild", response_model=ApiResponse[NetworkStatus],
             summary="Rebuild the dashboard data from the consolidated sheets now (in the background, about 5 minutes)")
def rebuild(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    network_service.rebuild_in_background(get_repository, settings, force=True)
    return ApiResponse(data=network_service.status(repo.store, settings))


@router.get("/download", summary="The current consolidated retailer data as an Excel workbook, all quarters or one (?quarter=Q2_FY27)",
            response_description="Read me, Retailers, Quarterly and Monthly revenue sheets")
def download(quarter: Optional[str] = Query(None, description="Only this quarter, e.g. Q2_FY27"),
             repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    content, name = consolidated_export.download(repo.store, settings, quarter)
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
