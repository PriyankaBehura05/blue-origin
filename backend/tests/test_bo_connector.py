"""BO Dashboard connector: consolidated Power BI files -> platform datasets (fictional rows, real layout)."""
from datetime import date
from io import BytesIO

import pandas as pd

from app.core.config import Settings
from app.services.bo_dashboard_connector import month_start, quarter_info
from app.services.model import build_model
from app.services.sync_service import SyncRunner

RETAILERS = """Retailer_ID,Distributor,District,State,City,Pincode,Address,Phone,Merge_Basis,Name_Variants,Source_Rows,Retailer_Name,Phone_Alt,Region,Variant_Count,First_Active_Month,Last_Active_Month,First_Active_Quarter,First_Listed_Quarter,Lifetime_Revenue
TST-00001,Test Dist,PUNE,Maharashtra,,411001,addr,999,phone,A,1,Alpha Sports,,West,1,Apr_25,Jun_26,Q1_FY26,Q1_FY26,900000
TST-00002,Test Dist,PUNE,Maharashtra,,411002,addr,998,,B,1,Beta Sports,,West,1,Apr_25,May_25,Q1_FY26,Q1_FY26,60000
"""
MONTH = """Retailer_ID,Month,Revenue,Quarter
TST-00001,Jan_26,100000,Q4_FY26
TST-00001,Apr_26,300000,Q1_FY27
TST-00001,May_26,300000,Q1_FY27
TST-00002,May_25,60000,Q1_FY26
"""
QUARTER = """Retailer_ID,Quarter,Revenue,Tier_Basis,Rows_Merged,Reported_Tier,Computed_Tier,Tier_Before_Merge,Tier_Changed_By_Merge,SIS_Unit,Carry_Bags,Influencer,GMB,Certificate,Product_Video,Hyperlocal_Ads,Shop_Board,Catalog,Deliverables
TST-00001,Q1_FY27,600000,600000,1,Gold,Gold,Gold,False,Yes,No,Cancelled,Yes,Yes,No,No,No,Yes,Yes
TST-00002,Q1_FY26,60000,60000,1,Yellow,Yellow,Yellow,False,No,No,No,No,No,No,No,No,No,No
"""


def _scheme() -> bytes:
    rows = [("Gold", b, "Yes") for b in ["SIS_Unit", "Carry_Bags", "Influencer", "GMB", "Certificate"]]
    rows += [("Yellow", "Carry_Bags", "Yes"), ("Yellow", "SIS_Unit", "No")]
    buf = BytesIO()
    pd.DataFrame(rows, columns=["Tier", "Benefits", "Required"]).to_excel(buf, index=False)
    return buf.getvalue()


def test_label_helpers():
    assert month_start("Sept_24") == date(2024, 9, 1) and month_start("July_25") == date(2025, 7, 1)
    assert quarter_info("Q1_FY27") == ("Q1 FY 27", date(2026, 6, 30))
    assert quarter_info("Q4_FY26") == ("Q4 FY 26", date(2026, 3, 31))


def test_connector_builds_all_datasets(repo, store):
    store.write("Power BI/BO_Dashboard/retailers.csv", RETAILERS.encode())
    store.write("Power BI/BO_Dashboard/retailer_month.csv", MONTH.encode())
    store.write("Power BI/BO_Dashboard/retailer_quarter.csv", QUARTER.encode())
    store.write("Power BI/Tier_scheme.xlsx", _scheme())
    settings = Settings(SYNC_INTERVAL_MINUTES=0, BO_SOURCE_FOLDER="/Power BI/BO_Dashboard",
                        BO_TIER_SCHEME="/Power BI/Tier_scheme.xlsx")

    run = SyncRunner(repo, settings).run("test")
    assert run["ok"], run
    by = {r["dataset"]: r for r in run["results"]}
    assert {d: by[d]["status"] for d in ("retailers", "distributors", "sales", "benefits", "fulfillments")} == \
        dict.fromkeys(("retailers", "distributors", "sales", "benefits", "fulfillments"), "updated")

    m = build_model(repo.snapshot()[1], today=date(2026, 7, 15))
    assert m.periods.current_label == "Q1 FY 27"
    alpha = m.retailers[m.retailers["code"] == "TST-00001"].iloc[0]
    assert alpha["currentQuarterSales"] == 600000 and alpha["currentTier"] == "Gold"
    assert alpha["status"] == "Active" and alpha["region"] == "West"
    assert m.retailers[m.retailers["code"] == "TST-00002"].iloc[0]["status"] == "Inactive"
    dist = m.distributors.iloc[0]
    assert dist["code"] == "TST" and dist["retailerCount"] == 2
    # Gold requires 5 benefits; Influencer is Cancelled -> 4 records; Yes -> Fulfilled, No -> Overdue (quarter over)
    ful = m.fulfillments.set_index("benefitId")["status"].to_dict()
    assert ful == {"GOLD-SIS_UNIT": "Fulfilled", "GOLD-CARRY_BAGS": "Overdue", "GOLD-GMB": "Fulfilled",
                   "GOLD-CERTIFICATE": "Fulfilled"}
    # scheme benefits are added; benefits that were already in the catalogue (BEN-000x) are kept
    assert set(m.benefits["id"]) == {"GOLD-SIS_UNIT", "GOLD-CARRY_BAGS", "GOLD-INFLUENCER", "GOLD-GMB",
                                     "GOLD-CERTIFICATE", "YELLOW-CARRY_BAGS", "BEN-0001", "BEN-0002"}

    again = SyncRunner(repo, settings).run("test")
    assert {r["status"] for r in again["results"]} == {"unchanged"}

    # edits made in the app survive the next import of the Power BI files
    from app.core.constants import DatasetType
    from app.services import record_service
    record_service.update(repo, DatasetType.BENEFITS, "GOLD-SIS_UNIT", {"unit_cost": 25000, "description": "Edited"})
    record_service.create(repo, DatasetType.BENEFITS, {"name": "Gift Hamper", "tier": "Gold", "unit_cost": 800})
    store.write("Power BI/BO_Dashboard/retailer_month.csv", (MONTH + "TST-00002,Jun_26,1000,Q1_FY27\n").encode())
    third = {r["dataset"]: r["status"] for r in SyncRunner(repo, settings).run("test")["results"]}
    assert third["benefits"] == "updated"
    b = repo.raw_table(DatasetType.BENEFITS).set_index("id")
    assert b.loc["GOLD-SIS_UNIT", "unit_cost"] == "25000" and b.loc["GOLD-SIS_UNIT", "description"] == "Edited"
    assert "Gift Hamper" in set(b["name"]) and "YELLOW-CARRY_BAGS" in b.index


