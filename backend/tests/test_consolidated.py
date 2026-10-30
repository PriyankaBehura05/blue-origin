"""Main data from /Power BI/Consolidated: cleaning the raw distributor sheets and building the dashboard from them."""
import gzip
import json

import pandas as pd

from app.pipeline import consolidated_prep as prep
from app.services import network_service

# Raw exports as BO_data.ipynb writes them to /Power BI/Consolidated: month columns without a year,
# sheet spellings ("Phone No", "Hyperloacl Ads", "Retailer Tier"), free-text benefit cells.
RAW_Q3_FY25 = """Retailer Name,Deliverables,Phone No,Pincode,Oct,Nov,Dec,Last 3 Months,Retailer Tier,Catalog,GMB,Hyperloacl Ads,Shop Board,SIS Unit,Carry Bags,Influencer,Distributor,Quarter,Sept,IMPRessions
  Star   Sports ,Yes,9876501234,560001,30000,30000,0,60000,Yellow,Yes,yes,,https://drive/x.jpg,done,rto,https://insta/x,Alpha Traders,Qtr3FY25,5000,
Star Sports,no,9876501234,560001,0,0,0,0,,,,,,,,,Alpha Traders,Qtr3FY25,,120
 ,Yes,,,1,1,1,3,,,,,,,,,Alpha Traders,Qtr3FY25,,
 ,No,,,0,0,0,0,,,,,,,,,Alpha Traders,Qtr3FY25,,
.,No,9123456780,,2,0,0,2,,,,,,,,,Alpha Traders,Qtr3FY25,,
"""
RAW_Q2_FY27 = """Retailer Name,Deliverables,Phone,Pincode,District,State,Jul,Aug,Sep,Last 3 Months,New Tier,Old Tier,Catalog,SIS Unit,Carry Bags,Certificate,Distributor,Quarter
Star Sports,Yes,9876501234,560001,Bengaluru,KARNATAKA,600000,500000,100000,1200000,Platinum,Gold,500,No space,Need to send,Sent,Alpha Traders,Qtr2FY27
"""


def test_month_columns_get_their_year():
    assert prep.month_column("Jul", 2027) == "July_26" and prep.month_column("Sep", 2027) == "Sept_26"
    assert prep.month_column("Sept", 2025) == "Sept_24" and prep.month_column("Jan", 2026) == "Jan_26"
    assert prep.month_column("September", 2027) == "Sept_26" and prep.month_column("Deliverables", 2027) is None
    assert [k for _, k, _, _ in prep.quarter_files(["FY27_Qtr2.csv", "FY25_Qtr3.csv", "notes.txt"])] == ["Q3_FY25", "Q2_FY27"]


def test_clean_quarter_like_the_notebook(tmp_path):
    raw = pd.read_csv(pd.io.common.StringIO(RAW_Q3_FY25), dtype={"Phone No": str})
    df = prep.clean_quarter(raw, "Q3_FY25", 2025)
    # trimmed; a nameless row with sales is kept (no sale is left out), a nameless row without sales is dropped
    assert list(df["Retailer Name"]) == ["Star Sports", "Star Sports", "(Name missing) row 4",
                                         "(Name missing) 9123456780"]
    assert list(df["Code name"]) == ["Star Sports-Alpha Traders", "Star Sports-Alpha Traders (1)",
                                     "(Name missing) row 4-Alpha Traders", "(Name missing) 9123456780-Alpha Traders"]
    assert {"Oct_24", "Nov_24", "Dec_24", "Sept_24", "Phone", "New Tier", "Hyperlocal Ads"} <= set(df.columns)
    first, second = df.iloc[0], df.iloc[1]
    assert (first["Deliverables"], second["Deliverables"]) == ("Yes", "Cancelled")
    assert first["SIS Unit"] == "Yes" and first["Carry Bags"] == "Yes" and first["GMB"] == "No"   # GMB off in FY25
    assert first["Shop Board"] == "Yes" and first["Influencer"] == "Yes"
    assert second["Hyperlocal Ads"] == "Yes"                                     # impressions > 0
    assert first["New Tier"] == "Yellow" and pd.isna(second["New Tier"])


def test_later_quarters_use_the_general_rules():
    raw = pd.read_csv(pd.io.common.StringIO(RAW_Q2_FY27), dtype={"Phone": str})
    row = prep.clean_quarter(raw, "Q2_FY27", 2027).iloc[0]
    assert (row["Catalog"], row["SIS Unit"], row["Carry Bags"], row["Certificate"]) == ("Yes", "Cancelled", "No", "Yes")
    assert row["July_26"] == 600000
    rows = prep.deliverables_rows(prep.clean_quarter(raw, "Q2_FY27", 2027), "Q2_FY27")
    assert set(rows["Benefit"]) == set(prep.BENEFITS) and set(rows["Quarter"]) == {"Q2_FY27"}
    assert rows.set_index("Benefit").loc["Catalog", "Status"] == "Yes"


def test_build_from_consolidated_folder(store, settings):
    s = settings.model_copy(update={"BO_DATA_FOLDER": "/Power BI/Consolidated", "BO_PIPELINE_INPUT": "/Power BI",
                                    "BO_SOURCE_FOLDER": "", "BO_INFO_FOLDER": ""})
    cons = store.at("/Power BI/Consolidated")
    cons.write("FY25_Qtr3.csv", RAW_Q3_FY25.encode())
    cons.write("FY27_Qtr2.csv", RAW_Q2_FY27.encode())
    # an old cleaned file in /Power BI is ignored once the main data folder is set
    store.at("/Power BI").write("FY26_qtr1.csv", b"Retailer Name,Apr_25,May_25,Jun_25,Distributor\nGhost,1,1,1,Beta\n")

    res = network_service.build(store, s)
    assert res["status"] == "built", res.get("message")
    assert res["main_data"] == "/Power BI/Consolidated"
    assert res["quarters"] == ["Q3_FY25", "Q2_FY27"]          # no Q2 FY 25: Sept_24 counts in its file's Q3 FY 25
    assert network_service.build(store, s)["status"] == "unchanged"

    cons.write("FY27_Qtr2.csv", RAW_Q2_FY27.replace("600000", "700000").encode())   # a sheet changes -> rebuild
    assert network_service.build(store, s)["status"] == "built"

    network_service._payload_cache.clear()
    body, _, _ = network_service.payload(store, s)
    data = json.loads(gzip.decompress(body))["data"]
    assert sorted(r["n"] for r in data["retailers"]) == ["(Name missing) 9123456780", "(Name missing) row 4",
                                                              "Star Sports"]   # no Ghost row
    star = next(r for r in data["retailers"] if r["n"] == "Star Sports")
    assert sum(star["m"]) == 5000 + 60000 + 700000 + 500000 + 100000
    assert data["tiers"][star["t"][-1]] == "Platinum"
    sept = data["months"].index("Sept_24")
    assert data["quarters"][data["monthQ"][sept]] == "Q3_FY25"
    q3 = sum(v for v, mq in zip(star["m"], data["monthQ"]) if data["quarters"][mq] == "Q3_FY25")
    assert q3 == 5000 + 60000 and data["tiers"][star["t"][0]] == "Yellow"    # Sept + Oct-Dec together
