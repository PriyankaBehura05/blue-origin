from typing import Optional

from fastapi import APIRouter, Depends, Query

from app.api.deps import current_model, list_params
from app.schemas.common import ApiResponse
from app.schemas.sales import SalesPage
from app.services import sales_service
from app.services.common import ListQuery
from app.services.model import Model

router = APIRouter(prefix="/sales", tags=["Sales"])


@router.get("", response_model=ApiResponse[SalesPage], summary="Sales rows (search, filter, sort, page) + totals")
def list_sales(
    fy: Optional[str] = Query(None, description='Financial year, e.g. "FY 27" (Apr 2026 - Mar 2027)'),
    quarter: Optional[str] = Query(None, description='e.g. "Q2 FY 27" (Q1 = Apr-Jun)'),
    month: Optional[str] = Query(None, description="YYYY-MM"),
    region: Optional[str] = None,
    state: Optional[str] = None,
    channel: Optional[str] = None,
    category: Optional[str] = None,
    distributor_id: Optional[str] = Query(None, alias="distributorId"),
    retailer_id: Optional[str] = Query(None, alias="retailerId"),
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"fy": fy, "quarter": quarter, "month": month, "region": region, "state": state, "channel": channel,
                 "category": category, "distributorId": distributor_id, "retailerId": retailer_id}
    return ApiResponse(data=sales_service.list_sales(m, q))
