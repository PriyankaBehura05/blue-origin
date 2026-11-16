"""Meta (Facebook / Instagram) Ads: read-only reporting through the Graph API (Marketing API).

Credentials come from backend/.env (META_ACCESS_TOKEN, META_AD_ACCOUNT_IDS). The token is sent in the Authorization
header, never in a URL, and every message that leaves this module is scrubbed of it. Every record keeps the platform's
original fields under "raw"; the plain-named numbers next to it are only a convenience.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import Settings
from . import common as C

PLATFORM = "meta"
GRAPH = "https://graph.facebook.com"
# Meta only keeps insights for the last 37 months
MAX_HISTORY_DAYS = 37 * 30

ACCOUNT_FIELDS = ("id,account_id,name,account_status,disable_reason,currency,timezone_name,created_time,amount_spent,balance,"
                  "spend_cap,business_name,business_country_code,age,funding_source_details,min_daily_budget")
CAMPAIGN_FIELDS = ("id,name,status,effective_status,configured_status,objective,buying_type,bid_strategy,daily_budget,lifetime_budget,"
                   "budget_remaining,spend_cap,start_time,stop_time,created_time,updated_time,special_ad_categories,"
                   "is_budget_schedule_enabled,source_campaign_id")
ADSET_FIELDS = ("id,name,campaign_id,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,"
                "bid_amount,bid_strategy,billing_event,optimization_goal,start_time,end_time,created_time,updated_time,"
                "destination_type,daily_min_spend_target,daily_spend_cap")
INSIGHT_FIELDS = ("account_id,account_name,campaign_id,campaign_name,objective,spend,impressions,reach,frequency,clicks,"
                  "inline_link_clicks,ctr,cpc,cpm,cpp,actions,action_values,cost_per_action_type,date_start,date_stop")
# DELETED is not accepted by the campaigns edge (deleted campaigns still show in Insights)
STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"]

# Meta has no single "results" number in the Insights API: it depends on the campaign objective. This maps the
# objective to the action that counts as a result (first one present wins). The raw actions are always kept.
RESULT_ACTIONS = {
    "OUTCOME_LEADS": ["onsite_conversion.lead_grouped", "lead", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"],
    "LEAD_GENERATION": ["onsite_conversion.lead_grouped", "lead", "offsite_conversion.fb_pixel_lead"],
    "OUTCOME_TRAFFIC": ["link_click", "landing_page_view"],
    "LINK_CLICKS": ["link_click", "landing_page_view"],
    "OUTCOME_ENGAGEMENT": ["post_engagement", "page_engagement"],
    "POST_ENGAGEMENT": ["post_engagement"],
    "OUTCOME_SALES": ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase"],
    "CONVERSIONS": ["offsite_conversion.fb_pixel_purchase", "omni_purchase", "lead"],
    "OUTCOME_APP_PROMOTION": ["mobile_app_install", "app_install"],
    "MESSAGES": ["onsite_conversion.messaging_conversation_started_7d"],
}


class MetaAds:
    def __init__(self, settings: Settings):
        self.s = settings
        self.token = settings.META_ACCESS_TOKEN.strip()
        self.version = settings.META_API_VERSION.strip() or "v23.0"

    # ------------------------------------------------------------ config
    def configured(self) -> bool:
        return bool(self.token)

    def missing(self) -> List[str]:
        return [] if self.token else ["META_ACCESS_TOKEN"]

    def account_ids(self) -> List[str]:
        return [("act_" + i.strip().replace("act_", "")) for i in self.s.META_AD_ACCOUNT_IDS.split(",") if i.strip()]

    # ------------------------------------------------------------ HTTP
    def _rate_limited(self, r: httpx.Response) -> bool:
        if r.status_code in (200, 204):
            return False
        try:
            e = r.json().get("error", {})
        except ValueError:
            return False
        return e.get("code") in (4, 17, 32, 341, 613) or 80000 <= int(e.get("code") or 0) <= 80014

    @staticmethod
    def _regain_seconds(r: httpx.Response) -> float:
        """Meta says how long the account must rest (minutes) in x-business-use-case-usage."""
        try:
            usage = json.loads(r.headers.get("x-business-use-case-usage", "{}"))
            return 60.0 * max([float(e.get("estimated_time_to_regain_access", 0)) for v in usage.values() for e in v] or [0])
        except (ValueError, AttributeError, TypeError):
            return 0.0

    def _get(self, path: str, params: Optional[dict] = None) -> dict:
        if not self.configured():
            raise C.AdsNotConfigured("Meta Ads is not configured: META_ACCESS_TOKEN is missing in backend/.env.")
        r = C.call("GET", f"{GRAPH}/{self.version}/{path.lstrip('/')}", platform="Meta", secrets=[self.token],
                   headers={"Authorization": f"Bearer {self.token}"}, params=params, is_rate_limit=self._rate_limited,
                   rate_wait=self._regain_seconds)
        try:
            body = r.json()
        except ValueError:
            raise C.AdsApiError(f"Meta returned an unreadable response (HTTP {r.status_code}).")
        if r.status_code >= 400 or "error" in body:
            self._raise(body.get("error") or {}, r.status_code)
        return body

    def _raise(self, e: dict, status: int):
        code, sub, msg = e.get("code"), e.get("error_subcode"), C.redact(e.get("message", "unknown error"), [self.token])
        if code == 190 or sub in (458, 459, 460, 463, 467):
            raise C.AdsAuthError("Meta rejected the access token (expired, revoked or the password changed). "
                                 "Create a new system-user token and update META_ACCESS_TOKEN.", {"meta_code": code, "meta_subcode": sub})
        if code in (10, 200, 294, 299) or 200 <= int(code or 0) <= 299:
            raise C.AdsPermissionError("The Meta token lacks a permission or access to this ad account "
                                       "(it needs ads_read and the account assigned to the system user). " + msg, {"meta_code": code})
        raise C.AdsApiError(f"Meta API error: {msg}", {"meta_code": code, "meta_subcode": sub, "http_status": status})

    def _pages(self, path: str, params: dict, limit: int = 500, max_pages: int = 400) -> List[dict]:
        """Follows Graph cursors (`after`) so the token never appears in a 'next' URL."""
        rows: List[dict] = []
        p = {**params, "limit": limit}
        for _ in range(max_pages):
            body = self._get(path, p)
            rows += body.get("data", [])
            after = (body.get("paging", {}).get("cursors") or {}).get("after")
            if not body.get("paging", {}).get("next") or not after:
                break
            p = {**params, "limit": limit, "after": after}
        return rows

    # ------------------------------------------------------------ accounts
    def accounts(self) -> List[dict]:
        ids = self.account_ids()
        if not ids:  # every account the token can see
            ids = [a["id"] for a in self._pages("me/adaccounts", {"fields": "id"})]
        out = []
        for i in ids:
            try:
                raw = self._get(i, {"fields": ACCOUNT_FIELDS})
                out.append({"platform": PLATFORM, "account_id": raw.get("id", i), "name": raw.get("name"), "currency": raw.get("currency"),
                            "timezone": raw.get("timezone_name"), "status": _ACCOUNT_STATUS.get(raw.get("account_status"), raw.get("account_status")),
                            "created_time": raw.get("created_time"), "amount_spent_lifetime": _money(raw.get("amount_spent")),
                            "business_name": raw.get("business_name"), "accessible": True, "raw": raw})
            except (C.AdsPermissionError, C.AdsApiError) as exc:
                out.append({"platform": PLATFORM, "account_id": i, "accessible": False, "error": exc.message})
        return out

    # ------------------------------------------------------------ campaigns / ad sets
    def campaigns(self, account_id: str) -> List[dict]:
        rows = self._pages(f"{account_id}/campaigns", {"fields": CAMPAIGN_FIELDS, "effective_status": json.dumps(STATUSES)})
        return [{"platform": PLATFORM, "account_id": account_id, "campaign_id": r.get("id"), "name": r.get("name"),
                 "status": r.get("effective_status") or r.get("status"), "objective": r.get("objective"),
                 "daily_budget": _money(r.get("daily_budget")), "lifetime_budget": _money(r.get("lifetime_budget")),
                 "budget_remaining": _money(r.get("budget_remaining")), "start_time": r.get("start_time"), "end_time": r.get("stop_time"),
                 "created_time": r.get("created_time"), "raw": r} for r in rows]

    def adsets(self, account_id: str, campaign_ids: Optional[List[str]] = None) -> List[dict]:
        """Ad sets of the account; with campaign_ids only those campaigns' (one small request each instead of every ad set of
        the account, which is thousands of rows and a lot of the API's rate limit)."""
        paths = [f"{account_id}/adsets"] if not campaign_ids else [f"{cid}/adsets" for cid in campaign_ids]
        found: Dict[str, dict] = {}
        for path in paths:
            for r in self._pages(path, {"fields": ADSET_FIELDS, "effective_status": json.dumps(STATUSES)}):
                found[str(r.get("id"))] = r
        rows = list(found.values())
        return [{"platform": PLATFORM, "account_id": account_id, "adset_id": r.get("id"), "campaign_id": r.get("campaign_id"), "name": r.get("name"),
                 "status": r.get("effective_status") or r.get("status"), "daily_budget": _money(r.get("daily_budget")),
                 "lifetime_budget": _money(r.get("lifetime_budget")), "budget_remaining": _money(r.get("budget_remaining")),
                 "optimization_goal": r.get("optimization_goal"), "billing_event": r.get("billing_event"),
                 "start_time": r.get("start_time"), "end_time": r.get("end_time"), "raw": r} for r in rows]

    # ------------------------------------------------------------ performance
    def history_start(self, account: dict, campaigns: List[dict]) -> date:
        """Earliest date worth asking for: the oldest campaign / the account creation, but never beyond Meta's 37 months."""
        firsts = [c["created_time"][:10] for c in campaigns if c.get("created_time")] + ([account["created_time"][:10]] if account.get("created_time") else [])
        floor = date.today() - timedelta(days=MAX_HISTORY_DAYS)
        return max(date.fromisoformat(min(firsts)) if firsts else floor, floor)

    def performance(self, account_id: str, start: date, end: date, granularity: str = "daily", level: str = "campaign") -> List[dict]:
        """granularity: daily | monthly | quarterly | custom (one row per campaign for the whole range) | lifetime."""
        base = {"fields": INSIGHT_FIELDS, "level": level}
        if granularity == "lifetime":
            return self._shape(self._pages(f"{account_id}/insights", {**base, "date_preset": "maximum"}), "lifetime")
        rows: List[dict] = []
        if granularity == "daily":
            for _, a, b in C.windows(start, end, "chunk"):
                rows += self._pages(f"{account_id}/insights", {**base, "time_increment": 1, "time_range": _rng(a, b)})
        elif granularity == "monthly":
            for _, a, b in C.windows(start, end, "monthly"):
                rows += self._pages(f"{account_id}/insights", {**base, "time_range": _rng(a, b)})
        elif granularity == "quarterly":
            for label, a, b in C.windows(start, end, "quarterly"):
                rows += [dict(r, _period=label) for r in self._pages(f"{account_id}/insights", {**base, "time_range": _rng(a, b)})]
        else:
            rows = self._pages(f"{account_id}/insights", {**base, "time_range": _rng(start, end)})
        return self._shape(rows, granularity)

    def spend_series(self, account_id: str, start: date, end: date, increment: Any) -> List[dict]:
        """Spend only, per campaign, in one paged request: increment 'monthly' or 1 (daily). Used by the budget screen."""
        rows = self._pages(f"{account_id}/insights", {"fields": "campaign_id,campaign_name,spend,date_start,date_stop", "level": "campaign",
                                                         "time_increment": increment, "time_range": _rng(start, end)})
        return [{"campaign_id": r.get("campaign_id"), "campaign_name": r.get("campaign_name"), "date_start": r.get("date_start"),
                 "spend": C.num(r.get("spend")) or 0.0} for r in rows]

    def _shape(self, rows: List[dict], granularity: str) -> List[dict]:
        out = []
        for r in rows:
            spend = C.num(r.get("spend"))
            results, basis = self._results(r)
            out.append({"platform": PLATFORM, "account_id": "act_" + str(r.get("account_id", "")).replace("act_", ""),
                        "campaign_id": r.get("campaign_id"), "campaign_name": r.get("campaign_name"), "objective": r.get("objective"),
                        "granularity": granularity, "period": r.get("_period"), "date_start": r.get("date_start"), "date_stop": r.get("date_stop"),
                        "spend": spend, "impressions": C.num(r.get("impressions")), "reach": C.num(r.get("reach")), "clicks": C.num(r.get("clicks")),
                        "ctr_pct": C.num(r.get("ctr")), "cpc": C.num(r.get("cpc")), "cpm": C.num(r.get("cpm")), "frequency": C.num(r.get("frequency")),
                        "results": results, "results_basis": basis, "cost_per_result": C.ratio(spend, results),
                        "conversions": _action_total(r.get("actions"), ("offsite_conversion.fb_pixel_purchase", "omni_purchase", "lead", "onsite_conversion.lead_grouped")),
                        "raw": r})
        return out

    def _results(self, r: dict):
        for a in RESULT_ACTIONS.get(r.get("objective") or "", []):
            v = _action_total(r.get("actions"), (a,))
            if v is not None:
                return v, a
        return None, None


_ACCOUNT_STATUS = {1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 8: "PENDING_SETTLEMENT", 9: "IN_GRACE_PERIOD",
                   100: "PENDING_CLOSURE", 101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED"}


def _rng(a: date, b: date) -> str:
    return json.dumps({"since": a.isoformat(), "until": b.isoformat()})


def _money(v: Any) -> Optional[float]:
    """Graph returns budgets and balances in the currency's minor unit (paise for INR) as strings; spend is already in rupees."""
    n = C.num(v)
    return None if n is None else round(n / 100.0, 2)


def _action_total(actions: Optional[List[dict]], types) -> Optional[float]:
    for t in types:
        for a in actions or []:
            if a.get("action_type") == t:
                return C.num(a.get("value"))
    return None
