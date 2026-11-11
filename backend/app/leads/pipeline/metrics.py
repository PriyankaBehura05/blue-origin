"""Headline numbers for the memo and the reconciliation sheet. The dashboard computes the same definitions in the
browser (frontend/src/leads/model.ts) so its filters work; keep the two in step."""
from __future__ import annotations

import math
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .classify import NEW, OUTCOMES, PENDING, WINDOWS
from .match import LEVELS


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson interval for k successes out of n, as fractions."""
    if n <= 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def quarter_months(sales) -> Dict[str, List[int]]:
    out: Dict[str, List[int]] = {}
    for m, q in sorted(sales.month_quarter.items()):
        out.setdefault(q, []).append(m)
    return out


def sales_headlines(sales) -> dict:
    qm = quarter_months(sales)
    qs = [q for q in sales.quarters if q in qm]
    rm = sales.month
    rev_q = {q: float(rm.loc[rm["m"].isin(qm[q]), "rev"].sum()) for q in qs}
    billed = rm[rm["rev"] > 0]
    who = {q: set(billed.loc[billed["m"].isin(qm[q]), "r"]) for q in qs}
    first = {r: int(a[0]) for r, a in sales.active.items() if len(a)}
    new_q = {q: sum(1 for r, f in first.items() if f in qm[q]) for q in qs}
    cur, prev = (qs[-1], qs[-2]) if len(qs) >= 2 else (qs[-1] if qs else None, None)
    end = int(rm["m"].max())
    status = {}
    for r, a in sales.active.items():
        last = int(a[-1])
        status[r] = "Active" if last >= end - 1 else ("At-risk" if last == end - 2 else "Churned")
    at_risk = [r for r, s in status.items() if s == "At-risk"]
    risk_rev = 0.0
    if at_risk:
        g = billed[billed["r"].isin(at_risk)]
        lastm = g.groupby("r")["m"].transform("max")
        risk_rev = float(g.loc[g["m"] > lastm - 3, "rev"].sum())
    retained = len(who[cur] & who[prev]) if prev else 0
    by_dist = {}
    if cur:
        newr = [r for r, f in first.items() if f in qm[cur]]
        by_dist = sales.retailers.loc[newr, "Distributor"].value_counts().head(5).to_dict()
    states_new = sales.retailers.loc[[r for r, f in first.items() if cur and f in qm[cur]], "State"].value_counts()
    return {
        "quarters": qs, "current": cur, "previous": prev, "revenue": rev_q, "new": new_q,
        "billed": {q: len(who[q]) for q in qs}, "retained": retained,
        "retention_pct": 100 * retained / len(who[prev]) if prev and who[prev] else None,
        "at_risk": len(at_risk), "churned": sum(1 for s in status.values() if s == "Churned"),
        "active": sum(1 for s in status.values() if s == "Active"), "revenue_at_risk": risk_rev,
        "top_new_distributors": by_dist, "top_new_states": states_new.head(5).to_dict(),
        "end_month": end,
    }


def lead_buckets(leads: pd.DataFrame) -> pd.DataFrame:
    """Rows: level x window; columns: each outcome, total unique leads, and the check that the buckets add up."""
    rows = []
    uniq = leads[leads["unique"]] if len(leads) else leads
    for lv in LEVELS:
        for w in WINDOWS:
            col = f"o_{lv}_{w}"
            counts = np.bincount(uniq[col].to_numpy(dtype=int), minlength=len(OUTCOMES)) if len(uniq) else \
                np.zeros(len(OUTCOMES), dtype=int)
            row = {"Matching level": lv, "Window (days)": w}
            row.update({o: int(c) for o, c in zip(OUTCOMES, counts)})
            row["Sum of buckets"] = int(counts.sum())
            row["Unique leads"] = int(len(uniq))
            row["Reconciles"] = "Yes" if int(counts.sum()) == len(uniq) else "NO"
            rows.append(row)
    return pd.DataFrame(rows)


def lead_headlines(leads: pd.DataFrame, sales, level: str = "likely", window: int = 60) -> Optional[dict]:
    if not len(leads):
        return None
    uniq = leads[leads["unique"]]
    col = f"o_{level}_{window}"
    valid = uniq[uniq["valid"]]
    judged = valid[valid[col] != PENDING]       # leads whose window has closed inside the sales data
    new = int((uniq[col] == NEW).sum())
    conv = 100 * new / len(judged) if len(judged) else 0.0
    rng = {}
    for lv in LEVELS:
        c = valid[f"o_{lv}_{window}"]
        n = int((c != PENDING).sum())
        rng[lv] = 100 * int((c == NEW).sum()) / n if n else 0.0
    camp = judged.groupby("campaign").agg(leads=("mobile", "size"), new=(col, lambda s: int((s == NEW).sum())))
    camp = camp[(camp["leads"] >= 30) & ~camp.index.isin(["(no campaign)"])]
    if len(camp) < 2:
        camp = camp.iloc[0:0]           # one campaign (or none named) has nothing to compare against
    camp["rate"] = 100 * camp["new"] / camp["leads"]
    by_src = judged.groupby("source").agg(leads=("mobile", "size"), new=(col, lambda s: int((s == NEW).sum())))
    return {
        "rows": len(leads), "unique": len(uniq), "valid": len(valid), "judged": len(judged),
        "pending": len(valid) - len(judged), "new": new, "conversion_pct": conv,
        "range_pct": rng, "repeat_rate_pct": 100 * (len(leads) - len(uniq)) / len(leads),
        "best_campaign": camp["rate"].idxmax() if len(camp) else None,
        "best_campaign_rate": float(camp["rate"].max()) if len(camp) else None,
        "worst_campaign": camp["rate"].idxmin() if len(camp) else None,
        "worst_campaign_rate": float(camp["rate"].min()) if len(camp) else None,
        "by_source": by_src.to_dict("index"),
        "matched": {lv: int((uniq[f"r_{lv}"] >= 0).sum()) for lv in LEVELS},
    }


def bo_order_check(active, lead_month: int, sales_end: int) -> str:
    """An ASM's 'order placed' against BO billing: the matched retailer billed in the lead month or the 2 after it."""
    if active is not None and len(active) and ((active >= lead_month) & (active <= lead_month + 2)).any():
        return "billed"
    return "pending" if lead_month + 2 > sales_end else "not billed"


