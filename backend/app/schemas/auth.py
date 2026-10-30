from datetime import datetime
from typing import Optional

from pydantic import Field

from app.schemas.common import CamelSchema


class User(CamelSchema):
    id: str
    email: str
    name: str
    role: str = Field(description="admin | editor | viewer")
    active: bool
    created_at: Optional[datetime] = None
    last_login_at: Optional[datetime] = None


class LoginRequest(CamelSchema):
    email: str
    password: str


class LoginResult(CamelSchema):
    token: str = Field(description="Send as 'Authorization: Bearer <token>'")
    expires_at: datetime
    user: User


class ChangePasswordRequest(CamelSchema):
    current_password: str
    new_password: str


class UserCreate(CamelSchema):
    email: str
    name: str = ""
    role: str = "viewer"
    password: str


class UserUpdate(CamelSchema):
    email: Optional[str] = None
    name: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(None, description="Set a new password for the user")
