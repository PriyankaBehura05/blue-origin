"""
Writes the Distribution Counter Report workbook with the exact layout of Distributor_Counter_Report.xlsx:
same six sheets, titles, notes, headers (merged Cnt / ₹ month pairs), fonts (Arial), fills (F2F2F2 headers and
labels, E6E6E6 totals, C6EFCE / 006100 for new counters and billed values), thin BFBFBF borders, number formats,
Excel formulas (Total / Peak / TOTAL / Cumulative / Growth % / Trend), green / red trend conditional formats,
frozen panes, header filter on Counter Detail and column widths.
"""
import io
from typing import List

import xlsxwriter
from xlsxwriter.utility import xl_col_to_name

INR = '###,##0;\\(###,##0\\);"–"'
PCT = '[Green]0.0%;[Red]\\-0.0%;"–"'
NOTE = ("Active = billed (Value>0)  •  New = first-ever billing within {fy}  •  Revenue in ₹  •  "
        "New-counter revenue = value brought in the add month")


def col(c: int) -> str:
    """1-based column number -> letter."""
    return xl_col_to_name(c - 1)


class _Styles:
    def __init__(self, wb):
        base = {"font_name": "Arial", "font_size": 10, "font_color": "#000000", "border": 1, "border_color": "#BFBFBF",
                "valign": "vcenter"}

        def f(**kw):
            return wb.add_format({**base, **kw})

        head = {"bold": True, "font_color": "#1A1A1A", "bg_color": "#F2F2F2", "text_wrap": True}
        self.title = wb.add_format({"font_name": "Arial", "font_size": 12, "bold": True, "font_color": "#1A1A1A",
                                    "align": "left", "valign": "vcenter", "bottom": 2, "bottom_color": "#808080"})
        self.note = wb.add_format({"font_name": "Arial", "font_size": 9, "italic": True, "font_color": "#777777"})
        self.head_l = f(**head, align="left")
        self.head_c = f(**head, align="center")
        self.head_t = f(**{**head, "bg_color": "#E6E6E6"}, align="center")
        self.left = f(align="left")
        self.center = f(align="center")
        self.inr = f(align="right", num_format=INR)
        self.pct = f(align="center", num_format=PCT)
        self.bold_c = f(bold=True, align="center")
        self.label = f(bold=True, align="left", bg_color="#F2F2F2")
        self.tot_l = f(bold=True, align="left", bg_color="#E6E6E6")
        self.tot_c = f(bold=True, align="center", bg_color="#E6E6E6")
        self.tot_inr = f(bold=True, align="right", bg_color="#E6E6E6", num_format=INR)
        self.tot_blank = f(align="center", bg_color="#E6E6E6")
        self.green_c = f(bold=True, align="center", font_color="#006100", bg_color="#C6EFCE")
        self.green_inr = f(align="right", font_color="#006100", bg_color="#C6EFCE", num_format=INR)
        self.green_b_inr = f(bold=True, align="right", font_color="#006100", bg_color="#C6EFCE", num_format=INR)
        self.up = wb.add_format({"font_color": "#006100", "bg_color": "#C6EFCE"})
        self.down = wb.add_format({"font_color": "#9C0006", "bg_color": "#FFC7CE"})


class _Sheet:
    """1-based row / column helpers around an xlsxwriter worksheet."""

    def __init__(self, wb, st: _Styles, name: str):
        self.ws, self.st = wb.add_worksheet(name), st

    def w(self, r, c, v, fmt):
        if v is None or v == "":
            self.ws.write_blank(r - 1, c - 1, None, fmt)
        elif isinstance(v, str) and v.startswith("="):
            self.ws.write_formula(r - 1, c - 1, v, fmt)
        else:
            self.ws.write(r - 1, c - 1, v, fmt)

    def title(self, text: str, last_col: int, note: str = ""):
        self.ws.merge_range(0, 0, 0, last_col - 1, text, self.st.title)
        self.ws.set_row(0, 24)
        if note:
            self.ws.merge_range(1, 0, 1, last_col - 1, note, self.st.note)

    def width(self, c: int, w: float):
        self.ws.set_column(c - 1, c - 1, w - 5 / 7)   # xlsxwriter adds ~5/7 padding when storing the width

    def growth(self, r: int, base_row: int, n: int, total_col: int, label: str):
        """Growth % and Trend rows comparing each month with the month before (values in row base_row)."""
        st = self.st
        self.w(r, 1, label, st.label)
        self.w(r + 1, 1, "Trend", st.label)
        for k in range(n):
            c = 2 + k
            if k == 0:
                self.w(r, c, "—", st.center)
                self.w(r + 1, c, "—", st.center)
                continue
            cur, prev = f"{col(c)}{base_row}", f"{col(c - 1)}{base_row}"
            self.w(r, c, f'=IF({prev}=0,"",({cur}-{prev})/{prev})', st.pct)
            self.w(r + 1, c, f'=IF({cur}>{prev},"▲ Growth",IF({cur}<{prev},"▼ Degrowth","► Flat"))', st.center)
        self.w(r, total_col, None, st.tot_blank)
        self.w(r + 1, total_col, None, st.tot_blank)
        if n > 1:
            rng = f"C{r + 1}:{col(1 + n)}{r + 1}"
            self.ws.conditional_format(rng, {"type": "formula", "criteria": f'=ISNUMBER(SEARCH("▲",C{r + 1}))', "format": st.up})
            self.ws.conditional_format(rng, {"type": "formula", "criteria": f'=ISNUMBER(SEARCH("▼",C{r + 1}))', "format": st.down})


