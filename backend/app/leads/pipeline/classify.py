"""Lead outcomes: five mutually exclusive buckets per unique lead, for every matching level and attribution window.

Sales are monthly totals, so "days" become calendar months (lead month L, window end month W = month of lead date +
window days):
    Existing active      matched retailer billed before month L and in one of the 3 months before it (~90 days)
    Reactivated          matched retailer billed before month L, not in those 3 months, and again in months L..W
    New -> converted     matched retailer's first-ever bill falls in months L..W
    Not converted        valid mobile, but none of the above (no match, or first bill after W, or dormant and silent)
    Unmatchable          invalid or missing mobile
    Too recent to judge  valid mobile, not converted so far, but month W is after the last month of sales data: it
                         may still convert, so it is left out of conversion rates until the sales data catches up
A bill in the lead's own month counts as after the lead (the day of a monthly bill is unknown).
"""
from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd

from .match import LEVELS
from .normalise import month_int

# shown on the dashboard as written: plain words (Existing active, Reactivated, New -> converted, Not converted,
# Unmatchable, Too recent to judge)
OUTCOMES = ["Already buying", "Came back", "New retailer", "No sale yet", "Invalid number", "Too new to tell"]
EXISTING, REACTIVATED, NEW, NOT_CONVERTED, UNMATCHABLE, PENDING = range(6)
WINDOWS = (30, 60, 90)


def outcome(active: np.ndarray | None, lm: int, wm: int) -> int:
    if active is None or not len(active):
        return NOT_CONVERTED
    first = int(active[0])
    if first < lm:
        if ((active >= lm - 3) & (active < lm)).any():
            return EXISTING
        if ((active >= lm) & (active <= wm)).any():
            return REACTIVATED
        return NOT_CONVERTED
    return NEW if first <= wm else NOT_CONVERTED


def classify(leads: pd.DataFrame, sales) -> pd.DataFrame:
    """Adds o_<level>_<window> (outcome index; -1 on repeat rows) and first_gap (months from lead to first bill of the
    likely-matched retailer, -1 when none)."""
    out = leads.copy()
    lm = np.array([month_int(d) for d in out["date"]], dtype=int) if len(out) else np.array([], dtype=int)
    wms = {w: np.array([month_int(d + timedelta(days=w)) for d in out["date"]], dtype=int) if len(out) else lm
           for w in WINDOWS}
    sales_end = max(sales.month_quarter) if sales.month_quarter else None
    for level in LEVELS:
        rs = out[f"r_{level}"].to_numpy()
        for w in WINDOWS:
            codes = np.full(len(out), -1)
            for i in range(len(out)):
                if not out["unique"].iat[i]:
                    continue
                if not out["valid"].iat[i]:
                    codes[i] = UNMATCHABLE
                elif rs[i] < 0:
                    codes[i] = NOT_CONVERTED
                else:
                    codes[i] = outcome(sales.active.get(int(rs[i])), lm[i], wms[w][i])
                if codes[i] == NOT_CONVERTED and sales_end is not None and wms[w][i] > sales_end:
                    codes[i] = PENDING
            out[f"o_{level}_{w}"] = codes
    gap = np.full(len(out), -1)
    for i, r in enumerate(out["r_likely"].to_numpy()):
        a = sales.active.get(int(r)) if r >= 0 else None
        if a is not None and len(a) and a[0] >= lm[i]:
            gap[i] = int(a[0]) - lm[i]
    out["first_gap"] = gap
    return out
