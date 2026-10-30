from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import Field

from app.schemas.common import BaseSchema


class ValidationIssueOut(BaseSchema):
    row: Optional[int] = Field(None, description="Excel row number (header = 1); null for file-level issues")
    column: Optional[str] = None
    code: str
    severity: str
    status: str
    message: str
    value: Optional[str] = None


class ValidationReportOut(BaseSchema):
    dataset: str
    filename: str
    sheet_name: Optional[str] = None
    total_rows: int
    can_process: bool
    status_counts: Dict[str, int]
    column_mapping: Dict[str, str] = Field(description="original header -> normalised column")
    missing_required_columns: List[str]
    unrecognised_columns: List[str]
    file_errors: List[ValidationIssueOut]
    file_warnings: List[ValidationIssueOut]
    issues: List[ValidationIssueOut]
    issues_total: int
    issues_truncated: bool
    preview: List[Dict[str, Any]]


class UploadRecord(BaseSchema):
    upload_id: str
    original_filename: str
    stored_filename: str
    dataset: str
    sha256: str
    size_bytes: int
    uploaded_at: datetime
    total_rows: int
    can_process: bool
    status_counts: Dict[str, int]
    sheet_name: Optional[str] = None
    processed: bool = False                     # True once activated as the live dataset
    activated_at: Optional[datetime] = None
    activation_mode: Optional[str] = None       # replace | append


class UploadResult(BaseSchema):
    upload: UploadRecord
    report: ValidationReportOut


class ActivationResult(BaseSchema):
    upload: UploadRecord
    dataset: str
    mode: str
    rows_stored: int
    path: str
