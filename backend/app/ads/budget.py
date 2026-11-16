"""Budget screen: account details, campaigns, statuses, daily / lifetime budgets, spend (today, this month, by month and
by financial quarter), budget utilisation and remaining budget, for Meta and Google.

The dashboard only ever reads the last saved result (ads/budget/<platform>.json.gz): opening the page calls nobody.
A refresh (admin button or POST /api/ads/budget/refresh) fetches from the platform in the background and saves it.
Numbers come from the platforms; what is calculated here is labelled as such in the payload (`*_basis`).

Only campaigns whose name contains ADS_CAMPAIGN_FILTER ("YASHA": the GT team's campaigns) are kept, so every number built on
this - the whole Lead Generation dashboard - is GT only. Each account also carries `gt` (gt.py): monthly spend, impressions,
reach, clicks and leads per campaign, and the combined reach.
"""
from __future__ import annotations

import gzip
import json
import logging
import threading
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.core.config import Settings
from app.core.errors import AppError
from app.storage.base import BlobStore

from . import common as C, gt as GT, service as svc

FOLDER = "ads/budget"
RECENT_DAYS = 62                       # daily detail kept for "today / this month / last 7 days"
log = logging.getLogger("blue_origin.ads")
_lock = threading.Lock()
_auto: Dict[str, Any] = {}
_running: Dict[str, bool] = {}
_errors: Dict[str, str] = {}
_latest: Dict[str, dict] = {}        # last good snapshot per platform, served if the file is busy being replaced

# platform status -> one of four groups the dashboard filters by
_ACTIVE = {"ACTIVE", "ENABLED", "WITH_ISSUES", "IN_PROCESS"}
_ENDED = {"ARCHIVED", "REMOVED", "DELETED", "ENDED"}


def status_group(status: Optional[str]) -> str:
    s = (status or "").upper()
    if s in _ACTIVE:
        return "active"
    if s in _ENDED:
        return "ended"
    if "PAUSED" in s:
        return "paused"
    return "other"


def _today(tz: Optional[str]) -> date:
    """Today in the ad account's own timezone (the server may run in another one)."""
    try:
        return datetime.now(ZoneInfo(tz)).date() if tz else date.today()
    except Exception:  # no tz database on this host
        return datetime.now(timezone(timedelta(hours=5, minutes=30)) if tz == "Asia/Kolkata" else timezone.utc).date()


def _pos(v: Any) -> Optional[float]:
    n = C.num(v)
    return n if n and n > 0 else None


