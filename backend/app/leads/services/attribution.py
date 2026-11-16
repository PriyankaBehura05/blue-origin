"""Lead -> campaign attribution: which ad campaign each lead submission came from, or why that cannot be said.

Inputs: the cleaned lead rows of the pipeline (prep.prepare_leads, every submission, with `unique` marking the first
enquiry per mobile) and each platform's campaigns and daily delivery saved by app/ads/delivery.py.

Rules, tried in this order; the first that gives exactly one campaign wins:

    1  Lead ID         Meta's lead ID in the sheet looked up in Meta's lead list (needs the leads_retrieval permission)
    2  Campaign ID     a campaign ID column in the sheet that is a known campaign of that platform
    3  Campaign name   a campaign name column in the sheet that is exactly one campaign's name
    4  Name + date     fallback: the only lead campaign of the platform that collected leads on the lead's date AND has the
                       lead's state in its name (Google names its lead campaigns per state)
    5  Date            fallback: the only lead campaign of the platform that collected leads on the lead's date

Anything else is reported as Unmatched with the reason; nothing is spread across campaigns or guessed. Leads from a source
with no ad platform (Print, JustDial) and Meta leads that Meta marks organic are Non-paid. Leads whose tab names no platform
at all (source Other, e.g. a state-wise tab with no copy in a platform tab) are Unmatched: platform unknown - they may well
be ad leads, so they are not called non-paid.

Duplicate submissions are attributed like any row, but every count of leads uses `unique` (one per mobile), so a person who
enquired three times is one unique lead of the campaign of their first enquiry.
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import pandas as pd

PAID = ("Meta", "Google")
UNKNOWN_SOURCE = "Other"      # the tab names no platform: may be an ad lead, so never counted as non-paid
STATUSES = ["Matched", "Unmatched", "Non-paid"]
MATCHED, UNMATCHED, NONPAID = range(3)
METHODS = ["Lead ID", "Campaign ID", "Campaign name", "Campaign name + date", "Date"]
LEAD_ID, CAMPAIGN_ID, CAMPAIGN_NAME, NAME_DATE, DATE_ONLY = range(5)
EXACT_METHODS = (LEAD_ID, CAMPAIGN_ID, CAMPAIGN_NAME)      # the rest are fallbacks, shown as such

# why a paid lead stayed unmatched (shown as written)
NO_DATA = "No campaign data saved for this platform yet"
NO_DATE = "No lead date"
UNKNOWN_PLATFORM = "Platform unknown: the sheet tab does not say where the lead came from"
NONE_THAT_DAY = "No lead campaign collected leads on that date"
SEVERAL = "Several lead campaigns collected leads on that date"
DAMAGED_ID = "Lead ID damaged in the sheet (shown like 1.23E+15)"

META_LEAD_OBJECTIVES = {"OUTCOME_LEADS", "LEAD_GENERATION"}


def _letters(s: object) -> str:
    return re.sub(r"[^a-z]", "", str(s or "").lower())


def lead_campaigns(platform: str, campaigns: List[dict]) -> Dict[str, dict]:
    """The campaigns that can bring sheet leads: Meta lead-form campaigns (objective Leads); Google campaigns named as lead
    generation ('lead' in the name), since Google Ads has no objective."""
    if platform == "Meta":
        return {c["campaign_id"]: c for c in campaigns if (c.get("objective") or "").upper() in META_LEAD_OBJECTIVES}
    return {c["campaign_id"]: c for c in campaigns if "lead" in str(c.get("name") or "").lower()}


class PlatformData:
    """One platform's campaigns, the lead campaigns delivering leads each day, and Meta's lead -> campaign map."""

    def __init__(self, platform: str, saved: Optional[dict]):
        self.platform = platform
        self.saved = saved is not None
        saved = saved or {}
        self.campaigns: Dict[str, dict] = {str(c["campaign_id"]): c for c in saved.get("campaigns", [])}
        self.by_name: Dict[str, List[str]] = defaultdict(list)
        for cid, c in self.campaigns.items():
            self.by_name[str(c.get("name") or "").strip().lower()].append(cid)
        leadc = lead_campaigns(platform, list(self.campaigns.values()))
        self.on_day: Dict[str, List[str]] = defaultdict(list)
        for r in saved.get("daily", []):
            cid = str(r.get("campaign_id"))
            if cid in leadc and (r.get("leads") or 0) > 0 and cid not in self.on_day[r["date"]]:
                self.on_day[r["date"]].append(cid)
        self.lead_map: Dict[str, dict] = saved.get("lead_map") or {}
        self.lead_map_available = bool(saved.get("lead_map_available"))
        self.notes: List[str] = list(saved.get("notes") or [])
        self.fetched_at = saved.get("fetched_at")

    def name(self, cid: str) -> str:
        return str(self.campaigns.get(cid, {}).get("name") or f"Campaign {cid}")


def _one(cands: List[str]) -> Optional[str]:
    return cands[0] if len(cands) == 1 else None


def attribute_one(p: Optional[PlatformData], source: str, day: Optional[str], state: str, lead_id: str,
                  sheet_cid: str, sheet_cname: str) -> Tuple[int, int, str, str]:
    """(status, method or -1, campaign_id or '', note) for one lead row."""
    if source == UNKNOWN_SOURCE:
        return UNMATCHED, -1, "", UNKNOWN_PLATFORM
    if source not in PAID:
        return NONPAID, -1, "", f"{source} lead: no ad platform"
    if p is None or not p.saved:
        return UNMATCHED, -1, "", NO_DATA
    if lead_id and lead_id in p.lead_map:
        hit = p.lead_map[lead_id]
        if hit.get("is_organic"):
            return NONPAID, -1, "", "Meta marks this lead organic (not from an ad)"
        return MATCHED, LEAD_ID, str(hit["campaign_id"]), ""
    if sheet_cid and sheet_cid in p.campaigns:
        return MATCHED, CAMPAIGN_ID, sheet_cid, ""
    if sheet_cname:
        cid = _one(p.by_name.get(sheet_cname.strip().lower(), []))
        if cid:
            return MATCHED, CAMPAIGN_NAME, cid, ""
    if not day:
        return UNMATCHED, -1, "", NO_DATE
    cands = p.on_day.get(day, [])
    if not cands:
        return UNMATCHED, -1, "", NONE_THAT_DAY
    st = _letters(state)
    if st:
        named = [c for c in cands if st in _letters(p.name(c))]
        if len(named) == 1:
            return MATCHED, NAME_DATE, named[0], ""
    if len(cands) == 1:
        return MATCHED, DATE_ONLY, cands[0], ""
    if re.fullmatch(r"\d+(\.\d+)?e\+\d+", lead_id.lower()) and p.platform == "Meta":
        return UNMATCHED, -1, "", DAMAGED_ID
    return UNMATCHED, -1, "", f"{SEVERAL}: {', '.join(sorted(p.name(c) for c in cands))}"


def attribute(leads: pd.DataFrame, platforms: Dict[str, Optional[dict]]) -> pd.DataFrame:
    """Adds platform, att_status, att_method, campaign_id, att_note, and sets `campaign` to the attributed campaign's name
    ('Unmatched' / 'Non-paid' otherwise). platforms: {'Meta': saved delivery or None, 'Google': ...}."""
    data = {k: PlatformData(k, v) for k, v in platforms.items()}
    out = leads.copy()
    lid = out["lead_id"] if "lead_id" in out else pd.Series([""] * len(out), index=out.index)
    scid = out["sheet_campaign_id"] if "sheet_campaign_id" in out else pd.Series([""] * len(out), index=out.index)
    sname = out["campaign"].where(out["campaign"] != "(no campaign)", "") if "campaign" in out else pd.Series([""] * len(out), index=out.index)
    res = [attribute_one(data.get(src), src, d.isoformat() if d is not None else None, st, str(i or ""), str(c or ""), str(n or ""))
           for src, d, st, i, c, n in zip(out["source"], out["date"], out["state"], lid, scid, sname)]
    out["platform"] = [s if s in PAID else "" for s in out["source"]]
    out["att_status"] = [r[0] for r in res]
    out["att_method"] = [r[1] for r in res]
    out["campaign_id"] = [r[2] for r in res]
    out["att_note"] = [r[3] for r in res]
    out["campaign"] = [data[s].name(r[2]) if r[0] == MATCHED else ("Non-paid" if r[0] == NONPAID else
                       "Unmatched: platform unknown" if s == UNKNOWN_SOURCE else f"Unmatched {s}")
                       for s, r in zip(out["source"], res)]
    return out


def summary(leads: pd.DataFrame, platforms: Dict[str, Optional[dict]]) -> dict:
    """Counts for the attribution page: every submission and unique leads, by status, method, platform and unmatched reason."""
    data = {k: PlatformData(k, v) for k, v in platforms.items()}
    if not len(leads) or "att_status" not in leads:
        return {"statuses": STATUSES, "methods": METHODS, "rows": [], "reasons": [], "platforms": {}}
    u = leads["unique"]
    rows = []
    for (plat, st, me), g in leads.groupby([leads["source"], "att_status", "att_method"]):
        rows.append({"source": plat, "status": int(st), "method": int(me), "submissions": int(len(g)), "unique": int(g["unique"].sum())})
    reasons = []
    um = leads[leads["att_status"] == UNMATCHED]
    for (plat, why), g in um.groupby([um["source"], um["att_note"]]):
        reasons.append({"source": plat, "reason": why, "submissions": int(len(g)), "unique": int(g["unique"].sum())})
    return {
        "statuses": STATUSES, "methods": METHODS, "exact_methods": list(EXACT_METHODS), "rows": rows,
        "reasons": sorted(reasons, key=lambda r: -r["unique"]),
        "duplicates": int((~u).sum()),
        "platforms": {k: {"saved": d.saved, "fetched_at": d.fetched_at, "lead_id_lookup": d.lead_map_available,
                          "lead_campaigns": len(lead_campaigns(k, list(d.campaigns.values()))), "notes": d.notes} for k, d in data.items()},
    }
