"""
BO Retailer Network: the consolidated retailer data behind the dashboard pages.

Main data (user, 2026-10-22): the cleaned files BO_data.ipynb writes into BO_PIPELINE_INPUT (/Power BI), read directly.
With BO_DATA_FOLDER set (/Power BI/Consolidated) the raw distributor sheets are cleaned first by
app/pipeline/consolidated_prep.py instead. There is no duplicate merging: one retailer per Code name.

    BO_PIPELINE_INPUT (/Power BI)                    app/pipeline/bo_pipeline.py               <store>/network/
      FY25_qtr3.csv ... FY27_qtr2.csv          ->    one retailer per Code name,               -> dashboard.json.gz (served to the app)
      Dist-state.xlsx, Tier_scheme.xlsx              sums revenue, recomputes tiers               retailers.csv, retailer_month.csv,
      (deliverables_consolidated.csv is not read)                                                retailer_quarter.csv, code_names.csv

The pipeline runs during the sync (and on POST /api/network/rebuild) only when an input file changed.
Until a build exists the dashboard falls back to BO_SOURCE_FOLDER/dashboard_data.json written by the
notebook, so nothing breaks while the first build runs.
"""
import gzip
import hashlib
import json
import logging
import posixpath
import re
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.core.config import Settings
from app.core.errors import AppError, DataNotAvailableError
from app.services import info_enrichment
from app.storage.base import META_DIR, BlobStore, StoredFile, SubFolderStore

log = logging.getLogger("blue_origin.network")

NETWORK_DIR = "network"
PAYLOAD_NAME = "dashboard.json.gz"
BUILD_PATH = f"{META_DIR}/network_build.json"
PIPELINE = Path(__file__).resolve().parent.parent / "pipeline" / "bo_pipeline.py"
PREP = Path(__file__).resolve().parent.parent / "pipeline" / "consolidated_prep.py"
_CONSOLIDATED_FILE = re.compile(r"^FY\d{2}_Qtr[1-4]\.csv$", re.I)
PIPELINE_TIMEOUT_SECONDS = 1800

_QUARTER_FILE = re.compile(r"^FY\d{2}_qtr[1-4]\.csv$", re.I)
_SIDE_INPUTS = ("dist-state.xlsx", "tier_scheme.xlsx", "deliverables_consolidated.csv")
# copied to <store>/network/ for the connector and for download; dashboard_data.json is stored gzipped
_OUTPUTS = ("retailers.csv", "retailer_month.csv", "retailer_quarter.csv", "code_names.csv")
# files of the duplicate merging, which was removed (user, 2026-10-22): deleted from older builds
_MERGE_FILES = ("dedup_audit.csv", "cross_distributor.csv", "same_name_different_phone.csv")

_BUILD_LOCK = threading.Lock()
_payload_cache: Dict[str, object] = {}
_PAYLOAD_RECHECK_SECONDS = 30


class NetworkBusyError(AppError):
    status_code, code = 409, "NETWORK_BUILD_RUNNING"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def network_store(store: BlobStore) -> BlobStore:
    return SubFolderStore(store, NETWORK_DIR)


def load_build(store: BlobStore) -> dict:
    raw = store.read(BUILD_PATH)
    return json.loads(raw.decode("utf-8")) if raw else {}


def has_build(store: BlobStore) -> bool:
    names = {posixpath.basename(f.path) for f in network_store(store).list("")}
    return PAYLOAD_NAME in names and all(n in names for n in ("retailers.csv", "retailer_month.csv", "retailer_quarter.csv"))


def pipeline_inputs(src: BlobStore, side_only: bool = False) -> List[StoredFile]:
    """Files read from BO_PIPELINE_INPUT. With side_only (main data from BO_DATA_FOLDER) only the reference files."""
    def wanted(name: str) -> bool:
        if name.lower() == "deliverables_consolidated.csv":    # deliverables are not read (user, 2026-10-22)
            return False
        if side_only:
            return name.lower() in _SIDE_INPUTS
        return bool(_QUARTER_FILE.match(name)) or name.lower() in _SIDE_INPUTS
    files = [f for f in src.list("") if wanted(posixpath.basename(f.path))]
    return sorted(files, key=lambda f: f.path.lower())


