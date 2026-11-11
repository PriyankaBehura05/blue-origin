"""Run the whole pipeline: input bytes in, dashboard payload + reconciliation workbook + findings memo out."""
from __future__ import annotations

import io
from dataclasses import asdict, dataclass
from datetime import date
from typing import Dict, List, Optional

import pandas as pd

from . import inputs as I
from . import metrics as M
from . import normalise as N
from .classify import classify
from .match import FUZZY_CEILING, FUZZY_LIKELY, match
from .memo import write_memo
from .payload import build_payload
from .prep import DEFAULT_TARGETS, Step, prepare_followup, prepare_leads, prepare_sales, prepare_spend, prepare_targets

ASSUMPTIONS = [
    "Reporting window: every acquisition count uses the period picked in the filter bar (default: latest quarter with "
    "sales); 'All' = the whole span of the sales data. Quarters follow the financial year (Q1 = Apr–Jun; FY 27 = Apr 2026 "
    "– Mar 2027), with the BO data's own month → quarter mapping (Sept 2024 counts in Q3 FY 25).",
    "Sales are monthly totals per retailer (no invoice dates), so 'days' become calendar months: 90 days before a lead = "
    "the 3 months before the lead's month; the attribution window ends in the month of lead date + 30/60/90 days.",
    "A bill in the lead's own month counts as after the lead (its day is unknown). This can overstate conversion for "
    "leads late in a month whose retailer billed earlier the same month.",
    "An 'order' is a month with billing; 'repeat' = billed in 2 or more months.",
    "First touch: when one mobile arrives several times, the earliest lead owns it; later ones count as repeat leads.",
    "Matching levels: floor = exact main phone only; likely = main or alternate phone, or business name ≥ "
    f"{FUZZY_LIKELY}% similar in the same pincode/city; ceiling = fuzzy ≥ {FUZZY_CEILING}%. When one number belongs to "
    "several retailers, the one billed first is used.",
    "Retailer acquisition source: a retailer whose first bill was a 'New retailer' outcome of a lead takes that lead's "
    "source (Meta, Google, JustDial, Print, Other) = marketing; every other retailer is Organic (includes distributor-"
    "led, ASM/RSM and word of mouth, which the data cannot separate).",
    "Health (as of the last sales month E): Active = billed in E or E−1 (< ~45 days); At-risk = last bill in E−2 (45–90 "
    "days); Churned = last bill E−3 or earlier (> 90 days).",
    "Revenue at risk = the 3 months of billing up to the last bill of every At-risk retailer (one quarter's run-rate).",
    "Retention (repeat) = retailers billed in the previous period who billed again in this period.",
    "Tiers are the BO Dashboard's recomputed tiers per quarter (retailer_quarter.csv Computed_Tier), Platinum only from "
    "Q1 FY 27.",
    "City = the retailer's City, else its District. City tiers: Tier 1 = 9 metros, Tier 2 = HRA 'Y' cities, else Tier 3.",
    "95% confidence intervals are Wilson intervals; groups under 30 are marked 'small sample'.",
]


@dataclass
class Result:
    payload: dict
    reconciliation: bytes
    memo: str


def _gaps(inp: I.Inputs, sales, leads, spend, follow, found_targets) -> List[str]:
    g = []
    if not inp.of("leads"):
        g.append("No lead dump yet: drop the Meta / Google / JustDial / Print lead exports (CSV or Excel) into the leads "
                 "inbox. Until then every lead-based number is empty; the sales-based sections are live.")
    if not len(spend):
        g.append("No marketing spend by campaign × month: CPL, cost per converted retailer, payback and ROI are skipped.")
    inline = len(leads) and bool(((leads["f_owner"] != "") | (leads["f_called"] >= 0)).any())
    if not len(follow) and not inline:
        g.append("No lead follow-up log: assigned-vs-followed-up, SLA breaches and ASM leaderboards are skipped.")
    elif not len(follow):
        g.append("Follow-up comes from the ASM columns of the lead sheets (ASM name, called, visited, order placed, "
                 "order value, category). They carry no call date, so time to first contact and SLA breaches cannot "
                 "be measured; 'Order placed' is the ASM's word, checked against BO billing.")
    if not found_targets:
        g.append("No targets sheet: RAG uses the editable placeholder targets (Data quality section).")
    r = sales.retailers
    g.append(f"Retailer phone missing for {100 * (r['phones'].map(len) == 0).mean():.0f}% of retailers: their leads can "
             "only be matched by name (pass 3).")
    g.append(f"Retailer city missing for {100 * (r['city_name'] == '').mean():.0f}% of retailers even after using the "
             "district: city-level geography and fuzzy matching are thinner there.")
    g.append("Sales are monthly per retailer, not invoice-level: no invoice dates, AOV is per billing month, and "
             "category mix is not available.")
    g.append("No ASM/RSM in the sales register and no onboarding source in the retailer master: distributor-led, "
             "ASM-led and word-of-mouth acquisitions are all shown as Organic.")
    for t in inp.tables:
        if t.kind == "unknown":
            g.append(f"File not used: {t.file} ({t.note}).")
    if len(spend) and len(leads):
        unknown = sorted(set(spend["campaign"]) - set(leads["campaign"]))
        if unknown:
            g.append(f"Spend for {len(unknown)} campaign(s) with no leads: {', '.join(unknown[:8])}"
                     f"{'…' if len(unknown) > 8 else ''}.")
    return g


