"""Service-level tests against the small fictional fixture dataset (see conftest.py)."""
from datetime import date

import pytest

from app.core.errors import InvalidFilterError, NotFoundError
from app.services import (benefit_service, distributor_service, meta_service,
                          report_service, retailer_service, sales_service, tier_service)
from app.services.common import ListQuery
from app.services.model import build_model, quarter_label, quarter_of

TODAY = date(2026, 3, 20)


@pytest.fixture
def m(repo):
    return build_model(repo.snapshot()[1], today=TODAY)


def test_quarter_labels():
    assert quarter_label(*quarter_of(date(2026, 3, 12))) == "Q4 FY 26"
    assert quarter_label(*quarter_of(date(2026, 4, 1))) == "Q1 FY 27"
    assert quarter_label(*quarter_of(date(2025, 10, 5))) == "Q3 FY 26"


def test_periods_follow_latest_sales_date(m):
    assert m.periods.current_label == "Q4 FY 26"
    assert m.periods.previous_label == "Q3 FY 26"


def test_only_valid_sales_rows_are_used(m):
    # bad-date row (invalid) and blank-amount row (missing) are excluded
    assert len(m.sales) == 4
    assert m.sales["netAmount"].sum() == 251000
    t2 = m.sales[m.sales["id"] == "T-2"].iloc[0]
    assert t2["grossAmount"] == 164000 and t2["returnAmount"] == 4000
    assert t2["region"] == "South"  # from the retailer master


def test_filter_options(m):
    opts = meta_service.filter_options(m)
    assert opts["current_quarter"] == "Q4 FY 26"
    assert opts["quarters"] == ["Q3 FY 27", "Q4 FY 26", "Q3 FY 26"]
    assert opts["tiers"] == ["Yellow", "Green", "Silver", "Gold", "Platinum", "Unranked"]
    assert opts["regions"] == ["South"]
    assert opts["channels"] == ["GT", "MBO"]
    assert opts["retailer_statuses"] == ["Active", "Inactive", "Unknown"]


def test_sales_list_filters_sort_and_summary(m):
    page = sales_service.list_sales(m, ListQuery(filters={"quarter": "Q4 FY 26"}, page_size=2))
    assert page["total"] == 3 and len(page["items"]) == 2
    assert page["items"][0]["id"] == "T-6"           # default sort: newest first
    assert page["summary"]["net"] == 191000 and page["summary"]["returns"] == 4000
    page = sales_service.list_sales(m, ListQuery(search="two"))
    assert [r["id"] for r in page["items"]] == ["T-3"]
    page = sales_service.list_sales(m, ListQuery(sort_by="netAmount", sort_dir="asc"))
    assert page["items"][0]["netAmount"] == 1000


def test_unknown_filter_rejected(m):
    with pytest.raises(InvalidFilterError):
        sales_service.list_sales(m, ListQuery(sort_by="nope"))


def test_retailers_include_sales_only_parties_and_tiers(m):
    page = retailer_service.list_retailers(m, ListQuery(page_size=50))
    by_code = {r["code"]: r for r in page["items"]}
    assert set(by_code) == {"R1", "R2", "R3", "R4"}
    assert by_code["R4"]["inMaster"] is False
    assert by_code["R1"]["currentTier"] == "Green" and by_code["R1"]["previousTier"] == "Yellow"
    assert by_code["R2"]["status"] == "Active"       # normalised from "active"
    assert by_code["R1"]["distributorName"] == "Test Dist A"
    green = retailer_service.list_retailers(m, ListQuery(filters={"tier": "Green"}))
    assert [r["code"] for r in green["items"]] == ["R1"]


def test_retailer_detail(m):
    rid = m.retailers[m.retailers["code"] == "R2"].iloc[0]["id"]
    detail = retailer_service.get_retailer(m, rid)
    assert [s["id"] for s in detail["sales"]] == ["T-3"]
    assert {f["id"] for f in detail["fulfillments"]} == {"FUL-0002", "FUL-0003"}
    with pytest.raises(NotFoundError):
        retailer_service.get_retailer(m, "missing")


def test_distributors_have_counts(m):
    page = distributor_service.list_distributors(m, ListQuery(sort_by="retailerCount", sort_dir="desc"))
    assert page["items"][0]["code"] == "D2" and page["items"][0]["retailerCount"] == 3


def test_tier_definitions_and_movements(m):
    defs = {d["tier"]: d for d in tier_service.definitions(m)}
    # Unranked = bought this quarter but below Yellow (R2, R4); R3 bought nothing and is not counted
    assert defs["Green"]["retailerCount"] == 1 and defs["Unranked"]["retailerCount"] == 2
    assert defs["Gold"]["color"].startswith("#")
    moves = tier_service.movements(m, ListQuery(filters={"direction": "Upgraded"}))
    assert [(x["from"], x["to"]) for x in moves["items"]] == [("Yellow", "Green")]
    # Q4 FY 26 vs Q3 FY 26: R1 Yellow -> Green; R2 (30,000) and R4 (1,000) buy for the first time
    every = {x["retailerName"]: x["direction"] for x in tier_service.movements(m, ListQuery(page_size=50))["items"]}
    assert every == {"Test Store One": "Upgraded", "Test Store Two": "New", "Sales Only Store": "New"}
    by_id = {r["name"]: r["movement"] for _, r in m.retailers.iterrows()}
    assert by_id["Test Store One"] == "Upgraded" and by_id["Test Store Three"] == "No sales"


