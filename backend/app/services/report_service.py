"""
Standard reports. Each report is computed from the analytics model (never re-implemented),
previewed in the UI and exported as CSV or XLSX. Export times are logged to meta/reports.json
in the data store so the UI can show "last generated".

Every report takes the same filters (all optional, empty = all): month (YYYY-MM), quarter ("Q2 FY 27"), region,
state and distributor (id). The period filters choose the period of the period-based reports (default: the
current quarter; a month also picks its quarter for tiers); region, state and distributor narrow the rows.
"""
import json
import re
import threading
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

import pandas as pd

from app.core.constants import MOVE_DOWN, MOVE_UP
from app.core.errors import InvalidFilterError, NotFoundError
from app.repositories.base import DataRepository
from app.services.common import to_file
from app.services.model import Model, month_label, parse_quarter_label, quarter_label, quarter_of
from app.storage.base import META_DIR, BlobStore

LOG_PATH = f"{META_DIR}/reports.json"
_LOCK = threading.Lock()

Table = Tuple[List[str], List[list]]


@dataclass(frozen=True)
class ReportFilters:
    month: str = ""          # 'YYYY-MM'
    quarter: str = ""        # 'Q2 FY 27'
    region: str = ""
    state: str = ""
    distributor: str = ""    # distributor id

    @classmethod
    def of(cls, month=None, quarter=None, region=None, state=None, distributor=None) -> "ReportFilters":
        f = cls(*(str(v or "").strip() for v in (month, quarter, region, state, distributor)))
        if f.month and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", f.month):
            raise InvalidFilterError("month must look like 2026-09.", details={"month": f.month})
        if f.quarter and parse_quarter_label(f.quarter) is None:
            raise InvalidFilterError("quarter must look like 'Q2 FY 27'.", details={"quarter": f.quarter})
        return f

    def period(self, m: Model) -> Tuple[Tuple[int, int], Optional[str]]:
        """((FY start, quarter), month or None): a month picks its own quarter; default = the current quarter."""
        if self.month:   # the quarter the data puts the month in (Sept 2024 counts in Q3 FY 25), else its own
            hit = m.sales.loc[m.sales["month"] == self.month, ["fyStart", "q"]] if "month" in m.sales else None
            if hit is not None and len(hit):
                return (int(hit.iloc[0]["fyStart"]), int(hit.iloc[0]["q"])), self.month
            return quarter_of(date(int(self.month[:4]), int(self.month[5:7]), 1)), self.month
        if self.quarter:
            return parse_quarter_label(self.quarter), None
        return m.periods.current, None

    def period_label(self, m: Model) -> str:
        fq, month = self.period(m)
        return month_label(month) if month else quarter_label(*fq)

    def describe(self, m: Model) -> str:
        """'Sep 26 · South · Karnataka · ABC Distributors' (empty when no filter is set)."""
        dist = ""
        if self.distributor:
            hit = m.distributors.loc[m.distributors["id"] == self.distributor, "name"]
            dist = str(hit.iloc[0]) if len(hit) else self.distributor
        period = month_label(self.month) if self.month else self.quarter
        return " · ".join(v for v in (period, self.region, self.state, dist) if v)


def _r(v) -> int:
    return int(round(float(v)))


def _iso(v) -> str:
    return v.isoformat() if v is not None and v == v else ""


def _geo(df: pd.DataFrame, f: ReportFilters, dist_col: str = "distributorId") -> pd.DataFrame:
    """Rows of the chosen region / state / distributor."""
    if f.region and "region" in df:
        df = df[df["region"] == f.region]
    if f.state and "state" in df:
        df = df[df["state"] == f.state]
    if f.distributor and dist_col in df:
        df = df[df[dist_col] == f.distributor]
    return df


def _period_sales(m: Model, f: ReportFilters) -> pd.DataFrame:
    """Sales of the chosen period (a month, or a quarter) in the chosen region / state / distributor."""
    (fy, q), month = f.period(m)
    s = m.sales
    s = s[s["month"] == month] if month else s[(s["fyStart"] == fy) & (s["q"] == q)]
    return _geo(s, f)


def _retailer_ids(m: Model, f: ReportFilters) -> set:
    return set(_geo(m.retailers, f)["id"])


def _quarterly_sales_by_retailer(m: Model, f: ReportFilters) -> Table:
    (fy, q), month = f.period(m)
    view = _geo(m.quarter_view(fy, q), f)
    amount = view["quarterSales"]
    if month:   # the month's purchase; the tier stays the quarter's
        amount = view["id"].map(_period_sales(m, f).groupby("retailerId")["netAmount"].sum()).fillna(0.0)
    df = view.assign(amount=amount)
    df = df[df["amount"] != 0].sort_values("amount", ascending=False)
    return (["Retailer", "City", "Distributor", f"Tier ({quarter_label(fy, q)})", f"{f.period_label(m)} Net Sales (₹)"],
            [[r["name"], r["city"], r["distributorName"], r["tier"], _r(r["amount"])] for _, r in df.iterrows()])


