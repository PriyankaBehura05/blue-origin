"""
Consolidated distributor sheets -> the cleaned quarter files bo_pipeline.py reads.

/Power BI/Consolidated holds one export per quarter of every distributor's Google Sheet (FY25_Qtr3.csv,
FY27_Qtr2.csv, ...): the main data. This module does what the cleaning half of BO_data.ipynb did, so the
app works straight from those files:

    Consolidated/FY27_Qtr2.csv  ->  FY27_qtr2.csv               month columns with their year (Jul -> July_26),
                                                                 column spellings fixed, names trimmed, blank rows
                                                                 dropped, tiers checked, benefit cells -> Yes / No /
                                                                 Cancelled, "Code name" = Retailer Name-Distributor
                                    deliverables_consolidated.csv one row per retailer x quarter x benefit

Each quarter keeps the status rules the notebook used for it; a quarter added later (FY27_Qtr3.csv, ...)
uses the general rules (the same as the Deliverables tracker). Phone numbers are split by bo_pipeline.py.

    python consolidated_prep.py <Consolidated folder> <output folder>
"""
import os
import re
import sys
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

FILE_RE = re.compile(r"^FY(\d{2})_Qtr([1-4])\.csv$", re.I)
_MON = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11,
        "dec": 12}
_MONTH_NAME = {1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr", 5: "May", 6: "Jun", 7: "July", 8: "Aug", 9: "Sept", 10: "Oct",
               11: "Nov", 12: "Dec"}            # the names bo_pipeline.py and the notebook use ("July_26", "Sept_26")
_FIXED = {"Phone No": "Phone", "Retailer name": "Retailer Name", "SHOP BOARD": "Shop Board",
          "Hyperloacl Ads": "Hyperlocal Ads", "IMPRessions": "Impressions", "Retailer Tier": "New Tier"}
VALID_TIERS = {"Platinum", "Gold", "Silver", "Green", "Yellow"}
DELIVERABLE_COLS = ["Deliverables", "SIS Unit", "Carry Bags", "Influencer", "GMB", "Certificate", "Product video",
                    "Hyperlocal Ads", "Shop Board", "Catalog"]
BENEFITS = ["SIS_Unit", "Carry_Bags", "Influencer", "GMB", "Certificate", "Product_Video", "Hyperlocal_Ads",
            "Shop_Board", "Catalog"]


def quarter_files(names: List[str]) -> List[Tuple[str, str, int, int]]:
    """(file name, quarter key 'Q2_FY27', FY end year, quarter) for every FYyy_Qtrn.csv, oldest first."""
    out = []
    for n in names:
        m = FILE_RE.match(os.path.basename(n))
        if m:
            fy, q = 2000 + int(m.group(1)), int(m.group(2))
            out.append((n, f"Q{q}_FY{fy % 100:02d}", fy, q))
    return sorted(out, key=lambda x: (x[2], x[3]))


def month_column(col: str, fy_end: int) -> Optional[str]:
    """'Jul' / 'July' / 'September' in an FY27 sheet -> 'July_26' / 'Sept_26' (Apr-Dec = FY start year)."""
    c = str(col).strip()
    if not re.fullmatch(r"[A-Za-z]+", c) or c[:3].lower() not in _MON or len(c) > 9:
        return None
    full = {"jan": "january", "feb": "february", "mar": "march", "apr": "april", "may": "may", "jun": "june",
            "jul": "july", "aug": "august", "sep": "september", "oct": "october", "nov": "november", "dec": "december"}
    k = c[:3].lower()
    if not (full[k].startswith(c.lower()) or c.lower() == "sept"):
        return None
    mo = _MON[k]
    year = fy_end - 1 if mo >= 4 else fy_end
    return f"{_MONTH_NAME[mo]}_{year % 100:02d}"


# ------------------------------------------------------------------ benefit status rules (from BO_data.ipynb)
def _norm(x) -> str:
    return "" if pd.isna(x) else str(x).strip().lower()


def _exact(yes: List[str], cancelled: List[str]) -> Callable:
    return lambda x: "Yes" if _norm(x) in yes else "Cancelled" if _norm(x) in cancelled else "No"


def _keywords(yes: List[str], cancelled: List[str], yes_contains: Tuple[str, ...] = ()) -> Callable:
    def f(x):
        s = _norm(x)
        if s in yes or any(k in s for k in yes_contains):
            return "Yes"
        if any(k in s for k in cancelled):
            return "Cancelled"
        return "No"
    return f


def _cb_fy25q3(x):
    s = _norm(x)
    return "Yes" if s in ["yes", "done", "rto"] else "Cancelled" if "rto" in s else "No"


