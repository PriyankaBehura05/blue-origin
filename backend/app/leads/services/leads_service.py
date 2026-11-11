"""Lead Generation data in the store: the inbox, the build and its outputs, the actions tracker and the targets.

    <store>/leads/inbox/      lead dumps, spend, follow-up log, targets (CSV / Excel) - dropped here by people
    <store>/leads/sheets/     the same, copied from linked Google Sheets every few minutes (sheets_source.py)
    <store>/leads/out/        dashboard.json.gz, reconciliation.xlsx, memo.md, build.json (fingerprint + time)
    <store>/leads/actions.json, targets.json   edited in the dashboard
    <store>/network/          the BO Dashboard's outputs, only ever read here

A request rebuilds when the fingerprint (inbox + Google Sheets copies + sales file versions, saved targets, pipeline version) changed, so a
new file in the inbox refreshes the dashboard on the next visit. The fingerprint is re-checked at most once a minute.
The background loop (start_auto) re-reads the linked Google Sheets every LEADS_SHEETS_MINUTES and rebuilds when a tab
changed, so the dashboard is current without anyone uploading anything.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import posixpath
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from app.core.errors import DataNotAvailableError
from app.storage.base import BlobStore

from ..pipeline import run
from ..pipeline.inputs import SALES_FILES
from . import sheets_source as sheets

log = logging.getLogger("blue_origin.leads")

PIPELINE_VERSION = "7"
INBOX, OUT, NETWORK = "leads/inbox", "leads/out", "network"
ACTIONS, TARGETS = "leads/actions.json", "leads/targets.json"
RECHECK_SECONDS = 60
INBOX_TYPES = (".csv", ".xlsx", ".xls", ".xlsm")

_lock = threading.Lock()
_cache: Dict[str, object] = {}


def _json(store: BlobStore, path: str, default):
    raw = store.read(path)
    return json.loads(raw) if raw else default


def inbox_files(store: BlobStore) -> List[dict]:
    return [{"name": posixpath.basename(f.path), "size": f.size, "modified": f.modified.isoformat() if f.modified else None}
            for f in store.list(INBOX) if f.path.lower().endswith(INBOX_TYPES)]


def _input_files(store: BlobStore):
    """Inbox files and Google Sheets copies, the build's inputs next to the sales data."""
    for folder in (INBOX, sheets.FOLDER):
        yield from (f for f in store.list(folder) if f.path.lower().endswith(INBOX_TYPES))