def data_inputs(store: BlobStore, settings: Settings) -> List[StoredFile]:
    """The consolidated quarter sheets in BO_DATA_FOLDER (FY27_Qtr2.csv, ...); empty when it is not set."""
    folder = settings.BO_DATA_FOLDER.strip()
    if not folder:
        return []
    files = [f for f in store.at(folder).list("") if _CONSOLIDATED_FILE.match(posixpath.basename(f.path))]
    return sorted(files, key=lambda f: f.path.lower())


def wrap_payload(raw_json: bytes) -> bytes:
    """Gzipped API envelope around the pipeline's dashboard_data.json, without re-parsing 9 MB of JSON."""
    meta = json.dumps({"generatedAt": _now()}).encode()
    return gzip.compress(b'{"success":true,"data":' + raw_json.strip() + b',"meta":' + meta + b"}", compresslevel=6)


# ------------------------------------------------------------------ build
def _info_file(store: BlobStore, settings: Settings) -> Optional[StoredFile]:
    folder = settings.BO_INFO_FOLDER.strip()
    if not folder:
        return None
    return next((f for f in store.at(folder).list("")
                 if posixpath.basename(f.path).lower() == info_enrichment.REFERENCE_FILE.lower()), None)


def _signature(data_folder: str, data: List[StoredFile], inputs: List[StoredFile], info_folder: str,
               info_file: Optional[StoredFile]) -> List[str]:
    """The input file versions a build was made from: a different list means the data changed."""
    sig = [f"{data_folder}/{f.path}|{f.version}" for f in data] + [f"{f.path}|{f.version}" for f in inputs]
    if info_file:
        sig.append(f"{info_folder}/{info_file.path}|{info_file.version}")
    return sig


def pending_change(store: BlobStore, settings: Settings) -> Optional[datetime]:
    """When an input file (a quarter file such as a new FY27_qtr3.csv, Dist-state.xlsx, ...) differs from the last
    build: the newest modification time of the inputs, so the caller can wait until a notebook run has finished
    writing all its files. None when nothing changed or the dashboard pipeline is off. Only lists folders."""
    folder, data_folder = settings.BO_PIPELINE_INPUT.strip(), settings.BO_DATA_FOLDER.strip()
    if not folder and not data_folder:
        return None
    inputs = pipeline_inputs(store.at(folder), side_only=bool(data_folder)) if folder else []
    data = data_inputs(store, settings)
    info_file = _info_file(store, settings)
    signature = _signature(data_folder, data, inputs, settings.BO_INFO_FOLDER.strip(), info_file)
    if load_build(store).get("signature") == signature and has_build(store):
        return None
    stamps = [f.modified for f in [*inputs, *data, *([info_file] if info_file else [])] if f.modified]
    newest = max(stamps) if stamps else datetime.now(timezone.utc)
    return newest if newest.tzinfo else newest.replace(tzinfo=timezone.utc)


