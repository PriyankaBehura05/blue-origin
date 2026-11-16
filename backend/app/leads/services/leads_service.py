"""Lead Generation data in the store: the inbox, the build and its outputs, the actions tracker and the targets.

    <store>/leads/inbox/      lead dumps, spend, follow-up log, targets (CSV / Excel) - dropped here by people
    <store>/leads/sheets/     the same, copied from linked Google Sheets every few minutes (sheets_source.py)
    <store>/leads/out/        dashboard.json.gz, campaign_facts.json.gz, reconciliation.xlsx, memo.md, build.json
    <store>/ads/budget/, ads/attribution/   ad spend, campaigns and daily delivery (app/ads), only ever read here
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

PIPELINE_VERSION = "11"  # 11: daily impressions, clicks and leads per campaign; 10: daily spend; 9: lead -> campaign attribution
INBOX, OUT, NETWORK = "leads/inbox", "leads/out", "network"
AD_FOLDERS = ("ads/budget", "ads/attribution")   # saved by app/ads: a new fetch rebuilds the lead data
PLATFORM_FILES = {"Meta": "meta.json.gz", "Google": "google.json.gz"}
ACTIONS, TARGETS = "leads/actions.json", "leads/targets.json"
REVIEWS = "leads/match_reviews.json"     # approve / reject decisions on ambiguous lead -> retailer matches
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
    ads = sorted((f.path, f.version or str(f.size)) for folder in AD_FOLDERS for f in store.list(folder))
    reviews = store.read(REVIEWS) or b""
    raw = json.dumps([PIPELINE_VERSION, inbox, sales, hashlib.sha1(targets).hexdigest(), ads, hashlib.sha1(reviews).hexdigest()])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _build(store: BlobStore, fp: str) -> None:
    inbox = {_display(f.path): store.read(f.path) or b"" for f in _input_files(store)}
    sales = {n: store.read(f"{NETWORK}/{n}") for n in SALES_FILES}
    if sales.get("retailers.csv") is None or sales.get("retailer_month.csv") is None:
        raise DataNotAvailableError("The BO Dashboard data (network/retailers.csv, retailer_month.csv) is not built yet.")
    started = time.time()
    res = run(inbox, sales, target_overrides=_json(store, TARGETS, {}), ads=_ad_data(store),
              reviews=_json(store, REVIEWS, []))
    body = gzip.compress(json.dumps(res.payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    store.write(f"{OUT}/dashboard.json.gz", body)
    store.write(f"{OUT}/reconciliation.xlsx", res.reconciliation)
    store.write(f"{OUT}/campaign_facts.json.gz", gzip.compress(json.dumps(res.facts or {}, separators=(",", ":")).encode("utf-8")))
    store.write(f"{OUT}/memo.md", res.memo.encode("utf-8"))
    store.write(f"{OUT}/build.json", json.dumps({
        "fingerprint": fp, "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seconds": round(time.time() - started, 1), "inbox": sorted(inbox), "lead_rows": len(res.payload["leads"]["day"]),
    }, indent=2).encode())


def _ad_data(store: BlobStore) -> dict:
    """The saved ad data (budget screen + daily delivery) per platform, None where nothing is saved yet."""
    def one(folder: str, name: str):
        try:
            raw = store.read(f"{folder}/{name}")
            return json.loads(gzip.decompress(raw)) if raw else None
        except Exception as exc:   # a file being replaced right now: the next build reads it
            log.warning("Lead build: could not read %s/%s: %s", folder, name, exc)
            return None
    return {"budget": {p: one("ads/budget", n) for p, n in PLATFORM_FILES.items()},
            "delivery": {p: one("ads/attribution", n) for p, n in PLATFORM_FILES.items()}}


def campaign_performance(store: BlobStore, start: Optional[str], end: Optional[str], level: str, window: int) -> dict:
    """KPIs of the months start..end ('YYYY-MM'; default = the whole span) from the last build's campaign facts."""
    from .spend_service import performance
    fp, _ = ensure_built(store, wait=False)
    if _cache.get("facts_fp") != fp:
        raw = store.read(f"{OUT}/campaign_facts.json.gz")
        _cache.update(facts=json.loads(gzip.decompress(raw)) if raw else {}, facts_fp=fp)
    facts = _cache["facts"]
    if not facts:
        raise DataNotAvailableError("No campaign data yet: the lead data has to be built with lead rows first.")
    months = sorted({m for _, m, _, _ in facts["spend"]} | {r[1] for rows in facts["leads"].values() for r in rows})
    to_m = lambda ym: int(ym[:4]) * 12 + int(ym[5:7]) - 1  # noqa: E731
    s = to_m(start) if start else months[0]
    e = to_m(end) if end else months[-1]
    return performance(facts, min(s, e), max(s, e), level, window)


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


def get_reviews(store: BlobStore) -> List[dict]:
    return _json(store, REVIEWS, [])


def save_review(store: BlobStore, mobile: str, retailer_id: str, decision: str, user: Optional[str]) -> List[dict]:
    """Record one decision ('approve' / 'reject'; 'clear' removes it). The next build applies it."""
    items = [d for d in get_reviews(store) if not (d.get("mobile") == mobile and d.get("retailer_id") == retailer_id)]
    if decision != "clear":
        items.append({"mobile": mobile, "retailer_id": retailer_id, "decision": decision, "by": user,
                      "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    store.write(REVIEWS, json.dumps(items, indent=1).encode("utf-8"))
    _cache.pop("checked", None)
    return items


def get_targets(store: BlobStore) -> dict:
    return _json(store, TARGETS, {})


def save_targets(store: BlobStore, targets: Dict[str, float]) -> dict:
    clean = {k: float(v) for k, v in targets.items() if v is not None}
    store.write(TARGETS, json.dumps(clean, indent=2).encode())
    _cache.pop("checked", None)  # targets are part of the fingerprint: the next request rebuilds the memo
    return clean
