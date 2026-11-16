"""Budget screen: the calculation, the Meta roll-up from ad sets, Google, and the endpoints. Canned platform responses only
(test-only data); no test calls Google or Meta."""
import json
import time
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from app.ads import budget as B, common as C, service as svc
from app.main import app
from tests.conftest import sign_in
from tests.ads.test_ads import G, TOKEN, gaql_server, serve

TODAY = date(2026, 11, 12)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    C.cache.clear()
    svc._clients.clear()
    B._running.clear()
    B._errors.clear()
    B._latest.clear()
    monkeypatch.setattr(C.time, "sleep", lambda s: None)
    yield
    C.transport = None
    C.cache.clear()
    svc._clients.clear()


def camp(cid, **kw):
    return {"campaign_id": cid, "name": f"C{cid}", "status": "ACTIVE", "daily_budget": None, "lifetime_budget": None, "remaining_budget": None, **kw}


def test_status_groups():
    assert [B.status_group(s) for s in ("ACTIVE", "ENABLED", "PAUSED", "CAMPAIGN_PAUSED", "ARCHIVED", "REMOVED", "WITH_ISSUES", None)] == \
           ["active", "active", "paused", "paused", "ended", "ended", "active", "other"]


def test_assemble_spend_windows_utilisation_and_quarters():
    monthly = [("1", "2026-08", 3000.0), ("1", "2026-10", 100.0), ("1", "2026-11", 1200.0), ("9", "2026-10", 50.0)]   # 9 = a campaign that no longer exists
    recent = [("1", "2026-11-12", 400.0), ("1", "2026-11-10", 300.0), ("1", "2026-11-01", 500.0), ("1", "2026-10-31", 100.0)]
    out = B.assemble({"account_id": "x"}, [camp("1", daily_budget=1000.0), camp("2", lifetime_budget=5000.0, remaining_budget=1250.0)], monthly, recent, TODAY)
    c1, c2 = out["campaigns"]
    assert (c1["spend_today"], c1["spend_mtd"], c1["spend_last_7d"]) == (400.0, 1200.0, 700.0)
    assert c1["utilization_pct"] == round(100 * 1200 / (1000 * 12), 1) == 10.0 and c1["spend_last_month"] == 100.0
    assert c1["spend_lifetime"] == 4300.0 and c1["spend_this_quarter"] == 1300.0           # Q3 FY27 = Oct-Dec
    assert c2["utilization_pct"] is None and c2["lifetime_utilization_pct"] == 75.0      # lifetime budget: (5000-1250)/5000
    assert [m["period"] for m in out["monthly"]] == ["2026-08", "2026-10", "2026-11"]
    assert out["monthly"][1]["spend"] == 150.0                                            # includes the removed campaign
    assert {q["period"]: q["spend"] for q in out["quarterly"]} == {"Q2 FY27": 3000.0, "Q3 FY27": 1350.0}
    assert sum(m["spend"] for m in out["monthly"]) == sum(q["spend"] for q in out["quarterly"])


def test_utilisation_is_withheld_when_lifetime_ad_sets_share_the_campaign():
    out = B.assemble({}, [camp("1", daily_budget=1000.0, lifetime_budget=9000.0, remaining_budget=1.0)], [], [("1", "2026-11-05", 5000.0)], TODAY)
    assert out["campaigns"][0]["utilization_pct"] is None


def meta_server():
    def h(req: httpx.Request):
        p, q = req.url.path, req.url.params
        if p.endswith("/act_55"):
            return httpx.Response(200, json={"id": "act_55", "name": "Acct", "currency": "INR", "timezone_name": "Asia/Kolkata", "account_status": 1,
                                             "created_time": "2026-01-01T00:00:00+0530"})
        if p.endswith("/campaigns"):
            return httpx.Response(200, json={"data": [
                {"id": "1", "name": "Daily via ad sets", "effective_status": "ACTIVE", "objective": "OUTCOME_LEADS", "created_time": "2026-01-05T00:00:00+0530"},
                {"id": "2", "name": "Lifetime ad set", "effective_status": "ACTIVE", "objective": "OUTCOME_TRAFFIC", "created_time": "2026-02-05T00:00:00+0530"},
                {"id": "3", "name": "Own daily budget", "effective_status": "PAUSED", "objective": "OUTCOME_SALES", "daily_budget": "300000", "budget_remaining": "300000",
                 "created_time": "2026-03-05T00:00:00+0530"}]})
        if p.endswith("/adsets"):
            return httpx.Response(200, json={"data": [
                {"id": "a", "campaign_id": "1", "effective_status": "ACTIVE", "configured_status": "ACTIVE", "daily_budget": "100000", "budget_remaining": "40000"},
                {"id": "b", "campaign_id": "1", "effective_status": "ACTIVE", "configured_status": "ACTIVE", "daily_budget": "50000", "budget_remaining": "10000"},
                {"id": "c", "campaign_id": "1", "effective_status": "PAUSED", "configured_status": "PAUSED", "daily_budget": "999900"},
                {"id": "d", "campaign_id": "2", "effective_status": "ACTIVE", "configured_status": "ACTIVE", "lifetime_budget": "2000000", "daily_budget": "0", "budget_remaining": "500000"}]})
        if p.endswith("/insights"):
            monthly = q.get("time_increment") == "monthly"
            rows = [{"campaign_id": "1", "date_start": "2026-11-01" if monthly else "2026-11-12", "spend": "600"},
                    {"campaign_id": "2", "date_start": "2026-11-01" if monthly else "2026-11-11", "spend": "15000"}]
            return httpx.Response(200, json={"data": rows})
        return httpx.Response(404, json={"error": {"message": "unexpected " + p}})
    serve(h)


