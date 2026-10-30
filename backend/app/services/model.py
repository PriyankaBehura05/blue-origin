"""
Analytics model: joins the stored datasets into the shapes the React app shows.

Built once per data version (see DataRepository.snapshot) and cached, so every endpoint
reads the same figures. All frames use the frontend's camelCase field names.

Period conventions (Indian FY, Apr-Mar; named after the year it ends):
  * FY label       "FY 27"       = Apr-2026 .. Mar-2027
  * quarter label  "Q1 FY 27"    = Apr-Jun 2026, Q2 = Jul-Sep 2026, Q3 = Oct-Dec 2026, Q4 = Jan-Mar 2027
  * current quarter = the quarter of the latest valid sales date (today when there are no sales)

Only VALID sales rows are counted. Rows flagged invalid / missing / duplicate / needs_review
stay in the store and are visible through the upload validation report, but are not summed.
"""
import re
import threading
import weakref
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

from app.core.constants import (BENEFIT_FREQUENCIES, FULFILLMENT_STATUSES, MOVE_DOWN, MOVE_DROPPED, MOVE_NEVER,
                                MOVE_NEW, MOVE_NONE, MOVE_SAME, MOVE_UP, PAN_INDIA, UNRANKED, DatasetType,
                                RecordStatus)
from app.processing.data_cleaner import name_match_key
from app.processing.data_transformer import internal_id_for_code, internal_id_for_name
from app.repositories.base import DataRepository
from app.rules.geography_rules import region_for_state
from app.rules.tier_rules import classify_amount, get_tier_config

_UNUSABLE = {RecordStatus.INVALID.value, RecordStatus.MISSING.value, RecordStatus.DUPLICATE.value}
# "Q1 FY 27" (current), "Q1 FY27", "Q1_FY27" (Power BI) and the older "Q1 FY26-27" are all understood
_QUARTER_RE = re.compile(r"^Q([1-4])[ _]?FY[ _]?(\d{2})(?:-(\d{2}))?$", re.I)


# ------------------------------------------------------------------ periods
def fy_start(d: date) -> int:
    return d.year if d.month >= 4 else d.year - 1


def quarter_of(d: date) -> Tuple[int, int]:
    return fy_start(d), (d.month - 4) % 12 // 3 + 1


def fy_label(fy: int) -> str:
    """Single-year label named after the year the FY ends: Apr-2026..Mar-2027 -> 'FY 27'."""
    return f"FY {(fy + 1) % 100:02d}"


def quarter_label(fy: int, q: int) -> str:
    return f"Q{q} {fy_label(fy)}"


def parse_quarter_label(label: Optional[str]) -> Optional[Tuple[int, int]]:
    """(FY start year, quarter) from a quarter label: 'Q1 FY 27' -> (2026, 1); 'Q1 FY26-27' -> (2026, 1)."""
    m = _QUARTER_RE.match((label or "").strip())
    if not m:
        return None
    year = 2000 + int(m.group(2))
    return (year if m.group(3) else year - 1), int(m.group(1))


def normalize_quarter_label(label: Optional[str]) -> Optional[str]:
    """Any understood quarter label in the current single-year format; other text unchanged."""
    parsed = parse_quarter_label(label) if label else None
    return quarter_label(*parsed) if parsed else label


def quarter_start(fy: int, q: int) -> date:
    """First day of a fiscal quarter: Q1 -> 1 Apr, Q2 -> 1 Jul, Q3 -> 1 Oct, Q4 -> 1 Jan (next year)."""
    return date(fy + (q == 4), (q * 3) % 12 + 1, 1)


def quarter_end(fy: int, q: int) -> date:
    """Last day of a fiscal quarter: Q1 -> 30 Jun, Q2 -> 30 Sep, Q3 -> 31 Dec, Q4 -> 31 Mar (next year)."""
    month = 3 + q * 3
    year = fy if month <= 12 else fy + 1
    month = (month - 1) % 12 + 1
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return date.fromordinal(nxt.toordinal() - 1)


