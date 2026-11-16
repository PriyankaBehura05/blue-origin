"""Google Ads stand-ins for GOOGLE_ADS_MODE=off and GOOGLE_ADS_MODE=sample (live = google_ads.GoogleAds).

off     nothing: no accounts, campaigns or performance, shown as Not Connected.
sample  a few made-up campaigns in the same record structure as Meta Ads (meta_ads.py), to preview pages before Google is
        connected. Generated in memory on every call from today's date (so it never goes stale), every record marked
        "sample": True and every name starting "SAMPLE". Nothing here writes to Google Sheets, the data store or any database,
        and the dashboard's real totals ignore it.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

from app.core.config import Settings
from . import common as C

PLATFORM = "google"
NOTE = "Sample data: made-up Google Ads figures (GOOGLE_ADS_MODE=sample), never saved and never used in the dashboard's totals."
ACCOUNT_ID = "sample-google"
TIMEZONE = "Asia/Kolkata"

# id, name, status, objective, daily budget, lifetime budget, started (days ago), stopped (days ago, or None = still running)
_CAMPAIGNS: List[Tuple[str, str, str, str, Optional[float], Optional[float], int, Optional[int]]] = [
    ("sample-g1", "SAMPLE · Search · Retailer enquiries", "ACTIVE", "SEARCH", 2500.0, None, 150, None),
    ("sample-g2", "SAMPLE · Performance Max · Sportswear", "ACTIVE", "PERFORMANCE_MAX", 4000.0, None, 90, None),
    ("sample-g3", "SAMPLE · YouTube · Brand video", "PAUSED", "VIDEO", None, 60000.0, 120, 30),
    ("sample-g4", "SAMPLE · Display · Remarketing", "ARCHIVED", "DISPLAY", 1200.0, None, 200, 100),
]


def _today() -> date:
    return date.today()


def _days(c, today: date) -> Tuple[date, date]:
    start = today - timedelta(days=c[6])
    stop = today - timedelta(days=c[7]) if c[7] is not None else today
    return start, stop


def daily(start: date, end: date) -> List[dict]:
    """Made-up daily figures per campaign: steady around the budget, a little different every day, always the same for a date."""
    today = _today()
    rows = []
    for ix, c in enumerate(_CAMPAIGNS):
        cs, ce = _days(c, today)
        per_day = c[4] if c[4] else (c[5] or 0) / max(1, (ce - cs).days + 1)
        d = max(start, cs)
        while d <= min(end, ce):
            factor = 0.8 + 0.4 * (((d.toordinal() * 37 + ix * 11) % 100) / 100)
            spend = round(per_day * factor, 2)
            imps = int(spend * 55)
            clicks = int(imps * 0.03)
            rows.append({"campaign_id": c[0], "date": d.isoformat(), "spend": spend, "impressions": imps, "clicks": clicks,
                         "conversions": round(clicks * 0.06, 1)})
            d += timedelta(days=1)
    return rows


class GoogleAdsOff:
    """GOOGLE_ADS_MODE=off: Not Connected, empty data."""
    mode = "off"
    version = "-"

    def __init__(self, settings: Settings):
        self.s = settings

    def configured(self) -> bool:
        return False

    def missing(self) -> List[str]:
        return []

    def customer_ids(self) -> List[str]:
        return []

    def accounts(self) -> List[dict]:
        return []

    def campaigns(self, account) -> List[dict]:
        return []

    def performance(self, account, start: date, end: date, granularity: str = "daily") -> List[dict]:
        return []


class GoogleAdsSample(GoogleAdsOff):
    """GOOGLE_ADS_MODE=sample: made-up records in the Meta Ads structure (accounts, campaigns, performance)."""
    mode = "sample"
    version = "sample"

    def configured(self) -> bool:
        return True

    def accounts(self) -> List[dict]:
        spent = sum(r["spend"] for r in daily(_today() - timedelta(days=400), _today()))
        return [{"platform": PLATFORM, "account_id": ACCOUNT_ID, "name": "SAMPLE Google Ads account (not real)", "currency": "INR",
                 "timezone": TIMEZONE, "status": "ACTIVE", "created_time": (_today() - timedelta(days=400)).isoformat() + "T00:00:00+0530",
                 "amount_spent_lifetime": round(spent, 2), "business_name": "Sample", "accessible": True, "sample": True, "raw": {"sample": True}}]

    def campaigns(self, account=None) -> List[dict]:
        today = _today()
        spent = defaultdict(float)
        for r in daily(today - timedelta(days=400), today):
            spent[r["campaign_id"]] += r["spend"]
        out = []
        for c in _CAMPAIGNS:
            cs, ce = _days(c, today)
            if c[5]:
                remaining = round(max(0.0, c[5] - spent[c[0]]), 2)
            else:
                remaining = round(c[4] * 0.4, 2) if c[4] and c[2] == "ACTIVE" else None
            out.append({"platform": PLATFORM, "account_id": ACCOUNT_ID, "campaign_id": c[0], "name": c[1], "status": c[2], "objective": c[3],
                        "daily_budget": c[4], "lifetime_budget": c[5], "budget_remaining": remaining,
                        "start_time": cs.isoformat() + "T00:00:00+0530", "end_time": ce.isoformat() + "T23:59:59+0530" if c[7] is not None else None,
                        "created_time": cs.isoformat() + "T00:00:00+0530", "sample": True, "raw": {"sample": True}})
        return out

    def performance(self, account, start: date, end: date, granularity: str = "daily") -> List[dict]:
        names = {c[0]: (c[1], c[3]) for c in _CAMPAIGNS}
        if granularity == "lifetime":
            start, end = _today() - timedelta(days=400), _today()
        buckets: Dict[tuple, List[dict]] = defaultdict(list)
        for r in daily(start, end):
            d = date.fromisoformat(r["date"])
            key = {"daily": r["date"], "monthly": d.strftime("%Y-%m"), "quarterly": C.fy_quarter(d)[0]}.get(granularity, granularity)
            buckets[(r["campaign_id"], key)].append(r)
        out = []
        for (cid, key), xs in buckets.items():
            spend = round(sum(x["spend"] for x in xs), 2)
            imps = sum(x["impressions"] for x in xs)
            clicks = sum(x["clicks"] for x in xs)
            conv = round(sum(x["conversions"] for x in xs), 1)
            out.append({"platform": PLATFORM, "account_id": ACCOUNT_ID, "campaign_id": cid, "campaign_name": names[cid][0], "objective": names[cid][1],
                        "granularity": granularity, "period": None if granularity == "daily" else key,
                        "date_start": min(x["date"] for x in xs), "date_stop": max(x["date"] for x in xs),
                        "spend": spend, "impressions": float(imps), "reach": None, "clicks": float(clicks),
                        "ctr_pct": C.ratio(clicks, imps, 100), "cpc": C.ratio(spend, clicks), "cpm": C.ratio(spend, imps, 1000), "frequency": None,
                        "results": conv, "results_basis": "conversions", "cost_per_result": C.ratio(spend, conv), "conversions": conv,
                        "sample": True, "raw": {"sample": True}})
        return sorted(out, key=lambda r: (r["date_start"], r["campaign_id"]))


def stamp() -> str:
    return datetime.now().isoformat(timespec="seconds")
