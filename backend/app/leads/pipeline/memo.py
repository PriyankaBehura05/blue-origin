"""One-page findings memo for leadership (Markdown), written from the same build as the dashboard."""
from __future__ import annotations

from datetime import date
from typing import List, Optional


def inr(v: float) -> str:
    a = abs(v)
    s = "-" if v < 0 else ""
    if a >= 1e7:
        return f"{s}₹{a / 1e7:.2f} Cr"
    if a >= 1e5:
        return f"{s}₹{a / 1e5:.1f} L"
    return f"{s}₹{a:,.0f}"


def qlabel(q: Optional[str]) -> str:
    if not q:
        return "—"
    n, fy = q.split("_FY")
    months = {"1": "Apr–Jun", "2": "Jul–Sep", "3": "Oct–Dec", "4": "Jan–Mar"}[n[1]]
    year = 2000 + int(fy) - (0 if n[1] == "4" else 1)
    return f"{n} FY {fy} ({months} {year})"


def month_name(label: str) -> str:
    y, m = label.split("-")
    return f"{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][int(m) - 1]} {y}"


def share(a: float, b: float) -> str:
    return f"{100 * a / b:.0f}%" if b else "n/a"


def pct(a: float, b: float) -> str:
    return f"{100 * (a - b) / b:+.0f}%" if b else "n/a"


