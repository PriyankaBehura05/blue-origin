from datetime import datetime
from typing import List, Optional

from app.schemas.common import CamelSchema


class IdName(CamelSchema):
    id: str
    name: str


class FilterOptions(CamelSchema):
    current_quarter: str
    previous_quarter: str
    current_fy: str
    regions: List[str]
    states: List[str]
    channels: List[str]
    quarters: List[str]
    sales_quarters: List[str]
    months: List[str] = []           # months with sales, 'YYYY-MM', newest first
    financial_years: List[str]
    tiers: List[str]
    distributors: List[IdName]
    retailers: List[IdName]
    categories: List[str]
    retailer_statuses: List[str]
    distributor_statuses: List[str]
    fulfillment_statuses: List[str]
    benefit_frequencies: List[str]
    benefits: List[IdName]
    movement_directions: List[str]


class DatasetStatus(CamelSchema):
    dataset: str
    stored: bool
    rows: int
    valid_rows: int
    modified: Optional[datetime] = None
    path: str
    required_columns: List[str]
    optional_columns: List[str]
