"""
BO Retailer Consolidation Pipeline
----------------------------------
Copy of Dropbox /Power BI/BO_Dashboard/bo_pipeline.py, run by app/services/network_service.py in a
subprocess. Changes: quarter files added after the QUARTERS list are picked up automatically; every month
belongs to its financial-year quarter (Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar) when that quarter has a
file, else to the quarter of its file (Sept_24 in FY25_qtr3.csv counts in Q3_FY25: there is no Q2_FY25 file); Platinum is only given from Q1_FY27 (April 2026), before that Gold is the top tier;
there is no duplicate merging: every Code name (shop name + distributor) is its own retailer (user, 2026-10-22).

Reads the cleaned quarterly files produced by BO_data.ipynb (FY25_qtr3.csv ... FY27_qtr1.csv),
one retailer per Code name, re-sums revenue, recomputes tier slabs and writes:

  out/retailers.csv            one row per retailer (Code name -> Retailer_ID)
  out/retailer_quarter.csv     Retailer_ID x Quarter: revenue, computed tier, reported tier, benefits
  out/retailer_month.csv       Retailer_ID x Month revenue (long)
  out/code_names.csv           one row per Code name with monthly revenue (the BO_Data report)
  out/dashboard_data.json      compact payload consumed by the hosted dashboard
  out/dashboard_data.json.gz   same, gzipped: the file the Vercel app reads from Dropbox

Usage:  python bo_pipeline.py "C:\\Users\\MITHUL CB\\Dropbox\\Power BI"
"""
import sys, os, re, json
import numpy as np
import pandas as pd

BASE = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(BASE, "BO_Dashboard_Output")
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------------ config
QUARTERS = [  # file, quarter key, month columns (in order)
    ("FY25_qtr3.csv", "Q3_FY25", ["Sept_24", "Oct_24", "Nov_24", "Dec_24"]),
    ("FY25_qtr4.csv", "Q4_FY25", ["Jan_25", "Feb_25", "Mar_25"]),
    ("FY26_qtr1.csv", "Q1_FY26", ["Apr_25", "May_25", "Jun_25"]),
    ("FY26_qtr2.csv", "Q2_FY26", ["July_25", "Aug_25", "Sept_25"]),
    ("FY26_qtr3.csv", "Q3_FY26", ["Oct_25", "Nov_25", "Dec_25"]),
    ("FY26_qtr4.csv", "Q4_FY26", ["Jan_26", "Feb_26", "Mar_26"]),
    ("FY27_qtr1.csv", "Q1_FY27", ["Apr_26", "May_26", "Jun_26"]),
    ("FY27_qtr2.csv", "Q2_FY27", ["July_26", "Aug_26", "Sept_26"]),
]


def _later_quarters(base, known):
    """Quarter files added after the list above (FY27_qtr3.csv, ...): month columns are read from the file header."""
    names = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
    out = []
    for f in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        m = re.fullmatch(r"FY(\d{2})_qtr([1-4])\.csv", f, flags=re.I)
        if not m or f.lower() in known:
            continue
        fy, q = 2000 + int(m.group(1)), int(m.group(2))
        months = [(fy - 1 if q < 4 else fy, mo) for mo in ([4, 5, 6], [7, 8, 9], [10, 11, 12], [1, 2, 3])[q - 1]]
        header = pd.read_csv(os.path.join(base, f), nrows=0).columns
        cols = []
        for y, mo in months:
            hit = [c for c in header if (mm := re.fullmatch(r"([A-Za-z]+)[_ ](\d{2})", str(c).strip()))
                   and names.get(mm.group(1)[:3].lower()) == mo and int(mm.group(2)) == y % 100]
            if hit:
                cols.append(hit[0])
        if cols:
            out.append((f, f"Q{q}_FY{fy % 100:02d}", cols))
        else:
            print(f"Skipping {f}: no month columns found for its quarter")
    return sorted(out, key=lambda x: (x[1][-2:], x[1][1]))


QUARTERS += _later_quarters(BASE, {f.lower() for f, _, _ in QUARTERS})

_MON = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}


def quarter_key(year, month):
    """(2024, 9) -> 'Q2_FY25': the financial year runs Apr-Mar and is named after the year it ends in."""
    return f"Q{(month - 4) % 12 // 3 + 1}_FY{(year + (month >= 4)) % 100:02d}"


def month_quarter(col):
    """'Sept_24' -> 'Q2_FY25'"""
    m = re.fullmatch(r"([A-Za-z]+)[_ ](\d{2})", str(col).strip())
    return quarter_key(2000 + int(m.group(2)), _MON[m.group(1)[:3].lower()])


def qorder(qkey):
    """'Q2_FY25' -> (25, 2), for sorting quarter keys."""
    return int(qkey[-2:]), int(qkey[1])


