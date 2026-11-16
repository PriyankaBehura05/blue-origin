"""Ad-platform API: everything under /api/ads (mounted in app/api/router.py behind sign-in).

Every endpoint that talks to Google or Meta needs the admin role and is only ever called on request: nothing here runs on
a schedule or on a page load. `refresh=true` skips the in-memory cache.
"""
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.api.deps import DataRepository, get_repository, require_admin
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.schemas.common import ApiResponse

from . import budget as bud, common as C, service as svc

router = APIRouter(prefix="/ads", tags=["Ad platforms"], dependencies=[Depends(require_admin)])


def _strip_raw(rows: List[dict], raw: bool) -> List[dict]:
    return rows if raw else [{k: v for k, v in r.items() if k != "raw"} for r in rows]


@router.get("/status", response_model=ApiResponse[dict], summary="Which credentials are set (names only). No call to Google or Meta")
def status(settings: Settings = Depends(get_settings)):
    return ApiResponse(data=svc.status(settings))


@router.get("/{platform}/accounts", response_model=ApiResponse[dict], summary="Accounts the credentials can reach")
def accounts(platform: str, refresh: bool = False, raw: bool = True, settings: Settings = Depends(get_settings)):
    rows, age = svc.accounts(platform, settings, refresh)
    return ApiResponse(data={"platform": platform, "mode": svc.mode_of(platform, settings), "count": len(rows), "cached_seconds": age, "items": _strip_raw(rows, raw)})


@router.get("/{platform}/campaigns", response_model=ApiResponse[dict], summary="Every campaign (active, paused, archived) with budgets")
def campaigns(platform: str, account_id: Optional[str] = None, refresh: bool = False, raw: bool = True,
              settings: Settings = Depends(get_settings)):
    rows, age = svc.campaigns(platform, settings, account_id, refresh)
    return ApiResponse(data={"platform": platform, "mode": svc.mode_of(platform, settings), "count": len(rows), "cached_seconds": age, "items": _strip_raw(rows, raw)})


@router.get("/meta/adsets", response_model=ApiResponse[dict], summary="Meta ad sets with their own budgets")
def adsets(account_id: Optional[str] = None, refresh: bool = False, raw: bool = True, settings: Settings = Depends(get_settings)):
    rows, age = svc.adsets(settings, account_id, refresh)
    return ApiResponse(data={"platform": "meta", "count": len(rows), "cached_seconds": age, "items": _strip_raw(rows, raw)})


@router.get("/{platform}/performance", response_model=ApiResponse[dict],
            summary="Spend, reach, clicks and results by day, month, quarter (Apr-Mar financial year), custom range or lifetime")
def performance(platform: str, granularity: str = "daily", start: Optional[str] = Query(None, description="YYYY-MM-DD; default = the oldest available"),
                end: Optional[str] = Query(None, description="YYYY-MM-DD; default = today"), account_id: Optional[str] = None,
                refresh: bool = False, raw: bool = False, page: int = Query(1, ge=1), page_size: int = Query(1000, ge=1, le=5000),
                settings: Settings = Depends(get_settings)):
    rows, age = svc.performance(platform, settings, granularity, C.parse_date(start, "start"), C.parse_date(end, "end"), account_id, refresh)
    total = len(rows)
    rows = _strip_raw(rows[(page - 1) * page_size: page * page_size], raw)
    dates = [r["date_start"] for r in rows if r.get("date_start")]
    return ApiResponse(data={"platform": platform, "mode": svc.mode_of(platform, settings), "granularity": granularity, "total": total, "page": page, "page_size": page_size,
                             "cached_seconds": age, "first_date": min(dates) if dates else None, "last_date": max(dates) if dates else None, "items": rows})


class SnapshotRequest(BaseModel):
    platforms: List[str] = ["meta", "google"]
    start: Optional[date] = None
    end: Optional[date] = None


@router.post("/snapshot", response_model=ApiResponse[dict], summary="Fetch all history now and keep the untouched API responses in the data store")
def snapshot(body: SnapshotRequest, repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    bad = [p for p in body.platforms if p not in svc.PLATFORMS]
    if bad:
        raise AppError(f"Unknown platform: {', '.join(bad)}.", code="INVALID_PLATFORM")
    return ApiResponse(data=svc.snapshot(settings, repo.store, body.platforms, body.start, body.end))


@router.get("/snapshots", response_model=ApiResponse[list], summary="Saved snapshots")
def snapshots(repo: DataRepository = Depends(get_repository)):
    return ApiResponse(data=svc.snapshots(repo.store))


# ---- budget screen: readable by any signed-in user (saved data only, no call to Google or Meta); refreshing is admin only
budget_router = APIRouter(prefix="/ads/budget", tags=["Ad budget"])


@budget_router.get("", response_model=ApiResponse[dict], summary="Budget screen as last saved, per platform. Calls neither Google nor Meta")
def budget(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    return ApiResponse(data=bud.read(settings, repo.store))


@budget_router.get("/detail", response_model=ApiResponse[dict], summary="Ad sets, ads, keywords, devices, geography ... as last saved. Calls neither Google nor Meta")
def ad_detail(repo: DataRepository = Depends(get_repository)):
    from . import detail
    return ApiResponse(data={p: detail.read(repo.store, p) for p in svc.PLATFORMS})


class RefreshRequest(BaseModel):
    platforms: List[str] = ["meta", "google"]


@budget_router.post("/refresh", response_model=ApiResponse[dict], dependencies=[Depends(require_admin)],
                    summary="Fetch the budget screen from the platform(s) in the background, then save it")
def budget_refresh(body: RefreshRequest, repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    bad = [p for p in body.platforms if p not in svc.PLATFORMS]
    if bad:
        raise AppError(f"Unknown platform: {', '.join(bad)}.", code="INVALID_PLATFORM")
    return ApiResponse(data={"started": bud.start_refresh(settings, repo.store, body.platforms)})


# ---- Meta Lead Ads: each lead with the campaign / ad set / ad it came from (admin only, on request)
@router.get("/meta/permissions", response_model=ApiResponse[dict], summary="Which permissions the Meta token has (no lead data is read)")
def meta_permissions(settings: Settings = Depends(get_settings)):
    from .meta_leads import check_permission
    return ApiResponse(data=check_permission(settings))


@router.get("/meta/leads", response_model=ApiResponse[dict], summary="Meta instant-form leads with their campaign, ad set and ad (needs leads_retrieval)")
def meta_leads(start: Optional[str] = Query(None, description="YYYY-MM-DD; default = 30 days before end"),
               end: Optional[str] = Query(None, description="YYYY-MM-DD; default = today"), account_id: Optional[str] = None,
               raw: bool = False, settings: Settings = Depends(get_settings)):
    from datetime import timedelta
    from .meta_leads import MetaLeads
    e = min(C.parse_date(end, "end") or date.today(), date.today())
    s = C.parse_date(start, "start") or e - timedelta(days=30)
    if s > e:
        raise AppError("start must not be after end.", code="INVALID_DATE")
    out = {"accounts": []}
    for a in svc._pick("meta", settings, account_id, False):
        r = MetaLeads(settings).leads(a["account_id"], s, e)
        r["items"] = _strip_raw(r["items"], raw)
        out["accounts"].append(r)
    out["count"] = sum(r["count"] for r in out["accounts"])
    return ApiResponse(data=out)
