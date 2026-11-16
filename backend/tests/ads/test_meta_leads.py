"""Meta Lead Ads retrieval. Canned responses only (test-only data): no test calls Meta or reads real leads."""
from datetime import date

import httpx
import pytest

from app.ads import common as C, service as svc
from app.ads.meta_leads import MetaLeads, check_permission
from tests.ads.test_ads import TOKEN, serve


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    C.cache.clear()
    svc._clients.clear()
    monkeypatch.setattr(C.time, "sleep", lambda s: None)
    yield
    C.transport = None
    C.cache.clear()
    svc._clients.clear()


def lead(i, ad, created, phone):
    return {"id": f"L{i}", "created_time": created, "ad_id": ad, "ad_name": f"Ad {ad}", "adset_id": "S1", "adset_name": "Set 1",
            "campaign_id": "C9", "campaign_name": "Lead Gen", "form_id": "F1", "platform": "ig", "is_organic": False,
            "field_data": [{"name": "full_name", "values": ["Test Shop"]}, {"name": "phone_number", "values": [phone]}, {"name": "city", "values": ["Pune"]}]}


def leads_server(seen):
    def h(req: httpx.Request):
        seen.append(req)
        p = req.url.path
        if p.endswith("/insights"):
            return httpx.Response(200, json={"data": [
                {"ad_id": "A1", "actions": [{"action_type": "link_click", "value": "40"}, {"action_type": "onsite_conversion.lead_grouped", "value": "3"}]},
                {"ad_id": "A2", "actions": [{"action_type": "link_click", "value": "90"}]}]})          # no leads: never asked
        if p.endswith("/A1/leads"):
            if not req.url.params.get("after"):
                return httpx.Response(200, json={"data": [lead(1, "A1", "2026-10-02T10:00:00+0000", "+919800000001"),
                                                          lead(2, "A1", "2026-10-05T10:00:00+0000", "9800000002")],
                                                 "paging": {"cursors": {"after": "x"}, "next": "https://graph.facebook.com/next"}})
            return httpx.Response(200, json={"data": [lead(3, "A1", "2026-10-03T10:00:00+0000", "9800000003")]})
        return httpx.Response(404, json={"error": {"code": 803, "message": "unexpected " + p}})
    serve(h)


def test_leads_come_with_their_campaign_and_only_ads_with_leads_are_asked(settings):
    seen = []
    leads_server(seen)
    s = settings.model_copy(update=dict(META_ACCESS_TOKEN=TOKEN, META_AD_ACCOUNT_IDS="55"))
    r = MetaLeads(s).leads("act_55", date(2026, 10, 1), date(2026, 10, 31))
    assert r["ads_with_leads"] == 1 and r["leads_reported_by_insights"] == 3 and r["count"] == 3
    assert [x["lead_id"] for x in r["items"]] == ["L2", "L3", "L1"]                 # newest first, both pages read
    first = r["items"][0]
    assert (first["campaign_id"], first["adset_id"], first["ad_id"], first["form_id"]) == ("C9", "S1", "A1", "F1")
    assert first["phone"] == "9800000002" and first["name"] == "Test Shop" and first["placement"] == "ig" and first["fields"]["city"] == "Pune"
    assert not any("/A2/leads" in r.url.path for r in seen)
    assert all(TOKEN not in str(r.url) for r in seen)
    flt = next(r for r in seen if r.url.path.endswith("/leads")).url.params["filtering"]
    assert "time_created" in flt and "GREATER_THAN_OR_EQUAL" in flt


def test_missing_leads_permission_is_explained(settings):
    def h(req):
        if req.url.path.endswith("/insights"):
            return httpx.Response(200, json={"data": [{"ad_id": "A1", "actions": [{"action_type": "lead", "value": "1"}]}]})
        return httpx.Response(400, json={"error": {"code": 100, "message": "(#100) Requires pages_manage_ads or leads_retrieval permission to manage the object"}})
    serve(h)
    s = settings.model_copy(update=dict(META_ACCESS_TOKEN=TOKEN))
    with pytest.raises(C.AdsPermissionError) as e:
        MetaLeads(s).leads("act_55", date(2026, 10, 1), date(2026, 10, 31))
    assert "leads_retrieval" in e.value.message and TOKEN not in e.value.message


def test_permission_check_reads_scopes_only(settings):
    serve(lambda req: httpx.Response(200, json={"data": {"type": "SYSTEM_USER", "scopes": ["ads_read", "public_profile"]}}))
    r = check_permission(settings.model_copy(update=dict(META_ACCESS_TOKEN=TOKEN)))
    assert r == {"configured": True, "scopes": ["ads_read", "public_profile"], "can_read_leads": False}


def test_leads_endpoint_is_admin_only_and_hides_raw_by_default(client, settings):
    settings.META_ACCESS_TOKEN, settings.META_AD_ACCOUNT_IDS = TOKEN, "55"
    seen = []
    leads_server(seen)

    def h(req: httpx.Request):
        if req.url.path.endswith("/act_55"):
            return httpx.Response(200, json={"id": "act_55", "name": "Acct", "currency": "INR", "account_status": 1})
        return inner(req)
    inner = C.transport.handle_request
    serve(lambda req: h(req))
    body = client.get("/api/ads/meta/leads?start=2026-10-01&end=2026-10-31").json()["data"]
    assert body["count"] == 3 and "raw" not in body["accounts"][0]["items"][0] and body["accounts"][0]["items"][0]["campaign_id"] == "C9"
    assert client.get("/api/ads/meta/leads?start=2026-11-01&end=2026-10-01").status_code == 400
