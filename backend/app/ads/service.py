"""Orchestration for the ad connectors: which platform, which accounts, caching and the raw snapshot.

Nothing here runs by itself: every call is an explicit request (an admin hitting an endpoint). Results are cached in
memory for ADS_CACHE_MINUTES; refresh=True always asks the platform again.
"""
from __future__ import annotations

import gzip
import json
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from app.core.config import Settings
from app.core.errors import AppError, NotFoundError
from app.storage.base import BlobStore

from . import common as C
from .google_ads import GoogleAds
from .google_sample import GoogleAdsOff, GoogleAdsSample
from .google_sheet import GoogleAdsSheet
from .meta_ads import MetaAds

PLATFORMS = ("meta", "google")
GRANULARITIES = ("daily", "monthly", "quarterly", "custom", "lifetime")
FOLDER = "ads"

_clients: Dict[str, Any] = {}


def google_mode(settings: Settings) -> str:
    """GOOGLE_ADS_MODE: off | sample | sheet | live. Anything else counts as off, so a typo never shows made-up or half-set data."""
    m = str(getattr(settings, "GOOGLE_ADS_MODE", "off") or "off").strip().lower()
    return m if m in ("off", "sample", "sheet", "live") else "off"


def mode_of(platform: str, settings: Settings) -> str:
    return google_mode(settings) if platform == "google" else "live"


# modes with real figures, which are fetched, saved and counted; off has nothing and sample is made up
REAL_MODES = ("live", "sheet")


def is_real(platform: str, settings: Settings) -> bool:
    return mode_of(platform, settings) in REAL_MODES


def client(platform: str, settings: Settings):
    if platform not in PLATFORMS:
        raise NotFoundError(f"Unknown platform '{platform}'. Use one of: {', '.join(PLATFORMS)}.")
    mode = mode_of(platform, settings)
    # one object per platform, so Google's access token is reused between calls
    if platform not in _clients or _clients[platform].s is not settings or getattr(_clients[platform], "mode", "live") != mode:
        if platform == "meta":
            _clients[platform] = MetaAds(settings)
        else:
            _clients[platform] = {"live": GoogleAds, "sheet": GoogleAdsSheet, "sample": GoogleAdsSample}.get(mode, GoogleAdsOff)(settings)
    return _clients[platform]


def status(settings: Settings) -> dict:
    """What is configured. No network call, no secret values: only which variables are present."""
    meta, google = client("meta", settings), client("google", settings)
    return {
        "meta": {"configured": meta.configured(), "missing": meta.missing(), "api_version": meta.version,
                 "accounts_pinned": len(meta.account_ids()) or None},
        "google": {"mode": google_mode(settings), "configured": google.configured(), "missing": google.missing(), "api_version": google.version,
                   "accounts_pinned": len(google.customer_ids()) or None,
                   "login_customer_id_set": bool(settings.GOOGLE_ADS_LOGIN_CUSTOMER_ID.strip())},
        "cache_minutes": settings.ADS_CACHE_MINUTES,
        "note": "Nothing is fetched automatically. Use the /api/ads/{platform}/... endpoints or POST /api/ads/snapshot.",
    }


def _cached(settings: Settings, key: tuple, fn, refresh: bool):
    value, age = C.cache.get_or_set(key, settings.ADS_CACHE_MINUTES, fn, refresh)
    return value, age


def accounts(platform: str, settings: Settings, refresh: bool = False):
    c = client(platform, settings)
    return _cached(settings, (platform, "accounts"), c.accounts, refresh)


def _pick(platform: str, settings: Settings, account_id: Optional[str], refresh: bool) -> List[dict]:
    accts, _ = accounts(platform, settings, refresh)
    ok = [a for a in accts if a.get("accessible") and not a.get("is_manager")]
    if account_id:
        norm = account_id.replace("act_", "").replace("-", "")
        ok = [a for a in ok if a["account_id"].replace("act_", "") == norm]
        if not ok:
            raise NotFoundError(f"No accessible {platform} account '{account_id}'. See /api/ads/{platform}/accounts.")
    return ok


def campaigns(platform: str, settings: Settings, account_id: Optional[str] = None, refresh: bool = False):
    c = client(platform, settings)
    out, age = [], None
    for a in _pick(platform, settings, account_id, refresh):
        fn = (lambda a=a: c.campaigns(a["account_id"])) if platform == "meta" else (lambda a=a: c.campaigns(a))
        rows, age = _cached(settings, (platform, "campaigns", a["account_id"]), fn, refresh)
        out += [r for r in rows if C.keep_campaign(r.get("name"), settings)]
    return out, age