def previous_quarter(fy: int, q: int) -> Tuple[int, int]:
    return (fy, q - 1) if q > 1 else (fy - 1, 4)


def same_day_last_year(d: date) -> date:
    try:
        return d.replace(year=d.year - 1)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year - 1, day=28)


def month_label(key: str) -> str:
    y, m = int(key[:4]), int(key[5:7])
    return f"{date(y, m, 1):%b} {y % 100:02d}"


def last_n_months(end: date, n: int) -> List[str]:
    out, y, m = [], end.year, end.month
    for _ in range(n):
        out.append(f"{y}-{m:02d}")
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


# ------------------------------------------------------------------ value helpers
def _txt(v) -> Optional[str]:
    if v is None or (isinstance(v, float) and v != v):
        return None
    s = str(v).strip()
    return s or None


def _num(v, default: float = 0.0) -> float:
    try:
        f = float(v)
        return default if f != f else f
    except (TypeError, ValueError):
        return default


def _date(v) -> Optional[date]:
    return v if isinstance(v, date) else None


def canon(value, vocabulary: Iterable[str]) -> Optional[str]:
    """Match a free-text value to a vocabulary case/spacing-insensitively; keep it as-is otherwise."""
    s = _txt(value)
    if s is None:
        return None
    key = re.sub(r"[\s_-]+", " ", s).casefold()
    for word in vocabulary:
        if re.sub(r"[\s_-]+", " ", word).casefold() == key:
            return word
    return s


def canon_status(value) -> Optional[str]:
    s = _txt(value)
    return s.title() if s else None


def canon_region(value) -> Optional[str]:
    s = _txt(value)
    if s is None:
        return None
    if re.sub(r"[\s_-]+", "", s).casefold() in {"panindia", "allindia", "national", "all"}:
        return PAN_INDIA
    return s.title() if s.islower() or s.isupper() else s


def usable(df: pd.DataFrame) -> pd.DataFrame:
    return df[~df["_row_status"].isin(_UNUSABLE)]


# ------------------------------------------------------------------ model
@dataclass
class Periods:
    latest_sales_date: Optional[date]
    current: Tuple[int, int]
    previous: Tuple[int, int]

    @property
    def current_label(self) -> str:
        return quarter_label(*self.current)

    @property
    def previous_label(self) -> str:
        return quarter_label(*self.previous)

    @property
    def current_fy(self) -> int:
        return self.current[0]


