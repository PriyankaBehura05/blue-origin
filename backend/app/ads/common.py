"""Shared pieces of the ad-platform connectors: errors, secret redaction, a small cache, a retrying HTTP call and
date helpers. Nothing here knows about Google or Meta specifically."""
from __future__ import annotations

import contextlib
import re
import threading
import time
from datetime import date, timedelta
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import httpx

from app.core.errors import AppError


# ------------------------------------------------------------------ errors
# Upstream (Google / Meta) failures use 502/503/429, never 401/403: the web app treats those as "sign in again".
class AdsNotConfigured(AppError):
    status_code, code = 503, "ADS_NOT_CONFIGURED"


class AdsAuthError(AppError):
    status_code, code = 502, "ADS_AUTH_FAILED"


class AdsPermissionError(AppError):
    status_code, code = 502, "ADS_PERMISSION_DENIED"


class AdsRateLimited(AppError):
    status_code, code = 429, "ADS_RATE_LIMITED"


class AdsApiError(AppError):
    status_code, code = 502, "ADS_API_ERROR"


# ------------------------------------------------------------------ secrets
_BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-~+/=]{8,}")
_QUERY = re.compile(r"(?i)((?:access_token|client_secret|refresh_token|developer[-_]token|appsecret_proof)[=:\"'\s]+)[^&\s\"',}]+")


def redact(text: Any, secrets: Iterable[str] = ()) -> str:
    """Remove every known secret value, bearer tokens and token-looking query parameters from a message."""
    out = str(text)
    for s in secrets:
        if s and len(s) >= 6:
            out = out.replace(s, "***")
    out = _BEARER.sub(r"\1***", out)
    return _QUERY.sub(r"\1***", out)