# ------------------------------------------------------------------ the shared calculation
def assemble(account: dict, campaigns: List[dict], monthly: List[tuple], recent: List[tuple], today: date) -> dict:
    """campaigns: rows with budgets already resolved; monthly: (campaign_id, 'YYYY-MM', spend); recent: (campaign_id, date, spend)."""
    month_first = today.replace(day=1)
    days_elapsed = today.day
    by_c_month: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for cid, ym, sp in monthly:
        by_c_month[cid][ym] += sp
    spend: Dict[str, Dict[str, float]] = defaultdict(lambda: {"today": 0.0, "mtd": 0.0, "last_7d": 0.0})
    for cid, d, sp in recent:
        d = date.fromisoformat(d) if isinstance(d, str) else d
        if d == today:
            spend[cid]["today"] += sp
        if d >= month_first:
            spend[cid]["mtd"] += sp
        if d > today - timedelta(days=7):
            spend[cid]["last_7d"] += sp
    this_q = C.fy_quarter(today)[0]
    last_m = (month_first - timedelta(days=1)).strftime("%Y-%m")
    rows, cq = [], defaultdict(lambda: defaultdict(float))
    for c in campaigns:
        cid = c["campaign_id"]
        sp = spend[cid]
        for ym, v in by_c_month.get(cid, {}).items():
            cq[cid][C.fy_quarter(date.fromisoformat(ym + "-01"))[0]] += v
        life = sum(by_c_month.get(cid, {}).values())
        db, lb, rem = c.get("daily_budget"), c.get("lifetime_budget"), c.get("remaining_budget")
        # only when the campaign runs on daily budgets alone: lifetime-budget ad sets also add to its spend
        util = round(100 * sp["mtd"] / (db * days_elapsed), 1) if db and not lb else None
        life_util = round(100 * (lb - rem) / lb, 1) if lb and rem is not None and rem <= lb else None
        rows.append({**c, "status_group": status_group(c.get("status")),
                     "spend_today": round(sp["today"], 2), "spend_mtd": round(sp["mtd"], 2), "spend_last_7d": round(sp["last_7d"], 2),
                     "spend_last_month": round(by_c_month.get(cid, {}).get(last_m, 0.0), 2), "spend_this_quarter": round(cq[cid].get(this_q, 0.0), 2),
                     "spend_lifetime": round(life, 2), "utilization_pct": util, "lifetime_utilization_pct": life_util,
                     "utilization_basis": f"spend so far this month ÷ (daily budget × {days_elapsed} days)" if util is not None else None})
    months: Dict[str, float] = defaultdict(float)
    quarters: Dict[str, float] = defaultdict(float)
    for _, ym, sp in monthly:   # all spend, including campaigns that no longer exist
        months[ym] += sp
        quarters[C.fy_quarter(date.fromisoformat(ym + "-01"))[0]] += sp
    qorder = {}
    for ym in sorted(months):
        qorder.setdefault(C.fy_quarter(date.fromisoformat(ym + "-01"))[0], ym)
    return {"account": account, "campaigns": rows,
            "monthly": [{"period": k, "spend": round(v, 2)} for k, v in sorted(months.items())],
            "quarterly": [{"period": q, "spend": round(quarters[q], 2), "first_month": qorder[q]} for q in qorder],
            "campaign_monthly": [{"campaign_id": cid, "period": ym, "spend": round(v, 2)} for cid, m in by_c_month.items() for ym, v in sorted(m.items())],
            "campaign_quarterly": [{"campaign_id": cid, "period": q, "spend": round(v, 2)} for cid, m in cq.items() for q, v in m.items()],
            "today": today.isoformat(), "days_elapsed": days_elapsed}


# ------------------------------------------------------------------ Meta
def _meta_account(settings: Settings, a: dict) -> dict:
    m = svc.client("meta", settings)
    acct = a["account_id"]
    keep = lambda name: C.keep_campaign(name, settings)  # noqa: E731
    camps = [c for c in m.campaigns(acct) if keep(c["name"])]
    ids = {c["campaign_id"] for c in camps}
    sets = [s for s in m.adsets(acct, sorted(ids)) if s["campaign_id"] in ids]
    today = _today(a.get("timezone"))
    start = m.history_start(a, camps)
    monthly = [(r["campaign_id"], r["date_start"][:7], r["spend"]) for r in m.spend_series(acct, start, today, "monthly") if keep(r["campaign_name"])]
    recent = [(r["campaign_id"], r["date_start"], r["spend"]) for r in m.spend_series(acct, max(start, today - timedelta(days=RECENT_DAYS)), today, 1) if keep(r["campaign_name"])]
    sets_by: Dict[str, List[dict]] = defaultdict(list)
    for s in sets:
        sets_by[s["campaign_id"]].append(s)
    rows = []
    for c in camps:
        live = [s for s in sets_by.get(c["campaign_id"], []) if (s["raw"].get("configured_status") or s["status"]) == "ACTIVE"]
        cd, cl = _pos(c["daily_budget"]), _pos(c["lifetime_budget"])
        sd = [s for s in live if _pos(s["daily_budget"])]
        sl = [s for s in live if _pos(s["lifetime_budget"])]
        daily = cd or (sum(s["daily_budget"] for s in sd) or None)
        life = cl or (sum(s["lifetime_budget"] for s in sl) or None)
        if cl:
            rem, basis = c.get("budget_remaining"), "lifetime budget left"
        elif sl:
            rem, basis = round(sum(s["budget_remaining"] or 0 for s in sl), 2), "lifetime budget left"
        elif cd:
            rem, basis = c.get("budget_remaining"), "left of today's daily budget"
        elif sd:
            rem, basis = round(sum(s["budget_remaining"] or 0 for s in sd), 2), "left of today's daily budget"
        else:
            rem, basis = None, None
        rows.append({"campaign_id": c["campaign_id"], "name": C.display_name(c["name"], settings), "status": c["status"], "objective": c["objective"],
                     "daily_budget": daily, "daily_budget_source": "campaign" if cd else ("ad sets" if daily else None),
                     "lifetime_budget": life, "lifetime_budget_source": "campaign" if cl else ("ad sets" if life else None),
                     "remaining_budget": rem, "remaining_basis": basis, "adsets": len(sets_by.get(c["campaign_id"], [])),
                     "live_adsets": len(live), "start": c["start_time"], "end": c["end_time"], "shared_budget": False})
    out = assemble({k: a.get(k) for k in ("account_id", "name", "currency", "timezone", "status", "created_time", "business_name")}, rows, monthly, recent, today)
    out["gt"] = GT.meta(m, acct, start, today, settings)
    return out