@dataclass
class Model:
    today: date
    periods: Periods
    sales: pd.DataFrame
    retailers: pd.DataFrame
    distributors: pd.DataFrame
    benefits: pd.DataFrame
    fulfillments: pd.DataFrame
    targets: pd.DataFrame
    tier_definitions: List[dict]
    movements: pd.DataFrame
    tier_rank: Dict[str, int]
    tier_names: Dict[str, str] = field(default_factory=dict)        # tier code -> name
    quarter_sums: Optional[pd.Series] = None                        # net sales by (fyStart, q, retailerId)
    _views: Dict[Tuple[int, int], pd.DataFrame] = field(default_factory=dict, repr=False)

    @property
    def sales_quarters(self) -> List[Tuple[int, int]]:
        """Quarters that have sales, newest first."""
        if self.quarter_sums is None or self.quarter_sums.empty:
            return [self.periods.current]
        pairs = {(int(a), int(b)) for a, b in zip(self.quarter_sums.index.get_level_values(0),
                                                    self.quarter_sums.index.get_level_values(1))}
        return sorted(pairs, reverse=True)

    def _qsum(self, fy: int, q: int) -> pd.Series:
        try:
            return self.quarter_sums.xs((fy, q), level=(0, 1))
        except (KeyError, AttributeError):
            return pd.Series(dtype=float)

    def _first_quarter(self) -> Dict[str, Tuple[int, int]]:
        """Retailer id -> first quarter with a purchase."""
        if "first" not in self._views:
            s = self.quarter_sums
            pos = s[s > 0] if s is not None else pd.Series(dtype=float)
            first: Dict[str, Tuple[int, int]] = {}
            for (fy, q, rid) in pos.index:
                if rid not in first or (fy, q) < first[rid]:
                    first[rid] = (int(fy), int(q))
            self._views["first"] = first          # type: ignore[assignment]
        return self._views["first"]               # type: ignore[return-value]

    def _ever_tiered_before(self, fy: int, q: int) -> set:
        """Retailers that were on a tier in any quarter with sales before (fy, q)."""
        out: set = set()
        for f2, q2 in self.sales_quarters:
            if (f2, q2) < (fy, q):
                v = self.quarter_view(f2, q2)
                out |= set(v.loc[v["tier"] != UNRANKED, "id"])
        return out

    def quarter_view(self, fy: int, q: int) -> pd.DataFrame:
        """Every retailer with its sales and tier in quarter (fy, q) and the quarter before it.
        Tiers are classified on that quarter's net sales with the same rules as the current quarter."""
        key = (fy, q)
        if key in self._views:
            return self._views[key]
        pf, pq = previous_quarter(fy, q)
        cur, prev = self._qsum(fy, q), self._qsum(pf, pq)
        r = self.retailers[["id", "code", "name", "distributorId", "distributorName", "region", "channel", "city",
                            "state", "status"]].copy()
        r["quarterSales"] = r["id"].map(cur).fillna(0.0).astype(float)
        r["previousQuarterSales"] = r["id"].map(prev).fillna(0.0).astype(float)

        def tiers(amounts: pd.Series, on: date) -> Tuple[pd.Series, pd.Series]:
            cls = _map(amounts, lambda a: classify_amount(a, on=on))   # tiers in force in that quarter
            return (cls.map(lambda c: _tier_name(c.tier_code, self.tier_names)),
                    cls.map(lambda c: c.status.value))

        r["tier"], r["tierStatus"] = tiers(r["quarterSales"], quarter_start(fy, q))
        r["previousTier"], _ = tiers(r["previousQuarterSales"], quarter_start(pf, pq))
        a = r["previousTier"].map(lambda t: self.tier_rank.get(t, 0))
        b = r["tier"].map(lambda t: self.tier_rank.get(t, 0))
        first = self._first_quarter()
        is_new = r["id"].map(lambda i: first.get(i) == (fy, q))
        was_tiered = r["id"].isin(self._ever_tiered_before(fy, q)) | (a > 0)
        conds = [is_new, r["quarterSales"] <= 0, (b > 0) & (b > a), (b > 0) & (b < a), b > 0, was_tiered]
        r["direction"] = np.select([pd.Series(c, index=r.index).astype(bool).to_numpy() for c in conds],
                                   [MOVE_NEW, MOVE_NONE, MOVE_UP, MOVE_DOWN, MOVE_SAME, MOVE_DROPPED], MOVE_NEVER)
        r["quarter"] = quarter_label(fy, q)
        r["previousQuarter"] = quarter_label(pf, pq)
        self._views[key] = r
        return r


class _PartyIndex:
    """Resolves (code, name) pairs from any dataset to a retailer/distributor id."""

    def __init__(self, prefix: str, master: pd.DataFrame, code_col: str, name_col: str):
        self.prefix = prefix
        self.ids = set(master["internal_id"]) if len(master) else set()
        keys = master[name_col].map(name_match_key) if len(master) else pd.Series(dtype=object)
        counts = keys.value_counts()
        self.by_name = {k: i for k, i in zip(keys, master.get("internal_id", [])) if k and counts.get(k) == 1}

    def resolve(self, code, name) -> Optional[str]:
        code, key = _txt(code), name_match_key(name)
        if code:
            cid = internal_id_for_code(self.prefix, code)
            if cid in self.ids or key not in self.by_name:
                return cid
        if key in self.by_name:
            return self.by_name[key]
        return internal_id_for_name(self.prefix, key) if key else None


