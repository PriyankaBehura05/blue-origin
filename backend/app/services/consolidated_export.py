"""
Consolidated data download: the current dashboard build (<store>/network/, written by bo_pipeline.py from the
consolidated distributor sheets) as one Excel workbook.

    Read me          what the file is, when the data was built, totals and the sheets
    Retailers        one row per retailer (Code name: shop name + distributor, no duplicate merging): details,
                     phones, revenue and tier per quarter, lifetime revenue
    Quarterly        retailer x quarter: revenue, tier (calculated / in the sheet), benefits
    Monthly revenue  retailer x month (₹), with a total

Built once per build (keyed on the version of dashboard.json.gz, which a build writes last).
"""
import io
import posixpath
import re
import threading
from datetime import datetime
from typing import Dict, Optional, Tuple

import pandas as pd
import xlsxwriter

from app.core.config import Settings
from app.core.errors import DataNotAvailableError
from app.services import network_service
from app.storage.base import BlobStore

_MON = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10,
        "nov": 11, "dec": 12}
_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
BENEFITS = ["SIS_Unit", "Carry_Bags", "Influencer", "GMB", "Certificate", "Product_Video", "Hyperlocal_Ads",
            "Shop_Board", "Catalog"]
_lock = threading.Lock()
_cache: Dict[str, Tuple[bytes, str]] = {}


def quarter_label(key: str) -> str:
    """'Q2_FY27' -> 'Q2 FY 27 (Jul–Sep 2026)'"""
    m = re.fullmatch(r"Q([1-4])_?\s*FY\s*(\d{2})", str(key).strip())
    if not m:
        return str(key)
    q, fy = int(m.group(1)), 2000 + int(m.group(2))
    first = (4, 7, 10, 1)[q - 1]
    year = fy - 1 if q < 4 else fy
    return f"Q{q} FY {fy % 100:02d} ({_ABBR[first]}–{_ABBR[first + 2]} {year})"


def month_key(label: str) -> Optional[Tuple[int, int]]:
    """'Sept_24' -> (2024, 9)"""
    m = re.fullmatch(r"([A-Za-z]+)[_ ](\d{2})", str(label).strip())
    return (2000 + int(m.group(2)), _MON[m.group(1)[:3].lower()]) if m and m.group(1)[:3].lower() in _MON else None


def _read(net: BlobStore, name: str, **kw) -> pd.DataFrame:
    raw = net.read(name)
    if raw is None:
        raise DataNotAvailableError(f"{name} is missing from the dashboard build. Rebuild the dashboard data first.")
    return pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False, **kw)


def _col(df: pd.DataFrame, name: str) -> pd.Series:
    """A column of a build file, or blanks when this build does not have it (e.g. no benefit data)."""
    return df[name] if name in df else pd.Series("", index=df.index)


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


