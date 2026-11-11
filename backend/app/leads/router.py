"""Lead Generation API: all routes under /api/leads (mounted in app/api/router.py behind sign-in)."""
from typing import Dict, List

from fastapi import APIRouter, Depends, File, Request, Response, UploadFile
from pydantic import BaseModel

from app.api.deps import DataRepository, current_user, get_repository
from app.core.config import get_settings
from app.core.errors import InvalidFileError
from app.schemas.common import ApiResponse

from .services import leads_service as svc

router = APIRouter(prefix="/leads", tags=["Lead Generation"])


@router.get("/data", summary="Dashboard data (gzip JSON, column arrays); rebuilt first when the inputs changed")
def data(request: Request, repo: DataRepository = Depends(get_repository)):
    body, etag = svc.payload(repo.store)
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})


@router.get("/status", response_model=ApiResponse[dict], summary="Last build and the files in the leads inbox")
def status(repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=svc.status(repo.store))


@router.post("/rebuild", response_model=ApiResponse[dict], summary="Rebuild from the inbox and the sales data now")
def rebuild(repo: DataRepository = Depends(get_repository)):
    svc.ensure_built(repo.store, force=True)
    return ApiResponse(data=svc.status(repo.store))


@router.post("/inbox", response_model=ApiResponse[dict], summary="Add a lead / spend / follow-up / targets file to the inbox")
async def upload(file: UploadFile = File(...), repo: DataRepository = Depends(get_repository)):
    try:
        svc.save_inbox_file(repo.store, file.filename or "upload.csv", await file.read())
    except ValueError as exc:
        raise InvalidFileError(str(exc))
    return ApiResponse(data=svc.status(repo.store))


@router.delete("/inbox/{name}", response_model=ApiResponse[dict], summary="Remove a file from the inbox")
def remove(name: str, repo: DataRepository = Depends(get_repository)):
    svc.delete_inbox_file(repo.store, name)
    return ApiResponse(data=svc.status(repo.store))


@router.get("/reconciliation", summary="Reconciliation workbook: checks, lead buckets, match passes, rows by step, "
                                       "assumptions, data gaps")
def reconciliation(repo: DataRepository = Depends(get_repository)):
    return Response(svc.output(repo.store, "reconciliation.xlsx"),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="Lead_Gen_Reconciliation.xlsx"'})


@router.get("/memo", summary="One-page findings memo for leadership (Markdown)")
def memo(repo: DataRepository = Depends(get_repository)):
    return Response(svc.output(repo.store, "memo.md"), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": 'inline; filename="Lead_Gen_Findings_Memo.md"'})


class ActionsBody(BaseModel):
    items: List[dict]


@router.get("/actions", response_model=ApiResponse[List[dict]], summary="Actions tracker")
def actions(repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=svc.get_actions(repo.store))


@router.put("/actions", response_model=ApiResponse[List[dict]], summary="Save the actions tracker (editors and admins)")
def save_actions(body: ActionsBody, repo: DataRepository = Depends(get_repository), user: dict = Depends(current_user)):
    return ApiResponse(data=svc.save_actions(repo.store, body.items, user.get("email")))


@router.get("/targets", response_model=ApiResponse[dict], summary="Targets saved in the dashboard")
def targets(repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=svc.get_targets(repo.store))


@router.put("/targets", response_model=ApiResponse[dict], summary="Save targets (editors and admins); rebuilds the memo")
def save_targets(body: Dict[str, float], repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=svc.save_targets(repo.store, body))


class SheetsBody(BaseModel):
    items: List[dict]


@router.get("/sheets", response_model=ApiResponse[dict], summary="Linked Google Sheets, their last read and the "
                                                                   "service-account email to share them with")
def sheets(repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=svc.sheets_status(repo.store))


@router.put("/sheets", response_model=ApiResponse[dict], summary="Save the Google Sheets links (editors and admins); "
                                                                  "reads them and rebuilds")
def save_sheets(body: SheetsBody, repo: DataRepository = Depends(get_repository)):
    try:
        return ApiResponse(data=svc.save_sheet_sources(repo.store, get_settings(), body.items))
    except ValueError as exc:
        raise InvalidFileError(str(exc))


@router.post("/sheets/refresh", response_model=ApiResponse[dict], summary="Read the linked Google Sheets now")
def refresh_sheets(repo: DataRepository = Depends(get_repository)):
    svc.refresh_sheets(repo.store, get_settings())
    return ApiResponse(data=svc.sheets_status(repo.store))