def _master(df: pd.DataFrame, name_col: str) -> pd.DataFrame:
    """Master rows: every named row except exact duplicates. A row flagged for one bad field
    (e.g. pincode) is still the retailer/distributor, so it is kept."""
    df = df[(df["_row_status"] != RecordStatus.DUPLICATE.value) & df[name_col].notna()]
    return df.drop_duplicates("internal_id", keep="first")


def _col(df: pd.DataFrame, c: str) -> pd.Series:
    if c in df:
        return df[c].astype(object).where(df[c].notna(), None)
    return pd.Series([None] * len(df), index=df.index, dtype=object)


def _map(series: pd.Series, fn) -> pd.Series:
    """Apply fn once per distinct value (fast for repetitive columns)."""
    cache: Dict = {}

    def get(v):
        key = None if v is None or (isinstance(v, float) and v != v) else v
        if key not in cache:
            cache[key] = fn(key)
        return cache[key]
    return pd.Series([get(v) for v in series.tolist()], index=series.index, dtype=object)


def _coalesce(*parts: pd.Series) -> pd.Series:
    out = parts[0]
    for p in parts[1:]:
        out = out.where(out.notna(), p)
    return out.astype(object).where(out.notna(), None)


def _resolve_many(index: "_PartyIndex", codes: pd.Series, names: pd.Series) -> pd.Series:
    cache: Dict = {}
    out = []
    for c, n in zip(codes.tolist(), names.tolist()):
        if (c, n) not in cache:
            cache[(c, n)] = index.resolve(c, n)
        out.append(cache[(c, n)])
    return pd.Series(out, index=codes.index, dtype=object)


def _num_col(df: pd.DataFrame, c: str, default: float = 0.0) -> pd.Series:
    if c not in df:
        return pd.Series(default, index=df.index, dtype=float)
    return pd.to_numeric(df[c], errors="coerce").fillna(default).astype(float)


def _from_master(master: pd.DataFrame, ids: pd.Series, c: str) -> pd.Series:
    """Column c of the master row for each id (None when absent)."""
    if c not in master:
        return pd.Series([None] * len(ids), index=ids.index, dtype=object)
    return _col(master, c).reindex(ids.tolist()).set_axis(ids.index)


