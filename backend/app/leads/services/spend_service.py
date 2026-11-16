"""Campaign performance: what each campaign and platform spent and what it brought in - enquiries, retailers, sales.

Two halves:

    build_facts()  at every lead build: per campaign and month, the spend (ad platforms, saved by the Ad budget page), the
                   lead counts (by the attribution, attribution.py) and the BO outcomes of those leads (match + classify),
                   for every matching level x window. Saved next to the dashboard as out/campaign_facts.json.gz.
    performance()  on request: the KPIs of a month range from those facts, with month-on-month and quarter-on-quarter
                   series, Meta vs Google, rankings and an effectiveness score.

Definitions (the dashboard shows them as written):
    Total spend            what the platform reports as spent in the months of the period
    Unique leads           first enquiry per mobile (duplicates removed), attributed to the campaign
    CPL                    spend / unique leads
    Converted leads        unique leads whose BO retailer billed after the lead: a completely new retailer or one that came
                           back after 3 quiet months (outcomes New retailer + Came back)
    Lead conversion rate   converted leads / unique leads that can be judged x 100 (leads too recent for the sales data, and
                           invalid numbers, are left out of the denominator so recent periods are not shown as failures)
    New retailers          distinct retailers whose first-ever BO bill came after a lead of the campaign; a retailer reached
                           by several leads belongs to the earliest
    Cost per new retailer  spend / new retailers
    Budget utilisation     spend / (daily budget x days the campaign spent) x 100; campaigns on a lifetime budget use
                           the platform's lifetime spend / lifetime budget. Budgets are today's settings (no history kept)
    Attributed revenue     BO billing in the period from those new retailers (from their first bill) and from retailers a
                           lead brought back (from the lead's month), each retailer credited to one campaign only
    ROAS                   attributed revenue / spend
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date
from typing import Dict, Iterable, List, Optional, Tuple

import pandas as pd

from app.leads.pipeline import normalise as N
from app.leads.pipeline.classify import NEW, PENDING, REACTIVATED, WINDOWS
from app.leads.pipeline.match import LEVELS
from .attribution import MATCHED, NONPAID, PAID, lead_campaigns

# minimum volume before a campaign can top a ranking (so one lucky lead is never "the best campaign")
THRESHOLDS = {"min_leads": 30, "min_spend": 5000.0, "min_new_retailers": 3}
SCORE_WEIGHTS = {"cost_per_new_retailer": 35, "conversion_rate": 25, "roas": 25, "cpl": 15}


def _key(platform: str, cid: str) -> str:
    return f"{platform}:{cid}"


def _ym(m: int) -> str:
    return f"{m // 12}-{m % 12 + 1:02d}"


def _m(ym: str) -> int:
    y, mo = ym[:7].split("-")
    return int(y) * 12 + int(mo) - 1


# ------------------------------------------------------------------ facts (at build time)
def build_facts(leads: pd.DataFrame, sales, budgets: Dict[str, Optional[dict]], delivery: Dict[str, Optional[dict]]) -> dict:
    """budgets / delivery: {'Meta': saved snapshot or None, 'Google': ...} (ads/budget/*.json.gz, ads/attribution/*.json.gz)."""
    campaigns: Dict[str, dict] = {}
    spend: Dict[Tuple[str, int], float] = defaultdict(float)
    days: Dict[Tuple[str, int], set] = defaultdict(set)
    for plat in PAID:
        b, d = budgets.get(plat), delivery.get(plat)
        leadc = set(lead_campaigns(plat, (d or {}).get("campaigns", [])))
        for a in (b or {}).get("accounts", []):
            for c in a.get("campaigns", []):
                campaigns[_key(plat, str(c["campaign_id"]))] = {
                    "platform": plat, "campaign_id": str(c["campaign_id"]), "name": c.get("name"), "objective": c.get("objective"),
                    "status": c.get("status_group"), "daily_budget": c.get("daily_budget"), "lifetime_budget": c.get("lifetime_budget"),
                    "lifetime_spend": c.get("spend_lifetime"), "lead_campaign": str(c["campaign_id"]) in leadc, "kind": "campaign"}
            for r in a.get("campaign_monthly", []):
                spend[(_key(plat, str(r["campaign_id"])), _m(r["period"]))] += float(r["spend"] or 0)
        for r in (d or {}).get("daily", []):
            if (r.get("spend") or 0) > 0:
                dt = date.fromisoformat(r["date"])
                days[(_key(plat, str(r["campaign_id"])), dt.year * 12 + dt.month - 1)].add(dt.day)
    for key in {k for k, _ in spend}:   # spend of a campaign the account no longer lists
        if key not in campaigns:
            plat, cid = key.split(":", 1)
            campaigns[key] = {"platform": plat, "campaign_id": cid, "name": "Removed campaign", "objective": None, "status": "ended",
                              "daily_budget": None, "lifetime_budget": None, "lifetime_spend": None, "lead_campaign": False, "kind": "campaign"}

    def lead_key(row) -> str:
        if row.att_status == MATCHED:
            return _key(row.platform, row.campaign_id)
        return f"{row.source}:{'nonpaid' if row.att_status == NONPAID else 'unmatched'}"

    keys = [lead_key(r) for r in leads.itertuples(index=False)] if len(leads) else []
    for k, src, st in zip(keys, leads["source"] if len(leads) else [], leads["att_status"] if len(leads) else []):
        if k not in campaigns:
            campaigns[k] = {"platform": src if src in PAID else "", "campaign_id": "", "kind": "nonpaid" if st == NONPAID else "unmatched",
                            "name": f"{src}: non-paid" if st == NONPAID else
                            ("Platform unknown: not linked to a campaign" if src == "Other" else f"{src}: not linked to a campaign"), "objective": None, "status": None,
                            "daily_budget": None, "lifetime_budget": None, "lifetime_spend": None, "lead_campaign": False, "source": src}
            if st == NONPAID:
                campaigns[k]["source"] = src

    lm = [N.month_int(dt) for dt in leads["date"]] if len(leads) else []
    out_leads: Dict[str, list] = {}
    out_rev: Dict[str, list] = {}
    rev_by = defaultdict(float)
    rm = sales.month
    bills: Dict[int, List[Tuple[int, float]]] = defaultdict(list)
    for r, m, v in zip(rm["r"], rm["m"], rm["rev"]):
        if v:
            bills[int(r)].append((int(m), float(v)))
    uniq = leads["unique"].to_numpy() if len(leads) else []
    valid = leads["valid"].to_numpy() if len(leads) else []
    order = sorted(range(len(keys)), key=lambda i: lm[i] * 40 + leads["date"].iat[i].day)   # earliest lead first
    for level in LEVELS:
        ret = leads[f"r_{level}"].to_numpy() if len(leads) else []
        for w in WINDOWS:
            o = leads[f"o_{level}_{w}"].to_numpy() if len(leads) else []
            agg: Dict[Tuple[str, int], List[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])   # submissions, unique, judged, converted, new
            acquired: Dict[int, int] = {}      # retailer -> lead row (earliest New retailer lead)
            back: Dict[int, int] = {}          # retailer -> lead row (earliest Came back lead)
            for i in order:
                a = agg[(keys[i], lm[i])]
                a[0] += 1
                if not uniq[i]:
                    continue
                a[1] += 1
                if valid[i] and o[i] != PENDING:
                    a[2] += 1
                if o[i] in (NEW, REACTIVATED):
                    a[3] += 1
                r = int(ret[i])
                if r >= 0 and o[i] == NEW and r not in acquired:
                    acquired[r] = i
                    a[4] += 1
                elif r >= 0 and o[i] == REACTIVATED and r not in back:
                    back[r] = i
            rev_by.clear()
            for r, i in acquired.items():
                for m, v in bills.get(r, []):
                    rev_by[(keys[i], m)] += v
            for r, i in back.items():
                if r in acquired:
                    continue
                for m, v in bills.get(r, []):
                    if m >= lm[i]:
                        rev_by[(keys[i], m)] += v
            combo = f"{level}:{w}"
            out_leads[combo] = [[k, m, *v] for (k, m), v in agg.items()]
            out_rev[combo] = [[k, m, round(v, 2)] for (k, m), v in rev_by.items()]
    sales_end = int(rm["m"].max()) if len(rm) else None
    return {
        "campaigns": campaigns,
        "spend": [[k, m, round(v, 2), len(days.get((k, m), ()))] for (k, m), v in spend.items()],
        "leads": out_leads, "revenue": out_rev,
        "sales_end": sales_end, "lead_end": max(lm) if lm else None,
        "spend_saved": {p: (budgets.get(p) or {}).get("fetched_at") for p in PAID},
    }


# ------------------------------------------------------------------ KPIs (on request)
def _div(a: float, b: float, scale: float = 1.0) -> Optional[float]:
    return round(a * scale / b, 2) if b else None


def _days_in(months: Iterable[int], today: date) -> int:
    n = 0
    for m in months:
        y, mo = m // 12, m % 12 + 1
        last = calendar.monthrange(y, mo)[1]
        if (y, mo) == (today.year, today.month):
            last = today.day
        elif date(y, mo, 1) > today:
            last = 0
        n += last
    return n


def _kpis(t: dict, days: int) -> dict:
    """Ratios on spend are blank when nothing was spent (non-paid leads, unmatched leads), never ₹0."""
    sp, u = t["spend"], t["unique"]
    paid = sp > 0
    return {
        "spend": round(sp, 2), "submissions": t["submissions"], "unique_leads": u, "duplicates": t["submissions"] - u,
        "cpl": _div(sp, u) if paid else None, "converted": t["converted"], "judged": t["judged"], "conversion_rate": _div(t["converted"], t["judged"], 100),
        "new_retailers": t["new"], "cost_per_new_retailer": _div(sp, t["new"]) if paid else None,
        "revenue": round(t["revenue"], 2), "roas": _div(t["revenue"], sp) if paid else None,
        # a campaign: per day it spent; a platform or a whole period: per calendar day
        "active_days": t["active_days"], "spend_per_day": _div(sp, t["active_days"] or days) if paid else None,
        "leads_per_day": _div(u, t["active_days"] or days),
    }


def _blank() -> dict:
    return {"spend": 0.0, "submissions": 0, "unique": 0, "judged": 0, "converted": 0, "new": 0, "revenue": 0.0, "active_days": 0}


def _totals(facts: dict, combo: str, months: set, group) -> Dict[str, dict]:
    """Sum the facts of `months` by group(key) -> name."""
    out: Dict[str, dict] = defaultdict(_blank)
    for k, m, v, d in facts["spend"]:
        if m in months:
            g = group(k)
            out[g]["spend"] += v
            out[g]["active_days"] += d
    for k, m, sub, uniq, judged, conv, new in facts["leads"].get(combo, []):
        if m in months:
            t = out[group(k)]
            t["submissions"] += sub; t["unique"] += uniq; t["judged"] += judged; t["converted"] += conv; t["new"] += new
    for k, m, v in facts["revenue"].get(combo, []):
        if m in months:
            out[group(k)]["revenue"] += v
    return out


def _utilisation(c: dict, spend: float, active_days: int) -> Tuple[Optional[float], Optional[str]]:
    if c.get("daily_budget") and active_days:
        return _div(spend, c["daily_budget"] * active_days, 100), f"spend ÷ (today's daily budget × {active_days} days it spent)"
    if c.get("lifetime_budget") and c.get("lifetime_spend") is not None:
        return _div(c["lifetime_spend"], c["lifetime_budget"], 100), "lifetime spend ÷ lifetime budget (whole campaign)"
    return None, None


def _rank(rows: List[dict], metric: str, eligible, best_low: bool) -> List[dict]:
    ok = [r for r in rows if eligible(r) and r[metric] is not None]
    ok.sort(key=lambda r: r[metric], reverse=not best_low)
    return [{"key": r["key"], "name": r["name"], "platform": r["platform"], "value": r[metric]} for r in ok[:10]]


def _score(rows: List[dict], th: dict) -> None:
    """0-100 overall acquisition score among campaigns with enough volume: the weighted percentile rank of cost per new
    retailer, conversion rate, ROAS and CPL. A campaign with no new retailer ranks last on cost per new retailer."""
    pool = [r for r in rows if r["kind"] == "campaign" and r["unique_leads"] >= th["min_leads"] and r["spend"] >= th["min_spend"]]
    for r in rows:
        r["score"], r["score_note"] = None, ("Not enough data: needs ≥ %d unique leads and ≥ ₹%s spend" % (th["min_leads"], f"{th['min_spend']:,.0f}")
                                            if r["kind"] == "campaign" else "Not a campaign")
    if len(pool) < 2:
        for r in pool:
            r["score_note"] = "Only one campaign has enough data to compare"
        return
    inf = float("inf")
    vals = {"cost_per_new_retailer": lambda r: r["cost_per_new_retailer"] if r["cost_per_new_retailer"] is not None else inf,
            "conversion_rate": lambda r: r["conversion_rate"] or 0.0, "roas": lambda r: r["roas"] or 0.0,
            "cpl": lambda r: r["cpl"] if r["cpl"] is not None else inf}
    low_better = {"cost_per_new_retailer", "cpl"}
    n = len(pool)
    for r in pool:
        total = 0.0
        for metric, wgt in SCORE_WEIGHTS.items():
            v = vals[metric](r)
            better = sum(1 for x in pool if (vals[metric](x) > v if metric in low_better else vals[metric](x) < v))
            ties = sum(1 for x in pool if vals[metric](x) == v) - 1
            total += wgt * (better + ties / 2) / (n - 1)
        r["score"] = round(total, 1)
        r["score_note"] = ""


def performance(facts: dict, start: int, end: int, level: str = "likely", window: int = 60,
                thresholds: Optional[dict] = None, today: Optional[date] = None) -> dict:
    """KPIs for months start..end (month ints, inclusive)."""
    th = {**THRESHOLDS, **(thresholds or {})}
    today = today or date.today()
    combo = f"{level}:{window}"
    months = set(range(start, end + 1))
    days = _days_in(months, today)
    camps = facts["campaigns"]
    per = _totals(facts, combo, months, lambda k: k)
    rows = []
    for k, t in per.items():
        if not (t["spend"] or t["submissions"]):
            continue
        c = camps.get(k, {"platform": k.split(":")[0], "name": k, "kind": "campaign"})
        util, basis = _utilisation(c, t["spend"], t["active_days"]) if c["kind"] == "campaign" and t["spend"] else (None, None)
        rows.append({"key": k, "name": c["name"], "platform": c["platform"] or c.get("source", ""), "campaign_id": c.get("campaign_id", ""),
                     "kind": c["kind"], "objective": c.get("objective"), "status": c.get("status"), "lead_campaign": c.get("lead_campaign", False),
                     "daily_budget": c.get("daily_budget"), "lifetime_budget": c.get("lifetime_budget"),
                     "budget_utilisation": util, "utilisation_basis": basis, **_kpis(t, days)})
    _score(rows, th)
    rows.sort(key=lambda r: (r["kind"] != "campaign", -(r["unique_leads"]), -r["spend"]))

    def plat(k: str) -> str:
        c = camps.get(k)
        return (c["platform"] or c.get("source", "")) if c else k.split(":")[0]
    def calendar(t: dict) -> dict:
        return {**t, "active_days": 0}
    platforms = {p: _kpis(calendar(t), days) for p, t in _totals(facts, combo, months, plat).items()}
    # month-on-month and quarter-on-quarter, per platform, over the whole span up to the end of the period
    all_m = sorted({m for _, m, _, _ in facts["spend"]} | {r[1] for r in facts["leads"].get(combo, [])})
    span = [m for m in all_m if m <= end]
    monthly = []
    for m in span:
        for p, t in _totals(facts, combo, {m}, plat).items():
            if p in PAID:
                monthly.append({"period": _ym(m), "platform": p, **_kpis(calendar(t), _days_in([m], today))})
    quarters: Dict[str, set] = defaultdict(set)
    for m in span:
        quarters[N.fy_quarter(m)].add(m)
    quarterly = []
    for q, ms in quarters.items():
        for p, t in _totals(facts, combo, ms, plat).items():
            if p in PAID:
                quarterly.append({"period": q, "platform": p, **_kpis(calendar(t), _days_in(ms, today))})
    camp_rows = [r for r in rows if r["kind"] == "campaign"]
    vol = lambda r: r["unique_leads"] >= th["min_leads"] and r["spend"] > 0  # noqa: E731
    rankings = {
        "lowest_cpl": _rank(camp_rows, "cpl", vol, True),
        "lowest_cost_per_new_retailer": _rank(camp_rows, "cost_per_new_retailer", lambda r: vol(r) and r["new_retailers"] >= th["min_new_retailers"], True),
        "highest_conversion_rate": _rank(camp_rows, "conversion_rate", lambda r: r["judged"] >= th["min_leads"], False),
        "highest_revenue": _rank(camp_rows, "revenue", lambda r: r["revenue"] > 0, False),
        "best_overall": _rank(camp_rows, "score", lambda r: r["score"] is not None, False),
    }
    pending_from = facts.get("sales_end")
    return {
        "period": {"start": _ym(start), "end": _ym(end), "days": days}, "level": level, "window": window,
        "thresholds": th, "score_weights": SCORE_WEIGHTS,
        "campaigns": rows, "platforms": platforms, "monthly": monthly,
        "quarterly": sorted(quarterly, key=lambda r: (r["period"][-2:], r["period"][1], r["platform"])),
        "rankings": rankings,
        "sales_end": _ym(pending_from) if pending_from is not None else None,
        "spend_saved": facts.get("spend_saved"),
    }
