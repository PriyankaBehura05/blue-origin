"""
Automatic pipeline: Dropbox inbox -> validated datasets.

Drop BO Excel/CSV files into the inbox folder of the data store:

    <DROPBOX_ROOT>/inbox/sales/Sales_Apr26.xlsx       one folder per dataset (recommended)
    <DROPBOX_ROOT>/inbox/retailers/Retailer_Master.xlsx
    <DROPBOX_ROOT>/inbox/BO_Data.xlsx                 inbox root: each sheet is matched by its name
                                                      ("Sales", "Retailers", ...); otherwise the file
                                                      name decides ("distributor_list.csv")

Each sync run (on a timer and on demand) lists the inbox, and for every dataset whose source
files were added, changed or removed it rebuilds datasets/<dataset>.csv from ALL of its current
source files: read -> normalise headers -> validate -> store. Files with file-level errors
(missing required columns, unreadable) are skipped and reported. Rows are never dropped; flagged
rows are stored and excluded from figures as usual.

A dataset fed from the inbox is owned by the inbox: when its files change, the dataset is rebuilt
from them (edits made in the UI to that dataset are replaced at that point).
"""
import json
import logging
import posixpath
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Dict, List, Optional, Tuple

import pandas as pd

from app.core.config import Settings
from app.core.constants import ALLOWED_EXTENSIONS, DatasetType, RecordStatus
from app.core.errors import AppError
from app.processing.data_cleaner import normalize_column_name
from app.processing.excel_reader import list_sheets
from app.processing.file_loader import detect_file_type
from app.processing.pipeline import run_pipeline
from app.repositories.base import DataRepository
from app.services import bo_dashboard_connector, network_service, sheets_download
from app.services.model import get_model
from app.services.upload_service import canonical_table
from app.storage.base import META_DIR, BlobStore, StoredFile

log = logging.getLogger("blue_origin.sync")

STATE_PATH = f"{META_DIR}/sync_state.json"
_RUN_LOCK = threading.Lock()

# Checked in order; the first keyword found in a normalised file/sheet name wins.
_KEYWORDS: List[Tuple[DatasetType, Tuple[str, ...]]] = [
    (DatasetType.FULFILLMENTS, ("fulfil",)),
    (DatasetType.BENEFITS, ("benefit",)),
    (DatasetType.TARGETS, ("target",)),
    (DatasetType.SALES, ("sale", "invoice", "billing")),
    (DatasetType.DISTRIBUTORS, ("distributor", "dist_master")),
    (DatasetType.RETAILERS, ("retailer", "outlet")),
]


class SyncBusyError(AppError):
    status_code, code = 409, "SYNC_RUNNING"


def _keep_catalogue_edits(existing: pd.DataFrame, incoming: pd.DataFrame) -> pd.DataFrame:
    """Benefits from the tier scheme, without losing what users changed in the app: rows that already exist keep
    their edited name / frequency / quantity / unit cost / description, and benefits added in the app are kept."""
    if existing.empty or "id" not in existing:
        return incoming
    old = existing.set_index(existing["id"].astype(str).str.upper())
    out = incoming.copy()
    for col in ("name", "frequency", "quantity", "unit_cost", "description"):
        if col in old:
            saved = out["id"].str.upper().map(old[col])
            out[col] = saved.where(saved.notna() & (saved.astype(str).str.strip() != ""), out[col])
    added = existing[~existing["id"].astype(str).str.upper().isin(set(out["id"].str.upper()))]
    return pd.concat([out, added], ignore_index=True).fillna("") if len(added) else out


def detect_dataset(name: str) -> Optional[DatasetType]:
    n = normalize_column_name(posixpath.splitext(name)[0])
    for dataset, words in _KEYWORDS:
        if any(w in n for w in words):
            return dataset
    return None


def _usable_file(f: StoredFile) -> bool:
    name = posixpath.basename(f.path)
    ext = posixpath.splitext(name)[1].lower()
    return ext in ALLOWED_EXTENSIONS and not name.startswith(("~$", ".", "_"))