def build(store: BlobStore, settings: Settings, force: bool = False) -> dict:
    """Run bo_pipeline.py when its input files changed. Returns a short result for the sync log.

    Main data: BO_DATA_FOLDER (the consolidated sheets, cleaned first by consolidated_prep.py). Without it, the
    cleaned FY*_qtr*.csv and deliverables_consolidated.csv written by BO_data.ipynb in BO_PIPELINE_INPUT are used."""
    folder = settings.BO_PIPELINE_INPUT.strip()
    data_folder = settings.BO_DATA_FOLDER.strip()
    if not folder and not data_folder:
        return {"status": "off", "message": "BO_DATA_FOLDER / BO_PIPELINE_INPUT is not set."}
    if not _BUILD_LOCK.acquire(blocking=False):
        raise NetworkBusyError("The dashboard data is already being rebuilt. Try again in a few minutes.")
    started = time.time()
    try:
        src = store.at(folder) if folder else None
        inputs = pipeline_inputs(src, side_only=bool(data_folder)) if src else []
        data = data_inputs(store, settings)
        if data_folder and not data:
            return _record(store, {"status": "failed",
                                   "message": f"No quarter sheets (FY27_Qtr2.csv, ...) in {data_folder}."})
        if not data_folder and not any(_QUARTER_FILE.match(posixpath.basename(f.path)) for f in inputs):
            return _record(store, {"status": "failed", "message": f"No quarter files (FY27_qtr1.csv, ...) in {folder}."})
        info_folder = settings.BO_INFO_FOLDER.strip()
        info_file = _info_file(store, settings)
        signature = _signature(data_folder, data, inputs, info_folder, info_file)
        prev = load_build(store)
        if not force and prev.get("signature") == signature and has_build(store):
            return {**prev, "status": "unchanged"}

        with tempfile.TemporaryDirectory(prefix="bo_network_") as tmp:
            inp, out = Path(tmp) / "in", Path(tmp) / "out"
            inp.mkdir()
            for f in inputs:
                content = src.read(f.path)
                if content is None:
                    raise DataNotAvailableError(f"{folder}/{f.path} could not be read.")
                (inp / posixpath.basename(f.path)).write_bytes(content)
            if data:   # main data: clean the consolidated sheets into the files bo_pipeline.py reads
                raw_dir = Path(tmp) / "consolidated"
                raw_dir.mkdir()
                dsrc = store.at(data_folder)
                for f in data:
                    content = dsrc.read(f.path)
                    if content is None:
                        raise DataNotAvailableError(f"{data_folder}/{f.path} could not be read.")
                    (raw_dir / posixpath.basename(f.path)).write_bytes(content)
                prep = subprocess.run([sys.executable, str(PREP), str(raw_dir), str(inp)], capture_output=True,
                                      text=True, timeout=PIPELINE_TIMEOUT_SECONDS, cwd=tmp)
                if prep.returncode != 0:
                    tail = (prep.stderr or prep.stdout).strip().splitlines()[-6:]
                    log.error("consolidated_prep.py failed:\n%s", prep.stderr)
                    return _record(store, {"status": "failed", "signature": prev.get("signature"),
                                           "message": "Cleaning the consolidated sheets failed: " + " | ".join(tail)})
            proc = subprocess.run([sys.executable, str(PIPELINE), str(inp), str(out)], capture_output=True, text=True,
                                  timeout=PIPELINE_TIMEOUT_SECONDS, cwd=tmp)
            if proc.returncode != 0:
                tail = (proc.stderr or proc.stdout).strip().splitlines()[-6:]
                log.error("bo_pipeline.py failed:\n%s", proc.stderr)
                return _record(store, {"status": "failed", "signature": prev.get("signature"),
                                       "message": "bo_pipeline.py failed: " + " | ".join(tail)})
            enrichment = None
            if info_file:  # fill blank city / pincode / phone from the reference workbook
                try:
                    ref = info_enrichment.load_reference(store.at(info_folder).read(info_file.path) or b"")
                    enrichment = {"source": f"{info_folder}/{info_file.path}", **info_enrichment.enrich(out, ref)}
                except Exception as exc:  # a bad reference file must not block the build
                    log.exception("Enrichment from %s failed", info_file.path)
                    enrichment = {"source": f"{info_folder}/{info_file.path}", "error": f"{type(exc).__name__}: {exc}"}
            raw = (out / "dashboard_data.json").read_bytes()
            head = json.loads(raw)
            net = network_store(store)
            for name in _OUTPUTS:
                if (out / name).exists():
                    net.write(name, (out / name).read_bytes())
            stale = {posixpath.basename(f.path) for f in net.list("")} & set(_MERGE_FILES)
            for name in stale:
                net.delete(name)
            net.write(PAYLOAD_NAME, wrap_payload(raw))  # last, so a reader never sees new data with old CSVs
            check = next((ln for ln in proc.stdout.splitlines() if ln.startswith("Revenue check")), "")
        result = {"status": "built", "signature": signature, "built_at": _now(),
                  "seconds": round(time.time() - started), "quarters": head["quarters"],
                  "retailers": len(head["retailers"]), "generated": head.get("generated"),
                  "revenue_check": check, "inputs": [f"{data_folder}/{f.path}" for f in data] + [f.path for f in inputs],
                  "main_data": data_folder or folder, "enrichment": enrichment, "message": None}
        _payload_cache.clear()
        return _record(store, result)
    except subprocess.TimeoutExpired:
        return _record(store, {"status": "failed", "message": "bo_pipeline.py took longer than 30 minutes and was stopped."})
    finally:
        _BUILD_LOCK.release()