def adsets(settings: Settings, account_id: Optional[str] = None, refresh: bool = False):
    c = client("meta", settings)
    out, age = [], None
    for a in _pick("meta", settings, account_id, refresh):
        rows, age = _cached(settings, ("meta", "adsets", a["account_id"]), lambda a=a: c.adsets(a["account_id"]), refresh)
        out += rows
    kept = {r["campaign_id"] for r in campaigns("meta", settings, account_id, refresh)[0]}
    return [r for r in out if r.get("campaign_id") in kept], age


def history_range(platform: str, settings: Settings, account: dict, refresh: bool = False) -> date:
    """Earliest date to fetch from when the caller gives none."""
    c = client(platform, settings)
    if platform == "meta":
        camps, _ = _cached(settings, (platform, "campaigns", account["account_id"]), lambda: c.campaigns(account["account_id"]), refresh)
        return c.history_start(account, camps)
    camps, _ = _cached(settings, (platform, "campaigns", account["account_id"]), lambda: c.campaigns(account), refresh)
    starts = [x.get("start_date") or (x.get("start_time") or "")[:10] for x in camps if x.get("start_date") or x.get("start_time")]
    return date.fromisoformat(min(starts)) if starts else date.today() - timedelta(days=730)


def performance(platform: str, settings: Settings, granularity: str = "daily", start: Optional[date] = None, end: Optional[date] = None,
                account_id: Optional[str] = None, refresh: bool = False):
    if granularity not in GRANULARITIES:
        raise AppError(f"granularity must be one of: {', '.join(GRANULARITIES)}.", code="INVALID_GRANULARITY")
    end = min(end or date.today(), date.today())
    c = client(platform, settings)
    out, age = [], None
    for a in _pick(platform, settings, account_id, refresh):
        s = start or history_range(platform, settings, a, refresh)
        if s > end:
            raise AppError("start must not be after end.", code="INVALID_DATE")
        key = (platform, "perf", a["account_id"], granularity, str(s), str(end))
        if platform == "meta":
            fn = lambda a=a, s=s: c.performance(a["account_id"], s, end, granularity)
        else:
            fn = lambda a=a, s=s: c.performance(a, s, end, granularity)
        rows, age = _cached(settings, key, fn, refresh)
        out += [r for r in rows if C.keep_campaign(r.get("campaign_name"), settings)]
    return out, age


# ------------------------------------------------------------------ raw snapshot
def _snapshot_one(p: str, settings: Settings, store: BlobStore, start: Optional[date], end: Optional[date], stamp: str, taken_at: str) -> dict:
    accts, _ = accounts(p, settings, refresh=True)
    camps, _ = campaigns(p, settings, refresh=True)
    sets = adsets(settings, refresh=True)[0] if p == "meta" else []
    daily, _ = performance(p, settings, "daily", start, end, refresh=True)
    life, _ = performance(p, settings, "lifetime", refresh=True)
    dates = sorted(r["date_start"] for r in daily if r.get("date_start"))
    body = {"platform": p, "taken_at": taken_at, "accounts": accts, "campaigns": camps, "adsets": sets,
            "daily_performance": daily, "lifetime_performance": life}
    path = f"{FOLDER}/{p}/snapshot_{stamp}.json.gz"
    store.write(path, gzip.compress(json.dumps(body, default=str).encode("utf-8")))
    return {"ok": True, "file": path, "accounts": len([a for a in accts if a.get("accessible")]), "campaigns": len(camps), "adsets": len(sets),
            "daily_rows": len(daily), "first_date": dates[0] if dates else None, "last_date": dates[-1] if dates else None}


def snapshot(settings: Settings, store: BlobStore, platforms: List[str], start: Optional[date], end: Optional[date]) -> dict:
    """Fetch everything the platform exposes for the whole available history and keep the untouched API responses in the
    data store (ads/<platform>/snapshot_<time>.json.gz). A platform that fails does not stop the other. A long job:
    it waits out rate limits for up to 10 minutes per request instead of giving up."""
    now = datetime.now()
    summary: Dict[str, Any] = {"taken_at": now.isoformat(timespec="seconds"), "platforms": {}}
    for p in platforms:
        if not is_real(p, settings):   # off: nothing to fetch; sample: made-up data is never written to the store
            summary["platforms"][p] = {"ok": False, "code": "GOOGLE_ADS_MODE", "error": f"Google Ads is in '{google_mode(settings)}' mode: nothing is saved."}
            continue
        try:
            with C.patient():
                summary["platforms"][p] = _snapshot_one(p, settings, store, start, end, now.strftime("%Y%m%d_%H%M%S"), summary["taken_at"])
        except AppError as exc:
            summary["platforms"][p] = {"ok": False, "code": exc.code, "error": exc.message}
    return summary


def snapshots(store: BlobStore) -> List[dict]:
    out = []
    for p in PLATFORMS:
        for f in store.list(f"{FOLDER}/{p}"):
            out.append({"platform": p, "file": f.path, "size_kb": round(getattr(f, "size", 0) / 1024, 1)})
    return sorted(out, key=lambda r: r["file"], reverse=True)
