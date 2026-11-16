"""Google Ads: read-only reporting through the Google Ads REST API (GAQL).

Credentials come from backend/.env (GOOGLE_ADS_DEVELOPER_TOKEN, _CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN and, optionally,
_CUSTOMER_ID / _LOGIN_CUSTOMER_ID). Tokens travel in headers or the request body, never a URL, and every message that
leaves this module is scrubbed of them. Every record keeps the platform's original response under "raw".
"""
from __future__ import annotations

import time
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import Settings
from . import common as C

PLATFORM = "google"
ADS = "https://googleads.googleapis.com"
TOKEN_URL = "https://oauth2.googleapis.com/token"

# friendly causes for the errors people actually hit
_HINTS = {
    "DEVELOPER_TOKEN_NOT_APPROVED": "The developer token only has test access. Apply for Basic access in the manager account's API Center.",
    "DEVELOPER_TOKEN_PROHIBITED": "This developer token is not allowed to call the API from here. Check it in the API Center.",
    "USER_PERMISSION_DENIED": "The signed-in Google user has no access to this account. Set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager account, or share the account with that user.",
    "CUSTOMER_NOT_ENABLED": "That Google Ads account is not active.",
    "NOT_ADS_USER": "The Google login used for the refresh token has no Google Ads account.",
    "OAUTH_TOKEN_INVALID": "The Google OAuth token is invalid.",
    "INVALID_CUSTOMER_ID": "A customer ID is not valid: use the 10 digits without dashes.",
}


