"""Ad connectors. The HTTP layer is replaced by canned responses (test-only, never product data) so no test touches
Google, Meta or the real credentials in backend/.env."""
import json
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from app.ads import common as C, service as svc
from app.ads.google_ads import GoogleAds
from app.ads.meta_ads import MetaAds
from app.main import app
from tests.conftest import sign_in

TOKEN = "EAAB-secret-meta-token-123456"
G = dict(GOOGLE_ADS_DEVELOPER_TOKEN="dev-token-abcdef", GOOGLE_ADS_CLIENT_ID="cid-123456.apps", GOOGLE_ADS_CLIENT_SECRET="csecret-abcdef",
         GOOGLE_ADS_REFRESH_TOKEN="1//refresh-abcdef", GOOGLE_ADS_CUSTOMER_ID="1112223334")


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    C.cache.clear()
    svc._clients.clear()
    monkeypatch.setattr(C.time, "sleep", lambda s: None)
    yield
    C.transport = None
    C.cache.clear()
    svc._clients.clear()


def serve(handler):
    C.transport = httpx.MockTransport(handler)


def meta(settings, **kw):
    return MetaAds(settings.model_copy(update=dict(META_ACCESS_TOKEN=TOKEN, META_AD_ACCOUNT_IDS="act_55", **kw)))


def google(settings, **kw):
    return GoogleAds(settings.model_copy(update={**G, **kw}))


# ------------------------------------------------------------------ helpers
def test_redact_removes_secrets_and_token_parameters():
    msg = f"failed https://x/?access_token={TOKEN}&a=1 with Bearer abcdefghijkl1234 and {TOKEN}"
    out = C.redact(msg, [TOKEN])
    assert TOKEN not in out and "abcdefghijkl1234" not in out and "a=1" in out


def test_financial_quarters_and_windows():
    assert C.fy_quarter(date(2026, 8, 5)) == ("Q2 FY27", date(2026, 7, 1), date(2026, 9, 30))
    assert C.fy_quarter(date(2026, 2, 1))[0] == "Q4 FY26"
    w = C.windows(date(2026, 3, 15), date(2026, 8, 10), "quarterly")
    assert [x[0] for x in w] == ["Q4 FY26", "Q1 FY27", "Q2 FY27"] and w[0][1] == date(2026, 3, 15) and w[-1][2] == date(2026, 8, 10)
    assert len(C.windows(date(2026, 1, 1), date(2026, 12, 31), "chunk")) == 5


# ------------------------------------------------------------------ Meta
def test_meta_follows_cursors_and_keeps_token_out_of_urls(settings):
    seen = []

    def h(req: httpx.Request):
        seen.append(req)
        if not req.url.params.get("after"):
            return httpx.Response(200, json={"data": [{"id": "1", "name": "A", "effective_status": "ACTIVE", "objective": "OUTCOME_LEADS", "daily_budget": "50000"}],
                                             "paging": {"cursors": {"after": "c1"}, "next": "https://graph.facebook.com/next?access_token=" + TOKEN}})
        return httpx.Response(200, json={"data": [{"id": "2", "name": "B", "effective_status": "PAUSED", "lifetime_budget": "1000000"}],
                                         "paging": {"cursors": {"after": "c2"}}})
    serve(h)
    rows = meta(settings).campaigns("act_55")
    assert [r["campaign_id"] for r in rows] == ["1", "2"] and len(seen) == 2
    assert rows[0]["daily_budget"] == 500.0 and rows[1]["lifetime_budget"] == 10000.0     # minor units -> rupees
    assert rows[0]["raw"]["objective"] == "OUTCOME_LEADS" and rows[0]["platform"] == "meta"
    assert all(TOKEN not in str(r.url) for r in seen) and seen[0].headers["authorization"] == f"Bearer {TOKEN}"


def test_meta_expired_token_gives_a_clear_error_without_the_token(settings):
    serve(lambda req: httpx.Response(400, json={"error": {"code": 190, "error_subcode": 463, "message": f"Error validating access token {TOKEN}"}}))
    with pytest.raises(C.AdsAuthError) as e:
        meta(settings).accounts()
    assert TOKEN not in e.value.message and "META_ACCESS_TOKEN" in e.value.message


def test_meta_missing_permission_and_rate_limit_retry(settings):
    serve(lambda req: httpx.Response(403, json={"error": {"code": 200, "message": "Requires ads_read"}}))
    with pytest.raises(C.AdsPermissionError):
        meta(settings).adsets("act_55")
    calls = []

    def h(req):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(400, json={"error": {"code": 17, "message": "User request limit reached"}})
        return httpx.Response(200, json={"data": []})
    serve(h)
    assert meta(settings).adsets("act_55") == [] and len(calls) == 3


