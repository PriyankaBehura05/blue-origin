"""GT campaign performance (the YASHA campaigns): month by month per campaign - spend, impressions, reach, clicks and leads -
plus the combined reach of all of them, saved with the budget screen (budget.py) for the Lead Generation dashboard.

Leads, as each platform counts them:
    Meta    the lead-form results of the campaign (the largest of Meta's lead action names, never their sum)
    Google  the conversions of the one conversion action named GOOGLE_ADS_LEAD_CONVERSION ("Conversion"); other conversion
            actions are not leads. When that breakdown is not available (an older Google Ads script), Google's total
            conversions are used and `leads_basis` says so.
Reach counts people, so it does not add up across months or campaigns: Meta's own de-duplicated reach of all the GT campaigns
together is fetched separately (per month and for the whole life). Google reports no reach.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date
from typing import Dict, List, Optional, Tuple

from app.core.config import Settings
from . import common as C
from .meta_ads import _action_total, _rng

LEAD_ACTIONS = ("onsite_conversion.lead_grouped", "lead", "leadgen_grouped")
FIELDS = "campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,actions,date_start"


def _leads(actions) -> float:
    return max([_action_total(actions, (t,)) or 0 for t in LEAD_ACTIONS])


def meta(m, account_id: str, start: date, end: date, settings: Settings) -> dict:
    """m: MetaAds. The filtered campaigns month by month, their lifetime reach, and the combined (de-duplicated) reach."""
    word = str(settings.ADS_CAMPAIGN_FILTER or "").strip()
    flt = json.dumps([{"field": "campaign.name", "operator": "CONTAIN", "value": word}]) if word else None
    base = {"fields": FIELDS, "level": "campaign", **({"filtering": flt} if flt else {})}
    monthly: List[dict] = []
    for _, a, b in C.windows(start, end, "monthly"):
        for r in m._pages(f"{account_id}/insights", {**base, "time_range": _rng(a, b)}):
            if not C.keep_campaign(r.get("campaign_name"), settings):
                continue
            monthly.append({"campaign_id": r.get("campaign_id"), "period": a.strftime("%Y-%m"), "spend": C.num(r.get("spend")) or 0.0,
                            "impressions": C.num(r.get("impressions")) or 0.0, "reach": C.num(r.get("reach")) or 0.0,
                            "clicks": C.num(r.get("clicks")) or 0.0, "link_clicks": C.num(r.get("inline_link_clicks")) or 0.0,
                            "leads": _leads(r.get("actions"))})
    life = {r.get("campaign_id"): C.num(r.get("reach")) or 0.0
            for r in m._pages(f"{account_id}/insights", {**base, "date_preset": "maximum"}) if C.keep_campaign(r.get("campaign_name"), settings)}
    # all the GT campaigns together, at account level so Meta removes people reached by more than one of them
    acct = {"fields": "reach,impressions", "level": "account", **({"filtering": flt} if flt else {})}
    combined = []
    for _, a, b in C.windows(start, end, "monthly"):
        rows = m._pages(f"{account_id}/insights", {**acct, "time_range": _rng(a, b)})
        if rows:
            combined.append({"period": a.strftime("%Y-%m"), "reach": C.num(rows[0].get("reach")) or 0.0})
    total = m._pages(f"{account_id}/insights", {**acct, "date_preset": "maximum"})
    return {"campaign_monthly": monthly, "lifetime_reach": [{"campaign_id": k, "reach": v} for k, v in life.items()],
            "combined_monthly_reach": combined, "combined_lifetime_reach": C.num(total[0].get("reach")) if total else None,
            "leads_basis": "Meta lead-form results", "has_reach": True}


def google(daily: List[dict], lead_conv: Optional[Dict[Tuple[str, str], float]], settings: Settings) -> dict:
    """daily: the connector's daily rows (already filtered); lead_conv: {(campaign_id, date): conversions of the lead action}
    or None when the breakdown by conversion action is not available."""
    agg: Dict[Tuple[str, str], Dict[str, float]] = defaultdict(lambda: {"spend": 0.0, "impressions": 0.0, "clicks": 0.0, "leads": 0.0, "all_conversions": 0.0})
    for r in daily:
        k = (r["campaign_id"], r["date_start"][:7])
        a = agg[k]
        a["spend"] += r.get("spend") or 0.0
        a["impressions"] += r.get("impressions") or 0.0
        a["clicks"] += r.get("clicks") or 0.0
        a["all_conversions"] += r.get("conversions") or 0.0
        a["leads"] += (lead_conv.get((r["campaign_id"], r["date_start"][:10]), 0.0) if lead_conv is not None else (r.get("conversions") or 0.0))
    action = settings.GOOGLE_ADS_LEAD_CONVERSION
    return {"campaign_monthly": [{"campaign_id": cid, "period": ym, "reach": None, "link_clicks": None, **{k: round(v, 2) for k, v in a.items()}}
                                 for (cid, ym), a in agg.items()],
            "lifetime_reach": [], "combined_monthly_reach": [], "combined_lifetime_reach": None, "has_reach": False,
            "leads_basis": f"Google Ads conversion action “{action}”" if lead_conv is not None else
                           f"All Google Ads conversions: the Google Ads sheet has no breakdown by conversion action yet, so “{action}” cannot be picked out (update the Google Ads script)"}