def _record(store: BlobStore, result: dict) -> dict:
    result = {"finished_at": _now(), **result}
    if result["status"] == "failed":
        prev = load_build(store)  # keep the last good build's details, add the failure
        result = {**{k: v for k, v in prev.items() if k not in ("status", "message")}, **result,
                  "last_success_at": prev.get("built_at")}
        log.warning("Network build failed: %s", result["message"])
    store.write(BUILD_PATH, json.dumps(result, indent=2).encode("utf-8"))
    return result


def building() -> bool:
    return _BUILD_LOCK.locked()


def rebuild_in_background(repo_factory, settings: Settings, force: bool = True) -> bool:
    """Start a rebuild without blocking the request. False when one is already running."""
    if building():
        return False

    def run():
        try:
            build(repo_factory().store, settings, force=force)
        except NetworkBusyError:
            pass
        except Exception:
            log.exception("Network rebuild crashed")

    threading.Thread(target=run, name="network-build", daemon=True).start()
    return True


# ------------------------------------------------------------------ payload
def _source(store: BlobStore, settings: Settings) -> Tuple[BlobStore, str, str]:
    """(store, file name, label) of the payload to serve: our build, else the notebook's file."""
    net = network_store(store)
    if any(posixpath.basename(f.path) == PAYLOAD_NAME for f in net.list("")):
        return net, PAYLOAD_NAME, "pipeline"
    folder = settings.BO_SOURCE_FOLDER.strip()
    if folder:
        src = store.at(folder)
        names = {posixpath.basename(f.path) for f in src.list("")}
        if "dashboard_data.json" in names:
            return src, "dashboard_data.json", "notebook"
    raise DataNotAvailableError(
        "No dashboard data yet. Set BO_DATA_FOLDER (e.g. /Power BI/Consolidated) in backend/.env and run a sync, "
        "or put dashboard_data.json in the BO_SOURCE_FOLDER.")


def payload(store: BlobStore, settings: Settings) -> Tuple[bytes, str, str]:
    """(gzipped envelope, etag, source). Re-reads Dropbox only when the file's version changed."""
    c = _payload_cache
    if c.get("checked") and time.time() - float(c["checked"]) < _PAYLOAD_RECHECK_SECONDS:
        return c["bytes"], c["etag"], c["source"]  # type: ignore[return-value]
    src, name, label = _source(store, settings)
    version = next((f.version for f in src.list("") if posixpath.basename(f.path) == name), "")
    if c.get("version") != version or c.get("source") != label:
        content = src.read(name)
        if content is None:
            raise DataNotAvailableError(f"{name} could not be read.")
        body = content if name.endswith(".gz") else wrap_payload(content)
        c.update(bytes=body, version=version, source=label, etag=f'"{label}-{version or len(body)}"')
    c["checked"] = time.time()
    return c["bytes"], c["etag"], c["source"]  # type: ignore[return-value]


def status(store: BlobStore, settings: Settings) -> dict:
    b = load_build(store)
    try:
        _, _, source = payload(store, settings)
    except AppError as exc:
        source = None
        b.setdefault("message", exc.message)
    try:
        files = input_files(store, settings, b)
    except AppError as exc:
        files = [{"file": settings.BO_DATA_FOLDER or settings.BO_PIPELINE_INPUT, "status": "Unreadable", "error": exc.message}]
    try:
        code = code_check(store, settings)
    except AppError as exc:
        code = [{"file": settings.BO_SOURCE_FOLDER, "status": "Unreadable", "error": exc.message}]
    return {"source": source, "building": building(),
            "pipeline_input": settings.BO_DATA_FOLDER or settings.BO_PIPELINE_INPUT or None,
            "last_build": b or None, "files": files, "code": code,
            "pending": any(f["status"] != "In dashboard" for f in files)}


# ------------------------------------------------------------------ pipeline overview (Data page)
def _iso(d: Optional[datetime]) -> Optional[str]:
    """Dropbox gives server_modified in UTC without a time zone."""
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat() if d else None


