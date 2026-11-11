"""Google Sheets as an automatic source for the lead dashboard: lead dumps, spend, follow-up logs or targets that are
kept up to date in Google Sheets are read on their own, with no file to download or upload.

    <store>/leads/sheets.json        the links: [{"url": ..., "name": ...}] - edited on the Data quality page
    <store>/leads/sheets/*.csv       the latest copy of every tab, read by the build next to the inbox files
    <store>/leads/sheets_state.json  per link: last check, tabs read, rows, error

A link with a tab (…/edit#gid=123) reads that tab; a link without one reads every tab, and the build keeps the tabs
it recognises (leads, spend, follow-up, targets) and reports the rest as unknown. The tab name helps the build tell
them apart ("Spend", "Follow up", "Targets"), as a file name does.

Access: the service-account key the BO Dashboard already uses for the distributor sheets (BO_GOOGLE_KEY) - share
each sheet with its email as a viewer. Without a key, a sheet shared as "Anyone with the link can view" is read
through its CSV export, its tabs found from its public HTML view.

Safety, as in the distributor download: an unchanged tab is not written again (so nothing is rebuilt for nothing),
and a read with far fewer rows than the copy already there (sharing removed, Google errors) does not replace it.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import posixpath
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Callable, List, Optional, Tuple

from app.storage.base import BlobStore

log = logging.getLogger("blue_origin.leads.sheets")

SOURCES, FOLDER, STATE = "leads/sheets.json", "leads/sheets", "leads/sheets_state.json"
MIN_SHARE_OF_EXISTING = 0.6
EXPORT = "https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}"
HTMLVIEW = "https://docs.google.com/spreadsheets/d/{id}/htmlview"


def sheet_id(url: str) -> str:
    m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else url.strip()


def tab_gid(url: str) -> Optional[int]:
    m = re.search(r"[#?&]gid=(\d+)", url)
    return int(m.group(1)) if m else None


def _safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9 _.-]+", "_", text).strip(" ._")[:80] or "sheet"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(store: BlobStore, path: str, default):
    raw = store.read(path)
    return json.loads(raw) if raw else default


# ------------------------------------------------------------------ links
def get_sources(store: BlobStore) -> List[dict]:
    return _json(store, SOURCES, [])


def save_sources(store: BlobStore, items: List[dict]) -> List[dict]:
    clean, seen = [], set()
    for it in items:
        url = str(it.get("url") or "").strip()
        if not url:
            continue
        if not re.search(r"docs\.google\.com/spreadsheets/d/", url):
            raise ValueError(f"Not a Google Sheets link: {url}")
        key = (sheet_id(url), tab_gid(url))
        if key in seen:
            continue
        seen.add(key)
        clean.append({"url": url, "name": str(it.get("name") or "").strip()})
    store.write(SOURCES, json.dumps(clean, indent=2, ensure_ascii=False).encode("utf-8"))
    # copies of tabs whose link was removed go too, so the build stops using them
    keep = {_prefix(s) for s in clean}
    for f in store.list(FOLDER):
        name = posixpath.basename(f.path)
        if not any(name.startswith(p) for p in keep):
            store.delete(f"{FOLDER}/{name}")
    return clean


def _prefix(src: dict) -> str:
    gid = tab_gid(src["url"])
    return f"{sheet_id(src['url'])[:10]}{'' if gid is None else f'-{gid}'}~"


# ------------------------------------------------------------------ reading Google
class Reader:
    """Reads tabs as rows: through the Sheets API with the service account, else through the public CSV export."""

    def __init__(self, client=None, fetch: Optional[Callable[[str], bytes]] = None):
        self.client = client            # app.services.sheets_download.GoogleSheets, or None
        self.fetch = fetch or _http_get

    def tabs(self, sid: str, gid: Optional[int]) -> Tuple[str, List[Tuple[str, List[List[str]]]]]:
        """(spreadsheet title, [(tab title, rows)])."""
        if self.client is None:
            tabs = self._public_tabs(sid)
            if gid is not None:
                tabs = [t for t in tabs if t[1] == gid] or [(f"tab {gid}", gid)]
            return "", [(title, self._public_rows(sid, g)) for title, g in tabs]
        meta = self.client._get(f"https://sheets.googleapis.com/v4/spreadsheets/{sid}",
                                {"fields": "properties.title,sheets.properties(sheetId,title)"})
        tabs = [s["properties"] for s in meta.get("sheets", [])]
        if gid is not None:
            tabs = [t for t in tabs if t.get("sheetId") == gid]
            if not tabs:
                raise FileNotFoundError(f"the tab gid={gid} is not in this sheet any more")
        return meta.get("properties", {}).get("title", ""), [(t["title"], self.client.values(sid, t["title"])) for t in tabs]


    def _public_tabs(self, sid: str) -> List[Tuple[str, int]]:
        """[(tab title, gid)] of a sheet shared as 'Anyone with the link', from its public HTML view."""
        try:
            html = self.fetch(HTMLVIEW.format(id=sid)).decode("utf-8", "replace")
        except Exception:
            html = ""
        found = [(json.loads(f'"{n}"'), int(g)) for n, g in re.findall(r'items\.push\(\{name: "((?:[^"\\]|\\.)*)",[^}]*?gid: "(\d+)"', html)]
        return found or [("tab 0", 0)]

    def _public_rows(self, sid: str, gid: int) -> List[List[str]]:
        text = self.fetch(EXPORT.format(id=sid, gid=gid)).decode("utf-8-sig")
        if text.lstrip().lower().startswith(("<!doctype", "<html")):
            raise PermissionError("the sheet is not shared as 'Anyone with the link can view'")
        return list(csv.reader(io.StringIO(text)))


def _http_get(url: str) -> bytes:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "BlueOrigin"}), timeout=90) as r:
            return r.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise PermissionError("the sheet is private: share it with the service account (BO_GOOGLE_KEY), "
                                  "or as 'Anyone with the link can view'") from None
        if exc.code == 404:
            raise FileNotFoundError("sheet not found (check the link)") from None
        raise


def make_reader(settings) -> Tuple[Reader, Optional[str]]:
    """(reader, service-account email or None). The BO key is used when it exists; otherwise public links only."""
    try:
        from app.services.sheets_download import GoogleSheets, key_path
        key = key_path(settings)
        if key.exists():
            client = GoogleSheets(key)
            return Reader(client), client.email
    except Exception as exc:  # key unreadable / google-auth missing: public links still work
        log.warning("Google service account not usable for lead sheets: %s", exc)
    return Reader(), None


# ------------------------------------------------------------------ the refresh
def _csv(rows: List[List[str]]) -> bytes:
    rows = [r for r in rows if any(str(v).strip() for v in r)]
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerows(rows)
    return buf.getvalue().encode("utf-8")


def refresh(store: BlobStore, reader: Reader) -> dict:
    """Read every linked tab; write the ones that changed. Returns the state (also saved), with 'changed'."""
    state = {"checked_at": _now(), "sources": [], "changed": 0}
    existing = {posixpath.basename(f.path): f for f in store.list(FOLDER)}
    for src in get_sources(store):
        sid, gid = sheet_id(src["url"]), tab_gid(src["url"])
        entry = {"url": src["url"], "name": src.get("name", ""), "tabs": [], "error": None}
        try:
            title, tabs = reader.tabs(sid, gid)
            entry["title"] = title
            for tab, rows in tabs:
                label = " - ".join(x for x in (src.get("name"), tab) if x)   # not the file title: it may name a platform
                name = f"{_prefix(src)}{_safe(label)}.csv"
                body, n = _csv(rows), max(len([r for r in rows if any(str(v).strip() for v in r)]) - 1, 0)
                old = store.read(f"{FOLDER}/{name}") if name in existing else None
                old_rows = max(old.count(b"\n") - 1, 0) if old else 0
                tab_info = {"tab": tab, "file": name, "rows": n, "updated": False, "note": None}
                if old is not None and hashlib.sha1(old).digest() == hashlib.sha1(body).digest():
                    pass
                elif old is not None and old_rows >= 20 and n < old_rows * MIN_SHARE_OF_EXISTING:
                    tab_info["note"] = f"kept the earlier copy: this read had {n} rows against {old_rows}"
                else:
                    store.write(f"{FOLDER}/{name}", body)
                    tab_info["updated"] = True
                    state["changed"] += 1
                entry["tabs"].append(tab_info)
        except Exception as exc:  # one bad link never stops the others
            entry["error"] = str(exc) or exc.__class__.__name__
            log.warning("Lead sheet %s: %s", src["url"], entry["error"])
        state["sources"].append(entry)
    store.write(STATE, json.dumps(state, indent=2, ensure_ascii=False).encode("utf-8"))
    return state


def last_state(store: BlobStore) -> dict:
    return _json(store, STATE, {})
