"""GOOGLE_ADS_MODE: off, sample and live. No test calls Google or Meta: any network call fails the test."""
from datetime import date, timedelta
from pathlib import Path

import httpx
import pytest

from app.ads import budget as B, common as C, service as svc
from app.ads.google_sample import GoogleAdsOff, GoogleAdsSample
from app.ads.meta_ads import MetaAds
from tests.ads.test_ads import G, TOKEN, serve


@pytest.fixture(autouse=True)
def _clean():
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


def files_under(root: Path):
    return sorted(str(p.relative_to(root)).replace("\\", "/") for p in root.rglob("*") if p.is_file())


def test_mode_is_off_by_default_and_a_typo_counts_as_off(settings):
    assert svc.google_mode(settings) == "off"
    for v, want in (("LIVE", "live"), (" sample ", "sample"), ("samples", "off"), ("", "off")):
        assert svc.google_mode(settings.model_copy(update={"GOOGLE_ADS_MODE": v})) == want
    assert isinstance(svc.client("google", settings), GoogleAdsOff)


def test_off_returns_empty_data_and_not_connected(client, settings, store):
    settings.GOOGLE_ADS_MODE = "off"
    st = client.get("/api/ads/status").json()["data"]["google"]
    assert st["mode"] == "off" and st["configured"] is False
    for path in ("accounts", "campaigns", "performance?granularity=monthly"):
        d = client.get(f"/api/ads/google/{path}").json()["data"]
        assert d["mode"] == "off" and (d.get("items") == []) and (d.get("count", d.get("total")) == 0)
    b = client.get("/api/ads/budget").json()["data"]["google"]
    assert b["mode"] == "off" and b["configured"] is False and b["snapshot"] is None and b["error"] is None
    assert client.post("/api/ads/budget/refresh", json={"platforms": ["google"]}).json()["data"]["started"] == []


def test_sample_uses_the_meta_record_structure(settings):
    s = settings.model_copy(update={"GOOGLE_ADS_MODE": "sample"})
    g = svc.client("google", s)
    assert isinstance(g, GoogleAdsSample) and g.configured()

    # the Meta records, from canned Meta responses, to compare the keys with
    serve(lambda req: httpx.Response(200, json={"data": [{"id": "1", "name": "M", "effective_status": "ACTIVE", "account_id": "55", "campaign_id": "1",
                                                          "campaign_name": "M", "spend": "1", "date_start": "2026-10-01", "date_stop": "2026-10-01"}]}
                                     if not req.url.path.endswith("/act_55") else {"id": "act_55", "name": "A", "account_status": 1}))
    m = MetaAds(settings.model_copy(update={"META_ACCESS_TOKEN": TOKEN, "META_AD_ACCOUNT_IDS": "55"}))
    meta_acct, meta_camp = m.accounts()[0], m.campaigns("act_55")[0]
    meta_perf = m.performance("act_55", date(2026, 10, 1), date(2026, 10, 31), "monthly")[0]
    C.transport = httpx.MockTransport(lambda req: (_ for _ in ()).throw(AssertionError("no network call expected")))

    acct = g.accounts()[0]
    camps = g.campaigns(acct)
    perf = g.performance(acct, date.today() - timedelta(days=60), date.today(), "monthly")
    assert set(meta_acct) <= set(acct) and set(meta_camp) <= set(camps[0]) and set(meta_perf) <= set(perf[0])
    assert all(x["sample"] is True and x["platform"] == "google" for x in [acct, *camps, *perf])
    assert all(c["name"].startswith("SAMPLE") for c in camps) and len(camps) == 4
    assert {c["status"] for c in camps} == {"ACTIVE", "PAUSED", "ARCHIVED"}
    # the same date gives the same figures (stable between page loads), and daily adds up to monthly
    assert g.performance(acct, date.today() - timedelta(days=60), date.today(), "monthly") == perf
    daily = g.performance(acct, date.today() - timedelta(days=60), date.today(), "daily")
    assert round(sum(r["spend"] for r in daily), 2) == round(sum(r["spend"] for r in perf), 2)


