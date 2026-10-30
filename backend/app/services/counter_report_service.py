"""
Distribution Counter Report: the six-sheet workbook of Distributor_Counter_Report.xlsx, for any financial year.

  Summary Dashboard              active counters, active revenue, new counters, new revenue, cumulative adds,
                                 MoM growth % and trend, per month + FY Total
  New Counters - State           new counters per month by state: count + ₹ brought in the add month, Total, TOTAL row
  New Counters - Distributor     same by distributor
  Active & Growth - State        active counters per month by state, Peak, TOTAL ACTIVE, MoM growth % and trend
  Active & Growth - Distributor  same by distributor
  Counter Detail                 one row per counter: distributor, state, status, first billing, value per month,
                                 Active Months

Definitions (as written in the report): a counter is a retailer of a distributor (the consolidated retailers of the
dashboard data, duplicates merged); Active = billed in the month (value > 0); New = first-ever billing falls in the
FY; New-counter revenue = value billed in the add month. Only months that have data are shown (a running FY ends at
the latest month). Totals, peaks, growth and trend are Excel formulas, exactly as in the template.
"""
import gzip
import json
import re
import threading
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from app.core.config import Settings
from app.core.errors import InvalidFilterError
from app.services import network_service
from app.services.counter_report_xlsx import to_xlsx
from app.storage.base import BlobStore

_MON = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10,
        "nov": 11, "dec": 12}
_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

@dataclass
class Month:
    index: int          # position in the payload's month list
    year: int
    month: int

    @property
    def label(self) -> str:   # 'Apr-25'
        return f"{_ABBR[self.month]}-{self.year % 100:02d}"


def _month(label: str, i: int) -> Optional[Month]:
    m = re.fullmatch(r"([A-Za-z]+)[_ ](\d{2})", label)
    if not m or m.group(1)[:3].lower() not in _MON:
        return None
    return Month(i, 2000 + int(m.group(2)), _MON[m.group(1)[:3].lower()])


def fy_of(m: Month) -> int:
    """FY named after the year it ends in: Apr-2025..Mar-2026 -> 26."""
    return (m.year + 1 if m.month >= 4 else m.year) % 100


# ---- data ----------------------------------------------------------------------------------------------------
_cache: Dict[str, object] = {}
_lock = threading.Lock()


def _payload(store: BlobStore, settings: Settings) -> Tuple[dict, str]:
    body, etag, _ = network_service.payload(store, settings)
    with _lock:
        if _cache.get("etag") != etag:
            _cache.clear()
            _cache.update(etag=etag, data=json.loads(gzip.decompress(body))["data"])
        return _cache["data"], etag  # type: ignore[return-value]


def financial_years(p: dict) -> List[dict]:
    months = [m for m in (_month(x, i) for i, x in enumerate(p["months"])) if m]
    out = []
    for fy in sorted({fy_of(m) for m in months}, reverse=True):
        ms = [m for m in months if fy_of(m) == fy]
        out.append({"fy": f"FY{fy:02d}", "label": f"FY{fy:02d} ({ms[0].label} to {ms[-1].label})", "months": [m.label for m in ms]})
    return out