def _summary(wb, st, d):
    s = _Sheet(wb, st, "Summary Dashboard")
    months, n = d["months"], len(d["months"])
    tot = n + 2
    last = col(1 + n)
    s.title(f"TECHNOSPORT  |  Distribution Counter Report  —  {d['label']}", tot, NOTE.format(fy=d["fy"]))
    s.w(4, 1, "Metric", st.head_l)
    for k, m in enumerate(months):
        s.w(4, 2 + k, m, st.head_c)
    s.w(4, tot, "FY Total", st.head_t)
    sm = d["summary"]
    rows = [("Active Counters (MoM)", sm["active"], st.bold_c, "MAX", st.tot_c),
            ("Active Counters Revenue (₹)", sm["activeRevenue"], st.inr, "SUM", st.tot_inr),
            ("New Counters Added", sm["newCount"], st.green_c, "SUM", st.tot_c),
            ("New Counters Revenue (₹)", sm["newRevenue"], st.green_inr, "SUM", st.tot_inr)]
    for i, (label, vals, fmt, agg, tfmt) in enumerate(rows):
        r = 5 + i
        s.w(r, 1, label, st.label)
        for k, v in enumerate(vals):
            s.w(r, 2 + k, v, fmt)
        s.w(r, tot, f"={agg}(B{r}:{last}{r})", tfmt)
    s.w(9, 1, "Cumulative New Adds", st.label)
    for k in range(n):
        c = 2 + k
        s.w(9, c, "=B7" if k == 0 else f"={col(c - 1)}9+{col(c)}7", st.center)
    s.w(9, tot, f"={last}9", st.tot_c)
    s.growth(10, 5, n, tot, "Active MoM Growth %")
    s.ws.freeze_panes("B5")
    s.width(1, 26)
    s.width(2, 11)
    s.width(tot, 13)


def _new(wb, st, name, label, groups: List[dict], months: List[str]):
    s = _Sheet(wb, st, name)
    n = len(months)
    tc, tr = 2 + 2 * n, 3 + 2 * n
    s.title(f"NEW COUNTERS ADDED PER MONTH  —  by {label}  (count + ₹ in add month)", tr)
    s.ws.merge_range(2, 0, 3, 0, label, st.head_l)
    for k, m in enumerate(months):
        c = 2 + 2 * k
        s.ws.merge_range(2, c - 1, 2, c, m, st.head_c)
        s.w(4, c, "Cnt", st.head_c)
        s.w(4, c + 1, "₹", st.head_c)
    s.ws.merge_range(2, tc - 1, 2, tr - 1, "Total", st.head_t)
    s.w(4, tc, "Cnt", st.head_t)
    s.w(4, tr, "₹", st.head_t)
    first = 5
    for i, g in enumerate(groups):
        r = first + i
        s.w(r, 1, g["name"], st.left)
        for k, (cnt, amt) in enumerate(g["cells"]):
            c = 2 + 2 * k
            s.w(r, c, cnt, st.green_c if cnt else st.center)
            s.w(r, c + 1, amt if cnt else None, st.green_inr if cnt else st.inr)
        s.w(r, tc, "=" + "+".join(f"{col(2 + 2 * k)}{r}" for k in range(n)), st.tot_c)
        s.w(r, tr, "=" + "+".join(f"{col(3 + 2 * k)}{r}" for k in range(n)), st.tot_inr)
    end = first + len(groups) - 1
    t = end + 1
    s.w(t, 1, "TOTAL", st.tot_l)
    for c in range(2, tr + 1):
        money = (c - 2) % 2 == 1
        s.w(t, c, f"=SUM({col(c)}{first}:{col(c)}{end})", st.tot_inr if money else st.tot_c)
    s.ws.freeze_panes("B5")
    s.width(1, 24)
    for c in range(2, tc):
        s.width(c, 6 if c % 2 == 0 else 10)
    s.width(tc, 7)
    s.width(tr, 12)


