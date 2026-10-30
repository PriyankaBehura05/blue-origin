"""
BO_Data report: the layout of BO_Consolidate_Final.xlsx, rebuilt from the Consolidated sheets (Dropbox
/Power BI/Consolidated) of the current build.

Six sheets, as in the original workbook:
  Consolidated_Tiered        one row per Code name (shop name + distributor, as in the sheets; no duplicate merging, so
                             every rupee of the sheets is in it, to the paisa): Code name, Retailer_Name, Distributor,
                             Phone, Pincode, City, State, Region (Unknown when the state has none), then per quarter
                             <Q> (net purchase), Tier_<Q>, Move_<Q>, then Total_Sales, Active_Quarters, First_Purchase,
                             Customer_Status, Distributor_State, Distributor_Region
  Tier_Distribution          retailers per tier (Platinum ... Yellow, No tier, Absent) per quarter
  Tier_Movement_Summary      retailers per movement per quarter
  Revenue_Region_x_Movement  latest quarter's purchase by movement x region (North, South, East, West, Unknown/Blank)
  Count_Region_x_Movement    the same as retailer counts
  Final_Data                 Consolidated_Tiered with Region = the distributor's region (header filter, top row frozen)

Rules (checked against every row of the original workbook):
  Tier      the quarter's tier when the retailer bought (Yellow ... Platinum), "No tier" when it bought below the
            Yellow minimum, "Absent" when it bought nothing.
  Move      "No sale" without a purchase; "New" in the quarter of the first purchase; with a tier: Upgraded /
            Downgraded / Stayed in same tier against the quarter before (No tier and Absent count as 0); below the
            tiers: "Dropped from Tier" when it was on a tier before, else "Never been on tier but some sale".
  Customer_Status  Inactive (never bought), One-time (bought in one quarter), Dropped (bought in 2+ quarters but not
            in the latest), else Upgraded / Downgraded / Retained: the latest tier against the tier of the last earlier
            quarter in which it bought.

Filters (the Reports page): distributor, region (the distributor's) and state (the retailer's) keep those retailers;
a quarter or a month gives the workbook as it stood at the end of that period (quarters up to it; for a month, its
quarter counts purchases up to that month).
"""
import gzip
import io
import json
import threading
from dataclasses import dataclass
from datetime import date
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import xlsxwriter

from app.core.config import Settings
from app.core.errors import DataNotAvailableError, InvalidFilterError
from app.services import network_service
from app.storage.base import BlobStore

TIER_ROWS = ["Platinum", "Gold", "Silver", "Green", "Yellow", "No tier", "Absent"]
MOVES = ["New", "Upgraded", "Stayed in same tier", "Downgraded", "Dropped from Tier", "Never been on tier but some sale",
         "No sale"]
REGIONS = ["North", "South", "East", "West"]
_MON = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11,
        "dec": 12}

_lock = threading.Lock()
_cache: Dict[Tuple, Tuple[bytes, str]] = {}


@dataclass(frozen=True)
class Scope:
    quarter: str = ""        # 'Q2 FY 27'
    month: str = ""          # 'YYYY-MM'
    region: str = ""         # distributor region
    state: str = ""          # retailer state
    distributor: str = ""    # distributor name

    def label(self) -> str:
        return "_".join(v for v in (self.month, self.quarter, self.region, self.state, self.distributor) if v)


def _payload(store: BlobStore, settings: Settings) -> Tuple[dict, str]:
    body, etag, _ = network_service.payload(store, settings)
    return json.loads(gzip.decompress(body))["data"], etag


def _month_key(label: str) -> Optional[str]:
    """'Sept_24' -> '2024-09'"""
    name, _, yy = str(label).replace(" ", "_").partition("_")
    mo = _MON.get(name[:3].lower())
    return f"20{yy[-2:]}-{mo:02d}" if mo and yy[-2:].isdigit() else None


def _qkey(label: str) -> str:
    """'Q2 FY 27' / 'Q2_FY27' -> 'Q2_FY27'"""
    s = label.replace(" ", "").upper()
    return s if "_" in s else s.replace("FY", "_FY")