def test_meta_results_follow_the_objective(settings):
    serve(lambda req: httpx.Response(200, json={"data": [{
        "account_id": "55", "campaign_id": "9", "campaign_name": "L", "objective": "OUTCOME_LEADS", "spend": "1000", "impressions": "10000",
        "clicks": "100", "reach": "8000", "date_start": "2026-10-01", "date_stop": "2026-10-31",
        "actions": [{"action_type": "link_click", "value": "90"}, {"action_type": "onsite_conversion.lead_grouped", "value": "25"}]}]}))
    r = meta(settings).performance("act_55", date(2026, 10, 1), date(2026, 10, 31), "monthly")[0]
    assert r["results"] == 25 and r["cost_per_result"] == 40.0 and r["results_basis"] == "onsite_conversion.lead_grouped" and r["raw"]["clicks"] == "100"


# ------------------------------------------------------------------ Google
def gaql_server(on_query, token_status=200, token_body=None):
    def h(req: httpx.Request):
        if "oauth2.googleapis.com" in str(req.url):
            return httpx.Response(token_status, json=token_body or {"access_token": "ya29.test-access", "expires_in": 3600})
        assert req.headers["developer-token"] == G["GOOGLE_ADS_DEVELOPER_TOKEN"] and req.headers["authorization"] == "Bearer ya29.test-access"
        q = json.loads(req.content).get("query", "") if req.content else ""
        return on_query(req, q)
    serve(h)


def test_google_unconfigured_lists_missing_variables(settings):
    g = GoogleAds(settings.model_copy(update=dict(GOOGLE_ADS_DEVELOPER_TOKEN="", GOOGLE_ADS_CLIENT_ID="", GOOGLE_ADS_CLIENT_SECRET="", GOOGLE_ADS_REFRESH_TOKEN="")))
    assert g.missing() == ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"]
    with pytest.raises(C.AdsNotConfigured):
        g.accounts()