# ------------------------------------------------------------------ sheets as data frames
def frames(net: BlobStore, quarter: Optional[str] = None) -> Tuple[Dict[str, pd.DataFrame], dict]:
    """The three sheets; with `quarter` ('Q2_FY27') only that quarter's retailers, months and revenue."""
    ret = _read(net, "retailers.csv")
    rq = _read(net, "retailer_quarter.csv")
    rm = _read(net, "retailer_month.csv")
    if quarter:
        if quarter not in set(rq["Quarter"]) | set(rm["Quarter"]):
            raise DataNotAvailableError(f"Quarter {quarter} is not in the dashboard data.")
        rq, rm = rq[rq["Quarter"] == quarter].copy(), rm[rm["Quarter"] == quarter].copy()
        ret = ret[ret["Retailer_ID"].isin(set(rq["Retailer_ID"]) | set(rm["Retailer_ID"]))].reset_index(drop=True)
    names = ret.set_index("Retailer_ID")[["Retailer_Name", "Distributor"]]

    # Quarter revenue is the sum of its months, so every month counts: a month listed in another quarter's sheet
    # (a month without a quarter file of its own counts in the quarter of its file: Sept_24 is in Q3 FY 25).
    rm["Revenue"] = _num(rm["Revenue"])
    by_month = rm.groupby(["Retailer_ID", "Quarter"], as_index=False)["Revenue"].sum()
    rq = rq.rename(columns={"Revenue": "_listed"}).merge(by_month, on=["Retailer_ID", "Quarter"], how="outer")
    rq["Revenue"] = rq["Revenue"].fillna(_num(rq["_listed"]))
    quarters = sorted(rq["Quarter"].unique(), key=lambda k: (int(k[-2:]), int(k[1])))
    rev = rq.pivot_table(index="Retailer_ID", columns="Quarter", values="Revenue", aggfunc="sum")
    tier = rq.pivot_table(index="Retailer_ID", columns="Quarter", values="Computed_Tier", aggfunc="first")
    per_q = pd.DataFrame(index=ret["Retailer_ID"])
    for q in quarters:
        per_q[f"{quarter_label(q)} revenue (₹)"] = rev[q] if q in rev else None
        per_q[f"{quarter_label(q)} tier"] = tier[q] if q in tier else None

    retailers = pd.DataFrame({
        "Retailer ID": ret["Retailer_ID"], "Retailer": ret["Retailer_Name"], "Distributor": ret["Distributor"],
        "Region": _col(ret, "Region"), "State": _col(ret, "State"), "District": _col(ret, "District"),
        "City": _col(ret, "City"), "Pincode": _col(ret, "Pincode"), "Address": _col(ret, "Address"),
        "Phone": _col(ret, "Phone"), "Other phones": _col(ret, "Phone_Alt"),
        "First active month": _col(ret, "First_Active_Month"), "Last active month": _col(ret, "Last_Active_Month"),
        "First listed quarter": _col(ret, "First_Listed_Quarter").map(lambda q: quarter_label(q) if q else ""),
        "Lifetime revenue (₹)": _num(_col(ret, "Lifetime_Revenue")),
    }).reset_index(drop=True)
    retailers = pd.concat([retailers, per_q.reset_index(drop=True)], axis=1)

    rq = rq.join(names, on="Retailer_ID")
    rq["_order"] = rq["Quarter"].map({q: i for i, q in enumerate(quarters)})
    rq = rq.sort_values(["Distributor", "Retailer_Name", "_order"])
    quarterly = pd.DataFrame({
        "Retailer ID": rq["Retailer_ID"], "Retailer": rq["Retailer_Name"], "Distributor": rq["Distributor"],
        "Quarter": rq["Quarter"].map(quarter_label), "Revenue (₹)": rq["Revenue"],
        "Tier (calculated)": _col(rq, "Computed_Tier"), "Tier in the sheet": _col(rq, "Reported_Tier"),
        "Deliverables": _col(rq, "Deliverables"),
        **{b.replace("_", " "): rq[b] for b in BENEFITS if b in rq},
    })

    months = sorted({m for m in rm["Month"] if month_key(m)}, key=month_key)
    wide = rm.pivot_table(index="Retailer_ID", columns="Month", values="Revenue", aggfunc="sum").reindex(columns=months)
    wide.columns = [f"{_ABBR[month_key(m)[1]]}-{month_key(m)[0] % 100:02d}" for m in months]
    wide = names.join(wide, how="inner").sort_values(["Distributor", "Retailer_Name"])
    wide["Total (₹)"] = wide[[c for c in wide.columns if c not in ("Retailer_Name", "Distributor")]].sum(axis=1)
    monthly = wide.reset_index().rename(columns={"Retailer_ID": "Retailer ID", "Retailer_Name": "Retailer"})

    sheets = {"Retailers": retailers.sort_values(["Distributor", "Retailer"]), "Quarterly": quarterly,
              "Monthly revenue": monthly}
    info = {"quarters": quarters, "months": wide.columns, "retailers": len(retailers),
            "revenue": float(rm["Revenue"].sum())}
    return sheets, info


# ------------------------------------------------------------------ workbook
_MONEY = re.compile(r"\(₹\)$|^[A-Z][a-z]{2}-\d{2}$")   # '... (₹)' and month columns 'Sep-24'
_WIDTH = {"Retailer": 34, "Distributor": 24, "Address": 40, "Quarters": 40, "Quarter": 26}


def _write(wb, name: str, df: pd.DataFrame, fmt: dict, title: str):
    ws = wb.add_worksheet(name)
    ws.write(0, 0, f"TECHNOSPORT  |  {title}", fmt["title"])
    ws.write(1, 0, f"{len(df):,} rows", fmt["note"])
    for c, col in enumerate(df.columns):
        ws.write(3, c, col, fmt["head"])
        ws.set_column(c, c, _WIDTH.get(col, 22 if " tier" in col or "revenue" in col.lower() else 14))
    money = [bool(_MONEY.search(c)) for c in df.columns]
    numeric = [pd.api.types.is_numeric_dtype(df[c]) for c in df.columns]
    for r, row in enumerate(df.itertuples(index=False, name=None), start=4):
        for c, v in enumerate(row):
            if v is None or (isinstance(v, float) and v != v) or v == "":
                continue
            if numeric[c]:
                ws.write_number(r, c, float(v), fmt["inr"] if money[c] else fmt["num"])
            else:
                ws.write_string(r, c, str(v), fmt["text"])
    ws.freeze_panes(4, 2)
    ws.autofilter(3, 0, 3 + max(len(df), 1), len(df.columns) - 1)
    ws.set_row(3, 30)