def followup_headlines(leads: pd.DataFrame, sales, level: str = "likely") -> Optional[dict]:
    """Unique valid leads with an ASM: called / visited / order claimed, and claimed orders seen in BO billing."""
    if "f_owner" not in leads:
        return None
    u = leads[leads["unique"] & leads["valid"]]
    asm = u[u["f_tracked"].astype(bool)]           # every lead of a sheet that has ASM columns, filled or not
    if not len(asm):
        return None
    from .normalise import month_int
    end = max(sales.month_quarter) if sales.month_quarter else 0
    claimed = asm[asm["f_order"] == 1]
    checks = [bo_order_check(sales.active.get(int(r)) if r >= 0 else None, month_int(d), end)
              for r, d in zip(claimed[f"r_{level}"], claimed["date"])]
    return {
        "leads": len(asm), "owners": int((asm["f_owner"] != "").groupby(asm["f_owner"]).size().shape[0]),
        "called": int((asm["f_called"] == 1).sum()), "visited": int((asm["f_visited"] == 1).sum()),
        "claimed": len(claimed), "claimed_value": float(claimed["f_value"].sum()),
        "median_value": float(claimed.loc[claimed["f_value"] > 0, "f_value"].median()) if (claimed["f_value"] > 0).any() else 0.0,
        "bo_billed": checks.count("billed"), "bo_not_billed": checks.count("not billed"),
        "bo_pending": checks.count("pending"),
    }
