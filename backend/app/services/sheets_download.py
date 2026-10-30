"""
Google Sheets download: the distributors' Google Sheets -> BO_SHEETS_FOLDER (/Power BI/Consolidated/FYyy_Qtrn.csv).

What the download cells of BO_data.ipynb did, run by the sync (the "Sync now" button and the automatic runs), with
nothing to change from one quarter to the next:

  * quarters  - from today's date: the current quarter and the one before it (late corrections to last quarter are
                picked up too). FY = April-March, named after the year it ends: Oct-Dec 2026 = Q3 FY 27 = FY27_Qtr3.csv.
  * tab       - found by its month names and year, in any spelling ("Oct-Nov-Dec 2026", "OCT NOV DEC 2026",
                "October-December 2026"). A tab without the year is never used, so an older year's "Oct-Nov-Dec"
                cannot be read for a new quarter.
  * columns   - the BO columns of the notebook plus the quarter's months in every spelling (Jul / July, Sep / Sept /
                September), saved under one name each; the Consolidated cleaning gives each month its year.
  * sheets    - BO_DISTRIBUTOR_SHEETS (/Power BI/BO_Dashboard/distributors.csv: Distributor, Sheet URL, Active). A new
                distributor is a new line there.

Only real sheet data is written, and only when it is safe: a quarter whose tab no distributor has created yet gets
no file, a download with far fewer rows than the file already there (sheets not shared, Google errors) does not
replace it, and an unchanged download is not written again (so the dashboard is not rebuilt for nothing).
Google access: the service-account key of BO_data.ipynb (BO_GOOGLE_KEY), read-only; every distributor sheet must be
shared with that service account.
"""
import csv
import io
import json
import logging
import posixpath
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote

import pandas as pd

from app.core.config import Settings
from app.storage.base import META_DIR, BlobStore

log = logging.getLogger("blue_origin.sheets")

STATE_PATH = f"{META_DIR}/sheets_download.json"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
BACKEND_DIR = Path(__file__).resolve().parent.parent.parent

MONTHS = {1: "January", 2: "February", 3: "March", 4: "April", 5: "May", 6: "June", 7: "July", 8: "August",
          9: "September", 10: "October", 11: "November", 12: "December"}
# every spelling of a month header seen in the distributor sheets: Jul / July, Sep / Sept / September, ...
MONTH_SPELLINGS = {m: list(dict.fromkeys([n[:3], n] + (["Sept"] if m == 9 else []))) for m, n in MONTHS.items()}
# the columns BO_data.ipynb kept (all spellings it used); the quarter's month columns are added per quarter
BASE_COLUMNS = [
    "Retailer Name", "Retailer name", "Deliverables", "Phone", "Phone No", "Address", "City", "Pincode", "District",
    "State", "Year", "Last 3 Months", "New Tier", "Old Tier", "Retailer Tier", "Catalog", "GMB", "Product video",
    "Store location link", "Hyperloacl Ads", "Hyperlocal Ads", "Shop Board", "SHOP BOARD", "SIS Unit", "Carry Bags",
    "Influencer", "Certificate", "IMPRessions",
]
# one name per column in the quarter file, whatever a sheet calls it
_SAME_AS = {"Retailer name": "Retailer Name", "Phone No": "Phone", "SHOP BOARD": "Shop Board",
            "Hyperloacl Ads": "Hyperlocal Ads"}
MIN_SHARE_OF_EXISTING = 0.6     # a download with fewer rows than 60% of the current file is not saved


# ------------------------------------------------------------------ quarters
def quarter_of(day: date) -> Tuple[int, int]:
    """(FY end year, quarter): 16 Oct 2026 -> (2027, 3)."""
    return day.year + (day.month >= 4), (day.month - 4) % 12 // 3 + 1


def previous(fy: int, q: int) -> Tuple[int, int]:
    return (fy, q - 1) if q > 1 else (fy - 1, 4)


def months_of(fy: int, q: int) -> List[Tuple[int, int]]:
    """[(year, month)]: (2027, 3) -> [(2026, 10), (2026, 11), (2026, 12)]."""
    first = (4, 7, 10, 1)[q - 1]
    year = fy - 1 if q < 4 else fy
    return [(year, first + i) for i in range(3)]


def file_name(fy: int, q: int) -> str:
    return f"FY{fy % 100:02d}_Qtr{q}.csv"


def quarter_text(fy: int, q: int) -> str:
    """(2027, 3) -> 'Q3 FY 27 (Oct-Dec 2026)'"""
    ms = months_of(fy, q)
    return f"Q{q} FY {fy % 100:02d} ({MONTHS[ms[0][1]][:3]}-{MONTHS[ms[2][1]][:3]} {ms[0][0]})"


def due_quarters(today: Optional[date] = None) -> List[Tuple[int, int]]:
    cur = quarter_of(today or date.today())
    return [previous(*cur), cur]


