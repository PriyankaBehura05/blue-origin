"""Google Ads through a Google Sheet (GOOGLE_ADS_MODE=sheet): real figures with no API credentials.

The Google Ads script in backend/docs/google_ads_to_sheet.js runs inside the Google Ads account every hour and writes three
tabs to a sheet of its own (never the lead sheet): Ads_Info, Ads_Campaigns and Ads_Daily. This module reads that sheet with
the same reader as the lead sheets (the BO service account, or a sheet shared "anyone with the link") and gives the same
records as the live connector, so budgets, spend, CPL and ROAS treat it exactly like the Google Ads API. Read-only.
"""
from __future__ import annotations

import time
from datetime import date
from typing import Dict, List, Optional

from app.core.config import Settings
from app.leads.services import sheets_source as sheets
from . import common as C
from .google_ads import GoogleAds

TABS = ("Ads_Info", "Ads_Campaigns", "Ads_Daily")
EXTRA_TABS = {"keywords": "Ads_Keywords", "search_terms": "Ads_SearchTerms", "devices": "Ads_Devices", "geo": "Ads_Geo",
              "conversions": "Ads_Conversions"}   # written by the newer script; a tab that is absent = not available
OPTIONAL_TABS = tuple(EXTRA_TABS.values())
SOURCE = "Google Ads script sheet"


def _num(v) -> float:
    return C.num(str(v).replace(",", "")) or 0.0


