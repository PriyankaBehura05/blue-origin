"""The dashboard payload: compact column arrays (dimension values stored once, rows refer to them by index) so the
browser can apply every global filter itself. Shape documented in frontend/src/leads/types.ts (keep both in sync)."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Dict, List

import numpy as np
import pandas as pd

from . import normalise as N
from .classify import OUTCOMES, WINDOWS
from .match import LEVELS
from .prep import TIERS

CITY_TIERS = ["Tier 1", "Tier 2", "Tier 3", "Unknown"]
EPOCH = date(1970, 1, 1).toordinal()


class Dim:
    """Distinct values in first-seen order, looked up by a key."""

    def __init__(self, fixed: List[str] | None = None):
        self.values: List[str] = list(fixed or [])
        self.index: Dict[str, int] = {v: i for i, v in enumerate(self.values)}

    def add(self, value: str, key: str | None = None) -> int:
        if not value:
            return -1
        k = key if key is not None else value
        if k not in self.index:
            self.index[k] = len(self.values)
            self.values.append(value)
        return self.index[k]


def _f(x) -> float:
    return round(float(x), 2)


def build_payload(sales, leads: pd.DataFrame, spend: pd.DataFrame, follow: pd.DataFrame, targets: dict,
                  targets_from_file: List[str], files: list, steps: list, gaps: List[str], assumptions: List[str]) -> dict:
    lead_months = [N.month_int(d) for d in leads["date"]] if len(leads) else []
    spend_months = [int(m) for m in spend["m"].dropna()] if len(spend) else []
    all_m = list(sales.month["m"]) + lead_months + spend_months
    m0, m1 = (min(all_m), max(all_m)) if all_m else (0, 0)
    months = list(range(m0, m1 + 1))
    mquarter = [sales.month_quarter.get(m, N.fy_quarter(m)) for m in months]
    quarters: List[str] = []
    for q in mquarter:
        if q not in quarters:
            quarters.append(q)

    dist, state, city, owner, status = Dim(), Dim(), Dim(), Dim(), Dim()
    campaign, adset = Dim(), Dim()
    r = sales.retailers
    for v in r["Distributor"].str.strip():
        dist.add(v)
    r_state = [state.add(v.strip().title()) for v in r["State"]]
    r_city = [city.add(n, k) for n, k in zip(r["city_name"], r["city_key"])]
    first = {k: int(a[0]) for k, a in sales.active.items() if len(a)}
    last = {k: int(a[-1]) for k, a in sales.active.items() if len(a)}
    retailers = {
        "id": r["Retailer_ID"].tolist(),
        "name": r["Retailer_Name"].str.strip().tolist(),
        "d": [dist.index.get(v.strip(), -1) for v in r["Distributor"]],
        "s": r_state,
        "c": r_city,
        "pin": r["pin"].tolist(),
        "phone": [p[0] if p else "" for p in r["phones"]],
        "tiers": sales.tiers,
        "first": [first[i] - m0 if i in first else -1 for i in range(len(r))],
        "last": [last[i] - m0 if i in last else -1 for i in range(len(r))],
        "life": [_f(v) for v in r["lifetime"]],
    }
    rm = {"r": sales.month["r"].astype(int).tolist(), "m": (sales.month["m"] - m0).astype(int).tolist(),
          "v": [_f(v) for v in sales.month["rev"]]}

    # BO territory: the distributor with the most BO retailers in the lead's pincode, else in its city - the
    # distributor a lead would be billed through when no follow-up log assigns one (read from the BO data only)
    def _top(keys, dists):
        t = pd.DataFrame({"k": keys, "d": dists})
        t = t[(t["k"] != "") & (t["d"] >= 0)]
        if not len(t):
            return {}
        n = t.groupby(["k", "d"]).size().reset_index(name="n").sort_values(["k", "n", "d"], ascending=[True, False, True])
        return dict(zip(*n.drop_duplicates("k")[["k", "d"]].T.to_numpy()))
    by_pin = _top(retailers["pin"], retailers["d"])
    by_city = _top(r["city_key"].tolist(), retailers["d"])

    fol = follow.set_index("mobile") if len(follow) else None
    L: Dict[str, list] = {k: [] for k in ("day", "m", "src", "camp", "adset", "s", "c", "pin", "mob", "name", "valid",
                                          "uniq", "pass", "conf", "rf", "rl", "rc", "o", "gap", "owner", "fdist",
                                          "contact", "status", "called", "visited", "ordered", "ordv", "selfEx",
                                          "zdist")}
    for row in leads.itertuples(index=False):
        L["day"].append(row.date.toordinal() - EPOCH)
        L["m"].append(N.month_int(row.date) - m0)
        L["src"].append(N.SOURCES.index(row.source))
        L["camp"].append(campaign.add(row.campaign))
        L["adset"].append(adset.add(row.adset))
        L["s"].append(state.add(row.state))
        L["c"].append(city.add(row.city_name, row.city_key) if row.city_key else -1)
        L["pin"].append(row.pin)
        L["mob"].append(row.mobile)
        L["name"].append(row.name)
        L["valid"].append(int(row.valid))
        L["uniq"].append(int(row.unique))
        L["pass"].append(int(row.mpass))
        L["conf"].append(int(row.conf))
        L["rf"].append(int(row.r_floor))
        L["rl"].append(int(row.r_likely))
        L["rc"].append(int(row.r_ceiling))
        codes = [getattr(row, f"o_{lv}_{w}") for lv in LEVELS for w in WINDOWS]
        L["o"].append("".join(str(c) for c in codes) if codes[0] >= 0 else "")
        L["gap"].append(int(row.first_gap))
        f = fol.loc[row.mobile] if fol is not None and row.valid and row.mobile in fol.index else None
        # a follow-up log row wins; otherwise the ASM columns of the lead sheet
        L["owner"].append(owner.add(f["owner"] if f is not None and f["owner"] else row.f_owner))
        L["fdist"].append(dist.add(f["distributor"]) if f is not None else -1)
        contact = f["contact"] if f is not None and f["contact"] else None
        L["contact"].append(contact.toordinal() - EPOCH if contact else -1)
        L["status"].append(status.add(f["status"] if f is not None and f["status"] else row.f_cat))
        L["called"].append(1 if contact else int(row.f_called))
        L["visited"].append(int(row.f_visited))
        L["ordered"].append(int(row.f_order))
        L["ordv"].append(_f(row.f_value))
        L["selfEx"].append(int(row.f_self))
        L["zdist"].append(int(by_pin.get(row.pin, by_city.get(row.city_key, -1))) if row.pin or row.city_key else -1)

    sp = {"camp": [], "m": [], "v": []}
    for row in spend.itertuples(index=False):
        sp["camp"].append(campaign.add(row.campaign, row.campaign) if row.campaign not in campaign.index
                          else campaign.index[row.campaign])
        sp["m"].append(int(row.m) - m0 if pd.notna(row.m) else -1)
        sp["v"].append(_f(row.spend))

    end_sales = int(sales.month["m"].max()) if len(sales.month) else m1
    as_of = max([date(end_sales // 12, end_sales % 12 + 1, 28)] + list(leads["date"])) if len(leads) else \
        date(end_sales // 12, end_sales % 12 + 1, 28)
    return {
        "version": 1,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "asOf": as_of.isoformat(),
        "monthStart": m0,
        "months": [N.month_label(m) for m in months],
        "monthQuarter": mquarter,
        "quarters": quarters,
        "tierQuarters": sales.quarters,   # the quarters retailers.tiers characters refer to
        "salesEnd": end_sales - m0,
        "hasLeads": bool(len(leads)),
        "hasSpend": bool(len(spend)),
        "hasFollowup": bool(len(follow)) or (bool(len(leads)) and bool(((leads["f_owner"] != "") | (leads["f_called"] >= 0)).any())),
        "hasContactDates": bool(len(follow)) and bool(follow["contact"].notna().any()),
        "dims": {"dist": dist.values, "state": state.values, "city": city.values,
                 "cityTier": [CITY_TIERS.index(N.city_tier(N.city_key(c))) for c in city.values],
                 "cityTiers": CITY_TIERS, "source": N.SOURCES, "campaign": campaign.values, "adset": adset.values,
                 "owner": owner.values, "status": status.values, "tiers": TIERS, "outcomes": OUTCOMES,
                 "levels": list(LEVELS), "windows": list(WINDOWS)},
        "retailers": retailers,
        "rm": rm,
        "leads": L,
        "spend": sp,
        "targets": targets,
        "targetsFromFile": targets_from_file,
        "files": files,
        "steps": steps,
        "gaps": gaps,
        "assumptions": assumptions,
    }

