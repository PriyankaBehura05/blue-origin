from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import DataRepository, Settings, get_repository, get_settings
from app.schemas.common import ApiResponse
from app.services import counter_report_service

router = APIRouter(prefix="/counter-report", tags=["Distribution Counter Report"])
FY = Query(None, description="e.g. FY26 (Apr-25 to Mar-26); default = latest financial year with data")


@router.get("", response_model=ApiResponse[Dict[str, Any]],
            summary="Summary of the Distribution Counter Report for one financial year (the download has every sheet)")
def report(fy: Optional[str] = FY, repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    return ApiResponse(data=counter_report_service.summary(repo.store, settings, fy))


@router.get("/download", summary="The report as an Excel workbook, laid out like Distributor_Counter_Report.xlsx")
def download(fy: Optional[str] = FY, repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    content, name = counter_report_service.download(repo.store, settings, fy)
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