def _monthly_sales_by_region(m: Model, f: ReportFilters) -> Table:
    s = _geo(m.sales, f)
    if f.month or f.quarter:
        (fy, q), month = f.period(m)
        s = s[s["month"] == month] if month else s[(s["fyStart"] == fy) & (s["q"] == q)]
    g = (s.assign(region=s["region"].fillna("Unassigned"))
         .groupby(["month", "region"])["netAmount"].sum().reset_index()
         .sort_values(["month", "region"], ascending=[False, True]))
    return ["Month", "Region", "Net Sales (₹)"], [[month_label(r["month"]), r["region"], _r(r["netAmount"])]
                                                  for _, r in g.iterrows()]


def _distributor_performance(m: Model, f: ReportFilters) -> Table:
    d = _geo(m.distributors, f, dist_col="id")
    sales = _period_sales(m, f).groupby("distributorId")["netAmount"].sum()
    df = d.assign(amount=d["id"].map(sales).fillna(0.0)).sort_values("amount", ascending=False)
    return (["Distributor", "Code", "Region", "Retailers", f"{f.period_label(m)} Net Sales (₹)"],
            [[r["name"], r["code"], r["region"], int(r["retailerCount"]), _r(r["amount"])] for _, r in df.iterrows()])


def _retailer_master(m: Model, f: ReportFilters) -> Table:
    df = _geo(m.retailers, f).sort_values("name", key=lambda s: s.str.casefold())
    return (["Retailer", "Code", "Distributor", "City", "State", "Pincode", "ASM", "RSM", "Status"],
            [[r["name"], r["code"], r["distributorName"], r["city"], r["state"], r["pincode"], r["asm"], r["rsm"],
              r["status"]] for _, r in df.iterrows()])


def _tier_movement(m: Model, f: ReportFilters) -> Table:
    (fy, q), _ = f.period(m)
    view = _geo(m.quarter_view(fy, q), f)
    df = view[view["direction"].isin([MOVE_UP, MOVE_DOWN])].sort_values("quarterSales", ascending=False)
    prev = df["previousQuarter"].iloc[0] if len(df) else "Previous quarter"
    return (["Retailer", "From", "To", "Movement", f"{prev} Net Sales (₹)", f"{quarter_label(fy, q)} Net Sales (₹)"],
            [[r["name"], r["previousTier"], r["tier"], r["direction"], _r(r["previousQuarterSales"]),
              _r(r["quarterSales"])] for _, r in df.iterrows()])


def _fulfilments(m: Model, f: ReportFilters) -> pd.DataFrame:
    df = m.fulfillments
    if f.region or f.state or f.distributor:
        df = df[df["retailerId"].isin(_retailer_ids(m, f))]
    if f.month or f.quarter:
        df = df[df["quarter"] == quarter_label(*f.period(m)[0])]
    return df


def _fulfilment_status(m: Model, f: ReportFilters) -> Table:
    df = _fulfilments(m, f).sort_values("plannedDate", ascending=False)
    return (["Retailer", "Benefit", "Tier", "Quarter", "Planned", "Actual", "Status", "Cost (₹)"],
            [[r["retailerName"], r["benefitName"], r["tier"], r["quarter"], _iso(r["plannedDate"]),
              _iso(r["actualDate"]), r["status"], _r(r["cost"])] for _, r in df.iterrows()])


def _overdue_benefits(m: Model, f: ReportFilters) -> Table:
    df = _fulfilments(m, f)
    df = df[df["status"] == "Overdue"].sort_values("plannedDate")
    return (["Retailer", "Benefit", "Planned", "Days overdue", "Cost (₹)"],
            [[r["retailerName"], r["benefitName"], _iso(r["plannedDate"]), (m.today - r["plannedDate"]).days,
              _r(r["cost"])] for _, r in df.iterrows()])


def _benefit_cost_by_tier(m: Model, f: ReportFilters) -> Table:
    g = _fulfilments(m, f).groupby(["tier", "quarter"])["cost"].sum().reset_index()
    rank = m.tier_rank
    g = g.assign(_rank=g["tier"].map(lambda t: rank.get(t, 99))).sort_values(["quarter", "_rank"], ascending=[False, True])
    return ["Tier", "Quarter", "Benefit Cost (₹)"], [[r["tier"], r["quarter"], _r(r["cost"])] for _, r in g.iterrows()]


