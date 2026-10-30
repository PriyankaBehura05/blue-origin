"""Distributor list with retailer counts and current-quarter sales."""
from typing import Tuple

from app.services.common import ListQuery, export_query, list_query, to_file
from app.services.model import Model

SEARCH_FIELDS = ("name", "code", "city", "asm", "rsm", "id")
FILTERS = ("region", "state", "status")


def list_distributors(m: Model, q: ListQuery) -> dict:
    return list_query(m.distributors, q, SEARCH_FIELDS)


def export_distributors(m: Model, q: ListQuery, fmt: str) -> Tuple[bytes, str, str]:
    cur = m.periods.current_label
    columns = [("code", "Distributor Code"), ("name", "Distributor"), ("state", "State"), ("region", "Region"),
               ("retailerCount", "Retailers"), ("currentQuarterSales", f"{cur} Net Sales (₹)"), ("status", "Status")]
    df = export_query(m.distributors, q, SEARCH_FIELDS, columns)
    content, media = to_file(df, fmt, "Distributors", f"Distributors as filtered on screen  •  Net sales in ₹  •  Current quarter {cur}",
                             total=True)
    return content, media, f"Distributors_{cur.replace(' ', '_')}.{fmt.lower()}"
