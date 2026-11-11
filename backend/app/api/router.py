from fastapi import APIRouter, Depends

from app.api import (auth, benefits, counter_report, datasets, distributors, geography, health, meta, network, reports,
                     retailers, sales, sync, tiers, uploads)
from app.api.deps import require_access
from app.leads.router import router as leads_router

api_router = APIRouter()
# open: liveness check and sign-in
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(auth.users_router)          # admins only
# everything else needs a signed-in user; changes need the editor or admin role
for module in (meta, network, sales, retailers, distributors, tiers, benefits, reports, geography,
               datasets, uploads, sync, counter_report):
    api_router.include_router(module.router, dependencies=[Depends(require_access)])
# Lead Generation Dashboard: its own module (app/leads), same sign-in and roles
api_router.include_router(leads_router, dependencies=[Depends(require_access)])
