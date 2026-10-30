from datetime import date
from typing import Optional

from app.schemas.common import CamelSchema


class Distributor(CamelSchema):
    id: str
    name: str
    code: Optional[str] = None
    state: Optional[str] = None
    city: Optional[str] = None
    region: Optional[str] = None
    asm: Optional[str] = None
    rsm: Optional[str] = None
    retailer_count: int
    current_quarter_sales: float
    status: str
    onboarded_on: Optional[date] = None
    in_master: bool