# ------------------------------------------------------------------ Google
def _google_account(settings: Settings, a: dict) -> dict:
    g = svc.client("google", settings)
    camps = [c for c in g.campaigns(a) if C.keep_campaign(c["name"], settings)]
    today = _today(a.get("timezone"))
    starts = [c["start_date"] for c in camps if c.get("start_date")]
    start = date.fromisoformat(min(starts)) if starts else today - timedelta(days=730)
    daily = [r for r in g.performance(a, start, today, "daily") if C.keep_campaign(r.get("campaign_name"), settings)]
    monthly_d: Dict[tuple, float] = defaultdict(float)
    for r in daily:
        monthly_d[(r["campaign_id"], r["date_start"][:7])] += r["spend"] or 0.0
    monthly = [(cid, ym, v) for (cid, ym), v in monthly_d.items()]
    recent = [(r["campaign_id"], r["date_start"], r["spend"] or 0.0) for r in daily if date.fromisoformat(r["date_start"]) >= today - timedelta(days=RECENT_DAYS)]
    life_spend = {c["campaign_id"]: c["lifetime_spend"] or 0.0 for c in camps}
    rows = []
    for c in camps:
        db, lb = _pos(c["daily_budget"]), _pos(c["lifetime_budget"])
        if lb:
            rem, basis = round(lb - life_spend[c["campaign_id"]], 2), "total budget minus spend"
        elif db:
            today_spend = sum(sp for cid, d, sp in recent if cid == c["campaign_id"] and d == today.isoformat())
            rem, basis = round(max(db - today_spend, 0.0), 2), "daily budget minus today's spend (reporting can lag a few hours)"
        else:
            rem, basis = None, None
        # Google keeps a campaign ENABLED after its end date; its serving status says ENDED
        status = "ENDED" if (c.get("serving_status") or "").upper() == "ENDED" else c["status"]
        rows.append({"campaign_id": c["campaign_id"], "name": C.display_name(c["name"], settings), "status": status, "objective": c.get("campaign_type"),
                     "daily_budget": db, "daily_budget_source": "campaign" if db else None, "lifetime_budget": lb,
                     "lifetime_budget_source": "campaign" if lb else None, "remaining_budget": rem, "remaining_basis": basis,
                     "adsets": None, "live_adsets": None, "start": c.get("start_date"), "end": c.get("end_date"),
                     "shared_budget": bool((c["raw"].get("campaignBudget") or {}).get("explicitlyShared"))})
    out = assemble({k: a.get(k) for k in ("account_id", "name", "currency", "timezone", "status", "is_manager", "login_customer_id")}, rows, monthly, recent, today)
    out["gt"] = GT.google(daily, google_leads(g, a, start, today, settings), settings)
    return out


def google_leads(g, account: dict, start: date, end: date, settings: Settings):
    """Conversions of the lead conversion action per (campaign, day), or None when the connector cannot break them down."""
    fn = getattr(g, "lead_conversions", None)
    if fn is None:
        return None
    try:
        return fn(account, start, end, settings.GOOGLE_ADS_LEAD_CONVERSION)
    except AppError as exc:
        log.warning("Google Ads lead conversions: %s", exc.message)
        return None


