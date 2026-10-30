from datetime import date
from typing import List, Optional

from pydantic import Field

from app.schemas.benefit import BenefitFulfillment
from app.schemas.common import CamelSchema
from app.schemas.sales import SalesRecord


class Retailer(CamelSchema):
    id: str = Field(description="Technical key: derived from retailer_code when present")
    code: Optional[str] = None
    name: str
    distributor_id: Optional[str] = None
    distributor_name: Optional[str] = None
    channel: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    region: Optional[str] = None
    pincode: Optional[str] = None
    asm: Optional[str] = None
    rsm: Optional[str] = None
    status: str
    current_tier: str
    previous_tier: str
    movement: str = Field("No sales", description="Tier movement in the current quarter: Upgraded, Downgraded, "
                                                  "Stayed in same tier, Dropped from the tier, New, "
                                                  "Never been on tier but some sales, No sales")
    tier_status: str = Field(description="'valid', or 'needs_review' when sales sit exactly on an "
                                          "unconfirmed tier boundary")
    current_quarter_sales: float
    fy_sales: float
    onboarded_on: Optional[date] = None
    in_master: bool = Field(description="False when the retailer appears only in sales data")


class RetailerDetail(CamelSchema):
    retailer: Retailer
    sales: List[SalesRecord]
    fulfillments: List[BenefitFulfillment]
