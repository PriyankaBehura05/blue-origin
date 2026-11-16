"""GOOGLE_ADS_MODE=sheet: Google Ads figures read from the sheet the Google Ads script fills. A fake sheet reader stands in
for Google Sheets (test-only rows); no test reads a real sheet or calls Google."""
from datetime import date, timedelta

import httpx
import pytest

from app.ads import budget as B, common as C, service as svc
from app.ads.google_sheet import GoogleAdsSheet
from app.ads.meta_ads import MetaAds
from app.leads.services import sheets_source as sheets
from tests.ads.test_ads import TOKEN, serve

URL = "https://docs.google.com/spreadsheets/d/TESTSHEETID/edit"
TODAY = date.today()
D1, D2 = (TODAY - timedelta(days=40)).isoformat(), (TODAY - timedelta(days=1)).isoformat()


def tabs():
    return [
        ("Ads_Info", [["key", "value"], ["account_name", "Test Ads"], ["customer_id", "111-222-3334"], ["currency", "INR"],
                      ["time_zone", "Asia/Kolkata"], ["updated_at", "2026-11-14T10:00:00"], ["days", "400"]]),
        ("Ads_Campaigns", [["campaign_id", "campaign_name", "status", "channel_type", "budget_amount", "budget_period", "budget_total_amount",
                            "budget_shared", "lifetime_cost", "lifetime_impressions", "lifetime_clicks", "lifetime_conversions"],
                           ["11", "Search A", "ENABLED", "SEARCH", "1000.00", "DAILY", "", "false", "5000.00", "20000", "400", "20"],
                           ["12", "Video B", "PAUSED", "VIDEO", "", "CUSTOM_PERIOD", "30000.00", "true", "12000.00", "90000", "300", "0"]]),
        ("Ads_Daily", [["date", "campaign_id", "campaign_name", "cost", "impressions", "clicks", "conversions"],
                       [D1, "11", "Search A", "800.00", "3000", "60", "3"],
                       [D2, "11", "Search A", "900.50", "3500", "70", "4"],
                       [D2, "12", "Video B", "1,200.00", "9000", "30", "0"],
                       ["2020-01-01", "11", "Search A", "99.00", "1", "1", "0"]]),       # outside the range: ignored
        ("Leads", [["mobile"], ["9800000000"]]),                                          # other tabs are left alone
    ]


class FakeReader:
    def __init__(self, content=None, fail=None):
        self.content, self.fail, self.calls = content if content is not None else tabs(), fail, 0

    def tabs(self, sid, gid):
        self.calls += 1
        assert sid == "TESTSHEETID" and gid is None
        if self.fail:
            raise self.fail
        return "Test sheet", self.content


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    C.cache.clear()
    svc._clients.clear()
    B._running.clear()
    B._errors.clear()
    B._latest.clear()
    C.transport = httpx.MockTransport(lambda req: (_ for _ in ()).throw(AssertionError(f"no network call expected: {req.url}")))
    yield
    C.transport = None
    C.cache.clear()
    svc._clients.clear()


def use(monkeypatch, reader, email="dash@project.iam.gserviceaccount.com"):
    monkeypatch.setattr(sheets, "make_reader", lambda settings: (reader, email))


def sheet_settings(settings, **kw):
    return settings.model_copy(update={"GOOGLE_ADS_MODE": "sheet", "GOOGLE_ADS_SHEET_URL": URL, "META_ACCESS_TOKEN": "", **kw})


def test_sheet_mode_is_a_real_mode_and_needs_the_link(settings):
    s = sheet_settings(settings)
    assert svc.google_mode(s) == "sheet" and svc.is_real("google", s) and isinstance(svc.client("google", s), GoogleAdsSheet)
    svc._clients.clear()
    blank = sheet_settings(settings, GOOGLE_ADS_SHEET_URL="")
    assert svc.client("google", blank).missing() == ["GOOGLE_ADS_SHEET_URL"] and not svc.client("google", blank).configured()