def write_memo(sh: dict, lh: Optional[dict], gaps: List[str], payload: dict, today: date,
               fh: Optional[dict] = None) -> str:
    cur, prev = sh["current"], sh["previous"]
    rev_c, rev_p = sh["revenue"].get(cur, 0), sh["revenue"].get(prev, 0)
    new_c, new_p = sh["new"].get(cur, 0), sh["new"].get(prev, 0)
    tgt = payload["targets"]
    set_by = payload.get("targetsSet", [])  # targets saved in the dashboard or read from a targets sheet

    def target_note(key: str) -> str:
        return "" if key in set_by or key in payload["targetsFromFile"] else " (placeholder target: set it in the dashboard)"
    lines = [
        "# Paid lead generation — findings for leadership",
        f"*{today:%d %b %Y} · sales data to {month_name(payload['months'][payload['salesEnd']])} · latest quarter {qlabel(cur)} · "
        "Blue Origin Lead Generation Dashboard*",
        "",
        "## Bottom line",
    ]
    if lh:
        lo, hi = lh["range_pct"]["floor"], lh["range_pct"]["ceiling"]
        verdict = "working" if lh["conversion_pct"] >= tgt["conversion_pct"] else "not yet paying back on conversion"
        lines.append(f"Paid lead gen is **{verdict}**: {lh['judged']:,} unique leads old enough to judge converted to new "
                     f"retailers at **{lh['conversion_pct']:.1f}%** (likely match, 60-day window; range {lo:.1f}%–{hi:.1f}% "
                     f"from strict to generous matching) against a {tgt['conversion_pct']:.0f}% target"
                     f"{target_note('conversion_pct')}."
                     + (f" Another {lh['pending']:,} leads are marked Pending sales data: their 60 days run past the last month "
                        "of sales data, so they are not counted as not converted." if lh["pending"] else ""))
    else:
        lines.append("**The question 'is paid lead gen working?' cannot be answered yet: no lead files have been loaded.** "
                     "The network itself is measurable today, and the findings below come from the sales data alone.")
    lines += ["", "## Findings (Insight → Number → Action → Owner)", ""]
    n = 1

    def add(insight, number, action, owner):
        nonlocal n
        if n > 5:  # at most 5 headline findings
            return
        lines.append(f"{n}. **{insight}** — {number}. → *{action}* · Owner: {owner}")
        n += 1

    if prev:
        add("Network revenue " + ("grew" if rev_c >= rev_p else "fell") + " quarter on quarter",
            f"{inr(rev_c)} in {qlabel(cur)} vs {inr(rev_p)} ({pct(rev_c, rev_p)})",
            "Review the distributors behind the change in the Distributors section before the next QBR", "Head of Sales")
        judged = not target_note("new_retailers_quarter")
        add("New-retailer intake " + (("is ahead of target" if new_c >= tgt["new_retailers_quarter"] else "is below target")
                                      if judged else ("rose" if new_c >= new_p else "fell") + " quarter on quarter"),
            f"{new_c:,} first-time billers vs {tgt['new_retailers_quarter']:,.0f} target{target_note('new_retailers_quarter')}; "
            f"{pct(new_c, new_p)} vs {new_p:,} in {qlabel(prev)}",
            "Set distributor-level new-outlet quotas for next quarter from the Forecast section", "National Sales Manager")
    if sh["retention_pct"] is not None:
        add("Retention", f"{sh['retention_pct']:.0f}% of {sh['billed'][prev]:,} retailers billed in {qlabel(prev)} billed "
            f"again in {qlabel(cur)}", "Run the at-risk list (Retailer list section) through ASM visits this month",
            "Regional Sales Managers")
    add("Revenue at risk", f"{sh['at_risk']:,} retailers have gone quiet for ~2 months, carrying {inr(sh['revenue_at_risk'])} "
        "of quarterly billing", "WhatsApp + ASM call to the at-risk list within 2 weeks; track win-backs in Actions",
        "ASMs via RSMs")
    if lh:
        if lh["best_campaign"]:
            add("Best and worst campaigns", f"'{lh['best_campaign']}' converts {lh['best_campaign_rate']:.1f}% vs "
                f"'{lh['worst_campaign']}' {lh['worst_campaign_rate']:.1f}% (campaigns with 30+ leads)",
                "Move budget from the bottom campaign to the top one (see Scale/Fix/Kill)", "Marketing Lead")
        else:
            src = {k: v for k, v in lh["by_source"].items() if v["leads"] >= 30}
            if len(src) >= 2:
                rate = {k: 100 * v["new"] / v["leads"] for k, v in src.items()}
                hi, lo = max(rate, key=rate.get), min(rate, key=rate.get)
                add("Best and worst sources", f"{hi} leads convert {rate[hi]:.1f}% ({src[hi]['new']:,} of "
                    f"{src[hi]['leads']:,}) vs {lo} {rate[lo]:.1f}% ({src[lo]['new']:,} of {src[lo]['leads']:,}); "
                    "the sheets name no campaigns", "Shift budget towards the better source and add a campaign "
                    "column to the lead sheets so campaigns can be compared", "Marketing Lead")
        if fh:
            checked = fh["bo_billed"] + fh["bo_not_billed"]
            add("Field follow-up", f"ASMs called {share(fh['called'], fh['leads'])} of {fh['leads']:,} leads and visited "
                f"{share(fh['visited'], fh['leads'])}; they report {fh['claimed']:,} orders ({inr(fh['claimed_value'])} "
                f"as typed, median {inr(fh['median_value'])})"
                + (f", of which {fh['bo_billed']:,} of {checked:,} that can be checked show up in BO billing"
                   if checked else "") + (f" ({fh['bo_pending']:,} too recent to check)" if fh["bo_pending"] else ""),
                "Call every uncalled lead within 2 days, and have ASMs log the shop's distributor so orders can be "
                "traced in BO billing", "RSMs")
        lo_m, hi_m = lh["matched"]["floor"], lh["matched"]["ceiling"]
        add("Matching uncertainty", f"{lo_m:,}–{hi_m:,} leads matched to a retailer depending on strictness",
            "Capture the lead's mobile on the distributor invoice so matching is exact", "Sales Ops")
    else:
        add("Lead data missing", "0 lead rows, no spend and no follow-up log loaded",
            "Export Meta / Google / JustDial / Print leads and campaign spend to the leads inbox; the dashboard refreshes "
            "itself", "Marketing Lead")
    lines += ["", "## Recommendation (in sequence)", ""]
    if lh:
        lines.append("1. **This quarter:** shift spend to the 'Scale' campaigns and clear the 0–30-day unconverted leads "
                     "through ASM visits. 2. **Next quarter:** re-set the budget with the What-if simulator once a full "
                     "quarter of payback is visible.")
    else:
        lines.append("1. **This quarter:** load 2 quarters of lead exports + spend, and win back the at-risk retailers. "
                     "2. **Next quarter:** judge paid lead gen on conversion and cost per converted retailer, then set "
                     "the budget.")
    lines += ["", "## Data caveats", ""]
    lines += [f"- {g}" for g in gaps[:5]]
    lines += ["", "*Every number reconciles in the Reconciliation workbook (Data quality section).*"]
    return "\n".join(lines) + "\n"
