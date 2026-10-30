from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.api.deps import current_model, list_params
from app.schemas.common import ApiResponse, Paged
from app.schemas.tier import TierClassification, TierConfigOut, TierDefinition, TierMixRow, TierMovement
from app.services import tier_service
from app.services.common import ListQuery
from app.services.model import Model

router = APIRouter(prefix="/tiers", tags=["Tiers"])


@router.get("", response_model=ApiResponse[TierConfigOut], summary="Tier configuration (reference)")
def get_tiers():
    return ApiResponse(data=tier_service.tier_config())


QUARTER_PARAM = Query(None, description='e.g. "Q1 FY 27"; default = latest quarter with sales')


@router.get("/classify", response_model=ApiResponse[TierClassification],
            summary="Classify one period's sales amount (uses the central tier config)")
def classify(amount: float = Query(..., description="Sales for the eligible period, in INR"),
             quarter: Optional[str] = Query(None, description='e.g. "Q4 FY 26": only tiers in force then '
                                                              '(Platinum from Q1 FY 27)')):
    return ApiResponse(data=tier_service.classify(amount, quarter))


@router.get("/definitions", response_model=ApiResponse[List[TierDefinition]],
            summary="Tier ladder with retailer counts for a quarter")
def definitions(quarter: Optional[str] = QUARTER_PARAM, m: Model = Depends(current_model)):
    return ApiResponse(data=tier_service.definitions(m, quarter))


@router.get("/by-quarter", response_model=ApiResponse[List[TierMixRow]],
            summary="Tier mix for every quarter with sales (newest first)")
def by_quarter(fy: Optional[str] = Query(None, description='Financial year, e.g. "FY 27"'),
               m: Model = Depends(current_model)):
    return ApiResponse(data=tier_service.mix_by_quarter(m, fy))


@router.get("/movements", response_model=ApiResponse[Paged[TierMovement]],
            summary="Retailer tiers and net sales for a quarter, vs the quarter before")
def movements(
    quarter: Optional[str] = QUARTER_PARAM,
    direction: Optional[str] = Query(None, description="Upgrade | Downgrade | Retained"),
    tier: Optional[str] = Query(None, description="Tier in the selected quarter"),
    region: Optional[str] = None,
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"direction": direction, "tier": tier, "region": region}
    return ApiResponse(data=tier_service.movements(m, q, quarter))