class GoogleAds:
    mode = "live"

    def __init__(self, settings: Settings):
        self.s = settings
        self.version = settings.GOOGLE_ADS_API_VERSION.strip() or "v21"
        self._access: Optional[str] = None
        self._expires = 0.0

    # ------------------------------------------------------------ config
    def _secrets(self) -> List[str]:
        s = self.s
        return [s.GOOGLE_ADS_DEVELOPER_TOKEN, s.GOOGLE_ADS_CLIENT_SECRET, s.GOOGLE_ADS_REFRESH_TOKEN, s.GOOGLE_ADS_CLIENT_ID, self._access or ""]

    def missing(self) -> List[str]:
        s = self.s
        return [n for n, v in (("GOOGLE_ADS_DEVELOPER_TOKEN", s.GOOGLE_ADS_DEVELOPER_TOKEN), ("GOOGLE_ADS_CLIENT_ID", s.GOOGLE_ADS_CLIENT_ID),
                               ("GOOGLE_ADS_CLIENT_SECRET", s.GOOGLE_ADS_CLIENT_SECRET), ("GOOGLE_ADS_REFRESH_TOKEN", s.GOOGLE_ADS_REFRESH_TOKEN)) if not v.strip()]

    def configured(self) -> bool:
        return not self.missing()

    @staticmethod
    def _digits(v: str) -> str:
        return "".join(ch for ch in v if ch.isdigit())

    def customer_ids(self) -> List[str]:
        return [self._digits(x) for x in self.s.GOOGLE_ADS_CUSTOMER_ID.split(",") if self._digits(x)]

    # ------------------------------------------------------------ auth + HTTP
    def _token(self) -> str:
        if self._access and time.time() < self._expires - 60:
            return self._access
        if not self.configured():
            raise C.AdsNotConfigured("Google Ads is not configured: missing " + ", ".join(self.missing()) + " in backend/.env.")
        r = C.call("POST", TOKEN_URL, platform="Google", secrets=self._secrets(),
                   data={"client_id": self.s.GOOGLE_ADS_CLIENT_ID, "client_secret": self.s.GOOGLE_ADS_CLIENT_SECRET,
                         "refresh_token": self.s.GOOGLE_ADS_REFRESH_TOKEN, "grant_type": "refresh_token"})
        body = r.json() if r.content else {}
        if r.status_code != 200 or "access_token" not in body:
            err = body.get("error", "")
            hint = ("The Google refresh token was revoked or has expired. If the OAuth app is still in 'Testing' mode, tokens expire after 7 days: "
                    "publish the app and create a new refresh token.") if err == "invalid_grant" else \
                   "The Google client ID or secret is wrong." if err in ("invalid_client", "unauthorized_client") else "Google refused the sign-in."
            raise C.AdsAuthError(hint, {"google_error": err})
        self._access, self._expires = body["access_token"], time.time() + float(body.get("expires_in", 3600))
        return self._access

    def _headers(self, login: Optional[str]) -> dict:
        h = {"Authorization": f"Bearer {self._token()}", "developer-token": self.s.GOOGLE_ADS_DEVELOPER_TOKEN.strip()}
        lc = login or self._digits(self.s.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
        if lc:
            h["login-customer-id"] = lc
        return h

    def _request(self, method: str, path: str, login: Optional[str], body: Optional[dict] = None) -> dict:
        url = f"{ADS}/{self.version}/{path.lstrip('/')}"
        for attempt in (0, 1):
            r = C.call(method, url, platform="Google", secrets=self._secrets(), headers=self._headers(login), json_body=body)
            if r.status_code == 401 and attempt == 0:  # the cached access token expired early: get a new one once
                self._access = None
                continue
            break
        try:
            data = r.json()
        except ValueError:
            raise C.AdsApiError(f"Google Ads returned an unreadable response (HTTP {r.status_code}).")
        if r.status_code >= 400:
            self._raise(data, r.status_code)
        return data

    def _raise(self, data: Any, status: int):
        e = (data[0] if isinstance(data, list) and data else data).get("error", {}) if isinstance(data, (dict, list)) else {}
        names = []
        for d in e.get("details", []):
            for x in d.get("errors", []):
                names += [str(v) for v in (x.get("errorCode") or {}).values()]
        msg = C.redact(e.get("message", "unknown error"), self._secrets())
        hint = next((_HINTS[n] for n in names if n in _HINTS), None)
        if status == 401 or any(n in ("AUTHENTICATION_ERROR", "OAUTH_TOKEN_INVALID", "OAUTH_TOKEN_EXPIRED") for n in names):
            raise C.AdsAuthError(hint or "Google rejected the credentials. " + msg, {"google_errors": names})
        if status == 403 or e.get("status") == "PERMISSION_DENIED":
            raise C.AdsPermissionError(hint or "Google Ads denied access: " + msg, {"google_errors": names})
        raise C.AdsApiError(hint or f"Google Ads API error: {msg}", {"google_errors": names, "http_status": status})

    def _query(self, customer_id: str, gaql: str, login: Optional[str] = None) -> List[dict]:
        """GAQL with nextPageToken pagination."""
        rows: List[dict] = []
        token = None
        for _ in range(2000):
            body: Dict[str, Any] = {"query": gaql, "pageSize": 10000}
            if token:
                body["pageToken"] = token
            data = self._request("POST", f"customers/{customer_id}/googleAds:search", login, body)
            rows += data.get("results", [])
            token = data.get("nextPageToken")
            if not token:
                break
        return rows

    # ------------------------------------------------------------ accounts
    def accounts(self) -> List[dict]:
        """Every client account reachable with this login (managers are expanded into their client accounts)."""
        seeds = self.customer_ids()
        if not seeds:
            data = self._request("GET", "customers:listAccessibleCustomers", None)
            seeds = [n.split("/")[-1] for n in data.get("resourceNames", [])]
        out: Dict[str, dict] = {}
        for cid in seeds:
            try:
                me = self._query(cid, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, "
                                      "customer.test_account, customer.status FROM customer")
            except (C.AdsPermissionError, C.AdsApiError) as exc:
                out.setdefault(cid, {"platform": PLATFORM, "account_id": cid, "accessible": False, "error": exc.message})
                continue
            c = me[0]["customer"] if me else {}
            if c.get("manager"):
                kids = self._query(cid, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, "
                                        "customer_client.time_zone, customer_client.manager, customer_client.test_account, customer_client.status, "
                                        "customer_client.level FROM customer_client WHERE customer_client.level <= 3", login=cid)
                for k in kids:
                    kc = k["customerClient"]
                    if not kc.get("manager"):
                        out[str(kc["id"])] = self._acct(kc, login=cid, raw=k)
                out.setdefault(cid, dict(self._acct(c, login=None, raw=me[0]), is_manager=True))
            else:
                out[str(c.get("id", cid))] = self._acct(c, login=self._digits(self.s.GOOGLE_ADS_LOGIN_CUSTOMER_ID) or None, raw=me[0] if me else {})
        return list(out.values())

    @staticmethod
    def _acct(c: dict, login: Optional[str], raw: dict) -> dict:
        return {"platform": PLATFORM, "account_id": str(c.get("id")), "login_customer_id": login, "name": c.get("descriptiveName"),
                "currency": c.get("currencyCode"), "timezone": c.get("timeZone"), "status": c.get("status"), "is_manager": bool(c.get("manager")),
                "test_account": bool(c.get("testAccount")), "accessible": True,
                # the Meta account fields, so both platforms give the same record (Google's customer resource has no such values)
                "created_time": None, "amount_spent_lifetime": None, "business_name": None, "raw": raw}

    def _account(self, account) -> dict:
        """Meta's functions take an account ID; Google's take that or a record from accounts() (which knows its manager login)."""
        if isinstance(account, dict):
            return account
        return {"account_id": self._digits(str(account)), "login_customer_id": self._digits(self.s.GOOGLE_ADS_LOGIN_CUSTOMER_ID) or None}

    # ------------------------------------------------------------ campaigns
    def campaigns(self, account) -> List[dict]:
        account = self._account(account)
        cid, login = account["account_id"], account.get("login_customer_id")
        rows = self._query(cid, (
            "SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, "
            "campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, "
            "campaign.start_date, campaign.end_date, campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, "
            "campaign_budget.total_amount_micros, campaign_budget.period, campaign_budget.delivery_method, campaign_budget.explicitly_shared, "
            "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, "
            "metrics.conversions, metrics.cost_per_conversion, metrics.all_conversions, metrics.conversions_value "
            "FROM campaign ORDER BY campaign.id"), login)
        out = []
        for r in rows:
            c, b, m = r.get("campaign", {}), r.get("campaignBudget", {}), r.get("metrics", {})
            cost = _micros(m.get("costMicros"))
            conv = C.num(m.get("conversions"))
            out.append({"platform": PLATFORM, "account_id": cid, "campaign_id": str(c.get("id")), "name": c.get("name"), "status": c.get("status"),
                        "serving_status": c.get("servingStatus"), "primary_status": c.get("primaryStatus"),
                        "campaign_type": c.get("advertisingChannelType"), "campaign_subtype": c.get("advertisingChannelSubType"),
                        "bidding_strategy": c.get("biddingStrategyType"), "objective": None,  # Google Ads has no campaign objective field
                        "daily_budget": _micros(b.get("amountMicros")) if b.get("period", "DAILY") == "DAILY" else None,
                        "lifetime_budget": _micros(b.get("totalAmountMicros")), "budget_period": b.get("period"),
                        "budget_name": b.get("name"), "start_date": c.get("startDate"), "end_date": c.get("endDate"),
                        "lifetime_spend": cost, "lifetime_impressions": C.num(m.get("impressions")), "lifetime_clicks": C.num(m.get("clicks")),
                        "lifetime_conversions": conv, "lifetime_cost_per_conversion": C.ratio(cost, conv),
                        # the Meta campaign fields, so both platforms give the same record
                        "budget_remaining": round(_micros(b.get("totalAmountMicros")) - (cost or 0), 2) if _micros(b.get("totalAmountMicros")) else None,
                        "start_time": c.get("startDate"), "end_time": c.get("endDate"), "created_time": None, "raw": r})
        return out

    # ------------------------------------------------------------ performance
    def performance(self, account, start: date, end: date, granularity: str = "daily", level: str = "campaign") -> List[dict]:
        """Daily rows come straight from the API; monthly / quarterly / custom are summed from them (cost, clicks,
        impressions and conversions add up exactly; CTR, CPC, CPM and cost per conversion are recomputed)."""
        if level != "campaign":
            raise C.AdsApiError("Google Ads performance is available per campaign only (level='campaign').")
        account = self._account(account)
        cid = account["account_id"]
        if granularity == "lifetime":
            return [dict(r, granularity="lifetime") for r in self._lifetime(self.campaigns(account))]
        daily = self._daily_rows(account, start, end)
        if granularity == "daily":
            return [self._shape(cid, x, "daily", x["date"], x["date"], x["date"]) for x in daily]
        buckets: Dict[tuple, List[dict]] = defaultdict(list)
        for x in daily:
            d = date.fromisoformat(x["date"])
            if granularity == "monthly":
                key = (x["campaign_id"], d.strftime("%Y-%m"))
            elif granularity == "quarterly":
                key = (x["campaign_id"], C.fy_quarter(d)[0])
            else:
                key = (x["campaign_id"], "custom")
            buckets[key].append(x)
        out = []
        for (_, label), xs in buckets.items():
            first = dict(xs[0], cost=sum(v["cost"] for v in xs), impressions=sum(v["impressions"] for v in xs), clicks=sum(v["clicks"] for v in xs),
                         conversions=sum(v["conversions"] for v in xs), conversions_value=sum(v["conversions_value"] for v in xs),
                         raw=[v["raw"] for v in xs])
            out.append(self._shape(cid, first, granularity, label if granularity != "custom" else None, min(v["date"] for v in xs), max(v["date"] for v in xs)))
        return sorted(out, key=lambda r: (r["date_start"], r["campaign_id"]))

    def _daily_rows(self, account: dict, start: date, end: date) -> List[dict]:
        """One row per campaign and day: campaign_id, campaign_name, campaign_type, date, cost, impressions, clicks, conversions,
        conversions_value, raw."""
        cid, login = account["account_id"], account.get("login_customer_id")
        rows = self._query(cid, (
            "SELECT campaign.id, campaign.name, campaign.advertising_channel_type, segments.date, metrics.cost_micros, metrics.impressions, "
            "metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.cost_per_conversion, "
            "metrics.all_conversions, metrics.conversions_value "
            f"FROM campaign WHERE segments.date BETWEEN '{start}' AND '{end}' ORDER BY segments.date, campaign.id"), login)
        daily = []
        for r in rows:
            c, m, d = r.get("campaign", {}), r.get("metrics", {}), r.get("segments", {}).get("date")
            daily.append({"campaign_id": str(c.get("id")), "campaign_name": c.get("name"), "campaign_type": c.get("advertisingChannelType"),
                          "date": d, "cost": _micros(m.get("costMicros")) or 0.0, "impressions": C.num(m.get("impressions")) or 0.0,
                          "clicks": C.num(m.get("clicks")) or 0.0, "conversions": C.num(m.get("conversions")) or 0.0,
                          "conversions_value": C.num(m.get("conversionsValue")) or 0.0, "raw": r})
        return daily

    def lead_conversions(self, account, start: date, end: date, action: str):
        """{(campaign_id, 'YYYY-MM-DD'): conversions} of the conversion action named `action` (any case); its All conversions
        when Google does not count it under Conversions (a secondary action)."""
        account = self._account(account)
        rows = self._query(account["account_id"], (
            "SELECT campaign.id, segments.date, segments.conversion_action_name, metrics.conversions, metrics.all_conversions "
            f"FROM campaign WHERE segments.date BETWEEN '{start}' AND '{end}'"), account.get("login_customer_id"))
        want = action.strip().lower()
        mine = [r for r in rows if str(r.get("segments", {}).get("conversionActionName", "")).strip().lower() == want]
        key = "conversions" if sum(C.num(r.get("metrics", {}).get("conversions")) or 0 for r in mine) > 0 else "allConversions"
        out = {}
        for r in mine:
            k = (str(r.get("campaign", {}).get("id")), r.get("segments", {}).get("date"))
            out[k] = out.get(k, 0.0) + (C.num(r.get("metrics", {}).get(key)) or 0.0)
        return out

    def _lifetime(self, rows):
        return [{"platform": PLATFORM, "account_id": c["account_id"], "campaign_id": c["campaign_id"], "campaign_name": c["name"],
                 "campaign_type": c["campaign_type"], "spend": c["lifetime_spend"], "impressions": c["lifetime_impressions"],
                 "clicks": c["lifetime_clicks"], "conversions": c["lifetime_conversions"], "cost_per_conversion": c["lifetime_cost_per_conversion"],
                 "ctr_pct": C.ratio(c["lifetime_clicks"], c["lifetime_impressions"], 100), "cpc": C.ratio(c["lifetime_spend"], c["lifetime_clicks"]),
                 "cpm": C.ratio(c["lifetime_spend"], c["lifetime_impressions"], 1000), "reach": None,
                 "objective": c["campaign_type"], "period": None, "date_start": None, "date_stop": None, "frequency": None,
                 "results": c["lifetime_conversions"], "results_basis": "conversions", "cost_per_result": c["lifetime_cost_per_conversion"],
                 "raw": c["raw"]} for c in rows]

    @staticmethod
    def _shape(cid: str, x: dict, granularity: str, period: Optional[str], a: str, b: str) -> dict:
        return {"platform": PLATFORM, "account_id": cid, "campaign_id": x["campaign_id"], "campaign_name": x["campaign_name"],
                "campaign_type": x["campaign_type"], "granularity": granularity, "period": period, "date_start": a, "date_stop": b,
                "spend": round(x["cost"], 2), "impressions": x["impressions"], "clicks": x["clicks"], "reach": None,
                "ctr_pct": C.ratio(x["clicks"], x["impressions"], 100), "cpc": C.ratio(x["cost"], x["clicks"]),
                "cpm": C.ratio(x["cost"], x["impressions"], 1000), "conversions": x["conversions"],
                "cost_per_conversion": C.ratio(x["cost"], x["conversions"]), "conversions_value": x["conversions_value"],
                # the Meta performance fields: Google has no "results", its conversions play that part; no frequency without reach
                "objective": x["campaign_type"], "frequency": None, "results": x["conversions"], "results_basis": "conversions",
                "cost_per_result": C.ratio(x["cost"], x["conversions"]), "raw": x["raw"]}


def _micros(v: Any) -> Optional[float]:
    n = C.num(v)
    return None if n is None else round(n / 1_000_000.0, 2)