# ------------------------------------------------------------------ cache
class TTLCache:
    """In-memory, per process. Keys are tuples; a value is kept for `minutes`."""

    def __init__(self) -> None:
        self._d: Dict[Tuple, Tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get_or_set(self, key: Tuple, minutes: float, fn: Callable[[], Any], refresh: bool = False) -> Tuple[Any, Optional[float]]:
        """Returns (value, age in seconds when served from the cache, else None)."""
        now = time.time()
        with self._lock:
            hit = self._d.get(key)
            if hit and not refresh and hit[0] > now:
                return hit[1], round(now - (hit[0] - minutes * 60), 1)
        value = fn()
        with self._lock:
            self._d[key] = (time.time() + minutes * 60, value)
        return value, None

    def clear(self) -> None:
        with self._lock:
            self._d.clear()


cache = TTLCache()

# how long one request may wait out a rate limit (seconds). A snapshot, which is a long job, waits longer.
max_wait = 45.0


@contextlib.contextmanager
def patient(seconds: float = 600.0):
    global max_wait
    old, max_wait = max_wait, seconds
    try:
        yield
    finally:
        max_wait = old


# tests replace this with an httpx.MockTransport; production leaves it None (real network)
transport: Optional[httpx.BaseTransport] = None


# ------------------------------------------------------------------ HTTP
def call(method: str, url: str, *, platform: str, secrets: Iterable[str], headers: Optional[dict] = None,
         params: Optional[dict] = None, data: Optional[dict] = None, json_body: Optional[dict] = None,
         is_rate_limit: Callable[[httpx.Response], bool] = lambda r: False, rate_wait: Callable[[httpx.Response], float] = lambda r: 0.0,
         retries: int = 6, timeout: float = 90.0) -> httpx.Response:
    """One HTTP call with retries for rate limits, 5xx and network errors. Returns the response (status handled by the
    caller); raises AdsRateLimited when the platform keeps refusing. Secrets travel in headers or the body, never the URL."""
    secrets = list(secrets)
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with httpx.Client(timeout=timeout, transport=transport) as c:
                r = c.request(method, url, headers=headers, params=params, data=data, json=json_body)
        except httpx.HTTPError as exc:
            if attempt == retries:
                raise AdsApiError(f"{platform}: could not reach the API ({type(exc).__name__}).", code="ADS_NETWORK")
            time.sleep(delay); delay = min(delay * 2, 30)
            continue
        if r.status_code == 429 or r.status_code >= 500 or is_rate_limit(r):
            if attempt == retries:
                raise AdsRateLimited(f"{platform}: the API is rate-limiting this account. Wait a few minutes and try again.")
            wait = max(delay, rate_wait(r))
            try:
                wait = max(wait, float(r.headers.get("retry-after", 0)))
            except ValueError:
                pass
            if wait > max_wait:
                raise AdsRateLimited(f"{platform}: the API is rate-limiting this account and asks for about {int(wait // 60) + 1} minute(s) of rest. "
                                     "Try again then (a full snapshot waits longer on its own).")
            time.sleep(wait); delay = min(delay * 2, 30)
            continue
        return r
    raise AdsApiError(f"{platform}: no response")  # unreachable


# ------------------------------------------------------------------ dates
def parse_date(v: Optional[str], name: str) -> Optional[date]:
    if not v:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise AppError(f"{name} must be a date like 2026-04-01.", code="INVALID_DATE")


def month_start(d: date) -> date:
    return d.replace(day=1)


def month_end(d: date) -> date:
    n = d.replace(day=28) + timedelta(days=4)
    return n - timedelta(days=n.day)


def fy_quarter(d: date) -> Tuple[str, date, date]:
    """Indian financial year, Apr-Mar: Jul-Sep 2026 = Q2 FY27. Returns (label, first day, last day)."""
    fy = d.year + 1 if d.month >= 4 else d.year
    q = ((d.month - 4) % 12) // 3
    m0 = 4 + 3 * q
    y0 = fy - 1 if m0 <= 12 else fy
    m0 = m0 if m0 <= 12 else m0 - 12
    em = m0 + 2
    ey = y0 + (1 if em > 12 else 0)
    em = em - 12 if em > 12 else em
    return f"Q{q + 1} FY{str(fy)[2:]}", date(y0, m0, 1), month_end(date(ey, em, 1))


def windows(start: date, end: date, granularity: str) -> List[Tuple[str, date, date]]:
    """Split [start, end] into (label, first, last) windows: 'monthly', 'quarterly' or fixed-size 'chunk' pieces."""
    out: List[Tuple[str, date, date]] = []
    cur = start
    while cur <= end:
        if granularity == "monthly":
            label, a, b = cur.strftime("%Y-%m"), month_start(cur), month_end(cur)
        elif granularity == "quarterly":
            label, a, b = fy_quarter(cur)
        else:  # 'chunk': 90-day pieces
            label, a, b = f"{cur}", cur, min(cur + timedelta(days=89), end)
        out.append((label, max(a, start), min(b, end)))
        cur = b + timedelta(days=1)
    return out


def num(v: Any) -> Optional[float]:
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def ratio(a: Optional[float], b: Optional[float], scale: float = 1.0) -> Optional[float]:
    return None if a is None or not b else round(a * scale / b, 6)


# ------------------------------------------------------------------ which campaigns count, and how they are named
# The one rule for the Lead Generation dashboard: only campaigns whose name contains ADS_CAMPAIGN_FILTER (any case) are
# fetched, counted and shown. The filter word is internal: display_name() takes it out of every name the dashboard receives.
def _filter_word(settings) -> str:
    return str(getattr(settings, "ADS_CAMPAIGN_FILTER", "") or "").strip()


def keep_campaign(name: Optional[str], settings) -> bool:
    """True when the campaign name contains ADS_CAMPAIGN_FILTER (any case); everything passes when the filter is empty."""
    f = _filter_word(settings).lower()
    return not f or f in str(name or "").lower()


def display_name(name: Optional[str], settings) -> str:
    """The campaign name without the internal filter word: 'YASHA_Lead Gen Whatsapp' -> 'Lead Gen Whatsapp',
    'GT_LeadGen_PMax_Telangana_YASHA_12Oct26' -> 'GT_LeadGen_PMax_Telangana_12Oct26'."""
    s, f = str(name or ""), _filter_word(settings)
    if not f:
        return s
    out = re.sub(rf"[ _\-|]*{re.escape(f)}[ _\-|]*", "_", s, flags=re.IGNORECASE)
    out = re.sub(r"_{2,}", "_", out).strip("_ -|")
    return out or s
