from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile

from app.api.deps import DataRepository, Settings, get_repository, get_settings
from app.core.constants import DatasetType
from app.schemas.common import ApiResponse
from app.schemas.upload import ActivationResult, UploadRecord, UploadResult, ValidationReportOut
from app.services import upload_service

router = APIRouter(prefix="/uploads", tags=["Uploads"])


@router.post("/validate", response_model=ApiResponse[ValidationReportOut],
             summary="Validate a BO file without storing it")
async def validate(
    file: UploadFile = File(..., description=".xlsx, .xls or .csv"),
    dataset: DatasetType = Form(..., description="sales | retailers | distributors | benefits | fulfillments | "
                                                 "targets"),
    sheet_name: Optional[str] = Form(None, description="Excel sheet (default: first sheet)"),
    settings: Settings = Depends(get_settings),
):
    content = await file.read()
    report = upload_service.validate_file(content, file.filename or "", dataset, sheet_name, settings)
    return ApiResponse(data=report)


@router.post("", response_model=ApiResponse[UploadResult], status_code=201,
             summary="Store a BO file in the data store (uploads/) and validate it")
async def upload(
    file: UploadFile = File(...),
    dataset: DatasetType = Form(...),
    sheet_name: Optional[str] = Form(None),
    allow_duplicate: bool = Query(False, description="Store even if an identical file was uploaded before"),
    settings: Settings = Depends(get_settings),
    repo: DataRepository = Depends(get_repository),
):
    content = await file.read()
    result = upload_service.store_upload(repo, content, file.filename or "", dataset, sheet_name, settings,
                                         allow_duplicate)
    return ApiResponse(data=result)


@router.post("/{upload_id}/activate", response_model=ApiResponse[ActivationResult],
             summary="Make a stored upload the live dataset (replace it, or append its rows)")
def activate(upload_id: str, mode: Literal["replace", "append"] = "replace",
             repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=upload_service.activate_upload(repo, upload_id, mode))


@router.get("", response_model=ApiResponse[List[UploadRecord]], summary="Upload history (newest first)")
def history(repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=upload_service.list_history(repo.store))
