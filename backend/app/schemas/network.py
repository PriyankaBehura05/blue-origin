"""BO Retailer Network: build status."""
from typing import Any, Dict, List, Optional

from pydantic import Field

from app.schemas.common import CamelSchema


class NetworkStatus(CamelSchema):
    source: Optional[str] = Field(None, description="'pipeline' (built here from the Power BI files), 'notebook' "
                                                    "(BO_SOURCE_FOLDER/dashboard_data.json) or null (no data yet)")
    building: bool
    pipeline_input: Optional[str] = None
    last_build: Optional[Dict[str, Any]] = None
    files: List[Dict[str, Any]] = Field(default_factory=list,
                                        description="Input files and their state against the last build: In dashboard, "
                                                    "Changed, New, Removed")
    pending: bool = Field(False, description="An input file changed since the last build (picked up at the next sync)")
    code: List[Dict[str, Any]] = Field(default_factory=list,
                                       description="BO_Dashboard pipeline code vs the platform's copy: In sync / Changed")
    next_check_at: Optional[str] = Field(None, description="Next automatic sync (rebuilds when an input changed)")
    sheets: Optional[Dict[str, Any]] = Field(None, description="Google Sheets download into the consolidated folder: "
                                                               "set-up, quarters due, last download")