@dataclass(frozen=True)
class Source:
    path: str
    version: str
    sheet: Optional[str]   # None = pick automatically (matching sheet name, else first sheet)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SyncRunner:
    def __init__(self, repo: DataRepository, settings: Settings):
        self.repo = repo
        self.store = repo.store
        self.inbox = settings.SYNC_INBOX.strip("/") or "inbox"
        self.settings = settings
        self.source_folder = settings.BO_SOURCE_FOLDER.strip()
        self.tier_scheme = settings.BO_TIER_SCHEME.strip()
        self._content: Dict[str, bytes] = {}

    # ------------------------------------------------------------------ state
    def load_state(self) -> dict:
        raw = self.store.read(STATE_PATH)
        return json.loads(raw.decode("utf-8")) if raw else {"datasets": {}, "root_files": {}, "runs": []}

    def _save_state(self, state: dict) -> None:
        self.store.write(STATE_PATH, json.dumps(state, indent=2, default=str).encode("utf-8"))

    def _read(self, path: str) -> bytes:
        if path not in self._content:
            content = self.store.read(path)
            if content is None:
                raise FileNotFoundError(path)
            self._content[path] = content
        return self._content[path]

    def _sheets(self, path: str) -> List[str]:
        ftype = detect_file_type(path)
        if ftype.value == "csv":
            return []
        return list_sheets(BytesIO(self._read(path)), ftype)

    # ------------------------------------------------------------------ discovery
    def ensure_folders(self) -> None:
        self.store.make_folder(self.inbox)
        for d in DatasetType:
            self.store.make_folder(f"{self.inbox}/{d.value}")

    def discover(self, state: dict, warnings: List[str]) -> Dict[DatasetType, List[Source]]:
        sources: Dict[DatasetType, List[Source]] = {d: [] for d in DatasetType}
        for d in DatasetType:
            for f in self.store.list(f"{self.inbox}/{d.value}"):
                if _usable_file(f):
                    sources[d].append(Source(f.path, f.version, None))

        known = state.setdefault("root_files", {})
        seen = set()
        for f in self.store.list(self.inbox):
            if not _usable_file(f):
                continue
            seen.add(f.path)
            entry = known.get(f.path)
            if not entry or entry.get("version") != f.version:
                entry = {"version": f.version, "sheets": self._root_mapping(f.path, warnings)}
                known[f.path] = entry
            for sheet, dataset in entry["sheets"].items():
                sources[DatasetType(dataset)].append(Source(f.path, f.version, sheet or None))
            if not entry["sheets"]:
                warnings.append(f"{f.path}: could not tell which dataset it holds - rename it (e.g. "
                                f"'sales_….xlsx') or move it into {self.inbox}/<dataset>/.")
        for path in list(known):
            if path not in seen:
                del known[path]
        return sources

    def _root_mapping(self, path: str, warnings: List[str]) -> Dict[str, str]:
        """{sheet name ('' = first sheet / CSV): dataset} for a file in the inbox root."""
        try:
            sheets = self._sheets(path)
        except Exception as exc:  # unreadable workbook: reported by name, kept out of the run
            warnings.append(f"{path}: could not be opened ({type(exc).__name__}).")
            return {}
        mapping = {s: detect_dataset(s).value for s in sheets if detect_dataset(s)}
        if not mapping:
            by_name = detect_dataset(posixpath.basename(path))
            if by_name:
                mapping = {"": by_name.value}
        return mapping

    # ------------------------------------------------------------------ build
    def _pick_sheet(self, src: Source, dataset: DatasetType) -> Optional[str]:
        if src.sheet:
            return src.sheet
        sheets = self._sheets(src.path)
        return next((s for s in sheets if detect_dataset(s) == dataset), sheets[0] if sheets else None)

    def build(self, dataset: DatasetType, sources: List[Source]) -> dict:
        files, tables = [], []
        for src in sources:
            entry = {"path": src.path, "sheet": None, "rows": 0, "valid_rows": 0, "issues": 0, "error": None}
            try:
                sheet = self._pick_sheet(src, dataset)
                entry["sheet"] = sheet
                content = self._read(src.path)
                name = posixpath.basename(src.path)
                result = run_pipeline(content, dataset, filename=name, sheet_name=sheet)
                v = result.validation
                entry.update(rows=v.total_rows, valid_rows=v.status_counts.get(RecordStatus.VALID.value, 0),
                             issues=len(v.issues))
                if not v.can_process:
                    entry["error"] = " ".join(i.message for i in v.file_errors)
                else:
                    tables.append(canonical_table(content, name, sheet, dataset))
            except AppError as exc:
                entry["error"] = exc.message
            except Exception as exc:  # one bad file must not stop the pipeline
                log.exception("Sync failed for %s", src.path)
                entry["error"] = f"Could not process the file ({type(exc).__name__})."
            files.append(entry)

        if not tables:
            return {"dataset": dataset.value, "status": "failed", "rows": 0, "files": files,
                    "message": "No usable source file; the stored dataset was left unchanged."}
        table = pd.concat(tables, ignore_index=True).fillna("")
        self.repo.save_table(dataset, table)
        bad = sum(1 for f in files if f["error"])
        return {"dataset": dataset.value, "status": "partial" if bad else "updated", "rows": len(table),
                "files": files, "message": f"{bad} file(s) skipped." if bad else None}

    # ------------------------------------------------------------------ BO Dashboard connector
    def _connector_source(self) -> Tuple[Optional[BlobStore], str]:
        """The consolidated files: our own pipeline build when there is one, else BO_SOURCE_FOLDER."""
        if network_service.has_build(self.store):
            return network_service.network_store(self.store), f"{self.repo.location}/{network_service.NETWORK_DIR}"
        if self.source_folder:
            return self.store.at(self.source_folder), self.source_folder
        return None, ""

    def run_connector(self, state: dict, force: bool, warnings: List[str]) -> List[dict]:
        """Rebuild retailers / distributors / sales / benefits / fulfilments from the consolidated
        retailer files when any of them changed."""
        src, folder = self._connector_source()
        if src is None:
            return []
        found = {posixpath.basename(f.path): f for f in src.list("")}
        missing = [n for n in bo_dashboard_connector.FILES if n not in found]
        if missing:
            warnings.append(f"BO Dashboard connector: {', '.join(missing)} not found in {folder}.")
            return []
        scheme_store, scheme_name = None, None
        if self.tier_scheme:
            scheme_store = self.store.at(posixpath.dirname(self.tier_scheme))
            scheme_name = posixpath.basename(self.tier_scheme)
            scheme_file = next((f for f in scheme_store.list("") if posixpath.basename(f.path) == scheme_name), None)
            if scheme_file is None:
                warnings.append(f"Tier scheme {self.tier_scheme} not found; benefits are not imported.")
                scheme_store = None
        sources = [f"{folder}/{n}|{found[n].version}" for n in bo_dashboard_connector.FILES]
        if scheme_store:
            sources.append(f"{self.tier_scheme}|{scheme_file.version}")
        prev = state.get("connector", {})
        if not force and prev.get("signature") == sources:
            return [{"dataset": d, "status": "unchanged", "rows": n, "files": prev.get("files", []), "message": None}
                    for d, n in prev.get("rows", {}).items()]

        def read(name: str) -> bytes:
            content = src.read(name)
            if content is None:
                raise FileNotFoundError(name)
            return content

        tables = bo_dashboard_connector.build_tables(read, scheme_store.read(scheme_name) if scheme_store else None)
        files = [{"path": s.split("|")[0], "sheet": None, "rows": 0, "valid_rows": 0, "issues": 0, "error": None}
                 for s in sources]
        results = []
        for dataset, table in tables.items():
            if dataset == DatasetType.BENEFITS:
                table = _keep_catalogue_edits(self.repo.raw_table(dataset), table)
            self.repo.save_table(dataset, table)
            results.append({"dataset": dataset.value, "status": "updated", "rows": len(table), "files": files,
                            "message": f"From the consolidated retailer files in {folder}"})
        state["connector"] = {"signature": sources, "synced_at": _now(), "files": files,
                              "rows": {r["dataset"]: r["rows"] for r in results}}
        return results

    # ------------------------------------------------------------------ Google Sheets -> Consolidated
    def run_sheets(self, trigger: str, warnings: List[str]) -> Optional[dict]:
        """Download the distributors' Google Sheets (current + previous quarter) into BO_DATA_FOLDER first, so the
        dashboard rebuild below uses them. A failed download is reported and the existing files are used."""
        res = sheets_download.run(self.store, self.settings, trigger)
        if res and res.get("error"):
            warnings.append(f"Google Sheets download: {res['error']}")
        for q in (res or {}).get("quarters", []):
            if q["outcome"] == "kept" or q["failed"]:
                warnings.append(f"Google Sheets {q['file']}: {q['message']}; {len(q['failed'])} sheet(s) could not "
                                "be read: " + "; ".join(q["failed"][:5]))
        return res

    # ------------------------------------------------------------------ BO Retailer Network
    def run_network(self, warnings: List[str]) -> Optional[dict]:
        """Re-run bo_pipeline.py when the main data (BO_DATA_FOLDER) or the Power BI files changed."""
        if not self.settings.BO_PIPELINE_INPUT.strip() and not self.settings.BO_DATA_FOLDER.strip():
            return None
        try:
            res = network_service.build(self.store, self.settings)
        except network_service.NetworkBusyError as exc:
            warnings.append(exc.message)
            return None
        if res["status"] == "failed":
            warnings.append(f"Dashboard data was not rebuilt: {res['message']}")
        return {k: res.get(k) for k in ("status", "built_at", "seconds", "quarters", "retailers", "message")}

    # ------------------------------------------------------------------ run
    def run(self, trigger: str, force: bool = False) -> dict:
        if not _RUN_LOCK.acquire(blocking=False):
            raise SyncBusyError("A sync is already running. Try again in a moment.")
        started = _now()
        try:
            self.ensure_folders()
            state = self.load_state()
            warnings: List[str] = []
            sheets = self.run_sheets(trigger, warnings)
            network = self.run_network(warnings)
            results = self.run_connector(state, force, warnings)
            sources = self.discover(state, warnings)
            for d, srcs in sources.items():
                signature = sorted(f"{s.path}|{s.version}|{s.sheet or ''}" for s in srcs)
                prev = state["datasets"].get(d.value, {})
                if not srcs:
                    if prev.get("signature"):
                        warnings.append(f"All inbox files for '{d.value}' were removed; the stored dataset was kept.")
                        state["datasets"][d.value] = {**prev, "signature": []}
                    continue
                if not force and prev.get("signature") == signature:
                    results.append({"dataset": d.value, "status": "unchanged", "rows": prev.get("rows", 0),
                                    "files": prev.get("files", []), "message": None})
                    continue
                res = self.build(d, srcs)
                results.append(res)
                if res["status"] != "failed":
                    state["datasets"][d.value] = {"signature": signature, "synced_at": _now(), "rows": res["rows"],
                                                  "files": res["files"]}
            run = {"trigger": trigger, "started_at": started, "finished_at": _now(), "ok": True, "error": None,
                   "warnings": warnings, "results": results, "network": network, "sheets": sheets}
        except AppError as exc:
            run = {"trigger": trigger, "started_at": started, "finished_at": _now(), "ok": False,
                   "error": exc.message, "warnings": [], "results": []}
            state = None
        finally:
            _RUN_LOCK.release()

        if state is not None:
            state["runs"] = ([run] + state.get("runs", []))[:20]
            try:
                self._save_state(state)
            except AppError as exc:
                run.update(ok=False, error=exc.message)
        if run["ok"]:
            log.info("Sync (%s): %s", trigger, ", ".join(f"{r['dataset']}={r['status']}" for r in run["results"]) or "no files")
        else:
            log.warning("Sync (%s) failed: %s", trigger, run["error"])
        return run