def _check_text(check: str) -> str:
    """bo_pipeline.py's 'Revenue check  source: 8359526103.25  consolidated: 8359526103.25' in words."""
    m = re.search(r"source:\s*(-?[\d.]+)\s+consolidated:\s*(-?[\d.]+)", check or "")
    if not m:
        return ""
    if abs(float(m.group(1)) - float(m.group(2))) < 0.005:
        return " (matches the distributor sheets to the paisa)"
    return f" (the distributor sheets total ₹{float(m.group(1)):,.2f})"


def to_xlsx(sheets: Dict[str, pd.DataFrame], info: dict, build: dict, source: str) -> bytes:
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "strings_to_numbers": False, "strings_to_formulas": False,
                                   "strings_to_urls": False})
    base = {"font_name": "Arial", "font_size": 10}
    fmt = {"title": wb.add_format({**base, "bold": True, "font_size": 12}),
           "note": wb.add_format({**base, "italic": True, "font_size": 9, "font_color": "#7F7F7F"}),
           "head": wb.add_format({**base, "bold": True, "bg_color": "#F2F2F2", "border": 1, "border_color": "#BFBFBF",
                                  "text_wrap": True, "valign": "vcenter"}),
           "text": wb.add_format(base), "num": wb.add_format({**base, "num_format": "#,##0", "align": "center"}),
           "inr": wb.add_format({**base, "num_format": '###,##0;\\(###,##0\\);"–"'}),
           "bold": wb.add_format({**base, "bold": True}), "wrap": wb.add_format({**base, "text_wrap": True, "valign": "top"})}

    ws = wb.add_worksheet("Read me")
    ws.set_column(0, 0, 26)
    ws.set_column(1, 1, 110)
    ws.write(0, 0, "TECHNOSPORT  |  BO consolidated retailer data", fmt["title"])
    q = info["quarters"]
    built = build.get("built_at") or ""
    try:
        built = datetime.fromisoformat(built).astimezone().strftime("%d %b %Y, %H:%M")
    except ValueError:
        pass
    lines = [
        ("Data built", built), ("Source", source),
        ("Quarters", f"{quarter_label(q[0])} to {quarter_label(q[-1])}" if q else ""),
        ("Retailers", f"{info['retailers']:,} (one per Code name: shop name + distributor, no duplicate merging)"),
        ("Revenue", f"₹{info['revenue']:,.0f} in total" + _check_text(build.get("revenue_check", ""))),
        ("Tiers", "Quarterly purchase: Yellow ₹50 K, Green ₹1.5 L, Silver ₹2.5 L until Q1 FY 27 and ₹3 L from Q2 FY 27 "
                  "(Green then runs to ₹3 L), Gold ₹5 L, Platinum ₹10 L from Q1 FY 27 (before that Gold is the top "
                  "tier). Each quarter's tier uses the ranges in force in that quarter."),
        ("", ""),
        ("Retailers", "One row per retailer: details, phones, and revenue and tier for each quarter."),
        ("Quarterly", "One row per retailer and quarter: revenue, tier calculated from the revenue, tier written "
                      "in the sheet, and the status of each benefit."),
        ("Monthly revenue", "One row per retailer, revenue per month in ₹ and the total."),
    ]
    for r, (k, v) in enumerate(lines, start=2):
        ws.write(r, 0, k, fmt["bold"])
        ws.write(r, 1, v, fmt["wrap"])
    titles = {"Retailers": "Retailers", "Quarterly": "Retailer x quarter",
              "Monthly revenue": "Monthly revenue per retailer (₹)"}
    for name, df in sheets.items():
        _write(wb, name, df, fmt, titles.get(name, name))
    wb.close()
    return buf.getvalue()


def download(store: BlobStore, settings: Settings, quarter: Optional[str] = None) -> Tuple[bytes, str]:
    """(xlsx bytes, file name) of the current dashboard build, all quarters or just `quarter` ('Q2_FY27')."""
    net = network_service.network_store(store)
    version = next((f.version for f in net.list("") if posixpath.basename(f.path) == network_service.PAYLOAD_NAME), None)
    if version is None:
        raise DataNotAvailableError("No consolidated data yet. Rebuild the dashboard data on the Data page first.")
    quarter = (quarter or "").strip() or None
    key = f"{version}|{quarter or ''}"
    with _lock:
        if key not in _cache:
            build = network_service.load_build(store)
            sheets, info = frames(net, quarter)
            day = (build.get("built_at") or datetime.now().isoformat())[:10]
            source = build.get("main_data") or settings.BO_DATA_FOLDER or settings.BO_PIPELINE_INPUT
            for old in [k for k in _cache if not k.startswith(f"{version}|")]:   # a newer build replaces the old files
                del _cache[old]
            name = f"BO_Consolidated_Data_{quarter + '_' if quarter else ''}{day}.xlsx"
            _cache[key] = (to_xlsx(sheets, info, build, source), name)
        return _cache[key]