def test_connector_reports_missing_files(repo, store):
    settings = Settings(SYNC_INTERVAL_MINUTES=0, BO_SOURCE_FOLDER="/Power BI/BO_Dashboard")
    run = SyncRunner(repo, settings).run("test")
    assert run["ok"] and any("not found" in w for w in run["warnings"])


def test_a_month_counts_in_the_quarter_the_build_gives_it(repo, store):
    # Sept_24 sits in FY25_qtr3.csv and there is no Q2 FY 25 file: the build puts it in Q3 FY 25
    month = "Retailer_ID,Month,Revenue,Quarter\nTST-00001,Sept_24,40000,Q3_FY25\nTST-00001,Oct_24,20000,Q3_FY25\n"
    store.write("Power BI/BO_Dashboard/retailers.csv", RETAILERS.encode())
    store.write("Power BI/BO_Dashboard/retailer_month.csv", month.encode())
    store.write("Power BI/BO_Dashboard/retailer_quarter.csv", QUARTER.encode())
    settings = Settings(SYNC_INTERVAL_MINUTES=0, BO_SOURCE_FOLDER="/Power BI/BO_Dashboard")
    assert SyncRunner(repo, settings).run("test")["ok"]
    m = build_model(repo.snapshot()[1], today=date(2024, 12, 15))
    sales = m.sales.set_index("month")
    assert sales.loc["2024-09", "quarter"] == "Q3 FY 25" and sales.loc["2024-10", "quarter"] == "Q3 FY 25"
    assert m.sales_quarters == [(2024, 3)]                                   # no Q2 FY 25
    alpha = m.retailers[m.retailers["code"] == "TST-00001"].iloc[0]
    assert alpha["currentQuarterSales"] == 60000 and alpha["currentTier"] == "Yellow"   # Sept + Oct together


def test_connector_works_without_deliverable_columns(repo, store):
    plain = "Retailer_ID,Quarter,Revenue,Tier_Basis,Reported_Tier,Computed_Tier\nTST-00001,Q1_FY27,600000,600000,Gold,Gold\n"
    store.write("Power BI/BO_Dashboard/retailers.csv", RETAILERS.encode())
    store.write("Power BI/BO_Dashboard/retailer_month.csv", MONTH.encode())
    store.write("Power BI/BO_Dashboard/retailer_quarter.csv", plain.encode())
    store.write("Power BI/Tier_scheme.xlsx", _scheme())
    settings = Settings(SYNC_INTERVAL_MINUTES=0, BO_SOURCE_FOLDER="/Power BI/BO_Dashboard",
                        BO_TIER_SCHEME="/Power BI/Tier_scheme.xlsx")
    run = SyncRunner(repo, settings).run("test")
    assert run["ok"], run
    by = {r["dataset"]: r for r in run["results"]}
    assert by["sales"]["status"] == "updated" and by["fulfillments"]["rows"] == 0
    m = build_model(repo.snapshot()[1], today=date(2026, 7, 15))          # an empty list still loads
    assert m.fulfillments.empty and m.sales["netAmount"].sum() == 760000