@dataclass(frozen=True)
class ReportSpec:
    id: str
    name: str
    description: str
    category: str
    format: str
    build: Callable[[Model, ReportFilters], Table]
    uses_period: bool = True     # False: the month / quarter filters do not apply (a master list)


REPORTS: Dict[str, ReportSpec] = {r.id: r for r in [
    ReportSpec("RPT-01", "Quarterly Sales by Retailer", "Net sales per retailer for the chosen quarter or month, with tier",
               "Sales", "XLSX", _quarterly_sales_by_retailer),
    ReportSpec("RPT-02", "Monthly Sales by Region", "Month-wise net sales split by region", "Sales", "XLSX",
               _monthly_sales_by_region),
    ReportSpec("RPT-03", "Distributor Performance", "Retailer count and net sales per distributor for the chosen period",
               "Sales", "CSV", _distributor_performance),
    ReportSpec("RPT-04", "Retailer Master List", "Retailers with geography, distributor and ASM/RSM mapping",
               "Retailer", "CSV", _retailer_master, uses_period=False),
    ReportSpec("RPT-05", "Tier Movement Report", "Upgrades and downgrades vs the quarter before", "Tier", "XLSX",
               _tier_movement),
    ReportSpec("RPT-06", "Benefit Fulfilment Status", "Planned vs actual benefit fulfilment with cost", "Benefit",
               "XLSX", _fulfilment_status),
    ReportSpec("RPT-07", "Overdue Benefits", "Benefits past their planned date and not yet fulfilled", "Benefit",
               "XLSX", _overdue_benefits),
    ReportSpec("RPT-09", "Benefit Cost by Tier", "Benefit spend grouped by tier and quarter", "Finance", "XLSX",
               _benefit_cost_by_tier),
]}


def _spec(report_id: str) -> ReportSpec:
    spec = REPORTS.get(report_id)
    if spec is None:
        raise NotFoundError(f"Report '{report_id}' was not found.", details={"id": report_id})
    return spec


def _clean(rows: List[list]) -> List[list]:
    return [[None if v is None or (isinstance(v, float) and v != v) else v for v in row] for row in rows]


# ------------------------------------------------------------------ generation log
def _read_log(store: BlobStore) -> Dict[str, str]:
    raw = store.read(LOG_PATH)
    return json.loads(raw.decode("utf-8")) if raw else {}


def _log_generated(store: BlobStore, report_id: str) -> None:
    with _LOCK:
        log = _read_log(store)
        log[report_id] = datetime.now(timezone.utc).isoformat()
        store.write(LOG_PATH, json.dumps(log, indent=2).encode("utf-8"))


# ------------------------------------------------------------------ public
def definitions(store: BlobStore) -> List[dict]:
    log = _read_log(store)
    return [{"id": s.id, "name": s.name, "description": s.description, "category": s.category,
             "format": s.format, "last_generated": log.get(s.id), "uses_period": s.uses_period} for s in REPORTS.values()]


def preview(m: Model, report_id: str, limit: int = 25, f: ReportFilters = ReportFilters()) -> dict:
    columns, rows = _spec(report_id).build(m, f)
    return {"report_id": report_id, "columns": columns, "rows": _clean(rows[:limit]), "total_rows": len(rows),
            "filters": f.describe(m)}


def export(repo: DataRepository, m: Model, report_id: str, fmt: str,
           f: ReportFilters = ReportFilters()) -> Tuple[bytes, str, str]:
    """Returns (content, media type, filename) and records the generation time."""
    spec = _spec(report_id)
    fmt = fmt.lower()
    if fmt not in ("csv", "xlsx"):
        raise InvalidFilterError("format must be csv or xlsx.", details={"format": fmt})
    columns, rows = spec.build(m, f)
    df = pd.DataFrame(_clean(rows), columns=columns)
    scope = f.describe(m)
    parts = [spec.name] + ([scope] if scope else [f.period_label(m)] if spec.uses_period else [])
    stem = re.sub(r"[^\w\-]+", "_", "_".join(parts)).strip("_")
    summary = report_id in ("RPT-02", "RPT-03", "RPT-09")  # grouped reports get a TOTAL row
    note = f"{spec.description}  •  Revenue in ₹  •  " + (f"Filters: {scope}" if scope else
                                                         f"All regions, states and distributors  •  "
                                                         f"{'Period ' + f.period_label(m) if spec.uses_period else 'All retailers'}")
    content, media = to_file(df, fmt, spec.name, note, total=summary)
    _log_generated(repo.store, report_id)
    return content, media, f"{stem}.{fmt}"
