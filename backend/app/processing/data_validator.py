"""
Validation: turns a raw DataFrame into a cleaned, typed DataFrame plus a ValidationReport.

Rows are NEVER removed. Each row gets `_row_status` (valid / invalid / missing / duplicate /
needs_review) and `_source_row` (the row number as seen in Excel, header = row 1).
"""
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional

import pandas as pd

from app.core.constants import STATUS_PRECEDENCE, RecordStatus, Severity
from app.processing import data_cleaner as dc
from app.processing.dataset_specs import (AMOUNT, CODE, DATE, INTEGER, MONTH, NAME, PINCODE, STATE,
                                          TEXT, DatasetSpec)
from app.rules import geography_rules as geo


@dataclass
class Issue:
    row: Optional[int]          # Excel row number; None for file-level issues
    column: Optional[str]
    code: str
    severity: Severity
    status: RecordStatus
    message: str
    value: Optional[str] = None

    def as_dict(self) -> dict:
        return {"row": self.row, "column": self.column, "code": self.code,
                "severity": self.severity.value, "status": self.status.value,
                "message": self.message, "value": self.value}


@dataclass
class ValidationResult:
    dataset: str
    clean: pd.DataFrame
    total_rows: int
    column_mapping: Dict[str, str]
    missing_required_columns: List[str]
    unrecognised_columns: List[str]
    file_errors: List[Issue] = field(default_factory=list)
    file_warnings: List[Issue] = field(default_factory=list)
    issues: List[Issue] = field(default_factory=list)

    @property
    def status_counts(self) -> Dict[str, int]:
        counts = {s.value: 0 for s in RecordStatus}
        if "_row_status" in self.clean:
            counts.update(self.clean["_row_status"].value_counts().to_dict())
        return counts

    @property
    def can_process(self) -> bool:
        """File-level problems block processing; row-level problems are reported, not blocking."""
        return not self.file_errors


def _worst(statuses) -> RecordStatus:
    present = set(statuses)
    for s in STATUS_PRECEDENCE:
        if s in present:
            return s
    return RecordStatus.VALID


