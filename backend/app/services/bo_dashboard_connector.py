"""
BO Dashboard connector: turns the consolidated Power BI files in Dropbox into platform datasets.

Source folder (BO_SOURCE_FOLDER, default "/Power BI/BO_Dashboard"):
    retailers.csv          one row per de-duplicated retailer (Retailer_ID, Distributor, State, Region, ...)
    retailer_month.csv     Retailer_ID, Month ("Sept_24"), Revenue, Quarter ("Q3_FY25")
    retailer_quarter.csv   Retailer_ID, Quarter, Reported_Tier, Deliverables, one Yes/No/Cancelled column per benefit
Tier scheme (BO_TIER_SCHEME, default "/Power BI/Tier_scheme.xlsx"): Tier, Benefits, Required (Yes/No)

Produces text tables with canonical column names for: retailers, distributors, sales (one row per
retailer per month), benefits (one per tier x required benefit) and fulfillments (one per retailer x
quarter x required benefit, for quarters with Deliverables = Yes).

Derivations (not present in the source, stated so they can be reviewed):
  * sales rows are dated the 1st of their month
  * distributor code = the Retailer_ID prefix (e.g. AJAH-00003 -> AJAH); distributor state/region =
    the most common among its retailers
  * retailer status = Active when it billed in the latest 6 months of data, otherwise Inactive
  * fulfilment: benefit "Yes" -> Fulfilled (actual date = quarter end), "No" -> not delivered
    (planned for quarter end, so it shows Overdue once the quarter is over), "Cancelled" -> skipped
"""
import io
import re
from datetime import date, timedelta
from typing import Callable, Dict, Optional

import pandas as pd

from app.core.constants import DatasetType
from app.rules.tier_rules import cap_tier

FILES = ("retailers.csv", "retailer_month.csv", "retailer_quarter.csv")
_MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10,
           "nov": 11, "dec": 12}
_TIER_ORDER = ["Yellow", "Green", "Silver", "Gold", "Platinum"]


def month_start(label: str) -> Optional[date]:
    """'Sept_24' / 'July_25' / 'Jun_26' -> first day of that month."""
    m = re.fullmatch(r"([A-Za-z]+)[_\- ]?(\d{2}|\d{4})", str(label).strip())
    if not m or m.group(1)[:3].lower() not in _MONTHS:
        return None
    year = int(m.group(2))
    return date(year + 2000 if year < 100 else year, _MONTHS[m.group(1)[:3].lower()], 1)


def quarter_info(label: str) -> Optional[tuple]:
    """'Q1_FY27' -> ('Q1 FY 27', quarter end date). FY27 = Apr-2026..Mar-2027."""
    m = re.fullmatch(r"Q([1-4])[_ ]?FY(\d{2})", str(label).strip(), flags=re.I)
    if not m:
        return None
    q, fy_end = int(m.group(1)), 2000 + int(m.group(2))
    fy_start = fy_end - 1
    end_month = 3 + q * 3                          # Q1 -> Jun, Q2 -> Sep, Q3 -> Dec, Q4 -> Mar (15)
    year = fy_start if end_month <= 12 else fy_start + 1
    end_month = (end_month - 1) % 12 + 1
    nxt = date(year + (end_month == 12), end_month % 12 + 1, 1)
    return f"Q{q} FY {fy_end % 100:02d}", nxt - timedelta(days=1)


def _csv(content: bytes) -> pd.DataFrame:
    return pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False, encoding="utf-8-sig")


def _mode(s: pd.Series) -> str:
    s = s[s.str.strip() != ""]
    return s.mode().iloc[0] if len(s) else ""


def _benefit_name(code: str) -> str:
    return {"GMB": "Google My Business", "SIS_Unit": "SIS Unit"}.get(code, code.replace("_", " ").title())


