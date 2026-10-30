"""Sign-in (/auth/...) and user management (/users, admins only)."""
from typing import List

from fastapi import APIRouter, Depends, Response

from app.api.deps import Settings, current_user, get_repository, get_settings, require_admin
from app.repositories.base import DataRepository
from app.schemas.auth import ChangePasswordRequest, LoginRequest, LoginResult, User, UserCreate, UserUpdate
from app.schemas.common import ApiResponse
from app.services import auth_service, user_register

router = APIRouter(prefix="/auth", tags=["Sign-in"])
users_router = APIRouter(prefix="/users", tags=["Users"], dependencies=[Depends(require_admin)])


@router.post("/login", response_model=ApiResponse[LoginResult], summary="Sign in with email and password")
def login(body: LoginRequest, repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    return ApiResponse(data=auth_service.login(repo.store, settings, body.email, body.password))


@router.get("/me", response_model=ApiResponse[User], summary="The signed-in user")
def me(user: dict = Depends(current_user)):
    return ApiResponse(data=auth_service.public(user))


@router.post("/change-password", response_model=ApiResponse[LoginResult],
             summary="Change your own password (returns a new token; older tokens stop working)")
def change_password(body: ChangePasswordRequest, user: dict = Depends(current_user),
                    repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    return ApiResponse(data=auth_service.change_own_password(repo.store, settings, user, body.current_password,
                                                             body.new_password))


@users_router.get("", response_model=ApiResponse[List[User]], summary="All users")
def list_users(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    users = auth_service.list_users(repo.store, settings)
    return ApiResponse(data=[auth_service.public(u) for u in sorted(users, key=lambda u: u["name"].casefold())])


@users_router.get("/register", summary="Excel register of all accounts: roles, status, sign-ins, history (no passwords)")
def user_register_download(repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    auth_service.list_users(repo.store, settings)
    content = user_register.build(repo.store)
    repo.store.write(user_register.REGISTER_PATH, content)       # keep the Dropbox copy current too
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="BO_User_Register.xlsx"'})


@users_router.post("", response_model=ApiResponse[User], status_code=201, summary="Add a user")
def create_user(body: UserCreate, actor: dict = Depends(current_user), repo: DataRepository = Depends(get_repository),
                settings: Settings = Depends(get_settings)):
    return ApiResponse(data=auth_service.create_user(repo.store, settings, body.email, body.name, body.role,
                                                     body.password, actor=actor))


@users_router.put("/{user_id}", response_model=ApiResponse[User],
                  summary="Change a user's details, role, active flag or password")
def update_user(user_id: str, body: UserUpdate, actor: dict = Depends(current_user),
                repo: DataRepository = Depends(get_repository), settings: Settings = Depends(get_settings)):
    return ApiResponse(data=auth_service.update_user(repo.store, settings, actor, user_id,
                                                     **body.model_dump(exclude_unset=True)))


@users_router.delete("/{user_id}", status_code=204, response_class=Response, summary="Delete a user")
def delete_user(user_id: str, actor: dict = Depends(current_user), repo: DataRepository = Depends(get_repository),
                settings: Settings = Depends(get_settings)):
    auth_service.delete_user(repo.store, settings, actor, user_id)
    return Response(status_code=204)
