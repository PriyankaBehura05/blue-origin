"""BO Retailer Network: pipeline build, payload serving and the deliverables tracker (local store, fictional data)."""
import gzip
import json

import pytest

from app.core.config import Settings
from app.services import network_service

# Two quarters of one distributor. "Star Sports" is listed under two spellings with the same phone, so the
# pipeline merges them; "Moon Store" first buys in Q2.
Q1 = """Retailer Name,Deliverables,Phone,Pincode,District,State,Apr_25,May_25,Jun_25,Last 3 Months,New Tier,Distributor
Star Sports,No,9876501234,560001,Bengaluru,Karnataka,30000,30000,0,60000,Yellow,Alpha Traders
"""
Q2 = """Retailer Name,Deliverables,Phone,Pincode,District,State,July_25,Aug_25,Sept_25,Last 3 Months,New Tier,Distributor
STAR SPORTS,No,9876501234,560001,Bengaluru,Karnataka,100000,60000,0,160000,Green,Alpha Traders
Moon Store,No,,560002,Bengaluru,Karnataka,200000,0,0,200000,Green,Alpha Traders
"""


@pytest.fixture
def net_settings(settings) -> Settings:
    return settings.model_copy(update={"BO_PIPELINE_INPUT": "/Power BI", "BO_SOURCE_FOLDER": "/Power BI/BO_Dashboard"})


def _payload(store, settings) -> dict:
    body, etag, source = network_service.payload(store, settings)
    return {"source": source, "etag": etag, **json.loads(gzip.decompress(body))}


def test_pipeline_build_and_serves(store, net_settings):
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", Q1.encode())
    src.write("FY26_qtr2.csv", Q2.encode())

    res = network_service.build(store, net_settings)
    assert res["status"] == "built", res.get("message")
    assert res["quarters"] == ["Q1_FY26", "Q2_FY26"] and res["retailers"] == 2
    assert network_service.has_build(store)
    assert network_service.build(store, net_settings)["status"] == "unchanged"   # inputs did not change

    network_service._payload_cache.clear()
    p = _payload(store, net_settings)
    assert p["success"] is True and p["source"] == "pipeline"
    data = p["data"]
    star = next(r for r in data["retailers"] if r["n"].lower() == "star sports")
    assert star["m"] == [30000, 30000, 0, 100000, 60000, 0]              # both spellings, one retailer
    assert star["t"] == [1, 2]                                              # Yellow, then Green
    assert data["distributors"][0]["r"] == "South"
    # the connector can read the build
    assert {f.path for f in network_service.network_store(store).list("")} >= {"retailers.csv", "retailer_month.csv"}


def test_payload_falls_back_to_notebook_file(store, net_settings):
    store.at("/Power BI/BO_Dashboard").write("dashboard_data.json", b'{"quarters": ["Q1_FY27"], "retailers": []}')
    network_service._payload_cache.clear()
    p = _payload(store, net_settings)
    assert p["source"] == "notebook" and p["data"]["quarters"] == ["Q1_FY27"]


def test_payload_without_any_data_is_503(client):
    network_service._payload_cache.clear()
    assert client.get("/api/network/data").status_code == 503