def _qorder(qk: str) -> Tuple[int, int]:
    """'Q2_FY27' -> (27, 2)"""
    q, _, fy = qk.partition("_FY")
    return int(fy), int(q[1:])


def frames(store: BlobStore, settings: Settings, scope: Scope) -> Dict[str, pd.DataFrame]:
    p, _ = _payload(store, settings)
    quarters: List[str] = p["quarters"]
    months: List[str] = p["months"]
    month_q = np.array(p["monthQ"])
    tiers = p["tiers"]                               # ['Untiered', 'Yellow', ..., 'Platinum']
    dists = p["distributors"]

    # ---- the period: quarters up to the chosen one; a month also cuts its quarter at that month
    last_q, last_m = len(quarters) - 1, len(months) - 1
    if scope.month:
        keys = [_month_key(m) for m in months]
        if scope.month not in keys:
            raise InvalidFilterError(f"No data for {scope.month}.", details={"month": scope.month})
        last_m = keys.index(scope.month)
        last_q = int(month_q[last_m])
    elif scope.quarter:
        qk = _qkey(scope.quarter)
        if qk not in quarters:
            raise InvalidFilterError(f"No data for {scope.quarter}.", details={"quarter": scope.quarter})
        last_q = quarters.index(qk)
        last_m = max(i for i, q in enumerate(month_q) if q <= last_q)
    Q = quarters[:last_q + 1]
    nq = len(Q)
    partial = last_m < max(i for i, q in enumerate(month_q) if q == last_q)   # the last quarter is cut at a month

    # ---- the Code names of the scope: one per shop name + distributor, straight from the Consolidated sheets
    raw = network_service.network_store(store).read("code_names.csv")
    if raw is None:
        raise DataNotAvailableError("BO_Data needs a fresh build: click \"Rebuild now\" on the Data page.")
    C = pd.read_csv(io.BytesIO(raw), dtype={c: str for c in ("Code_name", "Retailer_Name", "Distributor", "Phone",
                                                                "Pincode", "City", "State", "Region", "Listed")},
                    keep_default_na=False)
    if scope.distributor:
        C = C[C["Distributor"] == scope.distributor]
    if scope.region:
        C = C[C["Region"] == scope.region]
    if scope.state:
        C = C[C["State"] == scope.state]
    C = C.reset_index(drop=True)
    dreg = {d["n"]: d for d in dists}

    n = len(C)
    mon = np.zeros((n, len(months)))
    for j, m in enumerate(months):
        if m in C.columns:
            mon[:, j] = pd.to_numeric(C[m], errors="coerce").fillna(0).to_numpy()
    mon[:, last_m + 1:] = 0
    rev = np.stack([mon[:, month_q == i].sum(axis=1) for i in range(nq)], axis=1) if n else np.zeros((0, nq))
    listed = np.array([[q in set(x.split("|")) for q in Q] for x in C["Listed"]], dtype=bool).reshape(n, nq)
    bought = rev > 0

    # tier rank 0..5 (0 = below the tiers) from the quarter's purchase and that quarter's slabs
    slabs = p.get("slabsByQuarter") or {}
    tier_from = p.get("tierFrom") or {}

    def classify(v: float, qk: str) -> int:
        sl = slabs.get(qk, p["slabs"])
        for k in range(len(tiers) - 1, 0, -1):
            name = tiers[k]
            if name in tier_from and _qorder(qk) < _qorder(tier_from[name]):   # tier not offered yet
                continue
            if v >= sl.get(name, float("inf")):
                return k
        return 0

    rank = np.zeros((n, nq), dtype=int)
    for a in range(n):
        for i in range(nq):
            if bought[a, i]:
                rank[a, i] = classify(rev[a, i], Q[i])
    keep = (bought | listed | (np.abs(rev) > 1e-9)).any(axis=1)   # returns-only retailers too

    # ---- moves (as in the original workbook)
    first = np.where(bought.any(axis=1), bought.argmax(axis=1), -1)
    prev_rank = np.concatenate([np.zeros((n, 1), dtype=int), rank[:, :-1]], axis=1)
    tiered_before = np.concatenate([np.zeros((n, 1), dtype=bool),
                                    np.maximum.accumulate(bought & (rank > 0), axis=1)[:, :-1]], axis=1)
    qidx = np.arange(nq)[None, :]
    move = np.select(
        [~bought, first[:, None] == qidx, (rank > 0) & (rank > prev_rank), (rank > 0) & (rank < prev_rank),
         rank > 0, tiered_before],
        ["No sale", "New", "Upgraded", "Downgraded", "Stayed in same tier", "Dropped from Tier"],
        "Never been on tier but some sale")
    tier_lbl = np.where(~bought, "Absent", np.where(rank == 0, "No tier", np.array(tiers, dtype=object)[rank]))

    # ---- customer status: the latest tier against the last earlier quarter with a purchase
    active = bought.sum(axis=1)
    status = []
    for a in range(n):
        if active[a] == 0:
            status.append("Inactive")
        elif active[a] == 1:
            status.append("One-time")
        elif not bought[a, -1]:
            status.append("Dropped")
        else:
            before = [rank[a, i] for i in range(nq - 1) if bought[a, i]]
            cur, prv = rank[a, -1], before[-1]
            status.append("Upgraded" if cur > prv else "Downgraded" if cur < prv else "Retained")

    # ---- Consolidated_Tiered
    def num(v: str):
        d = "".join(ch for ch in str(v) if ch.isdigit())
        return int(d) if d and len(d) == len(str(v).strip()) else (v or None)

    region = C["Region"].where(C["Region"].isin(REGIONS), "Unknown")
    df = pd.DataFrame({"Code name": C["Code_name"], "Retailer_Name": C["Retailer_Name"],
                       "Distributor": C["Distributor"], "Phone": C["Phone"].map(num),
                       "Pincode": C["Pincode"].map(num), "City": C["City"].replace("", None),
                       "State": C["State"].replace("", None), "Region": region})
    for i, q in enumerate(Q):
        # exact to the paisa (returns included), so every column adds up to the sheets
        df[q] = np.where(np.abs(rev[:, i]) > 1e-9, np.round(rev[:, i], 4), np.where(listed[:, i], 0, np.nan))
        df[f"Tier_{q}"] = tier_lbl[:, i]
        df[f"Move_{q}"] = move[:, i]
    df["Total_Sales"] = np.round(rev.sum(axis=1), 4)
    df["Active_Quarters"] = active
    df["First_Purchase"] = [Q[f] if f >= 0 else None for f in first]
    df["Customer_Status"] = status
    df["Distributor_State"] = [(dreg.get(d) or {}).get("s") or None for d in C["Distributor"]]
    df["Distributor_Region"] = [(dreg.get(d) or {}).get("r") or None for d in C["Distributor"]]
    keep_rows = keep & np.ones(n, dtype=bool)
    df = df[keep_rows].sort_values("Total_Sales", ascending=False, kind="stable").reset_index(drop=True)
    last = Q[-1]

    # ---- summaries
    tier_dist = pd.DataFrame({"Tier": TIER_ROWS, **{q: [int((df[f"Tier_{q}"] == t).sum()) for t in TIER_ROWS]
                                                     for q in Q}})
    move_sum = pd.DataFrame({"Movement": MOVES, **{q: [int((df[f"Move_{q}"] == m).sum()) for m in MOVES] for q in Q}})
    reg = df["Region"].where(df["Region"].isin(REGIONS), "Unknown/Blank")
    rev_last = df[last].fillna(0)

    def by_region(values: pd.Series, how) -> pd.DataFrame:
        rows = []
        for m in MOVES + ["Grand Total"]:
            sel = df[f"Move_{last}"] == m if m != "Grand Total" else pd.Series(True, index=df.index)
            cells = [how(values[sel & (reg == g)]) for g in REGIONS + ["Unknown/Blank"]]
            rows.append([m] + cells + [round(sum(cells), 4)])
        return pd.DataFrame(rows, columns=["Movement"] + REGIONS + ["Unknown/Blank", "Total"])

    final = df.copy()
    final["Region"] = final["Distributor_Region"]
    return {"Consolidated_Tiered": df, "Tier_Distribution": tier_dist, "Tier_Movement_Summary": move_sum,
            "Revenue_Region_x_Movement": by_region(rev_last, lambda s: round(float(s.sum()), 4)),
            "Count_Region_x_Movement": by_region(rev_last, lambda s: int(len(s))), "Final_Data": final,
            "_meta": pd.DataFrame({"latest": [last], "partial": [partial]})}