def test_movement_categories(tmp_path):
    """Every category, on a small hand-made history of quarterly sales (Yellow from 50,000, Green from 150,000)."""
    from datetime import date

    from app.services.model import build_model
    rows = [  # retailer, invoice date, amount
        ("UP", "2025-08-01", 60000), ("UP", "2025-11-01", 200000),           # Yellow -> Green
        ("DOWN", "2025-08-01", 200000), ("DOWN", "2025-11-01", 60000),       # Green -> Yellow
        ("SAME", "2025-08-01", 60000), ("SAME", "2025-11-01", 70000),        # Yellow -> Yellow
        ("DROP", "2025-05-01", 60000), ("DROP", "2025-08-01", 1000), ("DROP", "2025-11-01", 2000),  # tiered in Q1
        ("NEVER", "2025-08-01", 1000), ("NEVER", "2025-11-01", 2000),        # always below Yellow
        ("NEW", "2025-11-01", 80000),                                        # first purchase in Q3
        ("GONE", "2025-08-01", 80000),                                       # nothing in Q3
    ]
    sales = "invoice_no,invoice_date,retailer_code,retailer_name,distributor_code,distributor_name,net_sales_amount\n" + \
        "".join(f"{i},{d[8:10]}-{d[5:7]}-{d[:4]},{r},{r},D1,Dist,{a}\n" for i, (r, d, a) in enumerate(rows))
    from app.repositories.store_repository import StoreRepository
    from app.storage.local_store import LocalStore
    (tmp_path / "datasets").mkdir()
    (tmp_path / "datasets" / "sales.csv").write_text(sales, encoding="utf-8")
    datasets = StoreRepository(LocalStore(tmp_path)).snapshot()[1]
    m = build_model(datasets, date(2026, 1, 15))
    v = m.quarter_view(2025, 3)
    got = dict(zip(v["name"], v["direction"]))
    assert got == {"UP": "Upgraded", "DOWN": "Downgraded", "SAME": "Stayed in same tier", "DROP": "Dropped from the tier",
                   "NEVER": "Never been on tier but some sales", "NEW": "New", "GONE": "No sales"}


def test_fulfilment_status_and_cost_are_derived(m):
    page = benefit_service.list_fulfillments(m, ListQuery(page_size=10))
    by_id = {f["id"]: f for f in page["items"]}
    assert by_id["FUL-0001"]["status"] == "Fulfilled" and by_id["FUL-0001"]["cost"] == 9000
    assert by_id["FUL-0002"]["status"] == "Overdue"
    assert by_id["FUL-0003"]["status"] == "In Progress" and by_id["FUL-0003"]["cost"] == 500
    assert by_id["FUL-0001"]["tier"] == "Green"      # canonical name from "green"
    assert page["summary"] == {"cost": 15500.0, "fulfilled": 1, "pending": 1, "overdue": 1, "records": 3}


def test_reports_preview(m, store):
    defs = report_service.definitions(store)
    assert len(defs) == 8 and all(d["last_generated"] is None for d in defs)
    p = report_service.preview(m, "RPT-01", limit=1)
    assert p["columns"][-1] == "Q4 FY 26 Net Sales (₹)" and p["total_rows"] == 3 and len(p["rows"]) == 1
    with pytest.raises(NotFoundError):
        report_service.preview(m, "RPT-99")


def test_quarter_definition_april_to_march():
    """Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar; FY 27 = Apr 2026 .. Mar 2027."""
    expected = {4: "Q1", 5: "Q1", 6: "Q1", 7: "Q2", 8: "Q2", 9: "Q2", 10: "Q3", 11: "Q3", 12: "Q3"}
    for month, q in expected.items():
        assert quarter_label(*quarter_of(date(2026, month, 15))) == f"{q} FY 27"
    for month in (1, 2, 3):
        assert quarter_label(*quarter_of(date(2027, month, 15))) == "Q4 FY 27"


def test_old_and_power_bi_quarter_labels_are_understood():
    from app.services.model import fy_label, normalize_quarter_label, parse_quarter_label
    for label in ("Q1 FY 27", "Q1 FY27", "Q1_FY27", "Q1 FY26-27"):
        assert parse_quarter_label(label) == (2026, 1), label
        assert normalize_quarter_label(label) == "Q1 FY 27"
    assert fy_label(2026) == "FY 27" and parse_quarter_label("Q4 FY 26") == (2025, 4)
