"""Shared response envelopes and base models used by every module."""
from datetime import datetime
from typing import Any, Generic, List, Optional, TypeVar

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

T = TypeVar("T")


class BaseSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class CamelSchema(BaseModel):
    """Models consumed by the React app: snake_case in Python, camelCase on the wire."""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True, alias_generator=to_camel)


class Paged(CamelSchema, Generic[T]):
    items: List[T]
    total: int
    page: int
    page_size: int


class DataSourceInfo(BaseSchema):
    source: str = Field(description="'dropbox' (normal use) or 'local' (offline development)")
    location: str = Field(description="Store root, e.g. dropbox:/blue-origin")
    loaded_at: Optional[datetime] = None


class PaginationMeta(BaseSchema):
    page: int
    page_size: int
    total_items: int
    total_pages: int


class ResponseMeta(BaseSchema):
    data_source: Optional[DataSourceInfo] = None
    pagination: Optional[PaginationMeta] = None
    filters_applied: Optional[dict] = None
    notes: List[str] = Field(default_factory=list)


class ApiResponse(BaseSchema, Generic[T]):
    """Standard success envelope: {success, data, meta}."""
    success: bool = True
    data: T
    meta: ResponseMeta = Field(default_factory=ResponseMeta)


class ErrorBody(BaseSchema):
    code: str
    message: str
    details: Optional[Any] = None


class ErrorResponse(BaseSchema):
    success: bool = False
    error: ErrorBody


class HealthResponse(BaseSchema):
    status: str
    app: str
    version: str
    environment: str
    data_source: str
    store: Optional[str] = None
    store_ok: bool
    store_error: Optional[str] = None
    timestamp: datetime