def layout(quarters):
    """Quarter keys, months and month -> quarter for the files being read. A month goes to its own financial
    quarter when that quarter has a file; otherwise it stays in the quarter of the file it is in (user,
    2026-10-23): Sept_24 in FY25_qtr3.csv counts in Q3_FY25, as there is no Q2_FY25 file."""
    months = [m for _, _, ms in quarters for m in ms]
    with_file = {q for _, q, _ in quarters}
    month_q = {}
    for _, q, ms in quarters:
        for m in ms:
            own = month_quarter(m)
            month_q[m] = own if own in with_file else q
    qkeys = sorted(with_file | set(month_q.values()), key=qorder)
    return qkeys, months, month_q


QKEYS, MONTHS, MONTH_Q = layout(QUARTERS)

# Quarterly purchase slabs (INR, current minimums, highest first); per-quarter amounts come from tiers.json below
TIER_SLABS = [("Platinum", 1_000_000), ("Gold", 500_000), ("Silver", 300_000),
              ("Green", 150_000), ("Yellow", 50_000)]
TIERS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "rules", "config", "tiers.json")


def _tier_from():
    """First quarter of each tier that does not always apply, from app/rules/config/tiers.json (effective_from):
    {'Platinum': 'Q1_FY27'}. Platinum is introduced in April 2026; before that Gold is the top tier."""
    try:
        with open(TIERS_JSON, encoding="utf-8") as fh:
            tiers = json.load(fh)["tiers"]
        return {t["name"]: quarter_key(int(t["effective_from"][:4]), int(t["effective_from"][5:7]))
                for t in tiers if t.get("effective_from")}
    except (OSError, KeyError, ValueError):
        return {"Platinum": "Q1_FY27"}


TIER_FROM = _tier_from()


def tier_allowed(t, qkey):
    return t not in TIER_FROM or qorder(qkey) >= qorder(TIER_FROM[t])


def _slab_changes():
    """Earlier minimums from tiers.json ('earlier'), as [(tier, first quarter of the current amount, old minimum)]:
    [('Silver', 'Q2_FY27', 250000)] = Silver started at 2.5 L until Q1 FY 27 and at 3 L from Q2 FY 27."""
    try:
        with open(TIERS_JSON, encoding="utf-8") as fh:
            tiers = json.load(fh)["tiers"]
        current = {t["name"]: t["min_amount"] for t in tiers}
        for i, (t, _) in enumerate(TIER_SLABS):
            TIER_SLABS[i] = (t, current.get(t, TIER_SLABS[i][1]))
        return [(t["name"], quarter_key(int(e["before"][:4]), int(e["before"][5:7])), e["min_amount"])
                for t in tiers for e in t.get("earlier", []) if e.get("min_amount") is not None]
    except (OSError, KeyError, ValueError):
        return [("Silver", "Q2_FY27", 250_000)]


SLAB_CHANGES = _slab_changes()


def slabs_in(qkey):
    """[(tier, minimum)] in force in a quarter, highest tier first: Silver 2.5 L until Q1_FY27, 3 L from Q2_FY27."""
    out = []
    for t, lo in TIER_SLABS:
        # the oldest change that still lies after this quarter gives its minimum
        older = sorted((qorder(frm), m) for name, frm, m in SLAB_CHANGES if name == t and qorder(qkey) < qorder(frm))
        out.append((t, older[0][1] if older else lo))
    return out
TIER_ORDER = ["Untiered", "Yellow", "Green", "Silver", "Gold", "Platinum"]
BENEFITS = ["SIS_Unit", "Carry_Bags", "Influencer", "GMB", "Certificate",
            "Product_Video", "Hyperlocal_Ads", "Shop_Board", "Catalog"]

