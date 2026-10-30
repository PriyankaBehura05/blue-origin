"""Benefit catalogue and fulfilment records (read + create / update / delete, stored in the data store)."""
from typing import List

from app.core.constants import DatasetType
from app.core.errors import InvalidFilterError, NotFoundError
from app.repositories.base import DataRepository
from app.rules.benefit_rules import benefit_categories
from app.schemas.benefit import BenefitCategory, BenefitIn, FulfillmentIn
from app.services import record_service
from app.services.common import ListQuery, filter_frame, list_query, paginate, sort_frame
from app.services.model import Model, canon

BENEFIT_SEARCH = ("name", "description", "id")
BENEFIT_FILTERS = ("tier", "frequency")
FULFILLMENT_SEARCH = ("retailerName", "benefitName", "id")
FULFILLMENT_FILTERS = ("quarter", "tier", "status", "retailerId", "benefitId")


def categories() -> List[BenefitCategory]:
    return [BenefitCategory(**c) for c in benefit_categories()]


# ------------------------------------------------------------------ catalogue
def list_benefits(m: Model, q: ListQuery) -> dict:
    return list_query(m.benefits, q, BENEFIT_SEARCH)


def _benefit_values(m: Model, body: BenefitIn) -> dict:
    tier = canon(body.tier, m.tier_rank.keys())
    if tier not in m.tier_rank:
        raise InvalidFilterError(f"Unknown tier '{body.tier}'.", details={"allowed": list(m.tier_rank)})
    return {"name": body.name.strip(), "tier": tier, "frequency": body.frequency, "quantity": body.quantity,
            "unit_cost": body.unit_cost, "description": body.description}


def create_benefit(repo: DataRepository, m: Model, body: BenefitIn) -> str:
    return record_service.create(repo, DatasetType.BENEFITS, _benefit_values(m, body))


def update_benefit(repo: DataRepository, m: Model, benefit_id: str, body: BenefitIn) -> None:
    record_service.update(repo, DatasetType.BENEFITS, benefit_id, _benefit_values(m, body))


def delete_benefit(repo: DataRepository, m: Model, benefit_id: str) -> None:
    in_use = m.fulfillments[m.fulfillments["benefitId"].str.casefold() == benefit_id.casefold()]
    if len(in_use):
        raise InvalidFilterError("This benefit has fulfilment records; delete those first.",
                                 details={"fulfillments": len(in_use)}, code="IN_USE")
    record_service.delete(repo, DatasetType.BENEFITS, benefit_id)


# ------------------------------------------------------------------ fulfilments
def list_fulfillments(m: Model, q: ListQuery) -> dict:
    df = filter_frame(m.fulfillments, q, FULFILLMENT_SEARCH)
    page = paginate(sort_frame(df, q.sort_by or "plannedDate", q.sort_dir if q.sort_by else "desc"),
                    q.page, q.page_size)
    page["summary"] = {
        "cost": float(df["cost"].sum()),
        "fulfilled": int((df["status"] == "Fulfilled").sum()),
        "pending": int(df["status"].isin(["Planned", "In Progress"]).sum()),
        "overdue": int((df["status"] == "Overdue").sum()),
        "records": len(df),
    }
    return page


def _fulfillment_values(m: Model, body: FulfillmentIn) -> dict:
    ben = m.benefits[m.benefits["id"].str.casefold() == body.benefit_id.strip().casefold()]
    if ben.empty:
        raise NotFoundError(f"Benefit '{body.benefit_id}' was not found.", details={"benefitId": body.benefit_id})
    ret = m.retailers[m.retailers["id"] == body.retailer_id]
    if ret.empty:
        raise NotFoundError(f"Retailer '{body.retailer_id}' was not found.", details={"retailerId": body.retailer_id})
    b, r = ben.iloc[0], ret.iloc[0]
    status = canon(body.status, ["Planned", "In Progress", "Fulfilled"]) if body.status else None
    if status and status not in ("Planned", "In Progress", "Fulfilled"):
        raise InvalidFilterError("status must be Planned, In Progress or Fulfilled (Overdue is derived).",
                                 details={"status": body.status})
    if status == "Fulfilled" and body.actual_date is None:
        raise InvalidFilterError("actualDate is required when status is Fulfilled.", details={"field": "actualDate"})
    return {
        "benefit_id": b["id"], "retailer_code": r["code"], "retailer_name": r["name"], "tier": b["tier"],
        "planned_date": body.planned_date, "actual_date": body.actual_date,
        "status": "Fulfilled" if body.actual_date else status,
        "cost": body.cost if body.cost is not None else float(b["quantity"]) * float(b["unitCost"]),
    }


def create_fulfillment(repo: DataRepository, m: Model, body: FulfillmentIn) -> str:
    return record_service.create(repo, DatasetType.FULFILLMENTS, _fulfillment_values(m, body))


def update_fulfillment(repo: DataRepository, m: Model, fulfillment_id: str, body: FulfillmentIn) -> None:
    record_service.update(repo, DatasetType.FULFILLMENTS, fulfillment_id, _fulfillment_values(m, body))


def delete_fulfillment(repo: DataRepository, fulfillment_id: str) -> None:
    record_service.delete(repo, DatasetType.FULFILLMENTS, fulfillment_id)
