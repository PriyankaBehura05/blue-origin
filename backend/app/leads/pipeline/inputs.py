"""Read the input files: lead dumps, spend, follow-up log and targets from the leads inbox, and the BO Dashboard's
sales outputs (retailers.csv, retailer_month.csv, retailer_quarter.csv) read-only.

Every file arrives as bytes keyed by its name, so the same code serves the Dropbox store and the command line.
A file (or each sheet of a workbook) is recognised by its name first (follow / spend / target), then by its columns.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import pandas as pd

SALES_FILES = ("retailers.csv", "retailer_month.csv", "retailer_quarter.csv")

# column aliases, compared after norm_col(): lower case, non-alphanumerics -> "_"
ALIASES = {
    "date": ["lead_date", "created_time", "created_at", "created_on", "date", "enquiry_date", "lead_created",
             "timestamp", "submitted_at", "date_time"],
    "mobile": ["mobile", "mobile_number", "mobile_no", "phone", "phone_number", "contact", "contact_number",
               "whatsapp", "whatsapp_number", "number", "cell"],
    "alt_mobile": ["alternate_mobile", "alt_mobile", "alternate_number", "alt_phone", "phone_2", "mobile_2"],
    "name": ["business_name", "shop_name", "store_name", "company", "company_name", "retailer_name", "firm_name",
             "full_name", "name", "contact_name", "customer_name"],
    "city": ["city", "town", "location", "district"],
    "state": ["state", "region_state"],
    "pincode": ["pincode", "pin_code", "pin", "zip", "zip_code", "postal_code"],
    "source": ["source", "lead_source", "platform", "channel", "medium", "utm_source"],
    "campaign": ["campaign", "campaign_name", "utm_campaign"],
    "adset": ["ad_set", "adset", "adset_name", "ad_set_name", "ad_group", "adgroup", "ad_group_name"],
    # spend
    "spend": ["spend", "amount_spent", "amount_spent_inr", "amount", "cost", "budget", "spend_inr"],
    "month": ["month", "period", "spend_month", "date", "day", "reporting_starts"],
    # follow-up log
    "owner": ["assigned_to", "owner", "asm", "asm_name", "rsm", "sales_person", "salesperson", "executive"],
    "distributor": ["distributor", "distributor_name", "assigned_distributor"],
    "contact_date": ["contact_date", "contacted_on", "follow_up_date", "followup_date", "first_contact",
                     "call_date", "last_contact"],
    "status": ["status", "lead_status", "follow_up_status", "followup_status", "disposition", "outcome"],
    # follow-up kept on the lead sheet itself (one ASM column set per lead row); matched on the exact header only
    "lead_id": ["lead_id", "leadgen_id", "id"],
    "called": ["calling_done", "call_done", "called", "calling_status", "call_status"],
    "visited": ["visit_done", "visited", "visit_status"],
    "order_flag": ["order_placed", "ordered", "order_status"],
    "order_value": ["order_value", "order_amount", "order_value_inr", "order_value_rs"],
    "category": ["category", "lead_category", "call_outcome", "lead_disposition"],
    "self_existing": ["existing_retailer", "retailer", "is_retailer", "existing_customer"],
    # targets
    "metric": ["metric", "kpi", "measure", "target_name"],
    "value": ["target", "value", "target_value", "goal"],
}

KINDS = ("leads", "spend", "followup", "targets")
# short or common words ("retailer", "category") would match unrelated headers by 'contains': exact headers only
EXACT_ONLY = {"lead_id", "called", "visited", "order_flag", "order_value", "category", "self_existing"}


def norm_col(c: object) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(c).strip().lower()).strip("_")


def pick_all(columns: List[str], key: str) -> List[str]:
    """Every column that is one of the key's aliases, in alias order (exact headers)."""
    return [a for a in ALIASES[key] if a in columns] or ([pick(columns, key)] if pick(columns, key) else [])


