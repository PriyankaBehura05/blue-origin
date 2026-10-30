"""Retailer list / profile, enriched with quarterly sales and tiers."""
from typing import Tuple

from app.core.errors import NotFoundError
from app.services.common import ListQuery, export_query, list_query, records, to_file
from app.services.model import Model

SEARCH_FIELDS = ("name", "code", "city", "distributorName", "id", "pincode")
FILTERS = ("region", "state", "channel", "tier", "status", "distributorId")


def list_retailers(m: Model, q: ListQuery) -> dict:
    return list_query(m.retailers.assign(tier=m.retailers["currentTier"]), q, SEARCH_FIELDS)


def export_retailers(m: Model, q: ListQuery, fmt: str) -> Tuple[bytes, str, str]:
    cur, prev = m.periods.current_label, m.periods.previous_label
    columns = [("code", "Retailer Code"), ("name", "Retailer"), ("distributorName", "Distributor"), ("city", "City"),
               ("state", "State"), ("region", "Region"), ("pincode", "Pincode"),
               ("status", "Status"), ("currentTier", f"Tier {cur}"), ("previousTier", f"Tier {prev}"),
               ("currentQuarterSales", f"{cur} Net Sales (₹)"), ("previousQuarterSales", f"{prev} Net Sales (₹)"),
               ("fySales", "FY Net Sales (₹)"), ("onboardedOn", "Onboarded"), ("asm", "ASM"), ("rsm", "RSM")]
    df = export_query(m.retailers.assign(tier=m.retailers["currentTier"]), q, SEARCH_FIELDS, columns)
    content, media = to_file(df, fmt, "Retailers", f"Retailers as filtered on screen  •  Net sales in ₹  •  Current quarter {cur}")
    return content, media, f"Retailers_{cur.replace(' ', '_')}.{fmt.lower()}"


def get_retailer(m: Model, retailer_id: str) -> dict:
    match = m.retailers[m.retailers["id"] == retailer_id]
    if match.empty:
        raise NotFoundError(f"Retailer '{retailer_id}' was not found.", details={"id": retailer_id})
    sales = m.sales[m.sales["retailerId"] == retailer_id].sort_values("date", ascending=False)
    ful = m.fulfillments[m.fulfillments["retailerId"] == retailer_id].sort_values("plannedDate", ascending=False)
    return {"retailer": records(match.head(1))[0], "sales": records(sales), "fulfillments": records(ful)}
