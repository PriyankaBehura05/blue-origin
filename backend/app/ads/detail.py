"""Ad detail for the Campaign performance page: what the campaign totals (budget.py, gt.py) do not show.

    Meta    ad sets (audience, budget, placements), ads (format, creative), their monthly and lifetime performance,
            breakdowns by placement, age and gender, region and device, and the conversion events (action types) of the campaigns
    Google  keywords, search terms, devices, geography and conversion actions, read from the Google Ads script sheet
            (tabs Ads_Keywords, Ads_SearchTerms, Ads_Devices, Ads_Geo, Ads_Conversions). A tab the script has not written is
            reported as not available, never as zero.

Only the GT campaigns are fetched (ADS_CAMPAIGN_FILTER, common.keep_campaign) and every name is passed through
common.display_name, so the filter word never reaches the dashboard. Saved as ads/detail/<platform>.json.gz with the budget
screen's refresh; opening the dashboard calls nobody. Read-only towards Meta and Google.
"""
from __future__ import annotations

import gzip
import json
import re
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional

from app.core.config import Settings
from app.core.errors import AppError
from app.storage.base import BlobStore

from . import common as C, service as svc
from .meta_ads import STATUSES, _money, _rng

FOLDER = "ads/detail"
LEAD_ACTIONS = ("onsite_conversion.lead_grouped", "lead", "leadgen_grouped")
INSIGHT = "spend,impressions,reach,frequency,clicks,inline_link_clicks,actions"
BREAKDOWNS = {"placement": "publisher_platform,platform_position", "age_gender": "age,gender", "region": "region", "device": "device_platform"}
FORMATS = {"VIDEO": "Video", "PHOTO": "Image", "SHARE": "Link post", "STATUS": "Text post", "OFFER": "Offer", "LINK": "Link", "DOMAIN": "Link"}
SEARCH_TERM_CAP = 3000     # search terms kept, by spend


def path(platform: str) -> str:
    return f"{FOLDER}/{platform}.json.gz"


def read(store: BlobStore, platform: str) -> Optional[dict]:
    try:
        raw = store.read(path(platform))
    except (AppError, OSError):
        return None
    return json.loads(gzip.decompress(raw)) if raw else None


# ------------------------------------------------------------------ names: the filter word never leaves the backend
def scrub(obj: Any, settings: Settings) -> Any:
    """Every string that contains the campaign filter word goes through display_name (recursively)."""
    word = str(getattr(settings, "ADS_CAMPAIGN_FILTER", "") or "").strip().lower()
    if not word:
        return obj
    if isinstance(obj, str):
        if word not in obj.lower():
            return obj
        if "_" in obj:     # a campaign-style code: the same cleaning as every campaign name
            return C.display_name(obj, settings)
        # plain text (a headline, a body): only the whole word goes, similar words (Yashas) stay
        out = re.sub(r"(?i)\b" + re.escape(word) + r"\b[ \-|]*", "", obj)
        return re.sub(r"\s{2,}", " ", out).strip() or obj
    if isinstance(obj, list):
        return [scrub(x, settings) for x in obj]
    if isinstance(obj, dict):
        return {k: scrub(v, settings) for k, v in obj.items()}
    return obj


# ------------------------------------------------------------------ Meta
def _leads(actions) -> float:
    """Meta reports the same form leads under more than one action name: the largest, never the sum."""
    best = 0.0
    for t in LEAD_ACTIONS:
        for a in actions or []:
            if a.get("action_type") == t:
                best = max(best, C.num(a.get("value")) or 0.0)
    return best


def _perf(r: dict) -> dict:
    return {"spend": round(C.num(r.get("spend")) or 0.0, 2), "impressions": C.num(r.get("impressions")) or 0.0,
            "reach": C.num(r.get("reach")) or 0.0, "clicks": C.num(r.get("clicks")) or 0.0,
            "link_clicks": C.num(r.get("inline_link_clicks")) or 0.0, "leads": _leads(r.get("actions"))}


def _names(geo: dict) -> List[str]:
    out: List[str] = []
    for key in ("regions", "cities", "subcities", "neighborhoods", "custom_locations", "places"):
        out += [str(x.get("name") or x.get("key") or "") for x in geo.get(key) or [] if isinstance(x, dict)]
    return [n for n in out if n]