def fingerprint(store: BlobStore) -> str:
    inbox = sorted((f.path, f.version or str(f.size)) for f in _input_files(store))
    sales = sorted((posixpath.basename(f.path), f.version or str(f.size)) for f in store.list(NETWORK)
                   if posixpath.basename(f.path) in SALES_FILES)
    targets = store.read(TARGETS) or b""
    raw = json.dumps([PIPELINE_VERSION, inbox, sales, hashlib.sha1(targets).hexdigest()])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _build(store: BlobStore, fp: str) -> None:
    inbox = {_display(f.path): store.read(f.path) or b"" for f in _input_files(store)}
    sales = {n: store.read(f"{NETWORK}/{n}") for n in SALES_FILES}
    if sales.get("retailers.csv") is None or sales.get("retailer_month.csv") is None:
        raise DataNotAvailableError("The BO Dashboard data (network/retailers.csv, retailer_month.csv) is not built yet.")
    started = time.time()
    res = run(inbox, sales, target_overrides=_json(store, TARGETS, {}))
    body = gzip.compress(json.dumps(res.payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    store.write(f"{OUT}/dashboard.json.gz", body)
    store.write(f"{OUT}/reconciliation.xlsx", res.reconciliation)
    store.write(f"{OUT}/memo.md", res.memo.encode("utf-8"))
    store.write(f"{OUT}/build.json", json.dumps({
        "fingerprint": fp, "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seconds": round(time.time() - started, 1), "inbox": sorted(inbox), "lead_rows": len(res.payload["leads"]["day"]),
    }, indent=2).encode())


def _display(path: str) -> str:
    """Name the build sees: the file name, a sheet copy without its link prefix (the tab name helps classify it)."""
    name = posixpath.basename(path)
    return f"Sheet tab - {name.split('~', 1)[1]}" if path.startswith(sheets.FOLDER + "/") and "~" in name else name


def ensure_built(store: BlobStore, force: bool = False, wait: bool = True) -> Tuple[str, dict]:
    """(fingerprint, build info); rebuilds first when the inputs changed (or when forced).

    wait=False (page requests): never keep a visitor waiting on a build (about a minute and a half with ~50k leads)
    while a previous one is there to show - the rebuild runs in the background and the next visit gets it."""
    key = store.describe()
    if not wait and not force and not _lock.acquire(blocking=False):
        if _cache.get("key") == key and "fp" in _cache:      # a build is running: show the last one meanwhile
            return str(_cache["fp"]), dict(_cache["info"])  # type: ignore[arg-type]
        _lock.acquire()
    elif wait or force:
        _lock.acquire()
    try:
        if not force and _cache.get("key") == key and time.time() - float(_cache.get("checked", 0)) < RECHECK_SECONDS:
            return str(_cache["fp"]), dict(_cache["info"])  # type: ignore[arg-type]
        fp = fingerprint(store)
        info = _json(store, f"{OUT}/build.json", {})
        stale = force or info.get("fingerprint") != fp or store.read(f"{OUT}/dashboard.json.gz") is None
        if stale and not wait and not force and info.get("fingerprint") and store.read(f"{OUT}/dashboard.json.gz"):
            old = str(info["fingerprint"])
            _cache.update(key=key, fp=old, info=info, checked=time.time())
            threading.Thread(target=_background_build, args=(store,), name="leads-build", daemon=True).start()
            return old, info
        if stale:
            _build(store, fp)
            info = _json(store, f"{OUT}/build.json", {})
            _cache.pop("body", None)
        _cache.update(key=key, fp=fp, info=info, checked=time.time())
        return fp, info
    finally:
        _lock.release()


def _background_build(store: BlobStore) -> None:
    try:
        _cache.pop("checked", None)
        ensure_built(store)
    except Exception as exc:  # the last build stays on screen; the next check tries again
        log.warning("Lead dashboard background build: %s", exc)


def payload(store: BlobStore) -> Tuple[bytes, str]:
    fp, _ = ensure_built(store, wait=False)
    if _cache.get("body_fp") != fp or _cache.get("body") is None:
        body = store.read(f"{OUT}/dashboard.json.gz")
        if body is None:
            raise DataNotAvailableError("The lead dashboard data could not be read.")
        _cache.update(body=body, body_fp=fp)
    return _cache["body"], f'"leads-{fp}"'  # type: ignore[return-value]


def output(store: BlobStore, name: str) -> bytes:
    ensure_built(store, wait=False)
    content = store.read(f"{OUT}/{name}")
    if content is None:
        raise DataNotAvailableError(f"{name} is not built yet.")
    return content


def status(store: BlobStore) -> dict:
    _, info = ensure_built(store, wait=False)
    return {"build": info, "inbox": inbox_files(store), "inbox_folder": f"{store.describe().rstrip('/')}/{INBOX}",
            "sheets": sheets_status(store)}


# ------------------------------------------------------------------ Google Sheets
_auto: Dict[str, object] = {}


def sheets_status(store: BlobStore) -> dict:
    return {"sources": sheets.get_sources(store), "last": sheets.last_state(store),
            "serviceAccount": _auto.get("email"), "everyMinutes": _auto.get("minutes", 0)}


def refresh_sheets(store: BlobStore, settings) -> dict:
    """Re-read the linked sheets now; rebuild when a tab changed."""
    reader, email = sheets.make_reader(settings)
    _auto["email"] = email
    state = sheets.refresh(store, reader)
    _cache.pop("checked", None)
    ensure_built(store)
    return state


def save_sheet_sources(store: BlobStore, settings, items: List[dict]) -> dict:
    sheets.save_sources(store, items)
    refresh_sheets(store, settings)
    return sheets_status(store)


def start_auto(repo_factory, settings) -> None:
    """Background loop: every LEADS_SHEETS_MINUTES read the linked Google Sheets and rebuild if anything changed
    (inbox, sheets or the BO sales outputs), so the next visit is instant. 0 = off (visits still rebuild)."""
    minutes = int(getattr(settings, "LEADS_SHEETS_MINUTES", 0) or 0)
    _auto["minutes"] = minutes
    try:
        _auto["email"] = sheets.make_reader(settings)[1]
    except Exception:  # never stops the app from starting
        pass
    if minutes <= 0 or _auto.get("thread"):
        return
    stop = threading.Event()

    def loop():
        while not stop.wait(30 if "ran" not in _auto else minutes * 60):
            _auto["ran"] = True
            try:
                store = repo_factory().store
                if sheets.get_sources(store):
                    refresh_sheets(store, settings)
                else:
                    ensure_built(store)
            except Exception as exc:  # e.g. the BO data not built yet; tried again next round
                log.warning("Lead dashboard automatic refresh: %s", exc)

    _auto.update(stop=stop, thread=threading.Thread(target=loop, name="leads-sheets", daemon=True))
    _auto["thread"].start()  # type: ignore[union-attr]


def stop_auto() -> None:
    if _auto.get("stop"):
        _auto["stop"].set()  # type: ignore[union-attr]
    _auto.pop("thread", None)


def save_inbox_file(store: BlobStore, name: str, content: bytes) -> None:
    safe = posixpath.basename(name.replace("\\", "/")).strip()
    if not safe.lower().endswith(INBOX_TYPES):
        raise ValueError("Only CSV or Excel files can go into the leads inbox.")
    store.write(f"{INBOX}/{safe}", content)
    _cache.pop("checked", None)


def delete_inbox_file(store: BlobStore, name: str) -> None:
    store.delete(f"{INBOX}/{posixpath.basename(name)}")
    _cache.pop("checked", None)


def get_actions(store: BlobStore) -> List[dict]:
    return _json(store, ACTIONS, [])


def save_actions(store: BlobStore, items: List[dict], user: Optional[str]) -> List[dict]:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    clean = [{**it, "updatedBy": it.get("updatedBy") or user, "updatedAt": it.get("updatedAt") or now} for it in items]
    store.write(ACTIONS, json.dumps(clean, indent=2, ensure_ascii=False).encode("utf-8"))
    return clean


def get_targets(store: BlobStore) -> dict:
    return _json(store, TARGETS, {})


def save_targets(store: BlobStore, targets: Dict[str, float]) -> dict:
    clean = {k: float(v) for k, v in targets.items() if v is not None}
    store.write(TARGETS, json.dumps(clean, indent=2).encode())
    _cache.pop("checked", None)  # targets are part of the fingerprint: the next request rebuilds the memo
    return clean