def test_meta_budget_rolls_ad_sets_up_to_campaigns(settings, monkeypatch):
    monkeypatch.setattr(B, "_today", lambda tz: TODAY)
    s = settings.model_copy(update=dict(META_ACCESS_TOKEN=TOKEN, META_AD_ACCOUNT_IDS="55"))
    meta_server()
    snap = B.build("meta", s)
    a = snap["accounts"][0]
    assert a["account"]["name"] == "Acct" and a["account"]["currency"] == "INR"
    c = {x["campaign_id"]: x for x in a["campaigns"]}
    assert c["1"]["daily_budget"] == 1500.0 and c["1"]["daily_budget_source"] == "ad sets"          # 1000 + 500; the paused ad set is left out
    assert c["1"]["remaining_budget"] == 500.0 and c["1"]["remaining_basis"] == "left of today's daily budget"
    assert c["2"]["lifetime_budget"] == 20000.0 and c["2"]["remaining_budget"] == 5000.0 and c["2"]["lifetime_utilization_pct"] == 75.0
    assert c["2"]["daily_budget"] is None                                                           # "0" means no daily budget
    assert c["3"]["daily_budget"] == 3000.0 and c["3"]["daily_budget_source"] == "campaign" and c["3"]["status_group"] == "paused"
    assert c["1"]["spend_today"] == 600.0 and c["1"]["utilization_pct"] == round(100 * 600 / (1500 * 12), 1)


def test_google_budget_uses_the_existing_connector(settings, monkeypatch):
    monkeypatch.setattr(B, "_today", lambda tz: TODAY)
    s = settings.model_copy(update={**G, "GOOGLE_ADS_MODE": "live"})

    def on(req, q):
        if "FROM customer_client" in q:
            return httpx.Response(200, json={"results": []})
        if "FROM customer" in q:
            return httpx.Response(200, json={"results": [{"customer": {"id": "1112223334", "descriptiveName": "Shop", "currencyCode": "INR", "timeZone": "Asia/Kolkata", "manager": False}}]})
        if "segments.date" in q:
            return httpx.Response(200, json={"results": [
                {"campaign": {"id": "5", "name": "Search"}, "segments": {"date": "2026-11-12"}, "metrics": {"costMicros": "250000000"}},
                {"campaign": {"id": "5", "name": "Search"}, "segments": {"date": "2026-11-02"}, "metrics": {"costMicros": "750000000"}},
                {"campaign": {"id": "5", "name": "Search"}, "segments": {"date": "2026-10-20"}, "metrics": {"costMicros": "100000000"}}]})
        return httpx.Response(200, json={"results": [
            {"campaign": {"id": "5", "name": "Search", "status": "ENABLED", "advertisingChannelType": "SEARCH", "startDate": "2026-10-01"},
             "campaignBudget": {"amountMicros": "500000000", "period": "DAILY", "explicitlyShared": True}, "metrics": {"costMicros": "1100000000"}}]})
    gaql_server(on)
    a = B.build("google", s)["accounts"][0]
    c = a["campaigns"][0]
    assert a["account"]["name"] == "Shop" and c["daily_budget"] == 500.0 and c["shared_budget"] is True and c["status_group"] == "active"
    assert c["spend_today"] == 250.0 and c["spend_mtd"] == 1000.0 and c["remaining_budget"] == 250.0       # 500 - 250 spent today
    assert [m["spend"] for m in a["monthly"]] == [100.0, 1000.0] and c["utilization_pct"] == round(100 * 1000 / (500 * 12), 1)