def input_files(store: BlobStore, settings: Settings, build_info: dict) -> List[dict]:
    """Every file the build reads, and whether the dashboard already has its current version:
    'In dashboard', 'Changed' (newer than the last build), 'New' (not in it yet) or 'Removed'."""
    built: Dict[str, str] = {}
    for entry in build_info.get("signature") or []:
        path, _, version = entry.rpartition("|")
        built[path] = version
    rows: List[dict] = []

    def add(key: str, f: StoredFile, kind: str, quarter: Optional[str] = None):
        state = "In dashboard" if built.get(key) == f.version else "Changed" if key in built else "New"
        rows.append({"file": key, "kind": kind, "quarter": quarter, "modified": _iso(f.modified), "size": f.size,
                     "status": state})

    data_folder = settings.BO_DATA_FOLDER.strip()
    for f in data_inputs(store, settings):
        m = re.match(r"^FY(\d{2})_Qtr([1-4])", posixpath.basename(f.path), re.I)
        add(f"{data_folder}/{f.path}", f, "Main data", f"Q{m.group(2)}_FY{m.group(1)}" if m else None)
    folder = settings.BO_PIPELINE_INPUT.strip()
    if folder:
        for f in pipeline_inputs(store.at(folder), side_only=bool(data_folder)):
            main = not data_folder and bool(_QUARTER_FILE.match(posixpath.basename(f.path)))
            add(f.path, f, "Main data" if main else "Reference")
    info_folder = settings.BO_INFO_FOLDER.strip()
    if info_folder:
        for f in store.at(info_folder).list(""):
            if posixpath.basename(f.path).lower() == info_enrichment.REFERENCE_FILE.lower():
                add(f"{info_folder}/{f.path}", f, "Contact details")
    seen = {r["file"] for r in rows}
    rows += [{"file": p, "kind": "", "quarter": None, "modified": None, "size": None, "status": "Removed"}
             for p in built if p not in seen]
    return rows


# The pipeline code the platform copied from BO_SOURCE_FOLDER (BO_Dashboard): bo_pipeline.py is copied as
# app/pipeline/bo_pipeline.py and the cleaning cells of BO_data.ipynb are ported to consolidated_prep.py.
# source_versions.json holds a fingerprint of that code at the time of the copy; a different fingerprint means
# the code in Dropbox changed and the copy needs updating. Only code counts: re-running the notebook (new
# outputs) or editing its Google Sheets download cells do not.
CODE_BASELINE = Path(__file__).resolve().parent.parent / "pipeline" / "source_versions.json"
_code_cache: Dict[str, Tuple[str, str]] = {}


def code_fingerprint(name: str, content: bytes) -> str:
    if name.lower().endswith(".ipynb"):
        cells = ["".join(c.get("source", [])) for c in json.loads(content.decode("utf-8"))["cells"]
                 if c.get("cell_type") == "code"]
        last_export = max((i for i, c in enumerate(cells) if "to_csv(" in c and "Consolidated" in c), default=-1)
        text = "\n".join(cells[last_export + 1:])          # the cleaning cells, after the export to Consolidated
    else:
        text = content.decode("utf-8", errors="replace")
    text = "\n".join(ln.rstrip() for ln in text.replace("\r\n", "\n").split("\n")).strip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def code_check(store: BlobStore, settings: Settings) -> List[dict]:
    """Is the platform's copy of each BO_Dashboard pipeline file still the same code? 'In sync' / 'Changed' / 'Missing'."""
    folder = settings.BO_SOURCE_FOLDER.strip()
    if not folder or not CODE_BASELINE.exists():
        return []
    baseline = json.loads(CODE_BASELINE.read_text(encoding="utf-8"))
    src = store.at(folder)
    found = {posixpath.basename(f.path): f for f in src.list("")}
    out = []
    for name, info in baseline.items():
        if name.lower().endswith(".ipynb") and not settings.BO_DATA_FOLDER.strip():
            continue   # the dashboard reads the notebook's own output files, so its changes need no copy
        row = {"file": f"{folder}/{name}", "copy": info["copy"], "copied": info["copied"], "modified": None}
        f = found.get(name)
        if f is None:
            out.append({**row, "status": "Missing"})
            continue
        cached = _code_cache.get(name)
        if not cached or cached[0] != f.version:
            content = src.read(f.path)
            if content is None:
                out.append({**row, "status": "Unreadable"})
                continue
            _code_cache[name] = (f.version, code_fingerprint(name, content))
        out.append({**row, "modified": _iso(f.modified),
                    "status": "In sync" if _code_cache[name][1] == info["fingerprint"] else "Changed"})
    return out
