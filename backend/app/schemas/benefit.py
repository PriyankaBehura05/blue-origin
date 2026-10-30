from datetime import date
from typing import List, Optional

from pydantic import Field

from app.schemas.common import BaseSchema, CamelSchema, Paged


class BenefitCategory(BaseSchema):
    code: str
    name: str
    eligible_tiers: Optional[List[str]] = None   # unconfirmed
    entitlement: Optional[str] = None            # unconfirmed
    frequency: Optional[str] = None              # unconfirmed


class Benefit(CamelSchema):
    id: str
    name: str
    tier: str
    frequency: Optional[str] = None
    quantity: float
    unit_cost: float
    description: Optional[str] = None


class BenefitIn(CamelSchema):
    name: str = Field(min_length=1)
    tier: str = Field(min_length=1)
    frequency: Optional[str] = None
    quantity: float = Field(1, ge=0)
    unit_cost: float = Field(0, ge=0)
    description: Optional[str] = None


class BenefitFulfillment(CamelSchema):
    id: str
    benefit_id: str
    benefit_name: str
    retailer_id: str
    retailer_name: str
    tier: str
    quarter: str
    fy: Optional[str] = None
    planned_date: date
    actual_date: Optional[date] = None
    status: str
    cost: float


class FulfillmentIn(CamelSchema):
    benefit_id: str = Field(min_length=1)
    retailer_id: str = Field(min_length=1, description="Retailer id from GET /retailers")
    planned_date: date
    actual_date: Optional[date] = None
    status: Optional[str] = Field(None, description="Planned / In Progress / Fulfilled. Overdue is derived.")
    cost: Optional[float] = Field(None, ge=0, description="Default: benefit quantity x unit cost")


class FulfillmentSummary(CamelSchema):
    cost: float
    fulfilled: int
    pending: int
    overdue: int
    records: int


class FulfillmentPage(Paged[BenefitFulfillment]):
    summary: FulfillmentSummary