def test_enrichment_fills_only_blanks(tmp_path):
    import pandas as pd
    from app.services import info_enrichment

    out = tmp_path
    pd.DataFrame([
        {"Retailer_ID": "A-1", "Distributor": "Alpha", "Retailer_Name": "Star Sports", "Name_Variants": "Star Sports",
         "Phone": "9876501234", "Phone_Alt": "", "City": "", "District": "", "Pincode": ""},
        {"Retailer_ID": "A-2", "Distributor": "Alpha", "Retailer_Name": "Moon Store", "Name_Variants": "MOON STORE | Moon Store",
         "Phone": "", "Phone_Alt": "", "City": "", "District": "BENGALURU", "Pincode": "560002"},
        {"Retailer_ID": "B-1", "Distributor": "Beta", "Retailer_Name": "Star Sports", "Name_Variants": "Star Sports",
         "Phone": "", "Phone_Alt": "", "City": "", "District": "", "Pincode": ""},
    ]).to_csv(out / "retailers.csv", index=False)
    (out / "dashboard_data.json").write_text('{"retailers": [{"id": "A-1", "n": "Star Sports"}, {"id": "A-2", "pin": "560002"}]}')
    ref = pd.DataFrame([
        {"Retailer_Name": "STAR SPORT", "Distributor": "Alpha", "Phone": "9876501234.0", "Pincode": "560001.0", "City": "Jayanagar"},
        {"Retailer_Name": "Moon Store", "Distributor": "Alpha", "Phone": "9123456780", "Pincode": "999", "City": "Koramangala"},
    ])
    stats = info_enrichment.enrich(out, ref)
    assert stats == {"matched_phone": 1, "matched_name": 1, "city": 1, "pincode": 1, "phone": 1}
    r = pd.read_csv(out / "retailers.csv", dtype=str, keep_default_na=False).set_index("Retailer_ID")
    assert r.loc["A-1", "City"] == "Jayanagar" and r.loc["A-1", "Pincode"] == "560001"   # matched on phone
    assert r.loc["A-2", "City"] == "" and r.loc["A-2", "Phone"] == "9123456780"         # has a district; name match
    assert r.loc["A-2", "Pincode"] == "560002" and r.loc["B-1", "City"] == ""          # kept; other distributor
    p = json.loads((out / "dashboard_data.json").read_text())
    assert p["retailers"][0]["ct"] == "Jayanagar" and p["retailers"][0]["pin"] == "560001"
    assert p["retailers"][1]["ph"] == "9123456780"


def test_counter_report_sheets_and_workbook():
    from io import BytesIO
    from openpyxl import load_workbook
    from app.services import counter_report_service as crs
    from app.services.counter_report_xlsx import to_xlsx

    p = {"months": ["Mar_25", "Apr_25", "May_25", "Jun_25"], "quarters": ["Q4_FY25", "Q1_FY26"],
         "distributors": [{"n": "Alpha", "s": "Karnataka", "r": "South"}, {"n": "Beta", "s": "Kerala", "r": "South"}],
         "retailers": [
             {"id": "A-1", "n": "Old Shop", "d": 0, "m": [100, 200, 0, 50], "t": [1, 1]},     # existing
             {"id": "A-2", "n": "New Shop", "d": 0, "m": [0, 0, 300, 0], "t": [-1, 1]},      # new in May-25
             {"id": "B-1", "n": "Quiet Shop", "d": 1, "m": [0, 0, 0, 0], "t": [-1, 0]},      # listed, never billed
             {"id": "B-2", "n": "Gone Shop", "d": 1, "m": [500, 0, 0, 0], "t": [1, -1]},     # not in FY26
         ]}
    assert [y["fy"] for y in crs.financial_years(p)] == ["FY26", "FY25"]
    d = crs.build(p, "FY26")
    assert d["label"] == "FY26 (Apr-25 to Jun-25)" and d["months"] == ["Apr-25", "May-25", "Jun-25"]
    assert d["summary"] == {"active": [1, 1, 1], "activeRevenue": [200, 300, 50], "newCount": [0, 1, 0], "newRevenue": [0, 300, 0]}
    status = {c["name"]: (c["status"], c["first"]) for c in d["counters"]}
    assert status == {"Old Shop": ("Existing", "Mar-25"), "New Shop": ("New (FY26)", "May-25"), "Quiet Shop": ("Never billed", "Never billed")}
    assert d["newByState"][0] == {"name": "Karnataka", "cells": [[None, None], [1, 300], [None, None]]}

    wb = load_workbook(BytesIO(to_xlsx(d)))
    assert wb.sheetnames == ["Summary Dashboard", "New Counters - State", "New Counters - Distributor",
                             "Active & Growth - State", "Active & Growth - Distributor", "Counter Detail"]
    s = wb["Summary Dashboard"]
    assert s["A1"].value == "TECHNOSPORT  |  Distribution Counter Report  —  FY26 (Apr-25 to Jun-25)"
    assert s["E5"].value == "=MAX(B5:D5)" and s["C11"].value.startswith('=IF(C5>B5,"▲ Growth"') and s.freeze_panes == "B5"
    n = wb["New Counters - State"]
    assert n["B3"].value == "Apr-25" and n["C4"].value == "₹" and n["H5"].value == "=B5+D5+F5"
    assert n["D5"].value == 1 and n["D5"].fill.fgColor.rgb == "FFC6EFCE" and n["A7"].value == "TOTAL"
    a = wb["Active & Growth - Distributor"]
    assert a["A6"].value == "TOTAL ACTIVE" and a["A8"].value == "MoM Growth % (Total Active)" and a["E4"].value == "=MAX(B4:D4)"
    c = wb["Counter Detail"]
    assert c.auto_filter.ref == "A3:I6" and c.freeze_panes == "I4" and c["I4"].value == '=COUNTIF(F4:H4,">0")'


