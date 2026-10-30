from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import DataRepository, current_model, get_repository, list_params
from app.core.errors import NotFoundError
from app.schemas.benefit import (Benefit, BenefitCategory, BenefitFulfillment, BenefitIn, FulfillmentIn,
                                 FulfillmentPage)
from app.schemas.common import ApiResponse, Paged
from app.services import benefit_service
from app.services.common import ListQuery, records
from app.services.model import Model, get_model

router = APIRouter(prefix="/benefits", tags=["Benefits"])


def _one(df, record_id: str) -> dict:
    hit = df[df["id"].str.casefold() == record_id.casefold()]
    if hit.empty:
        raise NotFoundError(f"Record '{record_id}' was not found.", details={"id": record_id})
    return records(hit.head(1))[0]


@router.get("/categories", response_model=ApiResponse[List[BenefitCategory]],
            summary="Reference benefit categories (entitlements unconfirmed)")
def categories():
    return ApiResponse(data=benefit_service.categories())


# ------------------------------------------------------------------ fulfilments
@router.get("/fulfillments", response_model=ApiResponse[FulfillmentPage],
            summary="Benefit fulfilment records + totals (Overdue is derived from the planned date)")
def list_fulfillments(
    fy: Optional[str] = Query(None, description='Financial year, e.g. "FY 27"'),
    quarter: Optional[str] = None,
    tier: Optional[str] = None,
    status: Optional[str] = Query(None, description="Planned | In Progress | Fulfilled | Overdue"),
    retailer_id: Optional[str] = Query(None, alias="retailerId"),
    benefit_id: Optional[str] = Query(None, alias="benefitId"),
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"fy": fy, "quarter": quarter, "tier": tier, "status": status, "retailerId": retailer_id,
                 "benefitId": benefit_id}
    return ApiResponse(data=benefit_service.list_fulfillments(m, q))


@router.post("/fulfillments", response_model=ApiResponse[BenefitFulfillment], status_code=201,
             summary="Plan a benefit for a retailer")
def create_fulfillment(body: FulfillmentIn, repo: DataRepository = Depends(get_repository),
                       m: Model = Depends(current_model)):
    new_id = benefit_service.create_fulfillment(repo, m, body)
    return ApiResponse(data=_one(get_model(repo).fulfillments, new_id))


@router.put("/fulfillments/{fulfillment_id}", response_model=ApiResponse[BenefitFulfillment],
            summary="Update a fulfilment (e.g. mark fulfilled with the actual date)")
def update_fulfillment(fulfillment_id: str, body: FulfillmentIn, repo: DataRepository = Depends(get_repository),
                       m: Model = Depends(current_model)):
    benefit_service.update_fulfillment(repo, m, fulfillment_id, body)
    return ApiResponse(data=_one(get_model(repo).fulfillments, fulfillment_id))


@router.delete("/fulfillments/{fulfillment_id}", status_code=204, summary="Delete a fulfilment record")
def delete_fulfillment(fulfillment_id: str, repo: DataRepository = Depends(get_repository)):
    benefit_service.delete_fulfillment(repo, fulfillment_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ catalogue
@router.get("", response_model=ApiResponse[Paged[Benefit]], summary="Benefit catalogue")
def list_benefits(
    tier: Optional[str] = None,
    frequency: Optional[str] = None,
    q: ListQuery = Depends(list_params),
    m: Model = Depends(current_model),
):
    q.filters = {"tier": tier, "frequency": frequency}
    return ApiResponse(data=benefit_service.list_benefits(m, q))


@router.post("", response_model=ApiResponse[Benefit], status_code=201, summary="Add a benefit to the catalogue")
def create_benefit(body: BenefitIn, repo: DataRepository = Depends(get_repository),
                   m: Model = Depends(current_model)):
    new_id = benefit_service.create_benefit(repo, m, body)
    return ApiResponse(data=_one(get_model(repo).benefits, new_id))


@router.put("/{benefit_id}", response_model=ApiResponse[Benefit], summary="Update a catalogue benefit")
def update_benefit(benefit_id: str, body: BenefitIn, repo: DataRepository = Depends(get_repository),
                   m: Model = Depends(current_model)):
    benefit_service.update_benefit(repo, m, benefit_id, body)
    return ApiResponse(data=_one(get_model(repo).benefits, benefit_id))


@router.delete("/{benefit_id}", status_code=204, summary="Delete a catalogue benefit (only if unused)")
def delete_benefit(benefit_id: str, repo: DataRepository = Depends(get_repository),
                   m: Model = Depends(current_model)):
    benefit_service.delete_benefit(repo, m, benefit_id)
    return Response(status_code=204)