def _build_sales(raw: pd.DataFrame, rets: _PartyIndex, dists: _PartyIndex,
                 ret_master: pd.DataFrame, dist_master: pd.DataFrame) -> pd.DataFrame:
    cols = ["id", "date", "month", "quarter", "fyStart", "q", "fy", "retailerId", "retailerName", "retailerCode", "city",
            "distributorId", "distributorName", "distributorCode", "state", "region", "channel", "category",
            "asm", "rsm", "quantity", "grossAmount", "returnAmount", "netAmount"]
    s = raw[raw["_row_status"] == RecordStatus.VALID.value].reset_index(drop=True)
    if s.empty:
        return pd.DataFrame(columns=cols)
    rid = _resolve_many(rets, _col(s, "retailer_code"), _col(s, "retailer_name"))
    did = _resolve_many(dists, _col(s, "distributor_code"), _col(s, "distributor_name"))
    rm = ret_master.set_index("internal_id")
    dm = dist_master.set_index("internal_id")

    dates = s["invoice_date"].astype(object)
    periods = _map(dates, lambda d: (quarter_of(d), f"{d:%Y-%m}"))
    # a quarter given with the row wins over the date's own quarter: the BO build puts Sept 2024 in Q3 FY 25
    given = _col(s, "quarter").map(lambda v: parse_quarter_label(v) if isinstance(v, str) and v.strip() else None)
    if given.notna().any():
        periods = pd.Series([(g, p[1]) if g else p for g, p in zip(given, periods)], index=periods.index)
    state = _coalesce(_col(s, "state"), _from_master(rm, rid, "state"))
    inv = _col(s, "invoice_no")
    inv_ok = inv.notna() & ~inv.duplicated(keep=False)
    net = _num_col(s, "net_sales_amount")
    returns = _num_col(s, "return_amount")
    gross = _num_col(s, "gross_amount", float("nan")).fillna(net + returns)
    return pd.DataFrame({
        "id": inv.where(inv_ok, "ROW-" + s["_source_row"].astype(int).astype(str)),
        "date": dates, "month": periods.map(lambda p: p[1]),
        "quarter": periods.map(lambda p: quarter_label(*p[0])),
        "fyStart": periods.map(lambda p: p[0][0]).astype(int), "q": periods.map(lambda p: p[0][1]).astype(int),
        "fy": periods.map(lambda p: fy_label(p[0][0])),
        "retailerId": rid, "retailerName": _col(s, "retailer_name"), "retailerCode": _col(s, "retailer_code"),
        "city": _coalesce(_col(s, "city"), _from_master(rm, rid, "city")),
        "distributorId": did, "distributorName": _col(s, "distributor_name"),
        "distributorCode": _col(s, "distributor_code"), "state": state,
        "region": _coalesce(_map(_col(s, "region"), canon_region),
                            _map(_from_master(rm, rid, "region"), canon_region),
                            _map(state, region_for_state), _map(_from_master(dm, did, "region"), canon_region)),
        "channel": _coalesce(_col(s, "channel"), _from_master(rm, rid, "channel")),
        "category": _col(s, "category"),
        "asm": _coalesce(_col(s, "asm"), _from_master(rm, rid, "asm")),
        "rsm": _coalesce(_col(s, "rsm"), _from_master(rm, rid, "rsm")),
        "quantity": _num_col(s, "quantity"), "grossAmount": gross, "returnAmount": returns, "netAmount": net,
    }, columns=cols)


def _sum_by(sales: pd.DataFrame, mask, key: str) -> Dict[str, float]:
    return sales[mask].groupby(key)["netAmount"].sum().to_dict() if len(sales) else {}


def _tier_name(code: Optional[str], names: Dict[str, str]) -> str:
    return names.get(code, UNRANKED) if code else UNRANKED