def test_pipeline_overview_flags_changed_inputs(store, net_settings):
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", Q1.encode())
    src.write("FY26_qtr2.csv", Q2.encode())
    versions = {f.path: f.version for f in src.list("")}
    built = {"signature": [f"FY26_qtr1.csv|{versions['FY26_qtr1.csv']}", "FY26_qtr2.csv|old", "FY25_qtr4.csv|x"]}
    state = {f["file"]: f["status"] for f in network_service.input_files(store, net_settings, built)}
    assert state == {"FY26_qtr1.csv": "In dashboard", "FY26_qtr2.csv": "Changed", "FY25_qtr4.csv": "Removed"}
    src.write("Tier_scheme.xlsx", b"x")
    state = {f["file"]: f["status"] for f in network_service.input_files(store, net_settings, built)}
    assert state["Tier_scheme.xlsx"] == "New"


def test_code_check_ignores_notebook_outputs_and_download_cells(store, net_settings, tmp_path, monkeypatch):
    def nb(download: str, cleaning: str, output: str) -> bytes:
        cells = [{"cell_type": "code", "source": [download], "outputs": []},
                 {"cell_type": "code", "source": ['df.to_csv(r"C:/Dropbox/Power BI/Consolidated/FY27_Qtr2.csv")']},
                 {"cell_type": "markdown", "source": ["notes"]},
                 {"cell_type": "code", "source": [cleaning], "outputs": [{"text": output}]}]
        return json.dumps({"cells": cells}).encode()

    fp = network_service.code_fingerprint("BO_data.ipynb", nb("pull()", "clean(df)", "1 row"))
    assert fp == network_service.code_fingerprint("BO_data.ipynb", nb("pull(more)", "clean(df)  \r\n", "9 rows"))
    assert fp != network_service.code_fingerprint("BO_data.ipynb", nb("pull()", "clean(df, new_rule)", "1 row"))

    baseline = tmp_path / "source_versions.json"
    baseline.write_text(json.dumps({"BO_data.ipynb": {"copy": "prep.py", "copied": "2026-10-15", "fingerprint": fp},
                                    "bo_pipeline.py": {"copy": "bo.py", "copied": "2026-10-15", "fingerprint": "x"}}))
    monkeypatch.setattr(network_service, "CODE_BASELINE", baseline)
    network_service._code_cache.clear()
    code = store.at("/Power BI/BO_Dashboard")
    code.write("BO_data.ipynb", nb("pull()", "clean(df)", "rerun"))
    raw_mode = net_settings.model_copy(update={"BO_DATA_FOLDER": "/Power BI/Consolidated"})   # the copy is in use
    state = {c["file"].split("/")[-1]: c["status"] for c in network_service.code_check(store, raw_mode)}
    assert state == {"BO_data.ipynb": "In sync", "bo_pipeline.py": "Missing"}
    code.write("BO_data.ipynb", nb("pull()", "clean(df, new_rule)", ""))
    assert network_service.code_check(store, raw_mode)[0]["status"] == "Changed"
    # reading the notebook's own output files: a notebook change needs no copy, so it is not flagged
    assert [c["file"].split("/")[-1] for c in network_service.code_check(store, net_settings)] == ["bo_pipeline.py"]


