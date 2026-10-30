from typing import Literal, Optional

from fastapi import APIRouter, Depends, Response

from app.api.deps import current_model, list_params
from app.schemas.common import ApiResponse, Paged
from app.schemas.distributor import Distributor
from app.services import distributor_service
from app.services.common import ListQuery
from app.services.model import Model

router = APIRouter(prefix="/distributors", tags=["Distributors"])


@router.get("", response_model=ApiResponse[Paged[Distributor]], summary="Distributors with retailer counts")
def list_distributors(
    region: Optional[str] = None,
    state: Optional[str] = None,
    status: Optional[str] = None,
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"region": region, "state": state, "status": status}
    return ApiResponse(data=distributor_service.list_distributors(m, q))


@router.get("/export", response_class=Response,
            summary="Download the distributor list (same search / filters / sort) as Excel or CSV")
def export_distributors(
    format: Literal["xlsx", "csv"] = "xlsx",
    region: Optional[str] = None,
    state: Optional[str] = None,
    status: Optional[str] = None,
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"region": region, "state": state, "status": status}
    content, media, name = distributor_service.export_distributors(m, q, format)
    return Response(content=content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})