class GoogleAdsSheet(GoogleAds):
    mode = "sheet"

    def __init__(self, settings: Settings):
        super().__init__(settings)
        self.version = "sheet"
        self._cache: Optional[tuple] = None

    # ------------------------------------------------------------ config
    def missing(self) -> List[str]:
        return [] if self.s.GOOGLE_ADS_SHEET_URL.strip() else ["GOOGLE_ADS_SHEET_URL"]

    def customer_ids(self) -> List[str]:
        return []

    # ------------------------------------------------------------ the sheet
    def _tabs(self) -> Dict[str, List[dict]]:
        """The three tabs as lists of dicts (header row = keys). Kept for a minute, so one budget build reads the sheet once."""
        if self._cache and time.time() - self._cache[0] < 60:
            return self._cache[1]
        url = self.s.GOOGLE_ADS_SHEET_URL.strip()
        if not url:
            raise C.AdsNotConfigured("Google Ads (sheet mode) needs GOOGLE_ADS_SHEET_URL in backend/.env: the sheet the Google Ads script fills.")
        reader, email = sheets.make_reader(self.s)
        try:
            _, tabs = reader.tabs(sheets.sheet_id(url), None)
        except Exception as exc:  # sharing, a wrong link, Google errors
            share = f"share it with {email} as a viewer" if email else 'share it as "Anyone with the link can view"'
            raise C.AdsPermissionError(f"Could not read the Google Ads sheet: {C.redact(exc)}. Check the link in GOOGLE_ADS_SHEET_URL and {share}.")
        by_name = {name.strip(): rows for name, rows in tabs}
        out: Dict[str, List[dict]] = {}
        for t in TABS:
            rows = by_name.get(t)
            if not rows:
                raise C.AdsApiError(f"The Google Ads sheet has no '{t}' tab yet. Has the Google Ads script run? (backend/docs/google_ads_to_sheet.js)")
            head = [h.strip() for h in rows[0]]
            out[t] = [dict(zip(head, r)) for r in rows[1:] if any(str(v).strip() for v in r)]
        for t in OPTIONAL_TABS:
            rows = by_name.get(t)
            if rows:
                head = [h.strip() for h in rows[0]]
                out[t] = [dict(zip(head, r)) for r in rows[1:] if any(str(v).strip() for v in r)]
        self._cache = (time.time(), out)
        return out

    def _info(self) -> Dict[str, str]:
        return {r.get("key", ""): r.get("value", "") for r in self._tabs()["Ads_Info"]}

    # ------------------------------------------------------------ the same records as the live connector
    def accounts(self) -> List[dict]:
        info = self._info()
        spent = sum(_num(r.get("lifetime_cost")) for r in self._tabs()["Ads_Campaigns"])
        return [{"platform": "google", "account_id": self._digits(info.get("customer_id", "")) or "google-sheet", "login_customer_id": None,
                 "name": info.get("account_name") or None, "currency": info.get("currency") or None, "timezone": info.get("time_zone") or None,
                 "status": "ENABLED", "is_manager": False, "test_account": False, "accessible": True,
                 "created_time": None, "amount_spent_lifetime": round(spent, 2), "business_name": None,
                 "source": SOURCE, "sheet_updated_at": info.get("updated_at") or None, "raw": info}]

    def campaigns(self, account=None) -> List[dict]:
        acct = self._account(account) if account is not None else {"account_id": self.accounts()[0]["account_id"]}
        out = []
        for r in self._tabs()["Ads_Campaigns"]:
            period = (r.get("budget_period") or "").upper()
            amount = _num(r.get("budget_amount")) or None
            total = _num(r.get("budget_total_amount")) or None
            cost = _num(r.get("lifetime_cost"))
            conv = _num(r.get("lifetime_conversions"))
            out.append({"platform": "google", "account_id": acct["account_id"], "campaign_id": str(r.get("campaign_id", "")).strip(),
                        "name": r.get("campaign_name"), "status": (r.get("status") or "").upper() or None,
                        "serving_status": (r.get("serving_status") or "").upper() or None, "primary_status": None, "campaign_type": r.get("channel_type") or None, "campaign_subtype": None,
                        "bidding_strategy": None, "objective": None,
                        "daily_budget": amount if period in ("DAILY", "") else None, "lifetime_budget": total, "budget_period": period or None,
                        "budget_name": None, "start_date": None, "end_date": None,
                        "lifetime_spend": round(cost, 2), "lifetime_impressions": _num(r.get("lifetime_impressions")),
                        "lifetime_clicks": _num(r.get("lifetime_clicks")), "lifetime_conversions": conv,
                        "lifetime_cost_per_conversion": C.ratio(cost, conv),
                        "budget_remaining": round(total - cost, 2) if total else None, "start_time": None, "end_time": None, "created_time": None,
                        "raw": {"campaignBudget": {"explicitlyShared": str(r.get("budget_shared", "")).strip().lower() == "true"}, "sheet_row": r}})
        return out

    def _daily_rows(self, account: dict, start: date, end: date) -> List[dict]:
        types = {c["campaign_id"]: c["campaign_type"] for c in self.campaigns(account)}
        out = []
        for r in self._tabs()["Ads_Daily"]:
            d = (r.get("date") or "").strip()[:10]
            if not d or not (start.isoformat() <= d <= end.isoformat()):
                continue
            cid = str(r.get("campaign_id", "")).strip()
            out.append({"campaign_id": cid, "campaign_name": r.get("campaign_name"), "campaign_type": types.get(cid), "date": d,
                        "cost": _num(r.get("cost")), "impressions": _num(r.get("impressions")), "clicks": _num(r.get("clicks")),
                        "conversions": _num(r.get("conversions")), "conversions_value": 0.0, "raw": r})
        return sorted(out, key=lambda x: (x["date"], x["campaign_id"]))


    def lead_conversions(self, account, start: date, end: date, action: str):
        """{(campaign_id, 'YYYY-MM-DD'): conversions} of the conversion action named `action` (any case), or None when the
        sheet has no Ads_Conversions tab. Uses the action's Conversions; if Google counts it only under All conversions (a
        secondary action), All conversions."""
        rows = self._tabs().get("Ads_Conversions")
        if rows is None:
            return None
        want = action.strip().lower()
        mine = [r for r in rows if str(r.get("conversion_action", "")).strip().lower() == want
                and start.isoformat() <= str(r.get("date", ""))[:10] <= end.isoformat()]
        key = "conversions" if sum(_num(r.get("conversions")) for r in mine) > 0 else "all_conversions"
        out = {}
        for r in mine:
            k = (str(r.get("campaign_id", "")).strip(), str(r.get("date", ""))[:10])
            out[k] = out.get(k, 0.0) + _num(r.get(key))
        return out

    def detail_tabs(self, keep) -> dict:
        """The detail tabs as rows per month: {key: {available, error, rows}}. `available` False = the script has not written the
        tab (never shown as zero); `error` = why the script could not read it (kept in Ads_Info as <key>_error)."""
        tabs, info = self._tabs(), self._info()
        out = {}
        for key, tab in EXTRA_TABS.items():
            rows = tabs.get(tab)
            err = (info.get(f"{key}_error") or "").strip() or None
            if rows is None:
                out[key] = {"available": False, "error": err, "rows": []}
                continue
            clean = []
            for r in rows:
                if not keep(r.get("campaign_name")):
                    continue
                period = str(r.get("month") or r.get("date") or "")[:7]
                row = {"period": period, "campaign_id": str(r.get("campaign_id", "")).strip(), "campaign_name": r.get("campaign_name")}
                for k in ("ad_group", "keyword", "match_type", "search_term", "status", "device", "region", "conversion_action"):
                    if k in r:
                        row[k] = r[k]
                if key == "conversions":
                    row.update(conversions=_num(r.get("conversions")), all_conversions=_num(r.get("all_conversions")))
                    row.pop("period", None)
                    row["period"] = period
                else:
                    row.update(spend=_num(r.get("cost")), impressions=_num(r.get("impressions")), clicks=_num(r.get("clicks")), conversions=_num(r.get("conversions")))
                clean.append(row)
            out[key] = {"available": True, "error": err, "rows": clean}
        return out