# One distributor, two quarters: shops that the old duplicate merging used to combine (fictional data).
RULES_Q1 = """Retailer Name,Deliverables,Phone,Pincode,District,State,Apr_25,May_25,Jun_25,Last 3 Months,New Tier,Distributor
Sun Traders,No,9811100001,751001,Khordha,Odisha,10000,0,0,10000,,Beta Agency
Moon Shop,No,9811100003,751001,Khordha,Odisha,10000,0,0,10000,,Beta Agency
Rose Mart,No,9811100005,751001,Khordha,Odisha,10000,0,0,10000,,Beta Agency
Rose Mart,No,9811100006,751002,Khordha,Odisha,10000,0,0,10000,,Beta Agency
Kite Store,No,,751001,Khordha,Odisha,10000,0,0,10000,,Beta Agency
Bright Garments House,No,9811100008,751001,Khordha,Odisha,10000,0,0,10000,,Beta Agency
Lotus Fashion,No,9811100009,751001,Khordha,Odisha,10000,0,0,10000,,Beta Agency
"""
RULES_Q2 = """Retailer Name,Deliverables,Phone,Pincode,District,State,July_25,Aug_25,Sept_25,Last 3 Months,New Tier,Distributor
Sun Traders,No,9811100002,751003,Khordha,Odisha,20000,0,0,20000,,Beta Agency
Moon Shop,No,9811100004,560001,Bengaluru,Karnataka,20000,0,0,20000,,Beta Agency
Rose Mart,No,,751001,Khordha,Odisha,20000,0,0,20000,,Beta Agency
Kite Store,No,9811100007,751001,Khordha,Odisha,20000,0,0,20000,,Beta Agency
Bright Garmnts House,No,,751001,Khordha,Odisha,20000,0,0,20000,,Beta Agency
Lotus Fashions,No,9811100009,751001,Khordha,Odisha,20000,0,0,20000,,Beta Agency
"""


def test_no_duplicate_merging_one_retailer_per_code_name(store, net_settings):
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", RULES_Q1.encode())
    src.write("FY26_qtr2.csv", RULES_Q2.encode())
    res = network_service.build(store, net_settings)
    assert res["status"] == "built", res.get("message")
    assert not {"dedup_audit.csv", "same_name_different_phone.csv", "cross_distributor.csv"} &         {f.path for f in network_service.network_store(store).list("")}
    network_service._payload_cache.clear()
    data = _payload(store, net_settings)["data"]
    names = {r["n"]: r["m"] for r in data["retailers"]}
    # every Code name (shop name + distributor) is one retailer: a shared phone or a similar name joins nothing
    assert sorted(names) == ["Bright Garments House", "Bright Garmnts House", "Kite Store", "Lotus Fashion",
                             "Lotus Fashions", "Moon Shop", "Rose Mart", "Sun Traders"]
    assert names["Sun Traders"] == [10000, 0, 0, 20000, 0, 0]       # the same Code name in both quarters
    assert names["Rose Mart"] == [20000, 0, 0, 20000, 0, 0]         # two Rose Mart rows of one sheet add up
    assert names["Lotus Fashion"] == [10000, 0, 0, 0, 0, 0] and names["Lotus Fashions"] == [0, 0, 0, 20000, 0, 0]
    assert not any(k in r for r in data["retailers"] for k in ("vn", "mb", "mg"))
    assert sum(sum(m) for m in names.values()) == 7 * 10000 + 6 * 20000                  # every rupee


