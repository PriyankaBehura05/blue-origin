from typing import List

from fastapi import APIRouter

from app.rules.geography_rules import get_geography_config
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/geography", tags=["Geography"])


@router.get("/states", response_model=ApiResponse[List[str]], summary="Reference list of Indian states/UTs")
def states():
    return ApiResponse(data=get_geography_config()["states"])
