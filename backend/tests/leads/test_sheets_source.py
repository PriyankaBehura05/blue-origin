"""Lead Google Sheets: links, reading tabs, writing only what changed, keeping a good copy over a short read."""
import pytest

from app.leads.services import leads_service as svc
from app.leads.services import sheets_source as S
from app.storage.local_store import LocalStore
from tests.leads.test_pipeline import MONTHS, QUARTERS, RETAILERS

URL = "https://docs.google.com/spreadsheets/d/AbCdEfGhIjKlMnOp/edit?gid=42#gid=42"
LEAD_ROWS = [["Lead Date", "Phone Number", "Business Name", "City", "Platform", "Campaign Name"],
             ["2026-04-10", "9876500001", "Alpha Sports", "Pune", "facebook", "Spring Retailers"],
             ["2026-05-20", "9876500022", "Beta", "Pune", "fb", "Spring Retailers"],
             ["", "", "", "", "", ""]]


class FakeClient:
    """Stands in for app.services.sheets_download.GoogleSheets."""
    email = "reader@example.iam.gserviceaccount.com"

    def __init__(self, tabs):
        self.tabs = tabs   # {gid: (title, rows)}

    def _get(self, url, params=None):
        return {"properties": {"title": "Lead tracker"},
                "sheets": [{"properties": {"sheetId": g, "title": t}} for g, (t, _) in self.tabs.items()]}

    def values(self, sid, title):
        return next(rows for t, rows in self.tabs.values() if t == title)


def test_links_are_parsed_and_checked(tmp_path):
    assert S.sheet_id(URL) == "AbCdEfGhIjKlMnOp" and S.tab_gid(URL) == 42
    assert S.tab_gid("https://docs.google.com/spreadsheets/d/AbC/edit") is None
    store = LocalStore(tmp_path)
    saved = S.save_sources(store, [{"url": URL}, {"url": URL + " "}, {"url": ""}])
    assert len(saved) == 1
    with pytest.raises(ValueError):
        S.save_sources(store, [{"url": "https://example.com/sheet"}])


def test_refresh_writes_only_changes_and_keeps_good_copy(tmp_path):
    store = LocalStore(tmp_path)
    S.save_sources(store, [{"url": URL}])
    client = FakeClient({42: ("Leads", LEAD_ROWS), 7: ("Spend", [["Month", "Campaign", "Spend"]])})
    first = S.refresh(store, S.Reader(client))
    tabs = first["sources"][0]["tabs"]
    assert [t["tab"] for t in tabs] == ["Leads"] and tabs[0]["rows"] == 2 and first["changed"] == 1
    assert S.refresh(store, S.Reader(client))["changed"] == 0            # unchanged: not written again

    many = [LEAD_ROWS[0]] + [["2026-04-10", f"98765{i:05d}", "Shop", "Pune", "fb", "C"] for i in range(30)]
    client.tabs[42] = ("Leads", many)
    assert S.refresh(store, S.Reader(client))["changed"] == 1
    client.tabs[42] = ("Leads", many[:5])                                 # a short read never replaces 30 rows
    short = S.refresh(store, S.Reader(client))["sources"][0]["tabs"][0]
    assert not short["updated"] and "kept the earlier copy" in short["note"]


def test_private_sheet_without_key_reports_the_error(tmp_path):
    store = LocalStore(tmp_path)
    S.save_sources(store, [{"url": URL}])
    state = S.refresh(store, S.Reader(fetch=lambda url: b"<!DOCTYPE html><html>sign in</html>"))
    assert "not shared" in state["sources"][0]["error"]


def test_removed_link_drops_its_copy_and_build_reads_sheets(tmp_path):
    store = LocalStore(tmp_path)
    for name, body in (("retailers.csv", RETAILERS), ("retailer_month.csv", MONTHS), ("retailer_quarter.csv", QUARTERS)):
        store.write(f"network/{name}", body.encode())
    S.save_sources(store, [{"url": URL}])
    S.refresh(store, S.Reader(FakeClient({42: ("Leads", LEAD_ROWS)})))
    svc._cache.clear()
    _, info = svc.ensure_built(store, force=True)
    assert info["lead_rows"] == 2 and any(n.startswith("Sheet tab - ") for n in info["inbox"])
    S.save_sources(store, [])
    assert store.list(S.FOLDER) == []