def build(p: dict, fy: Optional[str]) -> dict:
    """All six sheets as plain data (shared by the web page and the Excel file)."""
    years = financial_years(p)
    if not years:
        raise InvalidFilterError("The dashboard data has no months.")
    pick = next((y for y in years if y["fy"].replace(" ", "").lower() == (fy or "").replace(" ", "").lower()), None) if fy else years[0]
    if pick is None:
        raise InvalidFilterError(f"No data for {fy}. Available: {', '.join(y['fy'] for y in years)}.")
    fy_num = int(pick["fy"][2:])
    all_months = [m for m in (_month(x, i) for i, x in enumerate(p["months"])) if m]
    months = [m for m in all_months if fy_of(m) == fy_num]
    first_idx, last_idx = months[0].index, months[-1].index
    quarters = [i for i, q in enumerate(p["quarters"]) if re.search(rf"FY{fy_num:02d}$", q)]
    dists = p["distributors"]
    new_tag = f"New ({pick['fy']})"

    counters = []
    for r in p["retailers"]:
        vals = r["m"]
        billed_fy = any(vals[m.index] for m in months)
        listed_fy = any(r["t"][q] >= 0 for q in quarters if q < len(r["t"]))
        if not (billed_fy or listed_fy):
            continue
        first = next((i for i, v in enumerate(vals) if v > 0), -1)
        if first < 0 or first > last_idx:
            status, first_lbl = "Never billed", "Never billed"
        else:
            status = new_tag if first >= first_idx else "Existing"
            first_lbl = all_months[first].label if first < len(all_months) else ""
        d = dists[r["d"]]
        counters.append({"name": r["n"], "id": r["id"], "dist": d["n"], "state": d["s"] or "Unmapped", "status": status,
                         "first": first_lbl, "firstIdx": first, "values": [vals[m.index] or None for m in months]})
    counters.sort(key=lambda c: (c["state"], c["name"]))   # ASCII order, as in the template

    n = len(months)
    labels = [m.label for m in months]
    idx_of = {m.index: k for k, m in enumerate(months)}

    def is_new_in(c, k):
        return c["status"] == new_tag and idx_of.get(c["firstIdx"]) == k

    summary = {
        "active": [sum(1 for c in counters if (c["values"][k] or 0) > 0) for k in range(n)],
        "activeRevenue": [round(sum(c["values"][k] for c in counters if (c["values"][k] or 0) > 0)) for k in range(n)],
        "newCount": [sum(1 for c in counters if is_new_in(c, k)) for k in range(n)],
        "newRevenue": [round(sum(c["values"][k] or 0 for c in counters if is_new_in(c, k))) for k in range(n)],
    }

    def grouped(key: str):
        names = sorted({c[key] for c in counters})
        new = {g: [[0, 0.0] for _ in range(n)] for g in names}
        act = {g: [0] * n for g in names}
        for c in counters:
            for k in range(n):
                v = c["values"][k] or 0
                if v > 0:
                    act[c[key]][k] += 1
                if is_new_in(c, k):
                    new[c[key]][k][0] += 1
                    new[c[key]][k][1] += v
        return ([{"name": g, "cells": [[a, round(b)] if a else [None, None] for a, b in new[g]]} for g in names],
                [{"name": g, "active": act[g]} for g in names])

    new_state, act_state = grouped("state")
    new_dist, act_dist = grouped("dist")
    return {"fy": pick["fy"], "label": pick["label"], "years": years, "months": labels, "summary": summary,
            "newByState": new_state, "newByDistributor": new_dist, "activeByState": act_state,
            "activeByDistributor": act_dist, "counters": counters, "generated": p.get("generated"),
            "counts": {"counters": len(counters), "new": sum(1 for c in counters if c["status"] == new_tag),
                       "existing": sum(1 for c in counters if c["status"] == "Existing"),
                       "neverBilled": sum(1 for c in counters if c["status"] == "Never billed")}}


def report(store: BlobStore, settings: Settings, fy: Optional[str]) -> dict:
    p, _ = _payload(store, settings)
    return build(p, fy)


_DETAIL = ("newByState", "newByDistributor", "activeByState", "activeByDistributor", "counters")


def summary(store: BlobStore, settings: Settings, fy: Optional[str]) -> dict:
    """What the Reports page shows: the Summary Dashboard and the counts. The other five sheets, with one row per
    counter, are only in the download."""
    return {k: v for k, v in report(store, settings, fy).items() if k not in _DETAIL}


_files: Dict[Tuple[str, str], bytes] = {}


def download(store: BlobStore, settings: Settings, fy: Optional[str]) -> Tuple[bytes, str]:
    """(xlsx bytes, file name). Built once per data version and FY."""
    p, etag = _payload(store, settings)
    d = build(p, fy)
    key = (etag, d["fy"])
    with _lock:
        if key not in _files:
            if len(_files) > 6:
                _files.clear()
            _files[key] = to_xlsx(d)
        content = _files[key]
    return content, f"Distributor_Counter_Report_{d['fy']}.xlsx"