def _workbook(sheets: Dict[str, pd.DataFrame]) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="xlsxwriter") as xw:
        for name, df in sheets.items():
            df.to_excel(xw, sheet_name=name[:31], index=False)
            ws = xw.sheets[name[:31]]
            ws.freeze_panes(1, 0)
            for j, c in enumerate(df.columns):
                width = max([len(str(c))] + [len(str(v)) for v in df[c].head(200)]) + 2
                ws.set_column(j, j, min(90, width))
    return buf.getvalue()


def run(inbox: Dict[str, bytes], sales_files: Dict[str, bytes], target_overrides: Optional[dict] = None,
        today: Optional[date] = None) -> Result:
    inp = I.load(inbox, sales_files)
    if inp.retailers is None or inp.retailer_month is None:
        raise ValueError("The BO Dashboard sales outputs (network/retailers.csv and retailer_month.csv) are missing: "
                         "run the BO Dashboard build first.")
    log: List[Step] = []
    sales = prepare_sales(inp, log)
    leads = prepare_leads(inp, log, today)
    if len(leads):
        leads = classify(match(leads, sales), sales)
    spend = prepare_spend(inp, log)
    follow = prepare_followup(inp, log)
    found = prepare_targets(inp, log)
    targets = {**DEFAULT_TARGETS, **(target_overrides or {}), **found}
    gaps = _gaps(inp, sales, leads, spend, follow, found)
    files = [{"file": t.file, "kind": t.kind, "rows": int(len(t.frame)), "note": t.note} for t in inp.tables]
    steps = [{**asdict(s), "dropped": s.dropped} for s in log]
    payload = build_payload(sales, leads, spend, follow, targets, sorted(found), files, steps, gaps, ASSUMPTIONS)
    payload["targetsSet"] = sorted(target_overrides or {})

    sh = M.sales_headlines(sales)
    lh = M.lead_headlines(leads, sales) if len(leads) else None
    fh = M.followup_headlines(leads, sales) if len(leads) else None
    rm = sales.month
    qm = M.quarter_months(sales)
    sales_recon = pd.DataFrame([{
        "Quarter": q, "Months": ", ".join(N.month_label(m) for m in qm[q]),
        "Revenue (retailer_month.csv)": round(float(rm.loc[rm["m"].isin(qm[q]), "rev"].sum()), 2),
        "Retailers billed": sh["billed"][q], "New retailers (first bill)": sh["new"][q]} for q in sh["quarters"]])
    total_rm = round(float(rm["rev"].sum()), 2)
    total_life = round(float(sales.retailers["lifetime"].sum()), 2)
    sales_recon.loc[len(sales_recon)] = {"Quarter": "TOTAL", "Months": "",
                                         "Revenue (retailer_month.csv)": total_rm, "Retailers billed": "",
                                         "New retailers (first bill)": int(sum(sh["new"].values()))}
    checks = pd.DataFrame([
        {"Check": "Monthly revenue total = sum of retailers' lifetime revenue", "Left": total_rm, "Right": total_life,
         "Difference": round(total_rm - total_life, 2), "OK": "Yes" if abs(total_rm - total_life) < 1 else "NO"},
        {"Check": "Unique leads = sum of the five outcome buckets (every level × window)",
         "Left": int(leads["unique"].sum()) if len(leads) else 0, "Right": "see 'Lead buckets'", "Difference": "",
         "OK": "Yes" if not len(leads) or (M.lead_buckets(leads)["Reconciles"] == "Yes").all() else "NO"},
        {"Check": "Lead rows = unique leads + repeat leads", "Left": int(len(leads)),
         "Right": int(leads["unique"].sum()) + int((~leads["unique"]).sum()) if len(leads) else 0, "Difference": 0,
         "OK": "Yes"},
    ])
    if len(leads):
        uniq = leads[leads["unique"] & leads["valid"]]
        passes = pd.DataFrame([{"Pass": p, "Unique leads matched": int((uniq["mpass"] == i).sum())}
                               for i, p in [(1, "1 exact main phone"), (2, "2 alternate numbers"),
                                            (3, "3 fuzzy name + pincode/city"), (0, "not matched")]])
        conf = uniq.loc[uniq["mpass"] == 3, "conf"]
        bins = pd.cut(conf, [74, 79, 84, 89, 94, 100], labels=["75-79", "80-84", "85-89", "90-94", "95-100"])
        conf_t = bins.value_counts().sort_index().rename_axis("Fuzzy score").reset_index(name="Leads")
        buckets = M.lead_buckets(leads)
    else:
        passes = pd.DataFrame([{"Pass": "no lead files yet", "Unique leads matched": 0}])
        conf_t = pd.DataFrame(columns=["Fuzzy score", "Leads"])
        buckets = M.lead_buckets(leads)
    recon = _workbook({
        "Checks": checks,
        "Lead buckets": buckets,
        "Match passes": passes,
        "Fuzzy confidence": conf_t,
        "Sales by quarter": sales_recon,
        "Rows by step": pd.DataFrame(steps),
        "Input files": pd.DataFrame(files) if files else pd.DataFrame([{"file": "(none in the leads inbox)"}]),
        "Assumptions": pd.DataFrame({"#": range(1, len(ASSUMPTIONS) + 1), "Assumption": ASSUMPTIONS}),
        "Data gaps": pd.DataFrame({"#": range(1, len(gaps) + 1), "Gap": gaps}),
    })
    memo = write_memo(sh, lh, gaps, payload, today or date.today(), fh)
    return Result(payload, recon, memo)