def test_sample_is_never_written_anywhere_and_never_fetched(client, settings, store):
    settings.GOOGLE_ADS_MODE = "sample"
    settings.META_ACCESS_TOKEN = ""   # this test is about Google only
    root = Path(settings.local_store_dir)
    before = files_under(root)
    d = client.get("/api/ads/google/campaigns").json()["data"]
    assert d["mode"] == "sample" and d["count"] == 4
    b = client.get("/api/ads/budget").json()["data"]["google"]
    assert b["mode"] == "sample" and b["snapshot"]["sample"] is True and b["snapshot"]["accounts"][0]["campaigns"]
    assert client.post("/api/ads/budget/refresh", json={"platforms": ["google"]}).json()["data"]["started"] == []
    snap = client.post("/api/ads/snapshot", json={"platforms": ["google"]}).json()["data"]["platforms"]["google"]
    assert snap["ok"] is False and snap["code"] == "GOOGLE_ADS_MODE"
    assert B.run_due(settings, store, 30) == []
    with pytest.raises(C.AdsNotConfigured):
        B.build("google", settings)
    assert files_under(root) == before                                   # nothing was saved by any of the above
    assert not any("google" in f for f in files_under(root))


def test_live_is_the_existing_connector(settings):
    s = settings.model_copy(update={**G, "GOOGLE_ADS_MODE": "live"})
    from app.ads.google_ads import GoogleAds
    assert isinstance(svc.client("google", s), GoogleAds) and svc.client("google", s).configured()
    blank = settings.model_copy(update={"GOOGLE_ADS_MODE": "live", "GOOGLE_ADS_DEVELOPER_TOKEN": ""})
    assert svc.client("google", blank).configured() is False                # live without credentials: not configured, as before


def test_live_google_records_have_every_meta_field_and_take_an_account_id(settings):
    import json
    from app.ads.google_ads import GoogleAds
    serve(lambda req: httpx.Response(200, json={"data": [{"id": "1", "name": "M", "effective_status": "ACTIVE", "account_id": "55", "campaign_id": "1",
                                                          "campaign_name": "M", "spend": "1", "date_start": "2026-10-01", "date_stop": "2026-10-01"}]}
                                     if not req.url.path.endswith("/act_55") else {"id": "act_55", "name": "A", "account_status": 1}))
    m = MetaAds(settings.model_copy(update={"META_ACCESS_TOKEN": TOKEN, "META_AD_ACCOUNT_IDS": "55"}))
    meta = (m.accounts()[0], m.campaigns("act_55")[0], m.performance("act_55", date(2026, 10, 1), date(2026, 10, 31), "monthly")[0])

    def g(req):
        if "oauth2" in str(req.url):
            return httpx.Response(200, json={"access_token": "ya29.t", "expires_in": 3600})
        q = json.loads(req.content).get("query", "")
        if q.endswith("FROM customer"):
            return httpx.Response(200, json={"results": [{"customer": {"id": "1112223334", "descriptiveName": "G", "manager": False}}]})
        if "segments.date" in q:
            return httpx.Response(200, json={"results": [{"campaign": {"id": "5", "name": "S", "advertisingChannelType": "SEARCH"}, "segments": {"date": "2026-10-02"},
                                                          "metrics": {"costMicros": "2000000", "clicks": "4", "impressions": "100", "conversions": 2}}]})
        return httpx.Response(200, json={"results": [{"campaign": {"id": "5", "name": "S", "status": "ENABLED", "startDate": "2026-01-01"},
                                                      "campaignBudget": {"totalAmountMicros": "9000000", "period": "CUSTOM_PERIOD"}, "metrics": {"costMicros": "2000000"}}]})
    serve(g)
    gg = GoogleAds(settings.model_copy(update={**G, "GOOGLE_ADS_MODE": "live"}))
    acct = gg.accounts()[0]
    camp = gg.campaigns("111-222-3334")[0]                                   # an account ID works, like Meta
    perf = gg.performance("1112223334", date(2026, 10, 1), date(2026, 10, 31), "monthly")[0]
    for mk, gk in zip(meta, (acct, camp, perf)):
        assert set(mk) <= set(gk), sorted(set(mk) - set(gk))
    assert camp["budget_remaining"] == 7.0 and camp["start_time"] == "2026-01-01" and camp["lifetime_spend"] == 2.0   # old fields kept
    assert perf["results"] == 2 and perf["results_basis"] == "conversions" and perf["cost_per_result"] == 1.0 and perf["objective"] == "SEARCH"
    with pytest.raises(C.AdsApiError):
        gg.performance("1112223334", date(2026, 10, 1), date(2026, 10, 31), "daily", level="ad")