def to_xlsx(sheets: Dict[str, pd.DataFrame]) -> bytes:
    """The plain look of the original: bold headers (thin borders except Final_Data), General numbers, width 13."""
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "strings_to_numbers": False, "strings_to_formulas": False,
                                   "strings_to_urls": False, "nan_inf_to_errors": False})
    head = wb.add_format({"bold": True, "border": 1, "align": "center", "valign": "top"})
    head_plain = wb.add_format({"bold": True})
    for name, df in sheets.items():
        if name.startswith("_"):
            continue
        ws = wb.add_worksheet(name)
        fmt = head_plain if name == "Final_Data" else head
        for c, col in enumerate(df.columns):
            ws.write(0, c, col, fmt)
        for r, row in enumerate(df.itertuples(index=False, name=None), start=1):
            for c, v in enumerate(row):
                if v is None or (isinstance(v, float) and v != v):
                    continue
                if isinstance(v, (int, np.integer)) or (isinstance(v, (float, np.floating)) and float(v).is_integer()):
                    ws.write_number(r, c, int(v))
                elif isinstance(v, (float, np.floating)):
                    ws.write_number(r, c, float(v))
                else:
                    ws.write_string(r, c, str(v))
        ws.set_column(0, max(len(df.columns) - 1, 0), 13)
        if name == "Final_Data":
            ws.freeze_panes(1, 0)
            ws.autofilter(0, 0, max(len(df), 1), len(df.columns) - 1)
    wb.close()
    return buf.getvalue()