def _active(wb, st, name, label, groups: List[dict], months: List[str]):
    s = _Sheet(wb, st, name)
    n = len(months)
    pk = n + 2
    last = col(1 + n)
    s.title(f"ACTIVE COUNTERS & MoM GROWTH  —  by {label}", pk)
    s.w(3, 1, f"{label}  —  Active Counters", st.head_l)
    for k, m in enumerate(months):
        s.w(3, 2 + k, m, st.head_c)
    s.w(3, pk, "Peak", st.head_t)
    first = 4
    for i, g in enumerate(groups):
        r = first + i
        s.w(r, 1, g["name"], st.left)
        for k, v in enumerate(g["active"]):
            s.w(r, 2 + k, v, st.center)
        s.w(r, pk, f"=MAX(B{r}:{last}{r})", st.tot_c)
    end = first + len(groups) - 1
    t = end + 1
    s.w(t, 1, "TOTAL ACTIVE", st.tot_l)
    for k in range(n):
        c = 2 + k
        s.w(t, c, f"=SUM({col(c)}{first}:{col(c)}{end})", st.tot_c)
    s.w(t, pk, None, st.tot_blank)
    h = t + 2
    s.w(h, 1, "MoM Growth % (Total Active)", st.head_l)
    for k, m in enumerate(months):
        s.w(h, 2 + k, m, st.head_c)
    s.w(h, pk, None, st.head_t)
    s.ws.set_row(h - 1, 26.4)
    s.growth(h + 1, t, n, pk, "Growth %")
    s.ws.freeze_panes("B4")
    s.width(1, 26)
    s.width(2, 9)
    s.width(pk, 8)


def _detail(wb, st, d):
    s = _Sheet(wb, st, "Counter Detail")
    months, n = d["months"], len(d["months"])
    am = 6 + n
    s.title("COUNTER DETAIL  —  value billed per month (₹; blank = no billing)", am)
    for c, h in enumerate(["Retailer (Counter)", "Distributor", "State", "Status", "First Billing"], start=1):
        s.w(3, c, h, st.head_l)
    for k, m in enumerate(months):
        s.w(3, 6 + k, m, st.head_c)
    s.w(3, am, "Active Months", st.head_t)
    s.ws.set_row(2, 26.4)
    new_tag = f"New ({d['fy']})"
    fl, ll = col(6), col(5 + n)
    ws = s.ws
    for i, c in enumerate(d["counters"]):
        r0 = 3 + i                          # 0-based row of sheet row r0 + 1
        ws.write_string(r0, 0, c["name"], st.left)
        ws.write_string(r0, 1, c["dist"], st.left)
        ws.write_string(r0, 2, c["state"], st.left)
        ws.write_string(r0, 3, c["status"], st.green_c if c["status"] == new_tag else st.bold_c)
        ws.write_string(r0, 4, c["first"] or "", st.center)
        for k, v in enumerate(c["values"]):
            if v:
                ws.write_number(r0, 5 + k, round(v), st.green_b_inr)
            else:
                ws.write_blank(r0, 5 + k, None, st.inr)
        ws.write_formula(r0, am - 1, f'=COUNTIF({fl}{r0 + 1}:{ll}{r0 + 1},">0")', st.tot_c)
    end = 3 + max(len(d["counters"]), 1)
    ws.autofilter(f"A3:{col(am)}{end}")
    ws.freeze_panes("I4")
    for c, w in ((1, 30), (2, 20), (3, 16), (4, 13), (6, 10)):
        s.width(c, w)
    s.width(am, 12)


def to_xlsx(d: dict) -> bytes:
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "strings_to_numbers": False, "strings_to_formulas": False})
    st = _Styles(wb)
    _summary(wb, st, d)
    _new(wb, st, "New Counters - State", "State", d["newByState"], d["months"])
    _new(wb, st, "New Counters - Distributor", "Distributor", d["newByDistributor"], d["months"])
    _active(wb, st, "Active & Growth - State", "State", d["activeByState"], d["months"])
    _active(wb, st, "Active & Growth - Distributor", "Distributor", d["activeByDistributor"], d["months"])
    _detail(wb, st, d)
    wb.close()
    return buf.getvalue()