def pick(columns: List[str], key: str) -> Optional[str]:
    """The first column that matches one of the key's aliases (exact first, then 'contains')."""
    for a in ALIASES[key]:
        if a in columns:
            return a
    if key in EXACT_ONLY:
        return None
    for a in ALIASES[key]:
        for c in columns:
            if len(a) > 3 and a in c:
                return c
    return None


@dataclass
class InputTable:
    file: str          # file name (plus " / sheet" for a workbook sheet)
    kind: str          # leads | spend | followup | targets | unknown
    frame: pd.DataFrame
    note: str = ""


@dataclass
class Inputs:
    tables: List[InputTable] = field(default_factory=list)
    retailers: Optional[pd.DataFrame] = None
    retailer_month: Optional[pd.DataFrame] = None
    retailer_quarter: Optional[pd.DataFrame] = None
    sales_versions: Dict[str, str] = field(default_factory=dict)

    def of(self, kind: str) -> List[InputTable]:
        return [t for t in self.tables if t.kind == kind]


def _frames(name: str, content: bytes) -> List[tuple[str, pd.DataFrame]]:
    low = name.lower()
    if low.endswith((".xlsx", ".xlsm", ".xls")):
        sheets = pd.read_excel(io.BytesIO(content), sheet_name=None, dtype=str)
        return [(f"{name} / {s}", df) for s, df in sheets.items()]
    if low.endswith((".csv", ".txt")):
        for enc in ("utf-8-sig", "cp1252"):
            try:
                return [(name, pd.read_csv(io.BytesIO(content), dtype=str, encoding=enc, keep_default_na=False))]
            except UnicodeDecodeError:
                continue
    return []


def classify(name: str, df: pd.DataFrame) -> str:
    cols = list(df.columns)
    low = name.lower()
    if "follow" in low or "assign" in low:
        return "followup"
    if any(w in low for w in ("spend", "budget", "cost")):
        return "spend"
    if "target" in low:
        return "targets"
    has = {k: pick(cols, k) is not None for k in ("mobile", "spend", "campaign", "owner", "status", "metric", "value")}
    if has["metric"] and has["value"] and not has["mobile"]:
        return "targets"
    if has["spend"] and has["campaign"] and not has["mobile"]:
        return "spend"
    if has["mobile"] and has["owner"] and pick(cols, "contact_date"):
        return "followup"
    if has["mobile"]:
        return "leads"
    return "unknown"


def read_inbox(files: Dict[str, bytes]) -> List[InputTable]:
    out: List[InputTable] = []
    for name in sorted(files):
        try:
            frames = _frames(name, files[name])
        except Exception as exc:  # unreadable file: reported, never fatal
            out.append(InputTable(name, "unknown", pd.DataFrame(), f"could not be read: {exc}"))
            continue
        if not frames:
            out.append(InputTable(name, "unknown", pd.DataFrame(), "not a CSV or Excel file"))
        for label, df in frames:
            df = df.copy()
            df.columns = [norm_col(c) for c in df.columns]
            df = df.loc[:, [c for c in df.columns if c]]
            df = df.fillna("").astype(str)
            kind = classify(label, df)
            out.append(InputTable(label, kind, df, "" if kind != "unknown" else "no mobile / spend / target columns found"))
    return out


def read_sales(files: Dict[str, bytes]) -> Dict[str, pd.DataFrame]:
    out = {}
    for name in SALES_FILES:
        if files.get(name) is None:
            continue
        out[name] = pd.read_csv(io.BytesIO(files[name]), dtype=str, keep_default_na=False)
    return out


def load(inbox: Dict[str, bytes], sales: Dict[str, bytes], sales_versions: Optional[Dict[str, str]] = None) -> Inputs:
    s = read_sales(sales)
    return Inputs(tables=read_inbox(inbox), retailers=s.get("retailers.csv"), retailer_month=s.get("retailer_month.csv"),
                  retailer_quarter=s.get("retailer_quarter.csv"), sales_versions=sales_versions or {})
