"""Sales list with summary totals (gross / returns / net / quantity over ALL matching rows)."""
from app.services.common import ListQuery, filter_frame, paginate, sort_frame
from app.services.model import Model

SEARCH_FIELDS = ("retailerName", "distributorName", "id", "category", "retailerCode", "distributorCode")
FILTERS = ("fy", "quarter", "month", "region", "state", "channel", "category", "distributorId", "retailerId")


def list_sales(m: Model, q: ListQuery) -> dict:
    df = filter_frame(m.sales, q, SEARCH_FIELDS)
    page = paginate(sort_frame(df, q.sort_by or "date", q.sort_dir if q.sort_by else "desc"), q.page, q.page_size)
    page["summary"] = {
        "gross": float(df["grossAmount"].sum()),
        "returns": float(df["returnAmount"].sum()),
        "net": float(df["netAmount"].sum()),
        "quantity": float(df["quantity"].sum()),
        "records": len(df),
    }
    return page