# ---- distributor state (user-confirmed) and 4-region scheme
MANUAL_STATE = {
    "Ajay Hosiery": "Maharashtra", "Anand Distribution": "Jharkhand", "Anand Sports": "Odisha",
    "Bittu Sports": "UP", "Creative Marketing Group": "Kerala", "EM BEE SPORTS": "West Bengal",
    "Gandhi Creation": "Maharashtra", "Gaurav Trading Company": "UP", "Indigo Fashions": "West Bengal",
    "Ishwar Sports And Fitness": "Maharashtra", "JAIN SPORTS": "MP", "Jai Sports": "Chhattisgarh",
    "Jodhpur Apparels": "Rajasthan", "Kanchan Sales Corporation": "Gujarat", "Kripal Traders": "Uttarakhand",
    "Kumar Enterprises": "Bihar", "MTS Fashions": "Tamil Nadu", "Noble Sports Wear": "Telangana",
    "PAWAN GARMENTS": "Jammu", "SH Hosiery": "Rajasthan", "Sports & Paper House": "Tripura/Mizoram",
    "Sri Sai Durga Trader  Jeypore": "Odisha", "Sri Sai Enterprises": "Andhra Pradesh",
    "Sri Sai Enterprises - Vizianagaram": "Andhra Pradesh", "Tirupati Traders": "West Bengal",
    "Arti hosiery house": "UP", "M S Shree Ram Hosiery": "Bihar", "Mukunda Clothing": "Andhra Pradesh",
    "Shivaani Sports": "Delhi NCR", "U.S URBANIC": "Assam",
    "JAIN DISTRIBUTORS": "West Bengal", "MD Creation": "Tripura", "MS YK Sports India  Jagatpur": "Odisha",
    "Mukesh Readymade Stores": "Assam", "R M Readymades": "Tamil Nadu", "Savo Investments": "Kerala",
}
# short names used in BO_data.ipynb -> names in MANUAL_STATE.
# "Tirupati" is deliberately NOT mapped to "Tirupati Traders" (West Bengal): its retailers are in UP
# (Prayagraj, Lucknow, Gorakhpur, Meerut), so it keeps UP from Dist-state.xlsx.
DIST_ALIAS = {
    "Arti Hosiery": "Arti hosiery house", "Creative Marketing": "Creative Marketing Group", "EM BEE": "EM BEE SPORTS",
    "Gandhi": "Gandhi Creation", "Gaurav": "Gaurav Trading Company", "Indigo fashion": "Indigo Fashions",
    "Ishwar Sports": "Ishwar Sports And Fitness", "Jain Sports": "JAIN SPORTS", "Kanchan": "Kanchan Sales Corporation",
    "Mukesh Readymade": "Mukesh Readymade Stores", "Noble": "Noble Sports Wear", "Pawan Garments": "PAWAN GARMENTS",
    "RM Readymades": "R M Readymades", "Shree Ram Hosiery": "M S Shree Ram Hosiery",
    "Sri Sai Durga Trader - Jeypore": "Sri Sai Durga Trader  Jeypore", "Sri Sai Enterprise": "Sri Sai Enterprises",
    "U S Urbanic": "U.S URBANIC", "MD Creations": "MD Creation",
}
STATE_CANON = {  # spelling variants -> one display name
    "up": "Uttar Pradesh", "uttarpradesh": "Uttar Pradesh", "mp": "Madhya Pradesh", "madhyapradesh": "Madhya Pradesh",
    "maharstara": "Maharashtra", "maharashtra": "Maharashtra", "andhara": "Andhra Pradesh", "andhrapradesh": "Andhra Pradesh",
    "chattisgarh": "Chhattisgarh", "chhattisgarh": "Chhattisgarh", "biharpatna": "Bihar", "biharbhagalpur": "Bihar",
    "bihar": "Bihar", "delhincr": "Delhi NCR", "delhi": "Delhi NCR", "tripuramizoram": "Tripura/Mizoram",
    "tamilnadu": "Tamil Nadu", "westbengal": "West Bengal", "jammu": "Jammu", "jammukashmir": "Jammu",
}
STATE_REGION = {
    "UP": "North", "Uttarakhand": "North", "Jammu": "North", "Delhi NCR": "North", "Punjab": "North", "Rajasthan": "North",
    "Maharashtra": "West", "Gujarat": "West", "MP": "West", "Chhattisgarh": "West",
    "Tamil Nadu": "South", "Kerala": "South", "Karnataka": "South", "Telangana": "South", "Andhra Pradesh": "South",
    "Odisha": "East", "West Bengal": "East", "Jharkhand": "East", "Bihar": "East", "Assam": "East",
    "Tripura/Mizoram": "East", "Tripura": "East", "Nagaland": "East",
}
STATE_REGION.update({"Uttar Pradesh": "North", "Madhya Pradesh": "West"})



def tier_for(v, qkey):
    """Computed tier of a quarterly purchase, using only the tiers in force in that quarter."""
    for t, lo in slabs_in(qkey):
        if v >= lo and tier_allowed(t, qkey):
            return t
    return "Untiered"


def cap_tier(t, qkey):
    """A tier reported in a distributor sheet, limited to the tiers in force: Platinum before Q1_FY27 -> Gold."""
    if t in TIER_ORDER and not tier_allowed(t, qkey):
        return next(x for x in reversed(TIER_ORDER[:TIER_ORDER.index(t)]) if tier_allowed(x, qkey))
    return t


# ------------------------------------------------------------------ helpers
def clean_value(x):
    if isinstance(x, (int, float, np.integer, np.floating)):
        return 0.0 if pd.isna(x) else float(x)
    if x is None:
        return 0.0
    s = str(x).strip()
    if s == "" or s.lower() in ("nan", "na", "n/a", "none", "-"):
        return 0.0
    neg = s.startswith("(") and s.endswith(")")
    s = re.sub(r"[^0-9.\-]", "", s)
    try:
        v = float(s)
    except ValueError:
        return 0.0
    return -v if neg else v