def _google_sample(settings: Settings) -> dict:
    """The budget screen for GOOGLE_ADS_MODE=sample, assembled in memory from the made-up campaigns (google_sample.py)."""
    from . import google_sample as G
    g = svc.client("google", settings)
    a = g.accounts()[0]
    today = _today(a.get("timezone"))
    series = G.daily(today - timedelta(days=400), today)
    spent_today = defaultdict(float)
    monthly_d: Dict[tuple, float] = defaultdict(float)
    for r in series:
        monthly_d[(r["campaign_id"], r["date"][:7])] += r["spend"]
        if r["date"] == today.isoformat():
            spent_today[r["campaign_id"]] += r["spend"]
    rows = []
    for c in g.campaigns(a):
        rows.append({"campaign_id": c["campaign_id"], "name": C.display_name(c["name"], settings), "status": c["status"], "objective": c["objective"],
                     "daily_budget": c["daily_budget"], "daily_budget_source": "campaign" if c["daily_budget"] else None,
                     "lifetime_budget": c["lifetime_budget"], "lifetime_budget_source": "campaign" if c["lifetime_budget"] else None,
                     "remaining_budget": c["budget_remaining"],
                     "remaining_basis": "lifetime budget left" if c["lifetime_budget"] else ("left of today's daily budget" if c["budget_remaining"] is not None else None),
                     "adsets": None, "live_adsets": None, "start": c["start_time"], "end": c["end_time"], "shared_budget": False})
    recent = [(r["campaign_id"], r["date"], r["spend"]) for r in series if r["date"] >= (today - timedelta(days=RECENT_DAYS)).isoformat()]
    acc = assemble({k: a.get(k) for k in ("account_id", "name", "currency", "timezone", "status", "created_time", "business_name")},
                   rows, [(cid, ym, v) for (cid, ym), v in monthly_d.items()], recent, today)
    return {"platform": "google", "fetched_at": G.stamp(), "sample": True, "note": G.NOTE, "accounts": [acc], "unreachable": []}


def build(platform: str, settings: Settings) -> dict:
    if not svc.is_real(platform, settings):
        raise C.AdsNotConfigured(f"Google Ads is in '{svc.google_mode(settings)}' mode (GOOGLE_ADS_MODE), so there is nothing to fetch or save.")
    accts, _ = svc.accounts(platform, settings, refresh=True)
    ok = [a for a in accts if a.get("accessible") and not a.get("is_manager")]
    per = _meta_account if platform == "meta" else _google_account
    return {"platform": platform, "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "accounts": [per(settings, a) for a in ok],
            "unreachable": [{"account_id": a.get("account_id"), "error": a.get("error")} for a in accts if not a.get("accessible")]}


# ------------------------------------------------------------------ saved snapshot + background refresh
def _path(platform: str) -> str:
    return f"{FOLDER}/{platform}.json.gz"


def _refresh(platform: str, settings: Settings, store: BlobStore) -> None:
    try:
        with C.patient():
            snap = build(platform, settings)
        store.write(_path(platform), gzip.compress(json.dumps(snap, default=str).encode("utf-8")))
        _latest[platform] = snap
        _errors.pop(platform, None)
        # daily delivery for the lead -> campaign link; a failure here never spoils the budget screen
        from . import delivery
        try:
            delivery.refresh(platform, settings, store)
        except Exception as exc:
            log.warning("Campaign delivery for lead attribution (%s): %s", platform, C.redact(exc))
        try:   # ad sets, ads, keywords ... for the Campaign performance page
            from . import detail
            detail.refresh(platform, settings, store)
        except Exception as exc:
            log.warning("Campaign detail (%s): %s", platform, C.redact(exc))
    except AppError as exc:
        _errors[platform] = exc.message
    except Exception as exc:  # never leave the page spinning
        _errors[platform] = f"Unexpected error while fetching {platform}: {C.redact(exc)}"
    finally:
        with _lock:
            _running[platform] = False


def start_refresh(settings: Settings, store: BlobStore, platforms: List[str]) -> List[str]:
    started = []
    for p in platforms:
        svc.client(p, settings)
        if not svc.is_real(p, settings):   # off / sample: nothing to fetch, and sample data is never saved
            continue
        with _lock:
            if _running.get(p):
                continue
            _running[p] = True
        _errors.pop(p, None)
        threading.Thread(target=_refresh, args=(p, settings, store), daemon=True, name=f"budget-{p}").start()
        started.append(p)
    return started