def test_consolidated_download_has_every_sheet_and_all_revenue(store, net_settings):
    import io as _io

    import openpyxl

    from app.services import consolidated_export
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", Q1.encode())
    src.write("FY26_qtr2.csv", Q2.encode())
    assert network_service.build(store, net_settings)["status"] == "built"
    content, name = consolidated_export.download(store, net_settings)
    assert name.startswith("BO_Consolidated_Data_") and name.endswith(".xlsx")
    wb = openpyxl.load_workbook(_io.BytesIO(content), read_only=True)
    assert wb.sheetnames[:4] == ["Read me", "Retailers", "Quarterly", "Monthly revenue"]
    head = next(wb["Retailers"].iter_rows(min_row=4, max_row=4, values_only=True))
    assert "Q1 FY 26 (Apr–Jun 2025) revenue (₹)" in head and "Matched on" not in head
    quarterly = sum(r[0] or 0 for r in wb["Quarterly"].iter_rows(min_row=5, min_col=5, max_col=5, values_only=True))
    assert quarterly == 30000 + 30000 + 100000 + 60000 + 200000          # every month of both sheets
    readme = {r[0]: r[1] for r in wb["Read me"].iter_rows(values_only=True) if r[0]}
    assert readme["Revenue"].startswith("₹420,000 in total")


def test_consolidated_download_for_one_quarter(store, net_settings):
    import io as _io

    import openpyxl

    from app.core.errors import DataNotAvailableError
    from app.services import consolidated_export
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", Q1.encode())
    src.write("FY26_qtr2.csv", Q2.encode())
    assert network_service.build(store, net_settings)["status"] == "built"
    content, name = consolidated_export.download(store, net_settings, "Q2_FY26")
    assert "Q2_FY26" in name
    wb = openpyxl.load_workbook(_io.BytesIO(content), read_only=True)
    head = next(wb["Retailers"].iter_rows(min_row=4, max_row=4, values_only=True))
    assert any("Q2 FY 26" in str(h) for h in head) and not any("Q1 FY 26" in str(h) for h in head)
    quarterly = sum(r[0] or 0 for r in wb["Quarterly"].iter_rows(min_row=5, min_col=5, max_col=5, values_only=True))
    assert quarterly == 100000 + 60000 + 200000                      # the three months of Q2 only, not Q1
    allq, _ = consolidated_export.download(store, net_settings)
    assert allq != content                                           # the cache keeps the two apart
    with pytest.raises(DataNotAvailableError):
        consolidated_export.download(store, net_settings, "Q4_FY30")


def test_bo_data_workbook_has_the_six_sheets_and_rules(store, net_settings):
    import io as _io

    import openpyxl

    from app.services import bo_data_report as bo
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", Q1.encode())
    src.write("FY26_qtr2.csv", Q2.encode())
    assert network_service.build(store, net_settings)["status"] == "built"
    network_service._payload_cache.clear()

    s = bo.frames(store, net_settings, bo.Scope())
    df = s["Consolidated_Tiered"].set_index("Retailer_Name")
    star = df.loc["STAR SPORTS"]          # "Star Sports" (Q1) and "STAR SPORTS" (Q2) are one line, counted once
    assert (star["Q1_FY26"], star["Tier_Q1_FY26"], star["Move_Q1_FY26"]) == (60000, "Yellow", "New")
    assert (star["Q2_FY26"], star["Tier_Q2_FY26"], star["Move_Q2_FY26"]) == (160000, "Green", "Upgraded")
    assert (star["Total_Sales"], star["Active_Quarters"], star["First_Purchase"], star["Customer_Status"]) == \
        (220000, 2, "Q1_FY26", "Upgraded")
    assert df[["Q1_FY26", "Q2_FY26"]].fillna(0).values.sum() == 60000 + 160000 + 200000   # every rupee of the sheets
    moon = df.loc["Moon Store"]
    assert moon["Tier_Q1_FY26"] == "Absent" and moon["Move_Q1_FY26"] == "No sale" and moon["Customer_Status"] == "One-time"
    assert s["Tier_Distribution"].set_index("Tier").loc["Green", "Q2_FY26"] == 2
    assert s["Count_Region_x_Movement"].iloc[-1].tolist() == ["Grand Total", 0, 2, 0, 0, 0, 2]   # Bengaluru = South
    assert (s["Final_Data"]["Region"] == "South").all()

    content, name = bo.download(store, net_settings, bo.Scope(quarter="Q1 FY 26"))
    assert name == "BO_Data_Q1_FY_26.xlsx"
    wb = openpyxl.load_workbook(_io.BytesIO(content))
    assert wb.sheetnames == ["Consolidated_Tiered", "Tier_Distribution", "Tier_Movement_Summary",
                             "Revenue_Region_x_Movement", "Count_Region_x_Movement", "Final_Data"]
    head = [c.value for c in wb["Consolidated_Tiered"][1]]
    assert "Q2_FY26" not in head and head[8:11] == ["Q1_FY26", "Tier_Q1_FY26", "Move_Q1_FY26"]   # as at Q1 FY 26
    assert wb["Final_Data"].freeze_panes == "A2" and wb["Consolidated_Tiered"]["A1"].font.b
    assert len(bo.frames(store, net_settings, bo.Scope(distributor="Nobody"))["Consolidated_Tiered"]) == 0