_CANCEL_RE = re.compile(r"cancel|denied|not\s*applicable|not\s*interested|no\s*space|non[\s-]*serv|no\s*need|no\s*from|"
                        r"wrong\s*ph|invalid|improper|no\s*pin|no\s*address|digit\s*ph|refused|no\s*response", re.I)
_PENDING_RE = re.compile(r"to\s*be\s*(done|sent?|installed)|need\s*to|under\s*process|in\s*process|pending|will\s*do|"
                         r"not\s*install|#n/?a|^\s*(no|n,?a|na|false|-|0)\s*$", re.I)
_DONE_RE = re.compile(r"yes|done|sent|send|installed|insatlled|complet|deliver|rcvd|receiv|already|https?:|"
                      r"\.(jpe?g|png|mp4|mov)\b|\brto\b|rt0|repeated|marked", re.I)


def normalize_benefit(x) -> str:
    """General rule (FY27 Q2 onwards, same as the Deliverables tracker): free text and quantities -> status."""
    s = "" if pd.isna(x) else str(x).strip()
    if not s:
        return "No"
    if _CANCEL_RE.search(s):
        return "Cancelled"
    if _PENDING_RE.search(s):
        return "No"
    if re.fullmatch(r"\d+(\.\d+)?", s):          # a quantity, e.g. 500 carry bags
        return "Yes" if float(s) > 0 else "No"
    if _DONE_RE.search(s):
        return "Yes"
    return "No"


_SIS_OLD = _exact(["yes", "done"], ["no from distributor"])
_SIS_NEW = _exact(["yes", "done", "sent"], ["no from distributor"])
_CERT = _exact(["yes"], ["not applicable"])
_GMB_OFF = lambda x: "No"   # noqa: E731  (the notebook sets GMB to No for these quarters)

# quarter -> column -> rule. Quarters not listed (later ones) use normalize_benefit for these columns.
RULES: Dict[str, Dict[str, Callable]] = {
    "Q3_FY25": {"SIS Unit": _SIS_OLD, "Carry Bags": _cb_fy25q3, "GMB": _GMB_OFF,
                "Catalog": _keywords(["yes", "done", "rto"], ["non-service", "details added after sheet finalized",
                                                             "wrong ph no", "no address", "no ph no"],
                                     ("sending to distributor",))},
    "Q4_FY25": {"SIS Unit": _SIS_OLD, "GMB": _GMB_OFF, "Certificate": _CERT,
                "Carry Bags": _keywords(["yes", "done", "rto", "rt0"], ["non service", "non-service", "improper address"])},
    "Q1_FY26": {"SIS Unit": _SIS_OLD, "GMB": _GMB_OFF,
                "Certificate": _exact(["yes", "need to send certificate to this buyer as an exception"], ["not applicable"]),
                "Carry Bags": _keywords(["yes", "done", "rto"], ["non service", "non-service", "wrong ph", "wrong phone",
                                                                "no address", "no ph", "improper", "logistics", "pincode",
                                                                "9 digit", "11 digit"]),
                "Catalog": _keywords(["yes", "done", "rto"], ["non service", "address missing", "pincode karnataka",
                                                             "ajay hoisery", "radhe radhe", "gandhi creation", "no address",
                                                             "pincode ap", "karnataka", "9 digit phone no", "no phone no",
                                                             "rto - intransit", "logistics non-service", "wrong phone no."],
                                     ("sending to distributor",))},
    "Q2_FY26": {"SIS Unit": _SIS_OLD, "GMB": _GMB_OFF, "Certificate": _CERT,
                "Carry Bags": _keywords(["yes", "marked yes on nov", "rto"],
                                        ["non service", "non-service", "details added after sheet finalized", "wrong ph",
                                         "no address", "no ph"], ("sending to distributor",)),
                "Catalog": _keywords(["yes", "marked yes on nov", "rto"],
                                     ["non,service", "no pincode", "9 digit ph no", "11 digit ph no", "non-service",
                                      "no ph no", "details added after sheet finalized", "incorrect ph no", "wrong ph no",
                                      "invalaid ph no", "9-digit phone number", "9-digit ph no"],
                                     ("sending to distributor",))},
    "Q3_FY26": {"SIS Unit": _SIS_NEW, "Certificate": _CERT,
                "Carry Bags": _keywords(["yes", "done", "sent", "rto"],
                                        ["mobile no missing", "no pincode", "9 digit", "11 digit", "non-service",
                                         "non service", "digit"]),
                "Catalog": _keywords(["yes", "done", "rto"], ["non-service", "non service",
                                                             "details added after sheet finalized", "wrong ph no",
                                                             "no address", "no ph no", "digit"], ("sending to distributor",))},
    "Q4_FY26": {"SIS Unit": _SIS_NEW, "Certificate": _CERT,
                "Carry Bags": _keywords(["yes", "done", "sent", "rto", "to distributor"],
                                        ["mobile no missing", "no pincode", "9-digit", "9 digit", "11 digit",
                                         "non-service", "non service", "digit", "no ph no"]),
                "Catalog": _keywords(["yes", "done", "rto"], ["non-service", "non service",
                                                             "details added after sheet finalized", "wrong ph no",
                                                             "no address", "no ph no", "digit"], ("sending to distributor",))},
    "Q1_FY27": {},   # the notebook left these columns as typed; the final Yes / Cancelled check below applies
    "Q2_FY27": {c: normalize_benefit for c in ("SIS Unit", "Carry Bags", "Catalog", "Certificate")},
}
_GENERAL = {c: normalize_benefit for c in ("SIS Unit", "Carry Bags", "Catalog", "Certificate")}


