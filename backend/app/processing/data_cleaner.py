"""
Pure, reusable cleaning helpers. None of these delete rows; they only normalise values.
Each value-level helper returns (value, problem) so the validator can classify the row.
"""
import re
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, Optional, Tuple

import pandas as pd

from app.core.constants import BLANK_TOKENS

EXCEL_EPOCH = datetime(1899, 12, 30)
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_DATE_FORMATS = ("%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%Y-%m-%d", "%d-%b-%Y", "%d %b %Y",
                 "%d-%b-%y", "%d/%m/%y", "%Y/%m/%d", "%Y-%m-%d %H:%M:%S", "%d-%m-%Y %H:%M:%S")


# ---------------------------------------------------------------- columns
def normalize_column_name(name) -> str:
    """'  Net Sales (₹) ' -> 'net_sales'.  'Retailer  Name' -> 'retailer_name'."""
    s = str(name).strip().lower()
    s = re.sub(r"\(.*?\)", " ", s)          # drop bracketed units
    s = s.replace("&", " and ").replace("₹", " ").replace("%", " pct ")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return re.sub(r"_+", "_", s).strip("_")


def normalize_columns(df: pd.DataFrame, aliases: Optional[Dict[str, str]] = None) -> Tuple[pd.DataFrame, Dict[str, str]]:
    """Normalise headers and apply alias mapping. Returns (frame, {original: final})."""
    aliases = aliases or {}
    mapping, seen = {}, {}
    for col in df.columns:
        norm = normalize_column_name(col)
        final = aliases.get(norm, norm) or "unnamed"
        if final in seen:                      # two source columns collapse to one name
            seen[final] += 1
            final = f"{final}__{seen[final]}"
        else:
            seen[final] = 0
        mapping[str(col)] = final
    return df.rename(columns={c: mapping[str(c)] for c in df.columns}), mapping


# ---------------------------------------------------------------- text
def is_blank(value) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and value != value:
        return True
    return str(value).strip().lower() in BLANK_TOKENS


def clean_text(value) -> Optional[str]:
    """Trim and collapse internal whitespace; blank tokens -> None. Case is preserved."""
    if is_blank(value):
        return None
    return re.sub(r"\s+", " ", str(value).replace(" ", " ")).strip()


def strip_whitespace(df: pd.DataFrame, columns: Optional[Iterable[str]] = None) -> pd.DataFrame:
    out = df.copy()
    for col in columns or out.columns:
        out[col] = out[col].map(clean_text)
    return out


def name_match_key(value) -> Optional[str]:
    """Comparison key for retailer/distributor names: upper-case, punctuation-insensitive.
    Used ONLY to spot possible duplicates for review - never as an identifier."""
    text = clean_text(value)
    if text is None:
        return None
    text = text.upper().replace("&", " AND ")
    text = re.sub(r"\b(M/S|MS)\b\.?", " ", text)
    text = re.sub(r"[^A-Z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip() or None


def standardize_name(value) -> Optional[str]:
    """Display form of a party name: whitespace-clean, original casing kept (no guessing)."""
    return clean_text(value)


# ---------------------------------------------------------------- numbers
def parse_amount(value) -> Tuple[Optional[float], Optional[str]]:
    """'₹1,23,456.50' -> 123456.5 ; '(500)' -> -500 ; 'Rs. 2,000/-' -> 2000.
    Returns (None, None) for blank, (None, reason) when unparseable."""
    if is_blank(value):
        return None, None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value), None
    s = str(value).strip()
    negative = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    s = re.sub(r"(?i)\b(inr|rs)\b\.?|₹|/-", "", s).replace(",", "").replace(" ", "")
    if s.endswith("-") and not s.startswith("-"):
        s, negative = s[:-1], True
    try:
        num = float(s)
    except ValueError:
        return None, f"'{value}' is not a number"
    if num != num or num in (float("inf"), float("-inf")):
        return None, f"'{value}' is not a finite number"
    return (-num if negative else num), None


# ---------------------------------------------------------------- dates
def parse_date(value) -> Tuple[Optional[date], Optional[str]]:
    """Indian day-first dates, ISO dates, and Excel serial numbers. Ambiguity is not guessed:
    a value only parses if it matches a known format."""
    if is_blank(value):
        return None, None
    if isinstance(value, datetime):
        return value.date(), None
    if isinstance(value, date):
        return value, None
    s = str(value).strip()
    if _ISO_DATE.fullmatch(s):                         # fast path: 2026-04-01
        try:
            return date.fromisoformat(s), None
        except ValueError:
            pass
    if re.fullmatch(r"\d{5}(\.0+)?", s):               # Excel serial (e.g. 45383)
        serial = int(float(s))
        if 20000 <= serial <= 80000:
            return (EXCEL_EPOCH + timedelta(days=serial)).date(), None
        return None, f"'{value}' looks like an out-of-range Excel date serial"
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date(), None
        except ValueError:
            continue
    return None, f"'{value}' is not a recognised date (expected DD-MM-YYYY or YYYY-MM-DD)"


def parse_month(value) -> Tuple[Optional[str], Optional[str]]:
    """'2026-04', 'Apr-2026', '04/2026' or any full date -> 'YYYY-MM'."""
    if is_blank(value):
        return None, None
    s = str(value).strip()
    if re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", s):
        return s, None
    for fmt in ("%b-%Y", "%b %Y", "%B %Y", "%B-%Y", "%m/%Y", "%m-%Y", "%b-%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m"), None
        except ValueError:
            continue
    d, err = parse_date(value)
    if d is not None:
        return d.strftime("%Y-%m"), None
    return None, f"'{value}' is not a recognised month (expected YYYY-MM)"


def fiscal_year_label(d: date, start_month: int = 4) -> str:
    """FY label in house style: Apr-2025..Mar-2026 -> 'FY26'."""
    end_year = d.year + 1 if d.month >= start_month else d.year
    return f"FY{end_year % 100:02d}"


def fiscal_quarter(d: date, start_month: int = 4) -> str:
    """Q1 = Apr-Jun, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar."""
    offset = (d.month - start_month) % 12
    return f"Q{offset // 3 + 1}"