def test_records_match_the_live_connector_and_meta(settings, monkeypatch):
    r = FakeReader()
    use(monkeypatch, r)
    g = svc.client("google", sheet_settings(settings))
    acct = g.accounts()[0]
    assert (acct["account_id"], acct["name"], acct["currency"], acct["amount_spent_lifetime"]) == ("1112223334", "Test Ads", "INR", 17000.0)
    camps = {c["campaign_id"]: c for c in g.campaigns(acct)}
    assert camps["11"]["daily_budget"] == 1000.0 and camps["11"]["lifetime_budget"] is None and camps["11"]["status"] == "ENABLED"
    assert camps["12"]["daily_budget"] is None and camps["12"]["lifetime_budget"] == 30000.0 and camps["12"]["budget_remaining"] == 18000.0
    assert camps["12"]["raw"]["campaignBudget"]["explicitlyShared"] is True and camps["11"]["lifetime_cost_per_conversion"] == 250.0
    daily = g.performance(acct, TODAY - timedelta(days=60), TODAY, "daily")
    assert [(x["date_start"], x["campaign_id"], x["spend"]) for x in daily] == [(D1, "11", 800.0), (D2, "11", 900.5), (D2, "12", 1200.0)]
    custom = {x["campaign_id"]: x for x in g.performance(acct, TODAY - timedelta(days=60), TODAY, "custom")}
    assert custom["11"]["spend"] == 1700.5 and custom["11"]["clicks"] == 130 and custom["11"]["results"] == 7 and custom["11"]["objective"] == "SEARCH"
    assert r.calls == 1                                                               # one read of the sheet, then the minute's cache
    # every field Meta gives is there too
    serve(lambda req: httpx.Response(200, json={"data": [{"id": "1", "name": "M", "effective_status": "ACTIVE", "account_id": "55", "campaign_id": "1",
                                                          "campaign_name": "M", "spend": "1", "date_start": "2026-10-01", "date_stop": "2026-10-01"}]}
                                     if not req.url.path.endswith("/act_55") else {"id": "act_55", "name": "A", "account_status": 1}))
    m = MetaAds(settings.model_copy(update={"META_ACCESS_TOKEN": TOKEN, "META_AD_ACCOUNT_IDS": "55"}))
    for mk, gk in ((m.accounts()[0], acct), (m.campaigns("act_55")[0], camps["11"]),
                   (m.performance("act_55", date(2026, 10, 1), date(2026, 10, 31), "monthly")[0], custom["11"])):
        assert set(mk) <= set(gk), sorted(set(mk) - set(gk))


def test_budget_screen_is_built_and_saved_like_live(settings, store, monkeypatch):
    use(monkeypatch, FakeReader())
    s = sheet_settings(settings)
    assert B.run_due(s, store, 30) == ["google"]                                   # a real mode: fetched and saved
    assert B._errors.get("google") is None and store.read(B._path("google")) is not None
    snap = B.read(s, store)["google"]
    assert snap["mode"] == "sheet" and snap["snapshot"].get("sample") is None
    a = snap["snapshot"]["accounts"][0]
    assert a["account"]["name"] == "Test Ads" and {c["name"] for c in a["campaigns"]} == {"Search A", "Video B"}
    assert round(sum(m["spend"] for m in a["monthly"]), 2) == 2900.5               # the 2020 row is outside the 400 days


def test_unreadable_sheet_and_missing_tabs_are_explained(settings, monkeypatch):
    use(monkeypatch, FakeReader(fail=PermissionError("403 Forbidden")))
    with pytest.raises(C.AdsPermissionError) as e:
        svc.client("google", sheet_settings(settings)).accounts()
    assert "dash@project.iam.gserviceaccount.com" in e.value.message
    svc._clients.clear()
    use(monkeypatch, FakeReader(content=[t for t in tabs() if t[0] != "Ads_Daily"]))
    with pytest.raises(C.AdsApiError) as e:
        svc.client("google", sheet_settings(settings)).campaigns()
    assert "Ads_Daily" in e.value.message and "script" in e.value.message


def test_an_enabled_campaign_that_has_ended_counts_as_ended(settings, store, monkeypatch):
    t = tabs()
    t[1][1][0].append("serving_status")                     # header
    t[1][1][1].append("SERVING")
    t[1][1][2].append("ENDED")                              # Video B: ENABLED-looking, but its end date has passed
    t[1][1][2][2] = "ENABLED"
    use(monkeypatch, FakeReader(content=t))
    s = sheet_settings(settings)
    c = {x["campaign_id"]: x for x in B.build("google", s)["accounts"][0]["campaigns"]}
    assert c["12"]["status"] == "ENDED" and c["12"]["status_group"] == "ended" and c["11"]["status_group"] == "active"


def test_an_older_sheet_without_serving_status_still_reads(settings, monkeypatch):
    use(monkeypatch, FakeReader())
    camps = svc.client("google", sheet_settings(settings)).campaigns()
    assert all(c["serving_status"] is None for c in camps)