def build_model(datasets: Dict[DatasetType, pd.DataFrame], today: Optional[date] = None) -> Model:
    today = today or date.today()
    cfg = get_tier_config()
    tier_names = {b.code: b.name for b in cfg.bands}
    tier_rank = {UNRANKED: 0, **{b.name: b.rank for b in cfg.bands}}
    tier_vocab = list(tier_rank)

    ret_master = _master(datasets[DatasetType.RETAILERS], "retailer_name")
    dist_master = _master(datasets[DatasetType.DISTRIBUTORS], "distributor_name")
    rets = _PartyIndex("RET", ret_master, "retailer_code", "retailer_name")
    dists = _PartyIndex("DIST", dist_master, "distributor_code", "distributor_name")

    sales = _build_sales(datasets[DatasetType.SALES], rets, dists, ret_master, dist_master)

    # ---- periods
    latest = max(sales["date"]) if len(sales) else None
    cur = quarter_of(latest or today)
    prev = previous_quarter(*cur)
    periods = Periods(latest, cur, prev)

    is_cur = (sales["fyStart"] == cur[0]) & (sales["q"] == cur[1])
    is_prev = (sales["fyStart"] == prev[0]) & (sales["q"] == prev[1])
    is_fy = sales["fyStart"] == cur[0]
    cur_by_ret, prev_by_ret = _sum_by(sales, is_cur, "retailerId"), _sum_by(sales, is_prev, "retailerId")
    fy_by_ret = _sum_by(sales, is_fy, "retailerId")
    cur_by_dist = _sum_by(sales, is_cur, "distributorId")

    # ---- retailers (master rows + parties seen only in sales)
    rm = ret_master
    rm_did = _resolve_many(dists, _col(rm, "distributor_code"), _col(rm, "distributor_name"))
    dist_region = dict(zip(dist_master["internal_id"], _map(_col(dist_master, "region"), canon_region)))
    rm_state = _col(rm, "state")
    master_rows = pd.DataFrame({
        "id": rm["internal_id"], "code": _col(rm, "retailer_code"), "name": _col(rm, "retailer_name"),
        "distributorId": rm_did, "distributorName": _col(rm, "distributor_name"), "channel": _col(rm, "channel"),
        "city": _col(rm, "city"), "state": rm_state,
        "region": _coalesce(_map(_col(rm, "region"), canon_region), _map(rm_state, region_for_state),
                            _map(rm_did, dist_region.get)),
        "pincode": _col(rm, "pincode"), "asm": _col(rm, "asm"), "rsm": _col(rm, "rsm"),
        "status": _map(_col(rm, "status"), lambda v: canon_status(v) or "Unknown"),
        "onboardedOn": _map(_col(rm, "onboarding_date"), _date), "inMaster": True,
    })
    only = sales[~sales["retailerId"].isin(set(rm["internal_id"]))].sort_values("date", ascending=False)
    only = only.drop_duplicates("retailerId")
    sales_rows = pd.DataFrame({
        "id": only["retailerId"], "code": only["retailerCode"], "name": only["retailerName"],
        "distributorId": only["distributorId"], "distributorName": only["distributorName"],
        "channel": only["channel"], "city": only["city"], "state": only["state"], "region": only["region"],
        "pincode": None, "asm": only["asm"], "rsm": only["rsm"], "status": "Unknown", "onboardedOn": None,
        "inMaster": False,
    })
    parts = [p for p in (master_rows, sales_rows) if len(p)]
    retailers = pd.concat(parts, ignore_index=True) if parts else master_rows.reset_index(drop=True)
    retailers["currentQuarterSales"] = retailers["id"].map(cur_by_ret).fillna(0.0).astype(float)
    retailers["previousQuarterSales"] = retailers["id"].map(prev_by_ret).fillna(0.0).astype(float)
    retailers["fySales"] = retailers["id"].map(fy_by_ret).fillna(0.0).astype(float)
    cur_cls = _map(retailers["currentQuarterSales"], lambda a: classify_amount(a, on=quarter_start(*cur)))
    prev_cls = _map(retailers["previousQuarterSales"], lambda a: classify_amount(a, on=quarter_start(*prev)))
    retailers["currentTier"] = pd.Series([_tier_name(c.tier_code, tier_names) for c in cur_cls], dtype=object)
    retailers["previousTier"] = pd.Series([_tier_name(c.tier_code, tier_names) for c in prev_cls], dtype=object)
    retailers["tierStatus"] = pd.Series([c.status.value for c in cur_cls], dtype=object)

    # ---- distributors
    dist_rows: Dict[str, dict] = {}
    for _, d in dist_master.iterrows():
        state = _txt(d.get("state"))
        dist_rows[d["internal_id"]] = {
            "id": d["internal_id"], "name": _txt(d.get("distributor_name")), "code": _txt(d.get("distributor_code")),
            "state": state, "city": _txt(d.get("city")),
            "region": canon_region(d.get("region")) or region_for_state(state),
            "asm": _txt(d.get("asm")), "rsm": _txt(d.get("rsm")),
            "status": canon_status(d.get("status")) or "Unknown",
            "onboardedOn": _date(d.get("onboarding_date")), "inMaster": True,
        }
    if len(sales):
        for did, g in sales.sort_values("date", ascending=False).groupby("distributorId", sort=False):
            if did in dist_rows:
                continue
            first = g.iloc[0]
            dist_rows[did] = {"id": did, "name": first["distributorName"], "code": first["distributorCode"],
                              "state": first["state"], "city": first["city"], "region": first["region"],
                              "asm": first["asm"], "rsm": first["rsm"], "status": "Unknown",
                              "onboardedOn": None, "inMaster": False}
    ret_count = retailers["distributorId"].value_counts().to_dict() if len(retailers) else {}
    for did, d in dist_rows.items():
        d.update(retailerCount=int(ret_count.get(did, 0)), currentQuarterSales=cur_by_dist.get(did, 0.0))
    distributors = pd.DataFrame(list(dist_rows.values()), columns=[
        "id", "name", "code", "state", "city", "region", "asm", "rsm", "status", "onboardedOn", "inMaster",
        "retailerCount", "currentQuarterSales"])

    # ---- benefits catalogue
    b = usable(datasets[DatasetType.BENEFITS])
    benefits = pd.DataFrame([{
        "id": _txt(r.get("id")), "name": _txt(r.get("name")), "tier": canon(r.get("tier"), tier_vocab),
        "frequency": canon(r.get("frequency"), BENEFIT_FREQUENCIES),
        "quantity": _num(r.get("quantity"), 1.0), "unitCost": _num(r.get("unit_cost")),
        "description": _txt(r.get("description")),
    } for _, r in b.iterrows() if _txt(r.get("id"))],
        columns=["id", "name", "tier", "frequency", "quantity", "unitCost", "description"])
    ben_by_id = {str(k).casefold(): v for k, v in benefits.set_index("id").to_dict("index").items()}

    # ---- fulfilments
    f = usable(datasets[DatasetType.FULFILLMENTS])
    keep = _col(f, "id").notna() & _map(_col(f, "planned_date"), _date).notna()
    f = f[keep].reset_index(drop=True)
    planned = _map(_col(f, "planned_date"), _date)
    bid = _col(f, "benefit_id")
    bkey = _map(bid, lambda v: str(v).casefold() if v is not None else None)

    def ben_field(c: str) -> pd.Series:
        return _map(bkey, lambda k: ben_by_id.get(k, {}).get(c))

    f_rid = _resolve_many(rets, _col(f, "retailer_code"), _col(f, "retailer_name"))
    actual = _map(_col(f, "actual_date"), _date)
    raw_status = _map(_col(f, "status"), lambda v: canon(v, FULFILLMENT_STATUSES))
    overdue = pd.Series([p < today for p in planned], index=f.index, dtype=bool)
    status = np.select([(actual.notna() | (raw_status == "Fulfilled")).to_numpy(), overdue.to_numpy(),
                        (raw_status == "In Progress").to_numpy()], ["Fulfilled", "Overdue", "In Progress"], "Planned")
    ret_names = retailers.set_index("id")["name"].to_dict() if len(retailers) else {}
    cost_default = (pd.to_numeric(ben_field("quantity"), errors="coerce").fillna(1.0)
                    * pd.to_numeric(ben_field("unitCost"), errors="coerce").fillna(0.0))
    fulfillments = pd.DataFrame({
        "id": _col(f, "id"), "benefitId": bid, "benefitName": _coalesce(ben_field("name"), bid),
        "retailerId": f_rid.fillna(""),
        "retailerName": _coalesce(_map(f_rid, ret_names.get), _col(f, "retailer_name"),
                                  _col(f, "retailer_code")).fillna("-"),
        "tier": _coalesce(_map(_col(f, "tier"), lambda v: canon(v, tier_vocab)), ben_field("tier")).fillna(UNRANKED),
        "quarter": _coalesce(_map(_col(f, "quarter"), normalize_quarter_label),
                             _map(planned, lambda d: quarter_label(*quarter_of(d)))),
        "plannedDate": planned, "actualDate": actual, "status": status,
        "cost": _num_col(f, "cost", float("nan")).fillna(cost_default).astype(float),
    }, columns=["id", "benefitId", "benefitName", "retailerId", "retailerName", "tier", "quarter", "plannedDate",
                "actualDate", "status", "cost"])
    fulfillments["fy"] = _map(fulfillments["quarter"], lambda l: fy_label(parse_quarter_label(l)[0])
                              if parse_quarter_label(l) else None)

    # ---- targets
    t = datasets[DatasetType.TARGETS]
    t = t[t["_row_status"] == RecordStatus.VALID.value]
    targets = pd.DataFrame({
        "month": t["month"].tolist(), "target": [_num(v) for v in t["target_amount"]],
        "region": [canon_region(v) for v in t["region"]] if "region" in t else None,
        "channel": [_txt(v) for v in t["channel"]] if "channel" in t else None,
    }, columns=["month", "target", "region", "channel"])

    # ---- tiers
    # Counted over retailers that bought this quarter: "Unranked" = bought, but below the lowest tier
    # (retailers with no purchases this quarter are not part of the tier mix).
    buying = retailers[retailers["currentQuarterSales"] != 0]
    counts = buying["currentTier"].value_counts().to_dict() if len(buying) else {}
    unranked = cfg.raw.get("unranked", {})
    lowest = cfg.bands[0].min_amount if cfg.bands else 0.0
    tier_definitions = [{
        "tier": UNRANKED, "minQuarterlySales": 0.0, "maxQuarterlySales": lowest,
        "color": unranked.get("color", "#94a3b8"),
        "description": unranked.get("description", "Below the lowest tier threshold"),
        "retailerCount": int(counts.get(UNRANKED, 0)),
    }] + [{
        "tier": band.name, "minQuarterlySales": band.min_amount, "maxQuarterlySales": band.max_amount,
        "color": band.color, "description": band.description, "retailerCount": int(counts.get(band.name, 0)),
        "effectiveFrom": band.effective_from,
    } for band in cfg.bands]

    retailers["movement"] = MOVE_NONE
    model = Model(today, periods, sales, retailers, distributors, benefits, fulfillments, targets,
                  tier_definitions, pd.DataFrame(), tier_rank, tier_names,
                  sales.groupby(["fyStart", "q", "retailerId"])["netAmount"].sum() if len(sales) else None)
    # movement in the current quarter (same rules as the Tiers page): New, Upgraded, ... No sales
    view = model.quarter_view(*cur)
    retailers["movement"] = retailers["id"].map(dict(zip(view["id"], view["direction"]))).fillna(MOVE_NONE)
    moved = view[(view["quarterSales"] != 0) | (view["previousQuarterSales"] != 0)]
    model.movements = pd.DataFrame({
        "retailerId": moved["id"], "retailerName": moved["name"], "from": moved["previousTier"],
        "to": moved["tier"], "quarter": periods.current_label, "direction": moved["direction"],
        "quarterlySales": moved["quarterSales"], "previousQuarterSales": moved["previousQuarterSales"],
    }).reset_index(drop=True)
    return model


# ------------------------------------------------------------------ cache
_LOCK = threading.Lock()
_BUILD_LOCK = threading.Lock()   # one build at a time: concurrent requests wait for it instead of rebuilding
_CACHE: "weakref.WeakKeyDictionary[DataRepository, Tuple[tuple, date, Model]]" = weakref.WeakKeyDictionary()


def _cached(repo: DataRepository, token: tuple, today: date) -> Optional[Model]:
    with _LOCK:
        hit = _CACHE.get(repo)
        return hit[2] if hit and hit[0] == token and hit[1] == today else None


def get_model(repo: DataRepository, today: Optional[date] = None) -> Model:
    today = today or date.today()
    token, _ = repo.snapshot()
    model = _cached(repo, token, today)
    if model is not None:
        return model
    with _BUILD_LOCK:
        token, datasets = repo.snapshot()        # re-check: another request may have just built it
        model = _cached(repo, token, today)
        if model is None:
            model = build_model(datasets, today)
            with _LOCK:
                _CACHE[repo] = (token, today, model)
    return model

