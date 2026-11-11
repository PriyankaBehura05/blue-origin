"""Turn the raw input tables into clean frames, logging the rows kept and dropped at every step."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from . import normalise as N
from .inputs import Inputs, norm_col, pick, pick_all

TIERS = ["Untiered", "Yellow", "Green", "Silver", "Gold", "Platinum"]


@dataclass
class Step:
    table: str
    step: str
    rows_in: int
    rows_out: int
    note: str = ""

    @property
    def dropped(self) -> int:
        return self.rows_in - self.rows_out


@dataclass
class Sales:
    retailers: pd.DataFrame                  # one row per retailer, index = position used in the payload
    month: pd.DataFrame                      # r (retailer position), m (month int), rev
    quarters: List[str]                      # ordered FY quarter keys present in the sales data
    month_quarter: Dict[int, str]            # month int -> quarter key as the BO data assigns it
    tiers: List[str]                         # per retailer, one character per quarter: '-' none, '0'..'5' TIERS index
    active: Dict[int, np.ndarray] = field(default_factory=dict)  # retailer position -> sorted billed months


def _quarter_order(q: str) -> tuple:
    import re
    m = re.match(r"Q(\d)_FY(\d+)", q)
    return (int(m[2]), int(m[1])) if m else (999, 9)


def prepare_sales(inp: Inputs, log: List[Step]) -> Sales:
    r = inp.retailers.copy()
    n0 = len(r)
    r = r[r["Retailer_ID"].str.strip() != ""].drop_duplicates("Retailer_ID").reset_index(drop=True)
    log.append(Step("retailers.csv", "retailers with an ID (one row each)", n0, len(r)))
    city_raw = r.get("City", pd.Series([""] * len(r))).str.strip()
    district = r.get("District", pd.Series([""] * len(r))).str.strip()
    r["city_name"] = np.where(city_raw != "", city_raw, district).astype(str)
    r["city_name"] = r["city_name"].str.title()
    r["city_key"] = r["city_name"].map(N.city_key)
    r["pin"] = r.get("Pincode", "").map(N.pincode)
    r["phones"] = r.get("Phone", "").map(N.mobiles)
    r["alt_phones"] = r.get("Phone_Alt", "").map(N.mobiles)
    r["name_key"] = r["Retailer_Name"].map(N.name_key)
    r["lifetime"] = pd.to_numeric(r.get("Lifetime_Revenue", 0), errors="coerce").fillna(0.0)
    pos = {rid: i for i, rid in enumerate(r["Retailer_ID"])}

    m = inp.retailer_month.copy()
    n0 = len(m)
    m["rev"] = pd.to_numeric(m["Revenue"], errors="coerce")
    m["m"] = m["Month"].map(N.sales_month)
    m["r"] = m["Retailer_ID"].map(pos)
    bad = m["rev"].isna() | m["m"].isna() | m["r"].isna()
    log.append(Step("retailer_month.csv", "rows with a known retailer, month and amount", n0, int((~bad).sum()),
                    f"₹{m.loc[bad, 'rev'].fillna(0).sum():,.2f} in dropped rows"))
    m = m[~bad]
    month_quarter = dict(zip(m["m"].astype(int), m["Quarter"]))
    m = m.groupby(["r", "m"], as_index=False)["rev"].sum()
    m["r"] = m["r"].astype(int)
    m["m"] = m["m"].astype(int)
    billed = m[m["rev"] > 0]
    active = {int(k): np.sort(g["m"].to_numpy()) for k, g in billed.groupby("r")}
    quarters = sorted(set(month_quarter.values()), key=_quarter_order)

    tiers = ["-" * len(quarters) for _ in range(len(r))]
    q = inp.retailer_quarter
    if q is not None and len(q):
        col = "Computed_Tier" if "Computed_Tier" in q.columns else "Reported_Tier"
        qi = {k: i for i, k in enumerate(quarters)}
        grid = [["-"] * len(quarters) for _ in range(len(r))]
        for rid, qq, t in zip(q["Retailer_ID"], q["Quarter"], q[col].str.strip().str.title()):
            p, j = pos.get(rid), qi.get(qq)
            if p is not None and j is not None and t in TIERS:
                grid[p][j] = str(TIERS.index(t))
        tiers = ["".join(g) for g in grid]
    return Sales(r, m, quarters, month_quarter, tiers, active)


def prepare_leads(inp: Inputs, log: List[Step], today: Optional[date] = None) -> pd.DataFrame:
    parts = []
    for t in inp.of("leads"):
        df, cols = t.frame, list(t.frame.columns)
        get = lambda k: df[pick(cols, k)] if pick(cols, k) else pd.Series([""] * len(df), index=df.index)  # noqa: E731
        n0 = len(df)
        nonblank = df.apply(lambda row: any(str(v).strip() for v in row), axis=1) if n0 else pd.Series([], dtype=bool)
        log.append(Step(t.file, "non-blank rows", n0, int(nonblank.sum())))
        df = df[nonblank]
        # placeholder and test rows ("No leads found for odisha", a lead named "test")
        names = [c for c in (pick(cols, "name"), "full_name", "shop_name", "name") if c and c in cols]
        text = df.apply(lambda row: " ".join(str(v) for v in row).lower(), axis=1) if len(df) else pd.Series([], dtype=str)
        is_test = df[names].apply(lambda c: c.str.strip().str.lower().str.fullmatch(r"test(ing)?( \w+)?")).any(axis=1) \
            if names and len(df) else pd.Series(False, index=df.index)
        junk = text.str.contains("no leads found") | is_test
        if junk.any():
            log.append(Step(t.file, "placeholder and test rows removed", len(df), int((~junk).sum()),
                            "'No leads found for …' lines and leads named 'test'"))
            df = df[~junk]
        # the same lead copied again (an automation appending the sheet twice): one row per lead id - the copy with the
        # most follow-up filled in - or, without a lead id, one row per identical line
        idc = pick(cols, "lead_id")
        n1 = len(df)
        if idc and (df[idc].str.strip() != "").any():
            fu = [pick(cols, k) for k in ("owner", "called", "visited", "order_flag", "order_value", "category")]
            filled = sum((df[c].str.strip() != "").astype(int) for c in fu if c) if any(fu) else 0
            keyed = df[idc].str.strip()
            order = pd.DataFrame({"k": keyed, "f": filled}, index=df.index).sort_values("f", ascending=False, kind="stable")
            keep = ~order["k"].duplicated() | (order["k"] == "")
            df = df.loc[sorted(order.index[keep.to_numpy()])]
            note = "same lead id more than once; kept the copy with the most follow-up filled in"
        else:
            df = df[~df.duplicated()]
            note = "identical lines"
        if len(df) < n1:
            log.append(Step(t.file, "duplicate copies of the same lead removed", n1, len(df), note))
        part = pd.DataFrame({
            "file": t.file,
            "date": get("date").loc[df.index].map(N.lead_date),
            "mobile_raw": get("mobile").loc[df.index],
            "alt_raw": get("alt_mobile").loc[df.index],
            # shop name, else the person's name when the shop is left blank
            "name": _first_filled(df, [c for c in dict.fromkeys(pick_all(cols, "name"))]),
            "city_name": get("city").loc[df.index].str.strip().str.title(),
            "state": get("state").loc[df.index].map(N.state_name),
            "pin": get("pincode").loc[df.index].map(N.pincode),
            "source": [N.source(v, t.file) for v in get("source").loc[df.index]],
            "campaign": get("campaign").loc[df.index].str.strip().replace("", "(no campaign)"),
            "adset": get("adset").loc[df.index].str.strip().replace("", "(no ad set)"),
            # follow-up kept on the lead sheet (ASM NAME, Calling Done, Visit Done, Order Placed, Order Value, ...)
            "f_owner": get("owner").loc[df.index].fillna("").str.strip().str.title(),
            "f_called": get("called").loc[df.index].map(N.flag),
            "f_visited": get("visited").loc[df.index].map(N.flag),
            "f_order": get("order_flag").loc[df.index].map(N.flag),
            "f_value": get("order_value").loc[df.index].map(N.amount),
            "f_cat": get("category").loc[df.index].map(N.category),
            "f_cat_raw": get("category").loc[df.index].fillna("").str.strip(),
            "f_self": get("self_existing").loc[df.index].map(N.flag),
            "f_tracked": bool(pick(cols, "owner") or pick(cols, "called")),   # this sheet has ASM columns at all
        })
        n1 = len(part)
        part = part[part["date"].notna()]
        log.append(Step(t.file, "rows with a readable lead date", n1, len(part),
                        "" if pick(cols, "date") else "no lead-date column found"))
        n2, today = len(part), today or date.today()
        part = part[part["date"] <= today]      # a date not reached yet is a typing slip in the source
        if len(part) < n2:
            log.append(Step(t.file, "rows not dated in the future", n2, len(part), f"after {today:%d %b %Y}"))
        parts.append(part)
    if not parts:
        return pd.DataFrame(columns=["file", "date", "mobile", "alt", "name", "city_name", "city_key", "state", "pin",
                                     "source", "campaign", "adset", "valid", "unique", "f_owner", "f_called", "f_visited", "f_order", "f_value", "f_cat", "f_self", "f_tracked"])
    leads = pd.concat(parts, ignore_index=True)
    leads["mobile"] = leads["mobile_raw"].map(N.mobile)
    fixed = int(leads["mobile_raw"].map(N.mobile_repaired).sum())
    if fixed:
        log.append(Step("all lead files", "mobiles repaired", len(leads), len(leads),
                        f"{fixed:,} numbers typed with an extra 1 / 91 / 0 in front - the 10-digit mobile kept"))
    leads["f_owner"], merged = _merge_names(leads["f_owner"])
    if merged:
        log.append(Step("all lead files", "ASM name spellings merged", len(leads), len(leads),
                        "; ".join(f"{a} → {b}" for a, b in merged)))
    n_cat = leads.loc[leads["f_cat_raw"] != "", "f_cat_raw"].str.lower().str.strip().nunique()
    if n_cat:
        log.append(Step("all lead files", "call categories tidied", n_cat, int(leads.loc[leads["f_cat"] != "", "f_cat"].nunique()),
                        "the ASMs' Category spellings grouped into one short list (rows in = spellings, rows out = groups)"))
    leads = leads.drop(columns=["f_cat_raw"])
    leads["alt"] = leads["alt_raw"].map(N.mobile)
    leads["valid"] = leads["mobile"] != ""
    leads["city_key"] = leads["city_name"].map(N.city_key)
    leads["name_key"] = leads["name"].map(N.name_key)
    log.append(Step("all lead files", "rows with a valid 10-digit mobile (the rest stay as 'Invalid number')",
                    len(leads), int(leads["valid"].sum())))
    # first touch: the earliest lead per mobile is the unique lead; later ones are repeats
    leads = leads.sort_values(["date", "file"], kind="stable").reset_index(drop=True)
    first = ~leads["mobile"].duplicated() | ~leads["valid"]
    leads["unique"] = first
    log.append(Step("all lead files", "unique leads (first lead per mobile; invalid numbers count once per row)",
                    len(leads), int(first.sum())))
    # the ASM columns may be filled on any row of a mobile (a repeat enquiry often carries the call): one set per
    # mobile - called / visited / order = yes on any row, the largest order value, the latest owner and category
    v = leads["valid"]
    if v.any():
        g = leads[v].groupby("mobile")
        per = g[["f_called", "f_visited", "f_order", "f_self", "f_value"]].max()
        for c in ("f_owner", "f_cat"):
            per[c] = g[c].agg(lambda s: next((x for x in reversed(s.tolist()) if x), ""))
        for c in per.columns:
            leads.loc[v, c] = leads.loc[v, "mobile"].map(per[c]).to_numpy()
    return leads.drop(columns=["mobile_raw", "alt_raw"])


def _first_filled(df: pd.DataFrame, columns: List[str]) -> pd.Series:
    """Per row, the first of the columns that is not blank."""
    out = pd.Series([""] * len(df), index=df.index)
    for c in reversed(columns):
        v = df[c].fillna("").str.strip()
        out = v.where(v != "", out)
    return out


def _merge_names(names: pd.Series):
    """One spelling per ASM: case ('sATISH' = 'Satish') and rare near-misses of a much more common name
    ('Sunn' -> 'Sunny', 'RRaja' -> 'Raja'). Returns the names and the merges made."""
    from rapidfuzz import fuzz
    tidy = names.fillna("").str.strip().str.replace(r"\s+", " ", regex=True).str.title()
    counts = tidy[tidy != ""].value_counts()
    mapping, merged = {}, []
    for rare, n in counts.items():
        for big, m in counts.items():
            if big != rare and m >= 5 * n and len(rare) > 2 and fuzz.ratio(rare.lower(), big.lower()) >= 85:
                mapping[rare] = big
                merged.append((rare, big))
                break
    return tidy.replace(mapping), merged


def prepare_spend(inp: Inputs, log: List[Step]) -> pd.DataFrame:
    rows = []
    for t in inp.of("spend"):
        df, cols = t.frame, list(t.frame.columns)
        c_camp, c_spend, c_month = pick(cols, "campaign"), pick(cols, "spend"), pick(cols, "month")
        if not (c_camp and c_spend):
            log.append(Step(t.file, "spend rows (campaign + amount needed)", len(df), 0, "campaign or amount column missing"))
            continue
        amt = pd.to_numeric(df[c_spend].str.replace(r"[₹,\s]", "", regex=True), errors="coerce")
        mon = df[c_month].map(N.spend_month) if c_month else pd.Series([None] * len(df), index=df.index)
        ok = amt.notna() & (df[c_camp].str.strip() != "")
        log.append(Step(t.file, "spend rows with a campaign and an amount", len(df), int(ok.sum()),
                        "" if c_month else "no month column: spend is not split by month"))
        rows.append(pd.DataFrame({"campaign": df.loc[ok, c_camp].str.strip(), "m": mon[ok], "spend": amt[ok]}))
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(columns=["campaign", "m", "spend"])


def prepare_followup(inp: Inputs, log: List[Step]) -> pd.DataFrame:
    rows = []
    for t in inp.of("followup"):
        df, cols = t.frame, list(t.frame.columns)
        get = lambda k: df[pick(cols, k)] if pick(cols, k) else pd.Series([""] * len(df), index=df.index)  # noqa: E731
        f = pd.DataFrame({"mobile": get("mobile").map(N.mobile), "owner": get("owner").str.strip(),
                          "distributor": get("distributor").str.strip(), "contact": get("contact_date").map(N.lead_date),
                          "status": get("status").str.strip().str.title()})
        ok = f["mobile"] != ""
        log.append(Step(t.file, "follow-up rows with a valid mobile", len(f), int(ok.sum())))
        rows.append(f[ok])
    if not rows:
        return pd.DataFrame(columns=["mobile", "owner", "distributor", "contact", "status"])
    f = pd.concat(rows, ignore_index=True)
    # one row per mobile: the first contact and the latest status
    f = f.sort_values("contact", na_position="last", key=lambda s: s.map(lambda d: d.toordinal() if d else 10**9))
    return f.groupby("mobile", as_index=False).agg({"owner": "first", "distributor": "first", "contact": "first", "status": "last"})


DEFAULT_TARGETS = {
    "conversion_pct": 5.0,            # lead -> new retailer, %
    "marketing_share_pct": 20.0,      # share of new retailers acquired from leads, %
    "cost_per_retailer": 5000.0,      # ₹ per converted retailer
    "new_retailers_quarter": 1500.0,  # new retailers per quarter
    "retention_pct": 60.0,            # retailers billed last quarter who billed again, %
    "revenue_at_risk_pct": 5.0,       # max revenue at risk as % of the period's revenue
    "unique_leads_quarter": 3000.0,
    "sla_days": 2.0,                  # days to first contact
    "gross_margin_pct": 30.0,         # margin on retailer billing, for payback and ROI
}


TARGET_ALIASES = {
    "conversion": "conversion_pct", "conversion_rate": "conversion_pct", "lead_conversion": "conversion_pct",
    "paid_share_of_new_retailers": "marketing_share_pct", "paid_share": "marketing_share_pct",
    "marketing_share": "marketing_share_pct", "cost_per_converted_retailer": "cost_per_retailer",
    "new_retailers": "new_retailers_quarter", "new_retailers_per_quarter": "new_retailers_quarter",
    "retention": "retention_pct", "gross_margin": "gross_margin_pct", "margin": "gross_margin_pct", "unique_leads": "unique_leads_quarter", "sla": "sla_days",
}


def prepare_targets(inp: Inputs, log: List[Step]) -> Dict[str, float]:
    found: Dict[str, float] = {}
    for t in inp.of("targets"):
        df, cols = t.frame, list(t.frame.columns)
        c_m, c_v = pick(cols, "metric"), pick(cols, "value")
        if not (c_m and c_v):
            continue
        for k, v in zip(df[c_m], df[c_v]):
            key = norm_col(k)
            target = key if key in DEFAULT_TARGETS else TARGET_ALIASES.get(key)
            val = pd.to_numeric(str(v).replace(",", "").replace("%", "").replace("₹", "").strip(), errors="coerce")
            if target and pd.notna(val):
                found[target] = float(val)
        log.append(Step(t.file, "targets recognised", len(df), len(found)))
    return found