def test_bo_data_uses_the_notebook_code_names_and_skips_deliverables(store, net_settings):
    from app.services import bo_data_report as bo
    # BO_data.ipynb's cleaned files carry Retailer_ID + Code name: one line per Code name, two spellings included
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", ("Retailer Name,Phone,Pincode,State,Apr_25,May_25,Jun_25,Distributor,Code name,Retailer_ID\n"
                                "Star Sports,9876501234,560001,Karnataka,30000.25,30000,0,Alpha Traders,"
                                "Star Sports-Alpha Traders,ALP-1\n"
                                "Cash,,,Karnataka,1000,0,0,Alpha Traders,Cash-Alpha Traders,ALP-2\n").encode())
    src.write("FY26_qtr2.csv", ("Retailer Name,Phone,Pincode,State,July_25,Aug_25,Sept_25,Distributor,Code name,Retailer_ID\n"
                                "STAR SPORTS,9876501234,560001,Karnataka,100000,60000,0.5,Alpha Traders,"
                                "Star Sports-Alpha Traders,ALP-1\n").encode())
    src.write("deliverables_consolidated.csv", b"Code_Name,Distributor,Quarter,Deliverables,Benefit,Status\n")
    assert network_service.build(store, net_settings)["status"] == "built"
    assert not any(f.path.endswith("deliverables_consolidated.csv")
                   for f in network_service.pipeline_inputs(store.at("/Power BI")))
    network_service._payload_cache.clear()
    df = bo.frames(store, net_settings, bo.Scope())["Consolidated_Tiered"].set_index("Code name")
    assert sorted(df.index) == ["Cash-Alpha Traders", "Star Sports-Alpha Traders"]
    assert df.loc["Star Sports-Alpha Traders", "Q1_FY26"] == 60000.25 and df.loc["Star Sports-Alpha Traders", "Q2_FY26"] == 160000.5
    assert df["Total_Sales"].sum() == 60000.25 + 1000 + 160000.5          # every paisa of the files


def test_watch_sees_a_notebook_run_and_a_new_quarter(store, net_settings):
    src = store.at("/Power BI")
    src.write("FY26_qtr1.csv", Q1.encode())
    assert network_service.pending_change(store, net_settings) is not None       # never built
    assert network_service.build(store, net_settings)["status"] == "built"
    assert network_service.pending_change(store, net_settings) is None           # nothing changed since
    src.write("FY26_qtr2.csv", Q2.encode())                                      # the notebook writes a new quarter
    assert network_service.pending_change(store, net_settings) is not None
    res = network_service.build(store, net_settings)
    assert res["status"] == "built" and res["quarters"] == ["Q1_FY26", "Q2_FY26"]
    assert network_service.pending_change(store, net_settings) is None