def format_influencer(x) -> str:
    if pd.notna(x) and str(x).strip() != "":
        s = str(x).lower()
        if any(k in s for k in ["https", "jpeg", "jpg", "mp4", "mov"]):
            return "Yes"
        if any(k in s for k in ["no", "#n/a", "to be done"]):
            return "No"
        if any(k in s for k in ["cancelled", "retailer denied", "not applicable"]):
            return "Cancelled"
        return "Yes"
    return "No"


_SB_CANCEL = re.compile(r"cancelled|retailer\s*denied|not\s*applicable|not\s*interested|denied|ph\s*no|refused|"
                        r"did\s*not\s*pick|issue|not\s*responded", re.I)
_SB_NO = re.compile(r"\bno\b|#n/?a|to\s*be\s*done|to\s*be\s*installed|not\s*install(ed)?", re.I)
_SB_YES = re.compile(r"https|jpe?g|png|mp4|mov|installed|installation|repeated|done|completed|yes|insatlled|google|.lnk",
                     re.I)


def format_shop_board(x) -> str:
    if pd.isna(x) or not str(x).strip():
        return "No"
    s = str(x)
    if _SB_CANCEL.search(s):
        return "Cancelled"
    if _SB_NO.search(s):
        return "No"
    if _SB_YES.search(s):
        return "Yes"
    return "No"


def _final_status(col: str, x) -> str:
    """The notebook's last step for deliverables_consolidated.csv."""
    if col == "Product_Video":
        s = "" if pd.isna(x) else str(x).strip()
        low = s.lower()
        return "Yes" if s and (low == "yes" or any(k in low for k in ("https", "jpeg", "jpg", "mp4", "mov"))) else "No"
    s = _norm(x)
    return "Yes" if s == "yes" else "Cancelled" if s == "cancelled" else "No"