def validate_dataframe(raw: pd.DataFrame, spec: DatasetSpec, today: Optional[date] = None) -> ValidationResult:
    today = today or date.today()
    df, mapping = dc.normalize_columns(raw, spec.aliases)
    cols = list(df.columns)
    missing_cols = [c for c in spec.required if c not in cols]
    unknown_cols = [c for c in cols if c not in spec.all_columns]

    result = ValidationResult(spec.dataset.value, df, len(df), mapping, missing_cols, unknown_cols)

    for c in unknown_cols:
        result.file_warnings.append(Issue(None, c, "UNRECOGNISED_COLUMN", Severity.WARNING,
                                          RecordStatus.NEEDS_REVIEW,
                                          f"Column '{c}' is not part of the {spec.dataset.value} spec; kept as-is."))
    if missing_cols:
        result.file_errors.append(Issue(None, None, "MISSING_REQUIRED_COLUMNS", Severity.ERROR,
                                        RecordStatus.INVALID,
                                        f"Required column(s) missing: {', '.join(missing_cols)}.",
                                        ", ".join(missing_cols)))
    if len(df) == 0:
        result.file_errors.append(Issue(None, None, "NO_DATA_ROWS", Severity.ERROR, RecordStatus.MISSING,
                                        "The file has a header row but no data rows."))
    if result.file_errors:
        return result

    df = df.reset_index(drop=True)
    source_rows = [i + 2 for i in range(len(df))]  # Excel row numbers
    row_statuses: Dict[int, List[RecordStatus]] = defaultdict(list)
    clean = pd.DataFrame(index=df.index)

    def flag(i, col, code, status, msg, value=None):
        sev = Severity.ERROR if status in (RecordStatus.INVALID, RecordStatus.MISSING) else Severity.WARNING
        result.issues.append(Issue(source_rows[i], col, code, sev, status, msg,
                                   None if value is None else str(value)))
        row_statuses[i].append(status)

    # ---- column-by-column typing --------------------------------------------
    for col in cols:
        kind = spec.kinds.get(col, TEXT)
        required = col in spec.required
        out = []
        cache: Dict = {}

        def memo(fn, v):
            """Parsers are pure: parse each distinct raw value once per column (big files repeat a lot)."""
            if v not in cache:
                cache[v] = fn(v)
            return cache[v]

        for i, raw_val in enumerate(df[col].tolist()):
            if dc.is_blank(raw_val):
                if required:
                    flag(i, col, "REQUIRED_VALUE_MISSING", RecordStatus.MISSING, f"'{col}' is blank.")
                out.append(None)
                continue
            if kind == DATE:
                val, err = memo(dc.parse_date, raw_val)
                if err:
                    flag(i, col, "INVALID_DATE", RecordStatus.INVALID, err, raw_val)
                elif val > today and not spec.future_dates_ok:
                    flag(i, col, "FUTURE_DATE", RecordStatus.NEEDS_REVIEW, f"Date {val} is in the future.", raw_val)
                out.append(val)
            elif kind in (AMOUNT, INTEGER):
                val, err = memo(dc.parse_amount, raw_val)
                if err:
                    flag(i, col, "INVALID_NUMBER", RecordStatus.INVALID, err, raw_val)
                elif kind == INTEGER and val is not None and val != int(val):
                    flag(i, col, "NOT_WHOLE_NUMBER", RecordStatus.INVALID, f"'{raw_val}' should be a whole number.", raw_val)
                elif val is not None and val < 0 and col not in spec.negative_ok:
                    flag(i, col, "NEGATIVE_VALUE", RecordStatus.NEEDS_REVIEW,
                         f"Negative value {val:,.2f} (return/credit note?).", raw_val)
                elif kind == AMOUNT and val == 0 and col not in spec.zero_ok:
                    flag(i, col, "ZERO_VALUE", RecordStatus.NEEDS_REVIEW, "Amount is zero.", raw_val)
                out.append(val)
            elif kind == MONTH:
                val, err = memo(dc.parse_month, raw_val)
                if err:
                    flag(i, col, "INVALID_MONTH", RecordStatus.INVALID, err, raw_val)
                out.append(val)
            elif kind == PINCODE:
                chk = memo(geo.normalize_pincode, raw_val)
                if chk.status != RecordStatus.VALID:
                    flag(i, col, "INVALID_PINCODE", chk.status, chk.note, raw_val)
                out.append(chk.value)
            elif kind == STATE:
                chk = memo(geo.normalize_state, raw_val)
                if chk.status != RecordStatus.VALID:
                    flag(i, col, "UNRECOGNISED_STATE", chk.status, chk.note, raw_val)
                out.append(chk.value)
            elif kind == NAME:
                out.append(memo(dc.standardize_name, raw_val))
            else:  # TEXT, CODE
                out.append(memo(dc.clean_text, raw_val))
        clean[col] = out

    # ---- cross-field: pincode vs state ----------------------------------------
    if "pincode" in clean and "state" in clean:
        known_states = set(geo.get_geography_config()["states"])
        for i, (pin, st) in enumerate(zip(clean["pincode"], clean["state"])):
            if pin and st in known_states and geo.PINCODE_RE.match(str(pin)):
                if geo.pincode_matches_state(pin, st) is False:
                    flag(i, "pincode", "PINCODE_STATE_MISMATCH", RecordStatus.NEEDS_REVIEW,
                         f"Pincode {pin} does not usually belong to {st}.", pin)

    # ---- exact duplicate rows (flag later copies, keep all) -------------------
    if spec.exact_duplicate_check:
        key_cols = [c for c in cols if c in spec.all_columns]
        keys = [tuple(str(v) for v in row) for row in clean[key_cols].itertuples(index=False)]
        first_seen: Dict[str, int] = {}
        for i, k in enumerate(keys):
            if k in first_seen:
                flag(i, None, "DUPLICATE_ROW", RecordStatus.DUPLICATE,
                     f"Exact repeat of row {source_rows[first_seen[k]]}.")
            else:
                first_seen[k] = i

    # ---- repeated names: flag for review, never merge ------------------------
    for col in spec.review_repeated:
        if col not in clean:
            continue
        keys = clean[col].map(dc.name_match_key)
        counts = Counter(k for k in keys if k)
        for i, k in enumerate(keys):
            if k and counts[k] > 1 and RecordStatus.DUPLICATE not in row_statuses[i]:
                flag(i, col, "NAME_NOT_UNIQUE", RecordStatus.NEEDS_REVIEW,
                     f"'{clean.at[i, col]}' appears in {counts[k]} rows. Names are not treated as unique "
                     f"identifiers - confirm whether these are the same party.")

    clean["_source_row"] = source_rows
    clean["_row_status"] = [_worst(row_statuses.get(i, [])).value for i in range(len(clean))]
    result.clean = clean
    return result