# ============================================================
# PHONE PARSING  ->  Phone (primary) + Phone_Alt (all other numbers)
# ============================================================

# separators between numbers: / , ; | & + newline tab, "and"/"or", or 2+ spaces
PHONE_SPLIT_RE = re.compile(r"[\/;|&+,\n\r\t]+|\s{2,}|\band\b|\bor\b", flags=re.IGNORECASE)
MOBILE_RE = re.compile(r"^[6-9]\d{9}$")
THOUSANDS_RE = re.compile(r"^\s*\d{1,3}(,\d{3}){4,}\s*$")      # 88,959,338,656,370,900,000 (sheet number format)
JUNK_NUMBERS = {"9999999999", "8888888888", "7777777777", "6666666666", "9876543210", "1234567890"}


def _phone_candidates(d):
    """Yield (candidate, tier) from a digits-only token. Lower tier = more trustworthy."""
    n = len(d)
    if n < 10:
        return
    if d[0] == "0":
        st = d.lstrip("0")
        if len(st) == 12 and st.startswith("91"):
            yield st[2:], 1
        elif n == 11:
            yield d[1:], 2            # 0 + 10 digits (could be an STD landline)
        return
    if n == 12 and d.startswith("91"):
        yield d[2:], 1; return
    if n == 13 and d.startswith("91"):
        yield d[2:12], 1; return
    if n == 10:
        yield d, 1; return
    if n == 11:                       # one stray digit: prefer dropping the last, else the first
        yield (d[:10], 3) if MOBILE_RE.match(d[:10]) else (d[1:], 3)
    elif n >= 20 and n % 10 == 0:     # numbers glued together by single spaces
        for i in range(0, n, 10):
            yield d[i:i + 10], 3
    elif n == 12:
        yield d[:10], 3