def audience(t: dict) -> dict:
    """A readable summary of an ad set's targeting. What the data does not say is left out, not guessed."""
    geo = t.get("geo_locations") or {}
    places = _names(geo)
    countries = [str(c) for c in geo.get("countries") or []]
    genders = t.get("genders") or []
    gender = "Men" if genders == [1] else "Women" if genders == [2] else "All genders"
    amax = t.get("age_max")
    interests: List[str] = []
    for spec in t.get("flexible_spec") or []:
        for key in ("interests", "behaviors", "life_events", "work_positions", "industries"):
            interests += [str(x.get("name")) for x in spec.get(key) or [] if isinstance(x, dict) and x.get("name")]
    shown = ", ".join(places[:3]) + (f" +{len(places) - 3} more" if len(places) > 3 else "")
    return {"age": f"{t.get('age_min', 18)}–{amax if amax and amax < 65 else '65+'}", "gender": gender,
            "locations": shown or ", ".join(countries) or "not set", "location_count": len(places),
            "custom_audiences": len(t.get("custom_audiences") or []), "excluded_audiences": len(t.get("excluded_custom_audiences") or []),
            "interests": interests[:8], "advantage_audience": bool((t.get("targeting_automation") or {}).get("advantage_audience"))}


def placements(t: dict) -> dict:
    plats = t.get("publisher_platforms") or []
    positions = sum((t.get(k) or [] for k in ("facebook_positions", "instagram_positions", "audience_network_positions", "messenger_positions")), [])
    if not plats:
        return {"text": "Automatic placements", "positions": []}
    names = ", ".join(p.replace("_", " ").title() for p in plats)
    return {"text": f"{names} · {len(positions)} positions" if positions else names, "positions": positions}


