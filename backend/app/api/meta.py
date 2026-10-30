from fastapi import APIRouter, Depends

from app.api.deps import current_model
from app.schemas.common import ApiResponse
from app.schemas.meta import FilterOptions
from app.services import meta_service
from app.services.model import Model

router = APIRouter(prefix="/meta", tags=["Meta"])


@router.get("/filters", response_model=ApiResponse[FilterOptions],
            summary="Dropdown options and period context (current / previous quarter)")
def filters(m: Model = Depends(current_model)):
    return ApiResponse(data=meta_service.filter_options(m))