def read(settings: Settings, store: BlobStore) -> dict:
    """What the page shows: per platform, the saved snapshot (or None), whether it is configured, a refresh in progress or the last error."""
    out: Dict[str, Any] = {}
    for p in svc.PLATFORMS:
        c = svc.client(p, settings)
        mode = svc.mode_of(p, settings)
        if mode not in svc.REAL_MODES:   # never reads or writes the store: off = Not Connected, sample = made up in memory right now
            out[p] = {"configured": mode == "sample", "missing": [], "refreshing": False, "error": None, "mode": mode,
                      "snapshot": _google_sample(settings) if mode == "sample" else None, "auto_minutes": 0}
            continue
        try:
            raw = store.read(_path(p))
            snap = json.loads(gzip.decompress(raw)) if raw else _latest.get(p)
        except (AppError, OSError):   # the file is being replaced by a refresh right now (Windows may report it as busy)
            snap = _latest.get(p)
        out[p] = {"configured": c.configured(), "missing": c.missing(), "refreshing": bool(_running.get(p)), "error": _errors.get(p), "snapshot": snap, "mode": mode,
                  "auto_minutes": int(getattr(settings, "ADS_REFRESH_MINUTES", 0) or 0)}
    return out


# ------------------------------------------------------------------ automatic refresh
def _age_seconds(store: BlobStore, platform: str) -> Optional[float]:
    """How old the saved snapshot is, or None when there is none."""
    try:
        raw = store.read(_path(platform))
        snap = json.loads(gzip.decompress(raw)) if raw else _latest.get(platform)
    except (AppError, OSError):
        snap = _latest.get(platform)
    if not snap:
        return None
    try:
        return (datetime.now() - datetime.fromisoformat(snap["fetched_at"])).total_seconds()
    except (KeyError, ValueError):
        return None


def run_due(settings: Settings, store: BlobStore, minutes: int) -> List[str]:
    """Fetch every connected platform whose saved snapshot is missing or at least `minutes` old, one after the other, in the
    calling thread. A platform that is not connected is skipped without an error. Returns the platforms refreshed."""
    done: List[str] = []
    for p in svc.PLATFORMS:
        if not svc.is_real(p, settings) or not svc.client(p, settings).configured():
            continue
        age = _age_seconds(store, p)
        if age is not None and age < minutes * 60 - 60:
            continue
        with _lock:
            if _running.get(p):
                continue
            _running[p] = True
        _errors.pop(p, None)
        _refresh(p, settings, store)          # clears the running flag itself
        done.append(p)
    return done


def start_auto(repo_factory, settings: Settings) -> None:
    """Background loop: every few minutes look at the saved budget snapshots and re-fetch the ones older than
    ADS_REFRESH_MINUTES (default 30). Looking is cheap (it reads a file); fetching is not, and only happens when due, so a
    restart does not trigger a fetch of data that is already fresh. 0 = off."""
    minutes = int(getattr(settings, "ADS_REFRESH_MINUTES", 0) or 0)
    _auto["minutes"] = minutes
    if minutes <= 0 or _auto.get("thread"):
        return
    stop = threading.Event()
    tick = min(minutes * 60, 300)

    def loop():
        first = True
        while not stop.wait(60 if first else tick):   # the first look is a minute after start-up, so start-up is not slowed
            first = False
            try:
                done = run_due(settings, repo_factory().store, minutes)
                if done:
                    log.info("Ad budget refreshed automatically: %s", ", ".join(done))
            except Exception as exc:  # tried again at the next look
                log.warning("Ad budget automatic refresh: %s", C.redact(exc))

    _auto.update(stop=stop, thread=threading.Thread(target=loop, name="ads-budget", daemon=True))
    _auto["thread"].start()  # type: ignore[union-attr]


def stop_auto() -> None:
    if _auto.get("stop"):
        _auto["stop"].set()  # type: ignore[union-attr]
    _auto.pop("thread", None)