# ------------------------------------------------------------------ scheduler
class SyncScheduler:
    """Runs the pipeline at startup and then every SYNC_INTERVAL_MINUTES in a background thread."""

    def __init__(self):
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.interval_minutes = 0
        self.next_run_at: Optional[datetime] = None
        self.last_run: Optional[dict] = None

    def start(self, repo_factory, settings: Settings) -> None:
        self.interval_minutes = settings.SYNC_INTERVAL_MINUTES
        if self.interval_minutes <= 0 or (self._thread and self._thread.is_alive()):
            return
        self._stop.clear()

        watch = settings.DATA_WATCH_MINUTES * 60
        tried: Dict[str, Optional[datetime]] = {"newest": None}   # a failed build is not retried for the same files

        def sync(trigger: str) -> None:
            try:
                repo = repo_factory()
                self.last_run = SyncRunner(repo, settings).run(trigger)
                get_model(repo)  # pre-build the dashboard figures so the first page load is fast
            except SyncBusyError:
                pass
            except AppError as exc:  # e.g. Dropbox not configured: keep trying on the next tick
                self.last_run = {"trigger": trigger, "started_at": _now(), "finished_at": _now(),
                                 "ok": False, "error": exc.message, "warnings": [], "results": []}
                log.warning("Scheduled sync skipped: %s", exc.message)
            except Exception:
                log.exception("Scheduled sync crashed")

        def data_changed() -> bool:
            """True once BO_data.ipynb (or anyone) changed the dashboard files and then left them alone."""
            try:
                newest = network_service.pending_change(repo_factory().store, settings)
            except Exception as exc:  # Dropbox unreachable: the regular run will try again
                log.debug("Data watch skipped: %s", exc)
                return False
            if newest is None or newest == tried["newest"]:
                return False
            settled = (datetime.now(timezone.utc) - newest).total_seconds() >= settings.DATA_SETTLE_SECONDS
            if not settled:
                log.info("Dashboard files changed at %s; syncing once they stop changing", newest.isoformat())
            else:
                tried["newest"] = newest
            return settled

        def loop():
            due = time.monotonic() + 3.0  # first run shortly after startup
            while True:
                wait = max(0.0, due - time.monotonic())
                if watch > 0:
                    wait = min(wait, watch)
                self.next_run_at = datetime.fromtimestamp(datetime.now().timestamp() + max(0.0, due - time.monotonic()),
                                                          tz=timezone.utc)
                if self._stop.wait(wait):
                    return
                if time.monotonic() >= due:
                    sync("schedule")
                    due = time.monotonic() + self.interval_minutes * 60
                elif watch > 0 and not _RUN_LOCK.locked() and data_changed():
                    log.info("Dashboard files changed: syncing now")
                    sync("data change")

        self._thread = threading.Thread(target=loop, name="dropbox-sync", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.next_run_at = None

    @property
    def running(self) -> bool:
        return _RUN_LOCK.locked()


scheduler = SyncScheduler()
