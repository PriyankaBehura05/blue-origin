from typing import Literal, Optional

from fastapi import APIRouter, Depends, Path, Query, Response

from app.api.deps import current_model, list_params
from app.schemas.common import ApiResponse, Paged
from app.schemas.retailer import Retailer, RetailerDetail
from app.services import retailer_service
from app.services.common import ListQuery
from app.services.model import Model

router = APIRouter(prefix="/retailers", tags=["Retailers"])


@router.get("", response_model=ApiResponse[Paged[Retailer]], summary="Retailers with tier and quarterly sales")
def list_retailers(
    region: Optional[str] = None,
    state: Optional[str] = None,
    channel: Optional[str] = None,
    tier: Optional[str] = Query(None, description="Current tier name, e.g. Gold"),
    movement: Optional[str] = Query(None, description="Tier movement vs previous quarter: Upgrade | Downgrade | Retained"),
    status: Optional[str] = None,
    distributor_id: Optional[str] = Query(None, alias="distributorId"),
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"region": region, "state": state, "channel": channel, "tier": tier, "movement": movement,
                 "status": status, "distributorId": distributor_id}
    return ApiResponse(data=retailer_service.list_retailers(m, q))


@router.get("/export", response_class=Response,
            summary="Download the retailer list (same search / filters / sort) as Excel or CSV")
def export_retailers(
    format: Literal["xlsx", "csv"] = "xlsx",
    region: Optional[str] = None,
    state: Optional[str] = None,
    channel: Optional[str] = None,
    tier: Optional[str] = None,
    movement: Optional[str] = None,
    status: Optional[str] = None,
    distributor_id: Optional[str] = Query(None, alias="distributorId"),
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"region": region, "state": state, "channel": channel, "tier": tier, "movement": movement,
                 "status": status, "distributorId": distributor_id}
    content, media, name = retailer_service.export_retailers(m, q, format)
    return Response(content=content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/{retailer_id}", response_model=ApiResponse[RetailerDetail],
            summary="Retailer profile with its sales rows and benefit fulfilments")
def get_retailer(retailer_id: str = Path(..., description="id from the list endpoint"),
                 m: Model = Depends(current_model)):
    return ApiResponse(data=retailer_service.get_retailer(m, retailer_id))