def extract_phones(value, max_numbers=4):
    """All valid 10-digit Indian mobiles in a messy cell, best first, de-duplicated."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return []
    s = str(value).strip()
    if not s or s.lower() in ("nan", "none", "0"):
        return []
    if re.fullmatch(r"\d+(\.\d+)?e\+\d+", s, flags=re.I):          # 9.99566e+09
        s = f"{float(s):.0f}"
    elif re.fullmatch(r"\d+\.0", s):                                 # 9876543210.0
        s = s[:-2]
    elif THOUSANDS_RE.match(s):                                      # corrupted by number formatting
        s = re.sub(r"\D", "", s)[:10]
    hits = {}
    for pos, tok in enumerate(PHONE_SPLIT_RE.split(s)):
        dg = re.sub(r"\D", "", tok)
        for cand, tier in _phone_candidates(dg):
            if not MOBILE_RE.match(cand) or cand in JUNK_NUMBERS or len(set(cand)) <= 2 or cand.endswith("00000"):
                continue
            if cand not in hits or (tier, pos) < hits[cand]:
                hits[cand] = (tier, pos)
    return sorted(hits, key=lambda c: hits[c])[:max_numbers]


def split_phone_columns(df, col="Phone"):
    """Adds Phone_Raw (original text), Phone (primary) and Phone_Alt (others, ' | ' joined)."""
    raw = df[col] if col in df.columns else pd.Series(pd.NA, index=df.index)
    nums = raw.apply(extract_phones)
    df["Phone_Raw"] = raw
    df["Phone"] = nums.apply(lambda l: l[0] if l else pd.NA)
    df["Phone_Alt"] = nums.apply(lambda l: " | ".join(l[1:]) if len(l) > 1 else pd.NA)
    return df


REP = {"SPORT": "SPORTS", "GARMENT": "GARMENTS", "FASHIONS": "FASHION", "COLLECTIONS": "COLLECTION",
       "TRADER": "TRADERS", "ENTERPRISE": "ENTERPRISES", "HOSIERIES": "HOSIERY", "MENS": "MEN",
       "MENSWEAR": "MEN WEAR", "READYMADES": "READYMADE", "CLOTHINGS": "CLOTHING", "CENTER": "CENTRE",
       "SHREE": "SRI", "SHRI": "SRI", "SREE": "SRI"}


def norm_name(s):
    s = str(s).upper().replace("â€™", "'").replace("’", "'")
    s = re.sub(r"^\s*M\s*/\s*S\.?\s*", "", s)          # leading "M/S" prefix
    s = s.replace("&", " AND ")
    s = re.sub(r"[^A-Z0-9]", " ", s)
    toks = [t for t in s.split() if t not in {"THE", "AND"}]
    toks = [REP.get(t, t) for t in toks]
    return " ".join(toks)


def compact(s):
    return norm_name(s).replace(" ", "")


def digits_sig(s):
    return tuple(re.findall(r"\d+", str(s)))


class DSU:
    def __init__(self, n): self.p = list(range(n))
    def f(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]; x = self.p[x]
        return x
    def u(self, a, b):
        a, b = self.f(a), self.f(b)
        if a != b: self.p[max(a, b)] = min(a, b)


# ------------------------------------------------------------------ 1. load rows
rows = []
missing = [f for f, _, _ in QUARTERS if not os.path.exists(os.path.join(BASE, f))]
if missing:   # a quarter not consolidated yet: run without it rather than fail
    print("Skipping quarters with no file yet:", ", ".join(missing))
    QUARTERS = [x for x in QUARTERS if x[0] not in missing]
    QKEYS, MONTHS, MONTH_Q = layout(QUARTERS)
for f, q, ms in QUARTERS:
    d = pd.read_csv(os.path.join(BASE, f), low_memory=False, dtype={"Phone": str, "Phone_Alt": str, "Pincode": str})
    if "Phone_Alt" not in d.columns:          # older file: split the raw phone text here
        split_phone_columns(d, "Phone")
    d = d[d["Retailer Name"].notna() & (d["Retailer Name"].astype(str).str.strip() != "")].copy()
    d["Quarter"] = q
    for m in MONTHS:
        d[m] = d[m].apply(clean_value) if m in d.columns else 0.0
    d["Month_Sum"] = d[[m for m in ms if MONTH_Q[m] == q]].sum(axis=1)   # only this quarter's months
    d["L3M"] = d["Last 3 Months"].apply(clean_value) if "Last 3 Months" in d.columns else 0.0
    # tier basis per row: the larger of the sheet's Last-3-Months figure and the monthly sum
    d["Tier_Basis"] = np.maximum(d["L3M"], d["Month_Sum"])
    for c in ["District", "State", "Address", "City", "New Tier", "Old Tier", "Code name", "Deliverables"]:
        if c not in d.columns:
            d[c] = np.nan
    # the notebook's own Code name (its files carry a Retailer_ID): BO_Data keeps its lines as they are
    d["NB_Code"] = d["Code name"] if "Retailer_ID" in d.columns else np.nan
    d["NB_ID"] = d["Retailer_ID"] if "Retailer_ID" in d.columns else np.nan
    rows.append(d[["Quarter", "Distributor", "Retailer Name", "Code name", "NB_Code", "NB_ID", "Phone", "Phone_Alt", "Pincode", "District",
                   "State", "City", "Address", "New Tier", "Old Tier", "Deliverables", "L3M", "Month_Sum",
                   "Tier_Basis"] + MONTHS])
R = pd.concat(rows, ignore_index=True)
R["Retailer Name"] = R["Retailer Name"].astype(str).str.replace(r"\s+", " ", regex=True).str.strip()
R["Pin"] = R["Pincode"].astype(str).str.replace(r"\.0$", "", regex=True).str.replace(r"\D", "", regex=True)
R.loc[R["Pin"].str.len() != 6, "Pin"] = np.nan
def _row_phones(p, alt):
    out = []
    for v in [p] + (str(alt).split("|") if isinstance(alt, str) else []):
        for x in extract_phones(v):
            if x not in out:
                out.append(x)
    return out
R["Phones"] = [_row_phones(p, a) for p, a in zip(R["Phone"], R["Phone_Alt"])]
R["Norm"] = R["Retailer Name"].map(norm_name)
R["Key"] = R["Retailer Name"].map(compact)
# a shop name without letters or digits (".", "-") is kept under its phone (or address, else its distributor)
_nameless = R["Key"] == ""
if _nameless.any():
    R.loc[_nameless, "Retailer Name"] = ["(Name missing) " + (ps[0] if ps else (str(a).strip()[:40] if pd.notna(a) and
                                         str(a).strip() else str(d_))) for ps, a, d_ in
                                         zip(R.loc[_nameless, "Phones"], R.loc[_nameless, "Address"],
                                             R.loc[_nameless, "Distributor"])]
    R.loc[_nameless, "Norm"] = R.loc[_nameless, "Retailer Name"].map(norm_name)
    R.loc[_nameless, "Key"] = R.loc[_nameless, "Retailer Name"].map(compact)
# Every sale stays in (cash-sale rows such as "CASH" / "Cash Sales" too: they become their own retailer). Only rows
# with no name at all, or a sheet's own subtotal line ("TOTAL", "GRAND TOTAL"), are left out; the subtotals would
# count the same purchases twice.
SOURCE_TOTAL = R[MONTHS].sum().sum()
junk = R["Key"].isin(["", "TOTAL", "GRANDTOTAL"])
SUBTOTALS = R.loc[junk, MONTHS].sum().sum()
R = R[~junk].reset_index(drop=True)

# ------------------------------------------------------------------ 2. one retailer per Code name (no merging)
# No duplicate merging (user, 2026-10-22): every Code name (shop name + distributor) is its own retailer, the same
# lines as the BO_Data report. BO_data.ipynb's files: the notebook's Code name and Retailer_ID. Consolidated sheets:
# spellings that differ only in case, spaces or punctuation ("7 HILLS" / "7 hills") are one Code name.
R["QIdx"] = R["Quarter"].map({q: i for i, q in enumerate(QKEYS)})
R["Match_Phones"] = R["Phones"]
R["Cluster"] = R["NB_Code"].where(R["NB_Code"].notna(),
                                  R["Retailer Name"].str.lower().str.replace(r"[^a-z0-9]", "", regex=True)
                                  + "|" + R["Distributor"].astype(str))

# name = the most recent quarter's spelling; ID = the notebook's Retailer_ID, else distributor code + number
canon = (R.sort_values(["QIdx", "Tier_Basis"], ascending=[False, False])
          .groupby(["Distributor", "Cluster"]).first().reset_index())
dist_code = {}
for d in sorted(R["Distributor"].unique()):
    w = re.sub(r"[^A-Z ]", "", d.upper()).split()
    code = (w[0][:3] + "".join(x[0] for x in w[1:]))[:5] if w else "DIST"
    base, k = code, 2
    while code in dist_code.values():
        code = f"{base}{k}"; k += 1
    dist_code[d] = code
canon = canon.sort_values(["Distributor", "Retailer Name"]).reset_index(drop=True)
canon["Retailer_ID"] = canon.groupby("Distributor").cumcount().add(1).astype(str).str.zfill(5)
canon["Retailer_ID"] = canon["Distributor"].map(dist_code) + "-" + canon["Retailer_ID"]
nb_id = canon["NB_ID"].astype("string")
if nb_id.notna().all() and not nb_id.duplicated().any():
    canon["Retailer_ID"] = nb_id.astype(str)
R = R.merge(canon[["Distributor", "Cluster", "Retailer_ID"]], on=["Distributor", "Cluster"], how="left")

# ------------------------------------------------------------------ 3. retailer master
def last_valid(s):
    s = s.dropna()
    s = s[s.astype(str).str.strip().ne("") & s.astype(str).str.lower().ne("nan")]
    return s.iloc[-1] if len(s) else np.nan

Rs = R.sort_values("QIdx")
master = Rs.groupby("Retailer_ID").agg(
    Distributor=("Distributor", "first"),
    District=("District", last_valid), State=("State", last_valid), City=("City", last_valid),
    Pincode=("Pin", last_valid), Address=("Address", last_valid),
    Phone=("Match_Phones", lambda x: next((l[0] for l in reversed(list(x)) if l), np.nan)),
    All_Phones=("Match_Phones", lambda x: list(dict.fromkeys(p for l in reversed(list(x)) for p in l))),
    Name_Variants=("Retailer Name", lambda x: " | ".join(sorted(set(x)))),
    Source_Rows=("Retailer Name", "size"),
).reset_index()
master = master.merge(canon[["Retailer_ID", "Retailer Name"]].rename(columns={"Retailer Name": "Retailer_Name"}), on="Retailer_ID")
master["Phone_Alt"] = master["All_Phones"].map(lambda l: " | ".join(l[1:]) if len(l) > 1 else np.nan)
master = master.drop(columns="All_Phones")

# ---- distributor -> state -> region
def canon_state(x):
    if not isinstance(x, str) or not x.strip():
        return np.nan
    k = re.sub(r"[^a-z]", "", x.lower())
    return STATE_CANON.get(k, x.strip().title())

dist_state = {}
xl = os.path.join(BASE, "Dist-state.xlsx")
if os.path.exists(xl):                                   # fallback list kept in the Power BI folder
    dist_state.update(pd.read_excel(xl).set_index("Distributor")["State"].to_dict())
for short, full in DIST_ALIAS.items():                   # user-confirmed list wins
    if full in MANUAL_STATE:
        dist_state[short] = MANUAL_STATE[full]
for d in master["Distributor"].unique():
    if d in MANUAL_STATE:
        dist_state[d] = MANUAL_STATE[d]
mode_state = master.dropna(subset=["State"]).groupby("Distributor")["State"].agg(lambda x: x.mode().iat[0])
master["State"] = master["Distributor"].map(dist_state).fillna(master["Distributor"].map(mode_state)).map(canon_state)
master["Region"] = master["State"].map(lambda s: STATE_REGION.get(s, "Unmapped"))
master["District"] = master["District"].astype(str).str.upper().str.strip().replace("NAN", np.nan)

# ------------------------------------------------------------------ 4. retailer x quarter / month
tier_rank = {t: i for i, t in enumerate(TIER_ORDER)}
rq = R.groupby(["Retailer_ID", "Quarter"]).agg(
    Revenue=("Month_Sum", "sum"), Tier_Basis=("Tier_Basis", "sum"),
    Reported_Tier=("New Tier", lambda x: max([t for t in x if t in tier_rank] or ["Untiered"], key=tier_rank.get)),
).reset_index()
rq["Computed_Tier"] = [tier_for(v, q) for v, q in zip(rq["Tier_Basis"], rq["Quarter"])]
rq["Reported_Tier"] = [cap_tier(t, q) for t, q in zip(rq["Reported_Tier"], rq["Quarter"])]

rm = R.groupby("Retailer_ID")[MONTHS].sum()

# benefits from deliverables_consolidated.csv (Code_Name + Quarter -> Benefit status)
dpath = os.path.join(BASE, "deliverables_consolidated.csv")
if os.path.exists(dpath):
    D = pd.read_csv(dpath, usecols=["Code_Name", "Distributor", "Quarter", "Deliverables", "Benefit", "Status"])
    link = R[["Code name", "Distributor", "Quarter", "Retailer_ID"]].dropna().drop_duplicates(["Code name", "Distributor", "Quarter"])
    D = D.merge(link, left_on=["Code_Name", "Distributor", "Quarter"], right_on=["Code name", "Distributor", "Quarter"], how="inner")
    srank = {"Yes": 2, "Cancelled": 1, "No": 0}
    D["S"] = D["Status"].map(srank).fillna(0)
    B = D.pivot_table(index=["Retailer_ID", "Quarter"], columns="Benefit", values="S", aggfunc="max").reset_index()
    inv = {v: k for k, v in srank.items()}
    for b in BENEFITS:
        B[b] = B[b].map(inv).fillna("No") if b in B.columns else "No"
    dl = D.groupby(["Retailer_ID", "Quarter"])["Deliverables"].agg(
        lambda x: "Yes" if (x == "Yes").any() else ("Cancelled" if (x == "Cancelled").any() else "No")).reset_index()
    rq = rq.merge(B[["Retailer_ID", "Quarter"] + BENEFITS], on=["Retailer_ID", "Quarter"], how="left") \
           .merge(dl, on=["Retailer_ID", "Quarter"], how="left")
    for b in BENEFITS + ["Deliverables"]:
        rq[b] = rq[b].fillna("No")

# first active month / quarter (onboarding)
active_m = (rm > 0)
master = master.set_index("Retailer_ID")
master["First_Active_Month"] = active_m.idxmax(axis=1).where(active_m.any(axis=1))
master["Last_Active_Month"] = active_m.iloc[:, ::-1].idxmax(axis=1).where(active_m.any(axis=1))
master["First_Active_Quarter"] = master["First_Active_Month"].map(MONTH_Q)
first_listed = R.groupby("Retailer_ID")["QIdx"].min().map(dict(enumerate(QKEYS)))
master["First_Listed_Quarter"] = first_listed
master["Lifetime_Revenue"] = rm.sum(axis=1)
master = master.reset_index()

# ------------------------------------------------------------------ 6. write
master.to_csv(os.path.join(OUT, "retailers.csv"), index=False)
rq.to_csv(os.path.join(OUT, "retailer_quarter.csv"), index=False)
rm_long = rm.reset_index().melt(id_vars="Retailer_ID", var_name="Month", value_name="Revenue")
rm_long["Quarter"] = rm_long["Month"].map(MONTH_Q)
rm_long[rm_long["Revenue"] != 0].to_csv(os.path.join(OUT, "retailer_month.csv"), index=False)

# BO_Data report: one line per Code name (shop name + distributor) with no phone-number merging, values exact to the
# paisa. From BO_data.ipynb's cleaned files (/Power BI/FY*_qtr*.csv): the notebook's own Code name, as in
# Monthwise.csv. From the Consolidated sheets: spellings that differ only in case, spaces or punctuation ("7 HILLS" /
# "7 hills") are one line under the alphabetically first spelling; their rows add up once.
C = R.assign(Code_key=R["NB_Code"].where(R["NB_Code"].notna(),
                                         R["Retailer Name"].str.lower().str.replace(r"[^a-z0-9]", "", regex=True)
                                         + "|" + R["Distributor"].astype(str)),
             First_Phone=[l[0] if l else np.nan for l in R["Phones"]])
cg = C.groupby("Code_key", sort=False)
nb_code = cg["NB_Code"].agg(last_valid)
codes = pd.DataFrame({
    "Retailer_Name": cg["Retailer Name"].last().where(nb_code.notna(), cg["Retailer Name"].min()),
    "Distributor": cg["Distributor"].first(),
    "Phone": cg["First_Phone"].agg(last_valid), "Pincode": cg["Pin"].agg(last_valid),
    "City": cg["City"].agg(last_valid),
    "Listed": cg["Quarter"].agg(lambda x: "|".join(dict.fromkeys(x))),
})
codes["State"] = codes["Distributor"].map(dist_state).fillna(codes["Distributor"].map(mode_state)).map(canon_state)
codes["Region"] = codes["State"].map(lambda s: STATE_REGION.get(s, "Unmapped"))
codes = codes.join(cg[MONTHS].sum().round(4))
codes.insert(0, "Code_name", nb_code.where(nb_code.notna(), codes["Retailer_Name"] + "-" + codes["Distributor"].astype(str)))
codes.to_csv(os.path.join(OUT, "code_names.csv"), index=False)
print("Code-name check  sheets:", round(SOURCE_TOTAL - SUBTOTALS, 2), " code names:", round(codes[MONTHS].values.sum(), 2))

# compact JSON for the dashboard
dists = sorted(master["Distributor"].unique())
regions = ["North", "South", "East", "West"] + sorted(set(master["Region"]) - {"North", "South", "East", "West"})
dinfo = master.groupby("Distributor")[["State", "Region"]].first()
di = {d: i for i, d in enumerate(dists)}
ri = {r: i for i, r in enumerate(regions)}
rq_idx = {(x["Retailer_ID"], x["Quarter"]): x for x in rq.to_dict("records")}
def _paise(v):
    v = round(float(v), 4)
    return int(v) if v == int(v) else v
rm_d = {k: v for k, v in zip(rm.index, rm.values.tolist())}
tiers_short = {t: i for i, t in enumerate(TIER_ORDER)}
bcode = {"No": "0", "Yes": "1", "Cancelled": "2"}
ret = []
for r in master.itertuples():
    rev = [_paise(v) for v in rm_d[r.Retailer_ID]]   # unrounded paise (sheets carry up to 3 decimals): totals match
    tq, rpt, basis, ben, dlv = [], [], [], [], []
    for q in QKEYS:
        x = rq_idx.get((r.Retailer_ID, q))
        if x is not None:
            tq.append(tiers_short[x["Computed_Tier"]]); rpt.append(tiers_short[x["Reported_Tier"]])
            basis.append(int(round(x["Tier_Basis"])))
            ben.append("".join(bcode[x[b]] for b in BENEFITS) if BENEFITS[0] in x else "")
            dlv.append(bcode.get(x.get("Deliverables", "No"), "0"))
        else:
            tq.append(-1); rpt.append(-1); basis.append(0); ben.append(""); dlv.append("0")
    rec = {"id": r.Retailer_ID, "n": r.Retailer_Name, "d": di[r.Distributor],
           "m": rev, "t": tq, "fl": QKEYS.index(r.First_Listed_Quarter)}
    if pd.notna(r.District): rec["ds"] = str(r.District).title()
    if pd.notna(r.Pincode): rec["pin"] = str(r.Pincode)
    if pd.notna(r.Phone): rec["ph"] = str(r.Phone)
    if isinstance(r.Phone_Alt, str): rec["pa"] = r.Phone_Alt
    if rpt != tq: rec["rt"] = rpt
    if any(abs(b - sum(rev[i] for i, mq in enumerate(MONTHS) if MONTH_Q[mq] == q)) > 5 for b, q in zip(basis, QKEYS)): rec["b"] = basis
    if any(ben): rec["bn"] = ben
    if dlv.count("0") != len(dlv): rec["dl"] = "".join(dlv)
    ret.append(rec)
payload = {
    "generated": pd.Timestamp.now().strftime("%d %b %Y"),
    "months": MONTHS, "quarters": QKEYS, "monthQ": [QKEYS.index(MONTH_Q[m]) for m in MONTHS],
    "tiers": TIER_ORDER, "slabs": {t: lo for t, lo in TIER_SLABS}, "tierFrom": TIER_FROM,
    "slabsByQuarter": {q: {t: lo for t, lo in slabs_in(q)} for q in QKEYS}, "benefits": BENEFITS,
    "distributors": [{"n": d, "s": dinfo.at[d, "State"], "r": dinfo.at[d, "Region"]} for d in dists], "regions": regions,
    "scheme": pd.read_excel(os.path.join(BASE, "Tier_scheme.xlsx")).pivot(index="Tier", columns="Benefits", values="Required").to_dict(orient="index")
              if os.path.exists(os.path.join(BASE, "Tier_scheme.xlsx")) else {},
    "retailers": ret,
    "stats": {"source_rows": int(len(R)), "retailers": int(len(master))},
}
with open(os.path.join(OUT, "dashboard_data.json"), "w") as f:
    json.dump(payload, f, separators=(",", ":"))
# gzip copy for the Vercel dashboard (keeps the download well under Vercel's 4.5 MB response limit)
import gzip
with gzip.open(os.path.join(OUT, "dashboard_data.json.gz"), "wt", encoding="utf-8", compresslevel=9) as f:
    json.dump(payload, f, separators=(",", ":"))
print(json.dumps(payload["stats"], indent=1))
print("Revenue check  source:", round(SOURCE_TOTAL - SUBTOTALS, 2), " consolidated:", round(rm.values.sum(), 2),
      " subtotal lines left out:", round(SUBTOTALS, 2))
