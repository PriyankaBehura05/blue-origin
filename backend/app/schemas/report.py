from datetime import datetime
from typing import List, Optional, Union

from app.schemas.common import CamelSchema


class ReportDefinition(CamelSchema):
    id: str
    name: str
    description: str
    category: str
    last_generated: Optional[datetime] = None
    format: str            # default download format: XLSX | CSV
    uses_period: bool = True  # False: the month / quarter filters do not apply (a master list)


class ReportPreview(CamelSchema):
    report_id: str
    columns: List[str]
    rows: List[List[Union[int, float, str, None]]]
    total_rows: int
    filters: str = ""      # the filters applied, in words ('' = all)
