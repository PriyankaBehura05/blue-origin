"""
Column contracts for each BO dataset type.

These are PROVISIONAL. Required columns and header aliases must be revised once real
BO Excel/CSV files are inspected. Changing a spec here changes validation
everywhere - no other module lists columns.
"""
from dataclasses import dataclass, field
from typing import Dict, List

from app.core.constants import DatasetType

# column kinds understood by the validator/transformer
TEXT, NAME, CODE, DATE, AMOUNT, INTEGER, PINCODE, STATE, MONTH = (
    "text", "name", "code", "date", "amount", "integer", "pincode", "state", "month")


@dataclass(frozen=True)
class DatasetSpec:
    dataset: DatasetType
    required: List[str]
    optional: List[str]
    kinds: Dict[str, str]
    aliases: Dict[str, str] = field(default_factory=dict)  # normalised header -> canonical column
    exact_duplicate_check: bool = True
    # columns whose repeated values are flagged needs_review (identity is NOT inferred from them)
    review_repeated: List[str] = field(default_factory=list)
    # planning data (fulfilment plans, targets) legitimately holds future dates
    future_dates_ok: bool = False
    # amount columns where 0 is a normal value (e.g. no returns, nothing spent yet)
    zero_ok: List[str] = field(default_factory=list)
    # amount columns where a negative value is normal (e.g. a month whose credit notes exceed billing)
    negative_ok: List[str] = field(default_factory=list)

    @property
    def all_columns(self) -> List[str]:
        return self.required + self.optional


_COMMON_ALIASES = {
    "retailer": "retailer_name", "retailer_nm": "retailer_name", "store_name": "retailer_name",
    "party_name": "retailer_name", "customer_name": "retailer_name",
    "distributor": "distributor_name", "distributor_nm": "distributor_name", "dist_name": "distributor_name",
    "pin": "pincode", "pin_code": "pincode", "postal_code": "pincode",
    "town": "city", "state_name": "state", "zone": "region",
    "area_sales_manager": "asm", "regional_sales_manager": "rsm",
    "channel_type": "channel", "sales_channel": "channel",
}

SALES_SPEC = DatasetSpec(
    dataset=DatasetType.SALES,
    required=["invoice_date", "retailer_name", "distributor_name", "net_sales_amount"],
    optional=["invoice_no", "retailer_code", "distributor_code", "quantity",
              "state", "city", "pincode", "asm", "rsm", "region", "channel", "category",
              "gross_amount", "return_amount", "quarter"],
    kinds={"invoice_date": DATE, "quarter": TEXT, "retailer_name": NAME, "distributor_name": NAME,
           "net_sales_amount": AMOUNT, "invoice_no": CODE, "retailer_code": CODE,
           "distributor_code": CODE, "quantity": INTEGER, "state": STATE, "city": TEXT,
           "pincode": PINCODE, "asm": NAME, "rsm": NAME, "region": TEXT, "channel": TEXT,
           "category": TEXT, "gross_amount": AMOUNT, "return_amount": AMOUNT},
    aliases={**_COMMON_ALIASES, "date": "invoice_date", "bill_date": "invoice_date",
             "net_sales": "net_sales_amount", "net_amount": "net_sales_amount",
             "sales_value": "net_sales_amount", "amount": "net_sales_amount",
             "invoice_number": "invoice_no", "bill_no": "invoice_no", "qty": "quantity",
             "gross_sales": "gross_amount", "gross": "gross_amount", "gross_value": "gross_amount",
             "returns": "return_amount", "return_value": "return_amount", "sales_return": "return_amount",
             "product_category": "category"},
    zero_ok=["return_amount"],
    negative_ok=["net_sales_amount"],   # credit notes are real sales records and are counted
)

RETAILERS_SPEC = DatasetSpec(
    dataset=DatasetType.RETAILERS,
    required=["retailer_name", "distributor_name"],
    optional=["retailer_code", "distributor_code", "state", "city", "pincode",
              "asm", "rsm", "onboarding_date", "status", "region", "channel"],
    kinds={"retailer_name": NAME, "distributor_name": NAME, "retailer_code": CODE,
           "distributor_code": CODE, "state": STATE, "city": TEXT, "pincode": PINCODE,
           "asm": NAME, "rsm": NAME, "onboarding_date": DATE, "status": TEXT,
           "region": TEXT, "channel": TEXT},
    aliases={**_COMMON_ALIASES, "onboarded_on": "onboarding_date", "doj": "onboarding_date"},
    review_repeated=["retailer_name"],
)

DISTRIBUTORS_SPEC = DatasetSpec(
    dataset=DatasetType.DISTRIBUTORS,
    required=["distributor_name"],
    optional=["distributor_code", "state", "city", "pincode", "asm", "rsm",
              "onboarding_date", "status", "region"],
    kinds={"distributor_name": NAME, "distributor_code": CODE, "state": STATE, "city": TEXT,
           "pincode": PINCODE, "asm": NAME, "rsm": NAME, "onboarding_date": DATE, "status": TEXT,
           "region": TEXT},
    aliases={**_COMMON_ALIASES, "onboarded_on": "onboarding_date"},
    review_repeated=["distributor_name"],
)

BENEFITS_SPEC = DatasetSpec(
    dataset=DatasetType.BENEFITS,
    required=["name", "tier"],
    optional=["id", "frequency", "quantity", "unit_cost", "description"],
    kinds={"id": CODE, "name": TEXT, "tier": TEXT, "frequency": TEXT, "quantity": INTEGER,
           "unit_cost": AMOUNT, "description": TEXT},
    aliases={"benefit_id": "id", "benefit_code": "id", "code": "id", "benefit": "name",
             "benefit_name": "name", "eligible_tier": "tier", "qty": "quantity", "cost": "unit_cost",
             "unit_price": "unit_cost"},
    zero_ok=["unit_cost"],
)

FULFILLMENTS_SPEC = DatasetSpec(
    dataset=DatasetType.FULFILLMENTS,
    required=["benefit_id", "planned_date"],
    optional=["id", "retailer_code", "retailer_name", "tier", "quarter", "actual_date", "status", "cost",
              "owner", "remarks"],
    kinds={"id": CODE, "benefit_id": CODE, "retailer_code": CODE, "retailer_name": NAME, "tier": TEXT,
           "quarter": TEXT, "planned_date": DATE, "actual_date": DATE, "status": TEXT, "cost": AMOUNT,
           "owner": NAME, "remarks": TEXT},
    aliases={"fulfillment_id": "id", "fulfilment_id": "id", "benefit_code": "benefit_id",
             "retailer": "retailer_name", "planned_on": "planned_date", "fulfilled_on": "actual_date",
             "actual_on": "actual_date", "fulfilment_status": "status", "fulfillment_status": "status"},
    future_dates_ok=True,
    zero_ok=["cost"],
)

TARGETS_SPEC = DatasetSpec(
    dataset=DatasetType.TARGETS,
    required=["month", "target_amount"],
    optional=["region", "channel"],
    kinds={"month": MONTH, "target_amount": AMOUNT, "region": TEXT, "channel": TEXT},
    aliases={**_COMMON_ALIASES, "target": "target_amount", "target_value": "target_amount",
             "period": "month"},
    future_dates_ok=True,
)

SPECS = {s.dataset: s for s in (SALES_SPEC, RETAILERS_SPEC, DISTRIBUTORS_SPEC, BENEFITS_SPEC,
                                FULFILLMENTS_SPEC, TARGETS_SPEC)}


def get_spec(dataset: DatasetType) -> DatasetSpec:
    return SPECS[DatasetType(dataset)]