# ------------------------------------------------------------------ endpoints
def test_reading_needs_sign_in_only_and_never_calls_the_platforms(anon, client, settings):
    settings.GOOGLE_ADS_MODE = "live"
    settings.META_ACCESS_TOKEN = TOKEN
    C.transport = httpx.MockTransport(lambda req: (_ for _ in ()).throw(AssertionError("the budget page must not call Google or Meta")))
    d = client.get("/api/ads/budget").json()["data"]
    assert d["meta"]["configured"] is True and d["meta"]["snapshot"] is None and d["meta"]["refreshing"] is False
    assert d["google"]["configured"] is False and "GOOGLE_ADS_REFRESH_TOKEN" in d["google"]["missing"]
    assert json.dumps(d).count(TOKEN) == 0
    assert client.post("/api/users", json={"email": "v@test.local", "name": "V", "role": "viewer", "password": "viewer-pass-1"}).status_code in (200, 201)
    with TestClient(app) as v:
        sign_in(v, "v@test.local", "viewer-pass-1")
        assert v.get("/api/ads/budget").status_code == 200                      # a viewer can look
        assert v.post("/api/ads/budget/refresh", json={}).status_code == 403    # but not trigger a fetch


def test_refresh_saves_and_the_page_reads_it_back(client, settings, monkeypatch):
    settings.GOOGLE_ADS_MODE = "live"
    monkeypatch.setattr(B, "_today", lambda tz: TODAY)
    settings.META_ACCESS_TOKEN, settings.META_AD_ACCOUNT_IDS = TOKEN, "55"
    for k in ("GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"):
        setattr(settings, k, "")
    meta_server()
    assert client.post("/api/ads/budget/refresh", json={"platforms": ["meta", "google"]}).json()["data"]["started"] == ["meta", "google"]
    for _ in range(100):
        d = client.get("/api/ads/budget").json()["data"]
        if not d["meta"]["refreshing"] and not d["google"]["refreshing"]:
            break
        time.sleep(0.1)
    assert d["meta"]["snapshot"]["accounts"][0]["campaigns"][0]["name"] == "Daily via ad sets" and d["meta"]["error"] is None
    assert d["google"]["snapshot"] is None and "not configured" in d["google"]["error"]      # said plainly, no invented data
    assert client.post("/api/ads/budget/refresh", json={"platforms": ["tiktok"]}).status_code == 400


# ------------------------------------------------------------------ automatic refresh
def _meta_only(settings):
    s = settings.model_copy(update=dict(META_ACCESS_TOKEN=TOKEN, META_AD_ACCOUNT_IDS="55", GOOGLE_ADS_DEVELOPER_TOKEN="", GOOGLE_ADS_CLIENT_ID="",
                                         GOOGLE_ADS_CLIENT_SECRET="", GOOGLE_ADS_REFRESH_TOKEN=""))
    return s


def test_run_due_fetches_what_is_missing_or_old_and_skips_fresh_and_unconnected(settings, store, monkeypatch):
    import gzip
    from datetime import datetime, timedelta
    monkeypatch.setattr(B, "_today", lambda tz: TODAY)
    s = _meta_only(settings)
    meta_server()
    assert B.run_due(s, store, 30) == ["meta"]                     # nothing saved yet: fetched; Google is not connected: skipped
    assert "google" not in B._errors and B._errors.get("meta") is None
    first = json.loads(gzip.decompress(store.read(B._path("meta"))))["fetched_at"]
    assert B.run_due(s, store, 30) == []                           # just fetched: not due
    old = json.loads(gzip.decompress(store.read(B._path("meta"))))
    old["fetched_at"] = (datetime.now() - timedelta(minutes=45)).isoformat(timespec="seconds")
    store.write(B._path("meta"), gzip.compress(json.dumps(old).encode()))
    assert B.run_due(s, store, 30) == ["meta"]                     # 45 minutes old: due again
    assert json.loads(gzip.decompress(store.read(B._path("meta"))))["fetched_at"] >= first
    assert not B._running.get("meta")


def test_a_failed_automatic_fetch_is_recorded_and_does_not_raise(settings, store):
    s = _meta_only(settings)
    serve(lambda req: httpx.Response(400, json={"error": {"code": 190, "message": "token expired"}}))
    assert B.run_due(s, store, 30) == ["meta"]
    assert "META_ACCESS_TOKEN" in B._errors["meta"] and store.read(B._path("meta")) is None and not B._running.get("meta")


def test_the_scheduler_can_be_switched_off_and_stopped(settings):
    B._auto.clear()
    B.start_auto(lambda: None, settings.model_copy(update=dict(ADS_REFRESH_MINUTES=0)))
    assert "thread" not in B._auto
    B.start_auto(lambda: None, settings.model_copy(update=dict(ADS_REFRESH_MINUTES=30)))
    assert B._auto["thread"].is_alive() and B._auto["thread"].daemon
    B.stop_auto()
    B._auto["thread"] = None
    B._auto.clear()
