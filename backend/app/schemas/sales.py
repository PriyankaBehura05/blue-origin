from datetime import date
from typing import Optional

from app.schemas.common import CamelSchema, Paged


class SalesRecord(CamelSchema):
    id: str
    date: date
    month: str
    quarter: str
    fy: Optional[str] = None
    retailer_id: str
    retailer_name: str
    distributor_id: str
    distributor_name: str
    state: Optional[str] = None
    region: Optional[str] = None
    channel: Optional[str] = None
    category: Optional[str] = None
    quantity: float
    gross_amount: float
    return_amount: float
    net_amount: float


class SalesSummary(CamelSchema):
    gross: float
    returns: float
    net: float
    quantity: float
    records: int


class SalesPage(Paged[SalesRecord]):
    summary: SalesSummary