# ------------------------------------------------------------------ tabs and columns
def find_tab(titles: Sequence[str], fy: int, q: int) -> Optional[str]:
    """The quarter's tab: its title names the year (2026 or 26) and the months, at least the first and the last,
    in any spelling. A title without the year never matches."""
    months = [mo for _, mo in months_of(fy, q)]
    year = months_of(fy, q)[0][0]
    for t in titles:
        title = str(t).lower()
        if not {str(year), f"{year % 100:02d}"} & set(re.findall(r"\d+", title)):
            continue
        named = {mo for mo in months if any(w[:3] == MONTHS[mo][:3].lower() for w in re.findall(r"[a-z]+", title))}
        if {months[0], months[2]} <= named:
            return t
    return None


def required_columns(fy: int, q: int) -> Dict[str, str]:
    """{header in lower case: column name in the quarter file}."""
    out = {c.lower(): _SAME_AS.get(c, c) for c in BASE_COLUMNS}
    for _, mo in months_of(fy, q):
        out.update({s.lower(): MONTHS[mo][:3] for s in MONTH_SPELLINGS[mo]})      # Jul / July -> Jul
    return out


def sheet_frame(values: List[List[str]], wanted: Dict[str, str]) -> pd.DataFrame:
    """Rows of one tab with the wanted columns (header case and spaces ignored, as in BO_data.ipynb); blank rows out."""
    headers, rows = values[0], values[1:]
    keep, names = [], []
    for i, h in enumerate(headers):
        name = wanted.get(str(h).strip().lower())
        if name and name not in names:              # first column of a repeated header, as the notebook did
            keep.append(i)
            names.append(name)
    width = len(headers)
    data = pd.DataFrame([(list(r) + [""] * width)[:width] for r in rows], dtype=str)
    df = data.iloc[:, keep] if len(data) else pd.DataFrame(columns=range(len(keep)))
    df.columns = names
    if len(df):
        df = df[df.apply(lambda r: any(str(v).strip() for v in r), axis=1)]
    return df.reset_index(drop=True)


# ------------------------------------------------------------------ Google
class GoogleSheets:
    """Read-only Google Sheets API client with the service-account key (no gspread needed)."""

    def __init__(self, key_file: Path):
        from google.auth.transport.requests import AuthorizedSession
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_file(
            str(key_file), scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
        self.email = creds.service_account_email
        self.session = AuthorizedSession(creds)

    def _get(self, url: str, params: Optional[dict] = None) -> dict:
        for attempt in range(4):
            r = self.session.get(url, params=params, timeout=90)
            if r.status_code == 429 or r.status_code >= 500:      # read quota / Google hiccup: wait and retry
                time.sleep(20 * (attempt + 1))
                continue
            if r.status_code == 403:
                raise PermissionError(f"not shared with {self.email}")
            if r.status_code == 404:
                raise FileNotFoundError("sheet not found (check the link)")
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"Google kept answering {r.status_code}; try again later")

    def titles(self, sheet_id: str) -> List[str]:
        meta = self._get(f"{SHEETS_API}/{sheet_id}", {"fields": "sheets.properties.title"})
        return [s["properties"]["title"] for s in meta.get("sheets", [])]

    def values(self, sheet_id: str, title: str) -> List[List[str]]:
        rng = quote("'" + title.replace("'", "''") + "'", safe="")
        return self._get(f"{SHEETS_API}/{sheet_id}/values/{rng}").get("values", [])


def sheet_id(url: str) -> str:
    m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else url.strip()


# ------------------------------------------------------------------ settings
def key_path(settings: Settings) -> Path:
    p = Path(settings.BO_GOOGLE_KEY.strip() or "secrets/bo-data-service-account.json")
    return p if p.is_absolute() else BACKEND_DIR / p


def read_distributors(store: BlobStore, settings: Settings) -> Dict[str, str]:
    path = settings.BO_DISTRIBUTOR_SHEETS.strip()
    raw = store.at(posixpath.dirname(path)).read(posixpath.basename(path)) if path else None
    if raw is None:
        return {}
    rows = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    return {r["Distributor"].strip(): r["Sheet URL"].strip() for r in rows
            if (r.get("Distributor") or "").strip() and (r.get("Sheet URL") or "").strip()
            and str(r.get("Active") or "Yes").strip().lower() not in ("no", "n", "0", "false")}


def load_state(store: BlobStore) -> dict:
    raw = store.read(STATE_PATH)
    return json.loads(raw.decode("utf-8")) if raw else {}


def status(store: BlobStore, settings: Settings) -> dict:
    key = key_path(settings)
    try:
        n = len(read_distributors(store, settings))
    except Exception as exc:  # noqa: BLE001 - shown on the Data page
        n, err = 0, f"{type(exc).__name__}: {exc}"
    else:
        err = None
    return {"configured": bool(settings.BO_DISTRIBUTOR_SHEETS.strip() and settings.sheets_folder),
            "key_found": key.exists(), "key_path": str(key), "distributor_list": settings.BO_DISTRIBUTOR_SHEETS,
            "distributors": n, "list_error": err, "target": settings.sheets_folder,
            "quarters": [{"file": file_name(*q), "label": quarter_text(*q)} for q in due_quarters()],
            "every_minutes": settings.SHEETS_DOWNLOAD_MINUTES, "last": load_state(store) or None}