def meta(settings: Settings) -> dict:
    m = svc.client("meta", settings)
    accts, _ = svc.accounts("meta", settings, refresh=True)
    out: Dict[str, Any] = {"adsets": [], "ads": [], "adset_life": [], "ad_life": [], "adset_monthly": [], "ad_monthly": [],
                           "breakdowns": {}, "events": [], "errors": {}}
    errors = out["errors"]

    def attempt(label: str, fn: Callable[[], Any], default: Any) -> Any:
        try:
            return fn()
        except AppError as exc:        # one piece failing (a rate limit, a permission) never loses the others
            errors[label] = exc.message
            return default

    for a in [x for x in accts if x.get("accessible") and not x.get("is_manager")]:
        acct = a["account_id"]
        camps = [c for c in m.campaigns(acct) if C.keep_campaign(c["name"], settings)]
        if not camps:
            continue
        ids = [c["campaign_id"] for c in camps]
        flt = json.dumps([{"field": "campaign.id", "operator": "IN", "value": ids}])
        start, today = m.history_start(a, camps), date.today()
        for cid in ids:
            for r in attempt("ad sets", lambda cid=cid: m._pages(f"{cid}/adsets", {
                    "fields": "id,name,campaign_id,effective_status,daily_budget,lifetime_budget,optimization_goal,destination_type,targeting",
                    "effective_status": json.dumps(STATUSES)}), []):
                t = r.get("targeting") or {}
                out["adsets"].append({"adset_id": r.get("id"), "campaign_id": r.get("campaign_id"), "name": r.get("name"), "status": r.get("effective_status"),
                                      "daily_budget": _money(r.get("daily_budget")), "lifetime_budget": _money(r.get("lifetime_budget")),
                                      "optimization_goal": r.get("optimization_goal"), "audience": audience(t), "placements": placements(t)})
            for r in attempt("ads", lambda cid=cid: m._pages(f"{cid}/ads", {
                    "fields": "id,name,adset_id,campaign_id,effective_status,creative{id,name,object_type,title,body,call_to_action_type}",
                    "effective_status": json.dumps(STATUSES)}), []):
                c = r.get("creative") or {}
                out["ads"].append({"ad_id": r.get("id"), "adset_id": r.get("adset_id"), "campaign_id": r.get("campaign_id"), "name": r.get("name"),
                                   "status": r.get("effective_status"), "format": FORMATS.get(str(c.get("object_type") or "").upper(), (c.get("object_type") or "").title() or None),
                                   "creative_name": c.get("name"), "headline": c.get("title"), "body": (c.get("body") or "")[:160] or None,
                                   "cta": (c.get("call_to_action_type") or "").replace("_", " ").title() or None})

        def ins(level: str, **kw) -> List[dict]:
            return m._pages(f"{acct}/insights", {"fields": f"campaign_id,adset_id,ad_id,{INSIGHT}", "level": level, "filtering": flt, **kw})

        for level, key in (("adset", "adset"), ("ad", "ad")):
            for r in attempt(f"{level} performance (whole life)", lambda level=level: ins(level, date_preset="maximum"), []):
                out[f"{key}_life"].append({"campaign_id": r.get("campaign_id"), "adset_id": r.get("adset_id"), "ad_id": r.get("ad_id"),
                                           "frequency": C.num(r.get("frequency")), **_perf(r)})
            for r in attempt(f"{level} performance (monthly)", lambda level=level: ins(level, time_increment="monthly", time_range=_rng(start, today)), []):
                out[f"{key}_monthly"].append({"campaign_id": r.get("campaign_id"), "adset_id": r.get("adset_id"), "ad_id": r.get("ad_id"),
                                              "period": str(r.get("date_start"))[:7], **_perf(r)})
        for name, bd in BREAKDOWNS.items():
            rows = attempt(f"{name} breakdown", lambda bd=bd: m._pages(f"{acct}/insights", {
                "fields": f"campaign_id,{INSIGHT}", "level": "campaign", "breakdowns": bd, "time_increment": "monthly",
                "time_range": _rng(start, today), "filtering": flt}), [])
            keys = bd.split(",")
            out["breakdowns"].setdefault(name, []).extend(
                {"campaign_id": r.get("campaign_id"), "period": str(r.get("date_start"))[:7], **{k: r.get(k) for k in keys}, **_perf(r)} for r in rows)
        for r in attempt("conversion events", lambda: m._pages(f"{acct}/insights", {
                "fields": "campaign_id,actions", "level": "campaign", "date_preset": "maximum", "filtering": flt}), []):
            out["events"] += [{"campaign_id": r.get("campaign_id"), "action_type": x.get("action_type"), "value": C.num(x.get("value")) or 0.0}
                              for x in r.get("actions") or [] if (C.num(x.get("value")) or 0) > 0]
    return out


# ------------------------------------------------------------------ Google (from the script sheet)
def google(settings: Settings) -> dict:
    g = svc.client("google", settings)
    fn = getattr(g, "detail_tabs", None)
    if fn is None:
        return {"tabs": None, "reason": "Keywords, search terms, devices and geography come from the Google Ads script sheet (GOOGLE_ADS_MODE=sheet).",
                "lead_action": settings.GOOGLE_ADS_LEAD_CONVERSION}
    tabs = fn(lambda name: C.keep_campaign(name, settings))
    terms = tabs.get("search_terms")
    if terms and len(terms["rows"]) > SEARCH_TERM_CAP:
        terms["rows"] = sorted(terms["rows"], key=lambda r: -r["spend"])[:SEARCH_TERM_CAP]
        terms["capped"] = SEARCH_TERM_CAP
    return {"tabs": tabs, "lead_action": settings.GOOGLE_ADS_LEAD_CONVERSION}


def refresh(platform: str, settings: Settings, store: BlobStore) -> dict:
    """Fetch and save one platform's detail. Platform errors on single pieces are kept in the result (errors), not raised."""
    if not svc.is_real(platform, settings):
        raise C.AdsNotConfigured(f"{platform}: not connected with real data, nothing to fetch.")
    with C.patient():
        body = meta(settings) if platform == "meta" else google(settings)
    body = scrub(body, settings)
    body.update(platform=platform, fetched_at=datetime.now().isoformat(timespec="seconds"))
    store.write(path(platform), gzip.compress(json.dumps(body, default=str).encode("utf-8")))
    return {"platform": platform, "errors": body.get("errors") or {}}
