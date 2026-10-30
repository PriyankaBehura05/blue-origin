from datetime import date
from typing import Dict, List, Optional

from pydantic import Field

from app.schemas.common import BaseSchema, CamelSchema


class TierDefinition(CamelSchema):
    tier: str
    min_quarterly_sales: float
    max_quarterly_sales: Optional[float] = Field(None, description="null = no upper limit")
    color: str
    retailer_count: int
    description: str
    effective_from: Optional[date] = Field(None, description="First day the tier applies (null = always)")


class TierMovement(CamelSchema):
    """A retailer's tier and net sales in the selected quarter, compared with the quarter before."""
    retailer_id: str
    retailer_name: str
    retailer_code: Optional[str] = None
    distributor_name: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    status: Optional[str] = None
    from_: str = Field(alias="from")
    to: str
    quarter: str
    previous_quarter: Optional[str] = None
    direction: str
    quarterly_sales: float
    previous_quarter_sales: float = 0.0


class TierMixRow(CamelSchema):
    """Tier counts for one quarter (retailers that bought in that quarter)."""
    quarter: str
    buying_retailers: int
    tiered_retailers: int
    net_sales: float
    counts: Dict[str, int]


class TierBandOut(BaseSchema):
    code: str
    name: str
    rank: int
    min_amount: float
    max_amount: Optional[float] = Field(None, description="null = no upper limit")
    effective_from: Optional[date] = Field(None, description="Only for quarters starting on/after this date")


class TierConfigOut(BaseSchema):
    status: str
    currency: str
    qualification_basis: str
    boundary_rule: str
    notes: List[str]
    tiers: List[TierBandOut]


class TierClassification(BaseSchema):
    amount: Optional[float]
    tier_code: Optional[str]
    status: str
    note: Optional[str] = None