# ------------------------------------------------------------------ download
def download(client, distributors: Dict[str, str], quarters: List[Tuple[int, int]], delay: float = 1.0,
             batch_size: int = 10, batch_sleep: float = 15.0) -> Dict[Tuple[int, int], Tuple[pd.DataFrame, dict]]:
    """Every distributor's tab of each quarter (one pass over the sheets). {quarter: (data, report)}."""
    frames: Dict[Tuple[int, int], List[pd.DataFrame]] = {q: [] for q in quarters}
    reports = {q: {"loaded": [], "no_tab": [], "failed": []} for q in quarters}
    for n, (dist, url) in enumerate(distributors.items(), start=1):
        sid = sheet_id(url)
        try:
            titles = client.titles(sid)
        except Exception as exc:  # noqa: BLE001 - one bad sheet must not stop the others
            for q in quarters:
                reports[q]["failed"].append(f"{dist}: {exc}")
            log.warning("Sheet of %s: %s", dist, exc)
        else:
            for fy, q in quarters:
                rep = reports[(fy, q)]
                tab = find_tab(titles, fy, q)
                if tab is None:
                    rep["no_tab"].append(dist)
                    continue
                try:
                    values = client.values(sid, tab)
                except Exception as exc:  # noqa: BLE001
                    rep["failed"].append(f"{dist}: {exc}")
                    continue
                if len(values) < 2:
                    rep["no_tab"].append(dist)
                    continue
                df = sheet_frame(values, required_columns(fy, q))
                df["Distributor"] = dist
                df["Quarter"] = f"Qtr{q}FY{fy % 100:02d}"
                frames[(fy, q)].append(df)
                rep["loaded"].append(dist)
        time.sleep(batch_sleep if n % batch_size == 0 else delay)     # stay inside Google's read quota
    return {q: (pd.concat(frames[q], ignore_index=True) if frames[q] else pd.DataFrame(), reports[q]) for q in quarters}


def save(target: BlobStore, name: str, df: pd.DataFrame) -> Tuple[str, str]:
    """('saved' | 'unchanged' | 'kept' | 'no_tab', message)."""
    if df.empty:
        return "no_tab", "no distributor has this quarter's tab yet; no file written"
    content = df.to_csv(index=False).encode("utf-8")
    old = target.read(name)
    if old is not None:
        if old == content:
            return "unchanged", f"{len(df):,} rows, same as the file already in Consolidated"
        old_rows = max(old.count(b"\n") - 1, 0)
        if old_rows and len(df) < old_rows * MIN_SHARE_OF_EXISTING:
            return "kept", (f"only {len(df):,} rows downloaded against {old_rows:,} in the current file; the current "
                            "file was kept (see the sheets that failed)")
    target.write(name, content)
    return "saved", f"{len(df):,} rows saved"


def run(store: BlobStore, settings: Settings, trigger: str, client=None, today: Optional[date] = None,
        **pace) -> Optional[dict]:
    """Download the due quarters into BO_DATA_FOLDER. None when the download is not set up or not due
    (automatic runs download at most every SHEETS_DOWNLOAD_MINUTES; "Sync now" always does)."""
    if not (settings.BO_DISTRIBUTOR_SHEETS.strip() and settings.sheets_folder):
        return None
    prev = load_state(store)
    if trigger != "manual" and prev.get("finished_at"):
        last = datetime.fromisoformat(prev["finished_at"])
        if datetime.now(timezone.utc) - last < timedelta(minutes=settings.SHEETS_DOWNLOAD_MINUTES):
            return None
    started = datetime.now(timezone.utc).isoformat()
    result = {"trigger": trigger, "started_at": started, "ok": False, "error": None, "quarters": []}
    try:
        distributors = read_distributors(store, settings)
        if not distributors:
            raise ValueError(f"No distributor sheets in {settings.BO_DISTRIBUTOR_SHEETS}.")
        if client is None:
            key = key_path(settings)
            if not key.exists():
                raise FileNotFoundError(f"Google key not found at {key}. Copy bo-data-service-account.json (the key "
                                        "BO_data.ipynb uses) there.")
            client = GoogleSheets(key)
        quarters = due_quarters(today)
        target = store.at(settings.sheets_folder)
        for (fy, q), (df, rep) in download(client, distributors, quarters, **pace).items():
            outcome, message = save(target, file_name(fy, q), df)
            result["quarters"].append({"file": file_name(fy, q), "label": quarter_text(fy, q), "outcome": outcome,
                                       "message": message, "rows": len(df), **rep})
            log.info("Sheets %s: %s - %s", file_name(fy, q), outcome, message)
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001 - reported on the Data page, the sync carries on
        result["error"] = f"{exc}" if isinstance(exc, (FileNotFoundError, ValueError)) else f"{type(exc).__name__}: {exc}"
        log.warning("Sheets download failed: %s", result["error"])
    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    store.write(STATE_PATH, json.dumps(result, indent=2).encode("utf-8"))
    return result