# ------------------------------------------------------------------ one quarter
def clean_quarter(df: pd.DataFrame, qkey: str, fy_end: int) -> pd.DataFrame:
    df = df.rename(columns={c: _FIXED.get(str(c).strip(), str(c).strip()) for c in df.columns})
    df = df.rename(columns={c: month_column(c, fy_end) for c in df.columns if month_column(c, fy_end)})
    q = int(qkey[1])
    for mo in ([4, 5, 6], [7, 8, 9], [10, 11, 12], [1, 2, 3])[q - 1]:   # a sheet without a month column still gets it
        col = f"{_MONTH_NAME[mo]}_{(fy_end - 1 if mo >= 4 else fy_end) % 100:02d}"
        if col not in df.columns:
            df[col] = np.nan
    df = df.loc[:, ~df.columns.duplicated()].copy()

    df["Retailer Name"] = df["Retailer Name"].astype("string").str.strip().str.replace(r"\s+", " ", regex=True)
    # No sale is left out: a row without a shop name but with purchases is kept, named after its phone (or address,
    # else its row): "(Name missing) 9876501234". Rows with neither a name nor a purchase are dropped.
    months = [c for c in df.columns if re.fullmatch(r"[A-Za-z]+_\d{2}", str(c))]
    sales = df[months].apply(lambda s: pd.to_numeric(s.astype(str).str.replace(r"[,₹\s]", "", regex=True),
                                                       errors="coerce")).fillna(0).abs().sum(axis=1)
    missing = ~df["Retailer Name"].fillna("").str.contains(r"[A-Za-z0-9]", regex=True)   # blank, "." or "-"
    if (missing & (sales > 0)).any():
        blank = pd.Series("", index=df.index)
        phone = (df["Phone"].fillna("").astype(str).str.replace(r"\.0$", "", regex=True).str.replace(r"\D", "", regex=True)
                 if "Phone" in df.columns else blank)
        addr = df["Address"].fillna("").astype(str).str.strip().str.slice(0, 40) if "Address" in df.columns else blank
        ident = [p if len(p) >= 6 else (a if a and a.lower() != "nan" else f"row {i + 2}")
                 for i, (p, a) in enumerate(zip(phone.tolist(), addr.tolist()))]
        df.loc[missing, "Retailer Name"] = ["(Name missing) " + v for v, m in zip(ident, missing) if m]
    df = df[~missing | (sales > 0)].copy()
    if "Pincode" in df.columns:
        df["Pincode"] = df["Pincode"].astype(str).str.strip().replace("", np.nan)

    df["Code name"] = df["Retailer Name"].astype(str) + "-" + df["Distributor"].astype(str)
    dup = df.groupby("Code name").cumcount()
    df["Code name"] = df["Code name"] + dup.map(lambda n: f" ({n})" if n else "")

    if "Deliverables" in df.columns:
        df["Deliverables"] = df["Deliverables"].map(lambda x: "Yes" if _norm(x) == "yes" else "Cancelled"
                                                    if _norm(x) == "no" else "No")
    for col, rule in RULES.get(qkey, _GENERAL).items():
        if col in df.columns:
            df[col] = df[col].map(rule)
    if "Influencer" in df.columns:
        df["Influencer"] = df["Influencer"].map(format_influencer)
    if "Shop Board" in df.columns:
        df["Shop Board"] = df["Shop Board"].map(format_shop_board)
    hyper = df["Hyperlocal Ads"].astype(str).str.strip().str.lower().eq("yes") if "Hyperlocal Ads" in df.columns \
        else pd.Series(False, index=df.index)
    if "Impressions" in df.columns:
        hyper = hyper | (pd.to_numeric(df["Impressions"], errors="coerce").fillna(0) > 0)
    df["Hyperlocal Ads"] = hyper.map({True: "Yes", False: "No"})
    for col in ("New Tier", "Old Tier"):
        df[col] = df[col].map(lambda t: t if t in VALID_TIERS else None) if col in df.columns else None
    return df


def deliverables_rows(df: pd.DataFrame, qkey: str) -> pd.DataFrame:
    """Long table: Code_Name, Retailer_Name, Distributor, Quarter, Deliverables, New_Tier, Old_Tier, Benefit, Status."""
    std = dict(zip(DELIVERABLE_COLS, ["Deliverables"] + BENEFITS))
    keep = ["Code name", "Retailer Name", "Distributor", "New Tier", "Old Tier"] + [c for c in DELIVERABLE_COLS if c in df]
    d = df[keep].rename(columns={**std, "Code name": "Code_Name", "Retailer Name": "Retailer_Name",
                                 "New Tier": "New_Tier", "Old Tier": "Old_Tier"})
    if "Deliverables" not in d:
        d["Deliverables"] = "No"
    d["Quarter"] = qkey
    for col in BENEFITS:
        d[col] = d[col].map(lambda x, c=col: _final_status(c, x)) if col in d else "No"
    return d.melt(id_vars=["Code_Name", "Retailer_Name", "Distributor", "Quarter", "Deliverables", "New_Tier", "Old_Tier"],
                  value_vars=BENEFITS, var_name="Benefit", value_name="Status")


def prepare(src: str, out: str) -> List[str]:
    """Clean every FYyy_Qtrn.csv in `src` into `out`; returns the quarter keys written."""
    os.makedirs(out, exist_ok=True)
    files = quarter_files(os.listdir(src))
    if not files:
        raise SystemExit(f"No quarter files (FY27_Qtr2.csv, ...) in {src}")
    long = []
    for name, qkey, fy_end, q in files:
        raw = pd.read_csv(os.path.join(src, name), dtype={"Phone": str, "Phone No": str}, low_memory=False)
        df = clean_quarter(raw, qkey, fy_end)
        df.to_csv(os.path.join(out, f"FY{fy_end % 100:02d}_qtr{q}.csv"), index=False)
        long.append(deliverables_rows(df, qkey))
        print(f"{name}: {len(raw)} rows -> {len(df)} retailers")
    d = pd.concat(long, ignore_index=True).drop_duplicates()
    d = d.sort_values(["Code_Name", "Retailer_Name", "Quarter", "Benefit"]).reset_index(drop=True)
    d.to_csv(os.path.join(out, "deliverables_consolidated.csv"), index=False)
    return [k for _, k, _, _ in files]


if __name__ == "__main__":
    prepare(sys.argv[1], sys.argv[2])
