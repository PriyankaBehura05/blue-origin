from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import DataRepository, Settings, current_model, get_repository, get_settings
from app.schemas.common import ApiResponse
from app.schemas.report import ReportDefinition, ReportPreview
from app.services import bo_data_report, report_service
from app.services.model import Model

router = APIRouter(prefix="/reports", tags=["Reports"])


def report_filters(month: Optional[str] = Query(None, description="YYYY-MM, e.g. 2026-09"),
                   quarter: Optional[str] = Query(None, description="e.g. Q2 FY 27"),
                   region: Optional[str] = None, state: Optional[str] = None,
                   distributor: Optional[str] = Query(None, description="Distributor id")) -> report_service.ReportFilters:
    """Optional report filters; none = all. A month or quarter sets the period of the period-based reports."""
    return report_service.ReportFilters.of(month, quarter, region, state, distributor)


def bo_data_scope(f: report_service.ReportFilters, m: Model) -> bo_data_report.Scope:
    dist = ""
    if f.distributor:
        hit = m.distributors.loc[m.distributors["id"] == f.distributor, "name"]
        dist = str(hit.iloc[0]) if len(hit) else f.distributor
    return bo_data_report.Scope(quarter=f.quarter, month=f.month, region=f.region, state=f.state, distributor=dist)


@router.get("/bo-data/summary", response_model=ApiResponse[Dict[str, Any]],
            summary="BO_Data (layout of BO_Consolidate_Final.xlsx): row count, tier distribution and movement summary")
def bo_data_summary(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings),
                    m: Model = Depends(current_model), f: report_service.ReportFilters = Depends(report_filters)):
    return ApiResponse(data=bo_data_report.summary(repo.store, settings, bo_data_scope(f, m)))


@router.get("/bo-data/download", summary="BO_Data workbook: the six sheets of BO_Consolidate_Final.xlsx for the filters",
            response_class=Response)
def bo_data_download(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings),
                     m: Model = Depends(current_model), f: report_service.ReportFilters = Depends(report_filters)):
    content, name = bo_data_report.download(repo.store, settings, bo_data_scope(f, m))
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("", response_model=ApiResponse[List[ReportDefinition]], summary="Report catalogue")
def list_reports(repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=report_service.definitions(repo.store))


@router.get("/{report_id}/preview", response_model=ApiResponse[ReportPreview], summary="First rows of a report")
def preview(report_id: str, limit: int = Query(25, ge=1, le=500), m: Model = Depends(current_model),
            f: report_service.ReportFilters = Depends(report_filters)):
    return ApiResponse(data=report_service.preview(m, report_id, limit, f))


@router.get("/{report_id}/download", summary="Full report as CSV or XLSX (logs the generation time)",
            response_class=Response)
def download(report_id: str, format: Literal["csv", "xlsx"] = "xlsx",
             repo: DataRepository = Depends(get_repository), m: Model = Depends(current_model),
             f: report_service.ReportFilters = Depends(report_filters)):
    content, media, filename = report_service.export(repo, m, report_id, format, f)
    return Response(content=content, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})