def build_tables(read: Callable[[str], bytes], tier_scheme: Optional[bytes]) -> Dict[DatasetType, pd.DataFrame]:
    r = _csv(read("retailers.csv"))
    month = _csv(read("retailer_month.csv"))
    quarter = _csv(read("retailer_quarter.csv"))

    # ---- retailers --------------------------------------------------------------
    r["prefix"] = r["Retailer_ID"].str.rsplit("-", n=1).str[0]
    month["date"] = month["Month"].map(month_start)
    latest = max(d for d in month["date"] if d) if len(month) else None
    cutoff = None
    if latest:
        y, mo = latest.year, latest.month - 5
        cutoff = date(y - (mo <= 0), (mo - 1) % 12 + 1, 1)
    last_active = r["Last_Active_Month"].map(month_start)
    retailers = pd.DataFrame({
        "retailer_code": r["Retailer_ID"],
        "retailer_name": r["Retailer_Name"],
        "distributor_code": r["prefix"],
        "distributor_name": r["Distributor"],
        "state": r["State"],
        "city": r["City"].where(r["City"].str.strip() != "", r["District"].str.title()),
        "pincode": r["Pincode"],
        "region": r["Region"],
        "onboarding_date": r["First_Active_Month"].map(lambda v: (month_start(v) or "") and month_start(v).isoformat()),
        "status": last_active.map(lambda d: "" if d is None or cutoff is None else ("Active" if d >= cutoff else "Inactive")),
    })

    # ---- distributors (derived from their retailers) ------------------------------
    g = r.groupby("Distributor")
    distributors = pd.DataFrame({
        "distributor_code": g["prefix"].first(),
        "distributor_name": g["Distributor"].first(),
        "state": g["State"].agg(_mode),
        "region": g["Region"].agg(_mode),
    }).reset_index(drop=True)
    active_dist = set(retailers.loc[retailers["status"] == "Active", "distributor_name"])
    distributors["status"] = distributors["distributor_name"].map(lambda d: "Active" if d in active_dist else "Inactive")

    # ---- sales: one row per retailer per month ----------------------------------
    lookup = r.set_index("Retailer_ID")[["Retailer_Name", "Distributor", "prefix"]]
    s = month.join(lookup, on="Retailer_ID", how="left")
    sales = pd.DataFrame({
        "invoice_no": s["Retailer_ID"] + "/" + s["Month"],
        "invoice_date": s["date"].map(lambda d: d.isoformat() if d else ""),
        "retailer_code": s["Retailer_ID"],
        "retailer_name": s["Retailer_Name"].fillna(""),
        "distributor_code": s["prefix"].fillna(""),
        "distributor_name": s["Distributor"].fillna(""),
        "net_sales_amount": s["Revenue"],
        # the build's quarter of the month (Sept_24 counts in Q3 FY 25), so every page groups months the same way
        "quarter": s["Quarter"].map(lambda l: (quarter_info(l) or ("",))[0]) if "Quarter" in s else "",
    })

    out = {DatasetType.RETAILERS: retailers, DatasetType.DISTRIBUTORS: distributors, DatasetType.SALES: sales}

    # ---- benefits + fulfilments from the tier scheme ------------------------------
    if tier_scheme:
        scheme = pd.read_excel(io.BytesIO(tier_scheme), dtype=str).fillna("")
        scheme.columns = [c.strip().lower() for c in scheme.columns]
        scheme = scheme[scheme["required"].str.strip().str.lower() == "yes"]
        scheme["tier"] = scheme["tier"].str.strip().str.title()
        scheme["benefits"] = scheme["benefits"].str.strip()
        scheme["id"] = scheme["tier"].str.upper() + "-" + scheme["benefits"].str.upper()
        scheme["rank"] = scheme["tier"].map(lambda t: _TIER_ORDER.index(t) if t in _TIER_ORDER else 99)
        scheme = scheme.sort_values(["rank", "benefits"])
        out[DatasetType.BENEFITS] = pd.DataFrame({
            "id": scheme["id"], "name": scheme["benefits"].map(_benefit_name), "tier": scheme["tier"],
            "frequency": "Quarterly", "quantity": "1", "unit_cost": "",
            "description": "Required for " + scheme["tier"] + " (Tier_scheme.xlsx)",
        })

        # no deliverable data in the build (deliverables_consolidated.csv is not read): no fulfilment records
        has_dl = "Deliverables" in quarter.columns
        q = quarter[quarter["Deliverables"].str.strip().str.lower() == "yes"].copy() if has_dl else quarter.iloc[0:0].copy()
        if "Reported_Tier" not in q.columns:
            q["Reported_Tier"] = ""
        q = q.join(lookup[["Retailer_Name"]], on="Retailer_ID", how="left")
        info = {lbl: quarter_info(lbl) for lbl in q["Quarter"].unique()}
        # tiers in force in that quarter: a sheet's "Platinum" before Q1 FY 27 counts as Gold
        q_start = {lbl: v[1].replace(day=1) - pd.DateOffset(months=2) for lbl, v in info.items() if v}
        q["tier"] = [cap_tier(t, q_start[lbl].date() if lbl in q_start else None)
                     for t, lbl in zip(q["Reported_Tier"].str.strip().str.title(), q["Quarter"])]
        rows = q.merge(scheme[["tier", "benefits", "id"]], on="tier", how="inner")
        rows["value"] = [row.get(b, "") for row, b in zip(rows.to_dict("records"), rows["benefits"])]
        rows["value"] = rows["value"].fillna("").astype(str).str.strip().str.lower()
        rows = rows[rows["value"].isin(["yes", "no"])]
        q_end = rows["Quarter"].map(lambda l: info[l][1].isoformat() if info.get(l) else "")
        out[DatasetType.FULFILLMENTS] = pd.DataFrame({
            "id": rows["Retailer_ID"] + "/" + rows["Quarter"] + "/" + rows["benefits"],
            "benefit_id": rows["id"],
            "retailer_code": rows["Retailer_ID"],
            "retailer_name": rows["Retailer_Name"].fillna(""),
            "tier": rows["tier"],
            "quarter": rows["Quarter"].map(lambda l: info[l][0] if info.get(l) else ""),
            "planned_date": q_end,
            "actual_date": q_end.where(rows["value"] == "yes", ""),
            "status": rows["value"].map({"yes": "Fulfilled", "no": "Planned"}),
            "cost": "0",
        })
    return {k: v.fillna("").astype(str) for k, v in out.items()}
