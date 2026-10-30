"""Google Sheets -> Consolidated download (stand-in Google client, temporary local store; no real data touched)."""
from datetime import date

import pandas as pd
import pytest

from app.pipeline import consolidated_prep
from app.services import sheets_download as sd

DISTRIBUTORS = "Distributor,Sheet URL,Active\nAlpha,https://docs.google.com/spreadsheets/d/AAA/edit,Yes\n" \
               "Beta,https://docs.google.com/spreadsheets/d/BBB/edit?gid=1#gid=1,Yes\nGamma,broken-link,Yes\n" \
               "Old,https://docs.google.com/spreadsheets/d/OLD/edit,No\n"
ALPHA_Q2 = [["Retailer Name", "Phone", "Pincode", "Jul", "Aug", "Sep", "New Tier", "Remarks"],
            ["Star Sports", "9876501234", "560001", "30000", "20000", "", "Yellow", "x"],
            ["", "", "", "", "", "", "", ""]]
BETA_Q2 = [["retailer name ", "Phone No", "Pincode", "July", "August", "Sept", "New Tier"],
           ["Moon Store", "9876505678", "560002", "200000", "0", "100000", "Silver"]]


class FakeGoogle:
    def __init__(self, tabs):
        self.tabs = tabs                     # sheet id -> {title: values}

    def titles(self, sid):
        if sid not in self.tabs:
            raise PermissionError("not shared with the service account")
        return list(self.tabs[sid])

    def values(self, sid, title):
        return self.tabs[sid][title]


@pytest.fixture
def sheet_settings(settings):
    return settings.model_copy(update={"BO_DATA_FOLDER": "/Power BI/Consolidated",
                                       "BO_DISTRIBUTOR_SHEETS": "/Power BI/BO_Dashboard/distributors.csv"})


def test_quarters_and_tabs():
    assert sd.quarter_of(date(2026, 10, 16)) == (2027, 3) and sd.quarter_of(date(2027, 1, 2)) == (2027, 4)
    assert sd.due_quarters(date(2026, 10, 16)) == [(2027, 2), (2027, 3)]
    assert sd.due_quarters(date(2027, 4, 1)) == [(2027, 4), (2028, 1)]
    assert sd.file_name(2027, 3) == "FY27_Qtr3.csv" and sd.quarter_text(2027, 4) == "Q4 FY 27 (Jan-Mar 2027)"
    tabs = ["Oct-Nov-Dec", "July-Aug-Sept", "Oct-Nov-Dec 2025", "Apr-May-Jun 2026", "Jul-Aug-Sep 2026"]
    assert sd.find_tab(tabs, 2027, 2) == "Jul-Aug-Sep 2026"
    assert sd.find_tab(tabs, 2026, 3) == "Oct-Nov-Dec 2025"
    assert sd.find_tab(tabs, 2027, 3) is None                         # never an older year's "Oct-Nov-Dec"
    for t in ("Oct-Nov-Dec 2026", "OCT NOV DEC 2026", "October-December 2026", "Oct - Nov - Dec 26"):
        assert sd.find_tab(tabs + [t], 2027, 3) == t
    assert sd.find_tab(["Jan-Feb-Mar 2027"], 2027, 4) == "Jan-Feb-Mar 2027"


def test_sync_download_writes_the_quarter_file_and_is_safe(store, sheet_settings, tmp_path):
    store.at("/Power BI/BO_Dashboard").write("distributors.csv", DISTRIBUTORS.encode())
    google = FakeGoogle({"AAA": {"Apr-May-Jun 2026": [["Retailer Name"], ["old"]], "Jul-Aug-Sep 2026": ALPHA_Q2},
                         "BBB": {"July-Aug-Sept": [["Retailer Name"], ["2025 row"]], "July-Aug-Sept 2026": BETA_Q2}})
    today = date(2026, 10, 16)
    res = sd.run(store, sheet_settings, "manual", client=google, today=today, delay=0, batch_sleep=0)
    q2, q3 = res["quarters"]
    assert q2["file"] == "FY27_Qtr2.csv" and q2["outcome"] == "saved" and q2["rows"] == 2
    assert q2["loaded"] == ["Alpha", "Beta"] and len(q2["failed"]) == 1 and "Gamma" in q2["failed"][0]
    assert q3["outcome"] == "no_tab" and q3["no_tab"] == ["Alpha", "Beta"]
    target = store.at("/Power BI/Consolidated")
    assert target.read("FY27_Qtr3.csv") is None                       # no file for a quarter without tabs
    df = pd.read_csv(pd.io.common.BytesIO(target.read("FY27_Qtr2.csv")), dtype=str, keep_default_na=False)
    assert list(df.columns) == ["Retailer Name", "Phone", "Pincode", "Jul", "Aug", "Sep", "New Tier", "Distributor",
                                "Quarter"]                            # one name per column, Remarks left out
    assert df["Jul"].tolist() == ["30000", "200000"] and df["Distributor"].tolist() == ["Alpha", "Beta"]

    # the platform's cleaning reads it like a notebook export: months get their year
    (tmp_path / "in").mkdir()
    (tmp_path / "in" / "FY27_Qtr2.csv").write_bytes(target.read("FY27_Qtr2.csv"))
    consolidated_prep.prepare(str(tmp_path / "in"), str(tmp_path / "out"))
    clean = pd.read_csv(tmp_path / "out" / "FY27_qtr2.csv")
    assert {"July_26", "Aug_26", "Sept_26"} <= set(clean.columns) and clean["July_26"].sum() == 230000

    # same data again: not rewritten; half the sheets failing: the fuller file is kept
    again = sd.run(store, sheet_settings, "manual", client=google, today=today, delay=0, batch_sleep=0)
    assert again["quarters"][0]["outcome"] == "unchanged"
    del google.tabs["BBB"]
    partial = sd.run(store, sheet_settings, "manual", client=google, today=today, delay=0, batch_sleep=0)
    assert partial["quarters"][0]["outcome"] == "kept"
    assert target.read("FY27_Qtr2.csv").count(b"\n") == 3           # still both retailers

    # automatic runs download at most every SHEETS_DOWNLOAD_MINUTES; "Sync now" always does
    assert sd.run(store, sheet_settings, "schedule", client=google, today=today) is None
    assert sd.status(store, sheet_settings)["last"]["trigger"] == "manual"


def test_missing_key_is_reported_and_nothing_is_written(store, sheet_settings, tmp_path):
    store.at("/Power BI/BO_Dashboard").write("distributors.csv", DISTRIBUTORS.encode())
    s = sheet_settings.model_copy(update={"BO_GOOGLE_KEY": str(tmp_path / "missing.json")})
    res = sd.run(store, s, "manual")
    assert not res["ok"] and "Google key not found" in res["error"]
    assert store.at("/Power BI/Consolidated").list("") == []
    assert sd.status(store, s)["key_found"] is False and sd.status(store, s)["distributors"] == 3
