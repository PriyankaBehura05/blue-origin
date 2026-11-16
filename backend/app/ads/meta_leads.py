"""Meta Lead Ads: the individual leads from Meta instant forms, each with the campaign, ad set and ad it came from.

This is what ties a lead to a campaign: reporting (meta_ads.py) only gives totals per campaign. Meta needs the
`leads_retrieval` permission (or `pages_manage_ads`) on the token, with the Facebook Page that owns the forms assigned to
the system user; `ads_read` alone is refused. Read-only, fetched only on request.

To keep the number of calls low (the app is on Meta's development tier), one Insights request finds the ads that had
leads in the date range, and only those ads are asked for their leads.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone
from typing import Dict, List, Optional

from app.core.config import Settings
from . import common as C
from .meta_ads import MetaAds, _rng

LEAD_FIELDS = "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic,field_data"
LEAD_ACTIONS = ("onsite_conversion.lead_grouped", "lead", "leadgen_grouped")
PHONE_KEYS = ("phone_number", "phone", "mobile", "mobile_number", "whatsapp_number")
NAME_KEYS = ("full_name", "name", "first_name")


class MetaLeads:
    def __init__(self, settings: Settings):
        self.m = MetaAds(settings)

    def _ads_with_leads(self, account_id: str, start: date, end: date) -> Dict[str, float]:
        rows = self.m._pages(f"{account_id}/insights", {"fields": "ad_id,actions", "level": "ad", "time_range": _rng(start, end)})
        out: Dict[str, float] = {}
        for r in rows:
            # Meta reports the same form leads under more than one action name: take the largest, never the sum
            n = max([C.num(a.get("value")) or 0 for a in r.get("actions") or [] if a.get("action_type") in LEAD_ACTIONS] or [0])
            if n > 0 and r.get("ad_id"):
                out[r["ad_id"]] = max(out.get(r["ad_id"], 0), n)
        return out

    def leads(self, account_id: str, start: date, end: date) -> dict:
        """Leads created between start and end (inclusive), newest first, with their campaign / ad set / ad / form."""
        ads = self._ads_with_leads(account_id, start, end)
        since = int(datetime.combine(start, time.min, tzinfo=timezone.utc).timestamp())
        until = int(datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc).timestamp())
        flt = json.dumps([{"field": "time_created", "operator": "GREATER_THAN_OR_EQUAL", "value": since},
                          {"field": "time_created", "operator": "LESS_THAN", "value": until}])
        items: List[dict] = []
        for ad_id in ads:
            try:
                rows = self.m._pages(f"{ad_id}/leads", {"fields": LEAD_FIELDS, "filtering": flt})
            except C.AdsApiError as exc:
                if (exc.details or {}).get("meta_code") == 100 and "leads_retrieval" in exc.message:
                    raise C.AdsPermissionError(
                        "The Meta token cannot read lead-form leads: it needs the leads_retrieval permission (or pages_manage_ads), "
                        "and the Facebook Page that owns the lead forms must be assigned to the system user. Today it only has ads_read.",
                        {"meta_code": 100})
                raise
            items += [self._shape(r) for r in rows]
        items.sort(key=lambda r: r["created_time"] or "", reverse=True)
        return {"account_id": account_id, "start": start.isoformat(), "end": end.isoformat(), "ads_with_leads": len(ads),
                "leads_reported_by_insights": int(sum(ads.values())), "count": len(items), "items": items}

    @staticmethod
    def _shape(r: dict) -> dict:
        fields = {f.get("name", ""): (f.get("values") or [""])[0] for f in r.get("field_data") or []}
        pick = lambda keys: next((fields[k] for k in keys if fields.get(k)), None)  # noqa: E731
        return {"platform_source": "meta", "lead_id": r.get("id"), "created_time": r.get("created_time"),
                "campaign_id": r.get("campaign_id"), "campaign_name": r.get("campaign_name"),
                "adset_id": r.get("adset_id"), "adset_name": r.get("adset_name"), "ad_id": r.get("ad_id"), "ad_name": r.get("ad_name"),
                "form_id": r.get("form_id"), "placement": r.get("platform"), "is_organic": bool(r.get("is_organic")),
                "phone": pick(PHONE_KEYS), "name": pick(NAME_KEYS), "fields": fields, "raw": r}


def check_permission(settings: Settings) -> dict:
    """Which permissions the Meta token has, for the status line. No lead data is read."""
    m = MetaAds(settings)
    if not m.configured():
        return {"configured": False, "scopes": [], "can_read_leads": False}
    d = m._get("debug_token", {"input_token": m.token}).get("data", {})
    scopes = list(d.get("scopes") or [])
    return {"configured": True, "scopes": scopes, "can_read_leads": "leads_retrieval" in scopes or "pages_manage_ads" in scopes}