def download(store: BlobStore, settings: Settings, scope: Scope) -> Tuple[bytes, str]:
    """(xlsx bytes, file name); built once per build version and filter."""
    _, etag = _payload(store, settings)
    key = (etag, scope)
    with _lock:
        if key not in _cache:
            sheets = frames(store, settings, scope)
            last = str(sheets["_meta"]["latest"].iloc[0])
            name = f"BO_Data_{scope.label() or last}".replace(" ", "_").replace("/", "-")
            if len(_cache) > 8:
                _cache.clear()
            _cache[key] = (to_xlsx(sheets), f"{name}.xlsx")
        return _cache[key]


_summaries: Dict[Tuple, dict] = {}


def summary(store: BlobStore, settings: Settings, scope: Scope) -> dict:
    """On-screen preview: the two small summary sheets and the row count (cached per build version and filter)."""
    _, etag = _payload(store, settings)
    key = (etag, scope)
    if key not in _summaries:
        if len(_summaries) > 32:
            _summaries.clear()
        _summaries[key] = _summary(store, settings, scope)
    return _summaries[key]


def _summary(store: BlobStore, settings: Settings, scope: Scope) -> dict:
    s = frames(store, settings, scope)
    clean = lambda df: [[None if isinstance(v, float) and v != v else (int(v) if isinstance(v, (np.integer,)) else v)
                         for v in row] for row in df.itertuples(index=False, name=None)]
    return {"rows": int(len(s["Consolidated_Tiered"])), "latest": str(s["_meta"]["latest"].iloc[0]),
            "partial": bool(s["_meta"]["partial"].iloc[0]),
            "tierDistribution": {"columns": list(s["Tier_Distribution"].columns), "rows": clean(s["Tier_Distribution"])},
            "movementSummary": {"columns": list(s["Tier_Movement_Summary"].columns),
                                "rows": clean(s["Tier_Movement_Summary"])}}
