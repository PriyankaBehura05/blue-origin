"""Campaign delivery by day, for linking leads to campaigns (app/leads/services/attribution.py).

The lead sheet carries no campaign name or ID, only the platform (its tab), the date and Meta's lead ID. So, per platform,
this keeps what the attribution needs, next to the budget screen's data:

    ads/attribution/<platform>.json.gz
        campaigns   id, name, objective / channel type
        daily       one row per campaign and day with spend and the leads the platform reported (Meta: lead-form results;
                    Google: conversions)
        lead_map    Meta only, when the token may read lead forms (leads_retrieval): Meta lead ID -> campaign, ad set, ad,
                    organic flag. This is the exact link; without the permission it is empty and the attribution falls back
                    to name + date rules, which it reports as such.

Fetched with the budget screen (same admin button, same automatic refresh). Read-only towards Meta and Google.
"""
from __future__ import annotations

import gzip
import json
import logging
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

from app.core.config import Settings
from app.core.errors import AppError
from app.storage.base import BlobStore

from . import common as C, service as svc
from .meta_ads import _action_total, _rng

FOLDER = "ads/attribution"
LEAD_ACTIONS = ("onsite_conversion.lead_grouped", "lead", "leadgen_grouped")
LEAD_MAP_DAYS = 400          # how far back the Meta lead map is read (each ad with leads is one request)
log = logging.getLogger("blue_origin.ads")


def path(platform: str) -> str:
    return f"{FOLDER}/{platform}.json.gz"


def read(store: BlobStore, platform: str) -> Optional[dict]:
    try:
        raw = store.read(path(platform))
    except (AppError, OSError):
        return None
    return json.loads(gzip.decompress(raw)) if raw else None


def _meta(settings: Settings) -> dict:
    m = svc.client("meta", settings)
    accts, _ = svc.accounts("meta", settings, refresh=True)
    campaigns: List[dict] = []
    daily: List[dict] = []
    lead_map: Dict[str, dict] = {}
    notes: List[str] = []
    for a in [x for x in accts if x.get("accessible") and not x.get("is_manager")]:
        acct = a["account_id"]
        camps = [c for c in m.campaigns(acct) if C.keep_campaign(c["name"], settings)]
        campaigns += [{"campaign_id": c["campaign_id"], "name": C.display_name(c["name"], settings), "objective": c.get("objective"), "account_id": acct} for c in camps]
        start, today = m.history_start(a, camps), date.today()
        for _, s, e in C.windows(start, today, "chunk"):
            for r in m._pages(f"{acct}/insights", {"fields": "campaign_id,campaign_name,spend,impressions,clicks,actions,date_start", "level": "campaign",
                                                   "time_increment": 1, "time_range": _rng(s, e)}):
                if not C.keep_campaign(r.get("campaign_name"), settings):
                    continue
                # Meta reports the same form leads under more than one action name: the largest, never the sum
                leads = max([_action_total(r.get("actions"), (t,)) or 0 for t in LEAD_ACTIONS])
                spend = C.num(r.get("spend")) or 0.0
                if spend or leads:
                    daily.append({"campaign_id": r.get("campaign_id"), "date": r.get("date_start"), "spend": round(spend, 2), "leads": int(leads),
                                  "impressions": int(C.num(r.get("impressions")) or 0), "clicks": int(C.num(r.get("clicks")) or 0)})
    # the exact lead -> campaign link, only when the token may read lead forms
    from .meta_leads import MetaLeads, check_permission
    perm = check_permission(settings)
    if perm.get("can_read_leads"):
        ml = MetaLeads(settings)
        for a in [x for x in accts if x.get("accessible") and not x.get("is_manager")]:
            for _, s, e in C.windows(date.today() - timedelta(days=LEAD_MAP_DAYS), date.today(), "chunk"):
                for r in ml.leads(a["account_id"], s, e)["items"]:
                    lead_map[str(r["lead_id"])] = {"campaign_id": r["campaign_id"], "adset_id": r["adset_id"], "ad_id": r["ad_id"],
                                                   "is_organic": r["is_organic"]}
    else:
        notes.append("The Meta token cannot read lead forms (it needs leads_retrieval), so Meta lead IDs cannot be looked up: "
                     "Meta leads are linked by date instead.")
    return {"campaigns": campaigns, "daily": daily, "lead_map": lead_map, "lead_map_available": bool(perm.get("can_read_leads")), "notes": notes}


def _google(settings: Settings) -> dict:
    g = svc.client("google", settings)
    accts, _ = svc.accounts("google", settings, refresh=True)
    campaigns: List[dict] = []
    daily: List[dict] = []
    for a in [x for x in accts if x.get("accessible") and not x.get("is_manager")]:
        camps = [c for c in g.campaigns(a) if C.keep_campaign(c["name"], settings)]
        campaigns += [{"campaign_id": c["campaign_id"], "name": C.display_name(c["name"], settings), "objective": c.get("campaign_type"), "account_id": a["account_id"]} for c in camps]
        start, end = date.today() - timedelta(days=400), date.today()
        from .budget import google_leads
        leads = google_leads(g, a, start, end, settings)    # the "Conversion" action only, when available
        for r in g.performance(a, start, end, "daily"):
            if not C.keep_campaign(r.get("campaign_name"), settings):
                continue
            spend = r.get("spend") or 0.0
            conv = leads.get((r["campaign_id"], r["date_start"][:10]), 0.0) if leads is not None else (r.get("conversions") or 0.0)
            if spend or conv:
                daily.append({"campaign_id": r["campaign_id"], "date": r["date_start"], "spend": round(spend, 2), "leads": round(conv, 2),
                              "impressions": int(r.get("impressions") or 0), "clicks": int(r.get("clicks") or 0)})
    return {"campaigns": campaigns, "daily": daily, "lead_map": {}, "lead_map_available": False,
            "notes": ["Google Ads does not pass a lead ID or click ID into the lead sheet: Google leads are linked by campaign name (state) and date."]}


def refresh(platform: str, settings: Settings, store: BlobStore) -> dict:
    """Fetch and save one platform's delivery. Raises AppError on platform errors (the caller logs them)."""
    if not svc.is_real(platform, settings):
        raise C.AdsNotConfigured(f"{platform}: not connected with real data, nothing to fetch.")
    with C.patient():
        body = _meta(settings) if platform == "meta" else _google(settings)
    body.update(platform=platform, fetched_at=datetime.now().isoformat(timespec="seconds"))
    store.write(path(platform), gzip.compress(json.dumps(body, default=str).encode("utf-8")))
    return {"platform": platform, "campaigns": len(body["campaigns"]), "daily_rows": len(body["daily"]), "lead_map": len(body["lead_map"])}