def test_google_revoked_refresh_token_has_a_plain_message(settings):
    gaql_server(None, token_status=400, token_body={"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
    with pytest.raises(C.AdsAuthError) as e:
        google(settings).accounts()
    assert "7 days" in e.value.message and G["GOOGLE_ADS_REFRESH_TOKEN"] not in e.value.message


def test_google_test_only_developer_token_is_explained(settings):
    body = {"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "The developer token is only approved for use with test accounts.",
                      "details": [{"errors": [{"errorCode": {"authorizationError": "DEVELOPER_TOKEN_NOT_APPROVED"}}]}]}}
    gaql_server(lambda req, q: httpx.Response(403, json=body))
    with pytest.raises(C.AdsPermissionError) as e:
        google(settings).campaigns({"account_id": "1112223334"})
    assert "Basic access" in e.value.message


def test_google_manager_is_expanded_into_client_accounts(settings):
    def rows(req, q):
        if "FROM customer_client" in q:
            return httpx.Response(200, json={"results": [{"customerClient": {"id": "999", "descriptiveName": "Client", "currencyCode": "INR", "manager": False}}]})
        return httpx.Response(200, json={"results": [{"customer": {"id": "1112223334", "descriptiveName": "Mgr", "manager": True}}]})
    gaql_server(rows)
    a = google(settings).accounts()
    client = next(x for x in a if x["account_id"] == "999")
    assert client["login_customer_id"] == "1112223334" and client["currency"] == "INR" and any(x.get("is_manager") for x in a)


def test_google_campaigns_budgets_and_paging(settings):
    pages = iter([
        {"results": [{"campaign": {"id": "1", "name": "Search A", "status": "ENABLED", "advertisingChannelType": "SEARCH", "startDate": "2026-01-01"},
                      "campaignBudget": {"amountMicros": "500000000", "period": "DAILY"},
                      "metrics": {"costMicros": "2500000000", "clicks": "100", "impressions": "2000", "conversions": 5}}], "nextPageToken": "p2"},
        {"results": [{"campaign": {"id": "2", "name": "Old", "status": "REMOVED", "advertisingChannelType": "DISPLAY"},
                      "campaignBudget": {"totalAmountMicros": "90000000000", "period": "CUSTOM_PERIOD"}, "metrics": {}}]}])
    gaql_server(lambda req, q: httpx.Response(200, json=next(pages)))
    c = google(settings).campaigns({"account_id": "1112223334"})
    assert [x["campaign_id"] for x in c] == ["1", "2"]
    assert c[0]["daily_budget"] == 500.0 and c[0]["lifetime_spend"] == 2500.0 and c[0]["lifetime_cost_per_conversion"] == 500.0
    assert c[0]["raw"]["campaign"]["id"] == "1"
    assert c[1]["lifetime_budget"] == 90000.0 and c[1]["daily_budget"] is None and c[1]["status"] == "REMOVED"


def test_google_monthly_and_quarterly_are_exact_sums_of_daily(settings):
    def day(d, cost, clicks, imps, conv):
        return {"campaign": {"id": "1", "name": "S"}, "segments": {"date": d},
                "metrics": {"costMicros": str(cost * 1_000_000), "clicks": str(clicks), "impressions": str(imps), "conversions": conv}}
    data = {"results": [day("2026-07-30", 100, 10, 1000, 1), day("2026-07-31", 50, 5, 500, 0), day("2026-08-01", 200, 20, 4000, 4)]}
    gaql_server(lambda req, q: httpx.Response(200, json=data))
    g, acct = google(settings), {"account_id": "1112223334"}
    m = g.performance(acct, date(2026, 7, 1), date(2026, 8, 31), "monthly")
    assert [(r["period"], r["spend"], r["clicks"]) for r in m] == [("2026-07", 150.0, 15.0), ("2026-08", 200.0, 20.0)]
    assert m[0]["ctr_pct"] == 1.0 and m[0]["cpc"] == 10.0 and m[0]["cpm"] == 100.0 and m[0]["cost_per_conversion"] == 150.0
    q = g.performance(acct, date(2026, 7, 1), date(2026, 8, 31), "quarterly")
    assert len(q) == 1 and q[0]["period"] == "Q2 FY27" and q[0]["spend"] == 350.0
    assert len(g.performance(acct, date(2026, 7, 1), date(2026, 8, 31), "daily")) == 3


# ------------------------------------------------------------------ endpoints
def test_ads_endpoints_need_an_admin(anon, client):
    anon_headers = dict(anon.headers)
    anon.headers.pop("Authorization", None)
    assert anon.get("/api/ads/status").status_code == 401
    anon.headers.update(anon_headers)
    r = client.post("/api/users", json={"email": "v@test.local", "name": "V", "role": "viewer", "password": "viewer-pass-1"})
    assert r.status_code in (200, 201), r.text
    with TestClient(app) as v:
        sign_in(v, "v@test.local", "viewer-pass-1")
        assert v.get("/api/ads/status").status_code == 403
        assert v.get("/api/ads/meta/accounts").status_code == 403


def test_status_shows_names_only_and_unconfigured_calls_fail_cleanly(client, settings):
    settings.GOOGLE_ADS_MODE = "live"   # these checks are about the live connector
    settings.GOOGLE_ADS_DEVELOPER_TOKEN = ""
    settings.META_ACCESS_TOKEN = ""
    d = client.get("/api/ads/status").json()["data"]
    assert d["google"]["configured"] is False and "GOOGLE_ADS_DEVELOPER_TOKEN" in d["google"]["missing"] and d["meta"]["missing"] == ["META_ACCESS_TOKEN"]
    r = client.get("/api/ads/google/accounts")
    assert r.status_code == 503 and r.json()["error"]["code"] == "ADS_NOT_CONFIGURED"
    assert client.get("/api/ads/tiktok/accounts").status_code == 404
    s = client.post("/api/ads/snapshot", json={"platforms": ["meta", "google"]}).json()["data"]["platforms"]
    assert s["meta"]["ok"] is False and s["google"]["ok"] is False and s["meta"]["code"] == "ADS_NOT_CONFIGURED"


def test_endpoint_returns_meta_rows_with_platform_and_raw_and_hides_the_token(client, settings):
    settings.META_ACCESS_TOKEN, settings.META_AD_ACCOUNT_IDS = TOKEN, "55"

    def h(req: httpx.Request):
        p = str(req.url.path)
        if p.endswith("/act_55"):
            return httpx.Response(200, json={"id": "act_55", "name": "Acct", "currency": "INR", "account_status": 1, "created_time": "2025-01-01T00:00:00+0530"})
        if p.endswith("/campaigns"):
            return httpx.Response(200, json={"data": [{"id": "7", "name": "C", "effective_status": "ACTIVE", "objective": "OUTCOME_TRAFFIC",
                                                        "created_time": "2025-02-01T00:00:00+0530"}]})
        return httpx.Response(200, json={"data": []})
    serve(h)
    body = client.get("/api/ads/meta/campaigns").json()["data"]
    assert body["count"] == 1 and body["items"][0]["platform"] == "meta" and body["items"][0]["raw"]["id"] == "7"
    assert TOKEN not in json.dumps(body) and TOKEN not in json.dumps(client.get("/api/ads/status").json())
    assert client.get("/api/ads/meta/campaigns?raw=false").json()["data"]["items"][0].get("raw") is None
