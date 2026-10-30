"""
Sign-in and user management.

Users are kept in the store as ``meta/users.json`` (Dropbox in normal use), one entry per user:
    {id, email, name, role, active, password_hash, created_at, last_login_at, password_set_at}
Every change is also written to ``meta/users_log.json`` and to the Excel register Users/BO_User_Register.xlsx
(app/services/user_register.py): accounts, roles and history, never passwords.
Passwords are stored only as PBKDF2-SHA256 hashes: ``pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>``.

Login returns a signed token (HMAC-SHA256, valid AUTH_TOKEN_HOURS). Every request checks the token and
that the user still exists, is active and has not changed password since the token was issued.

Roles:
    admin   everything, including the Users page
    editor  view and change data (uploads, benefits, sync, rebuilds)
    viewer  view and download only
"""
import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from app.core.config import Settings
from app.core.errors import (ConflictError, ForbiddenError, InvalidFilterError, NotFoundError, TooManyAttemptsError,
                             UnauthorizedError)
from app.services import account_book
from app.storage.base import META_DIR, BlobStore

log = logging.getLogger("blue_origin.auth")

USERS_PATH = f"{META_DIR}/users.json"
LOG_PATH = f"{META_DIR}/users_log.json"
SECRET_PATH = f"{META_DIR}/auth_secret.json"
ROLES = ("admin", "editor", "viewer")
PBKDF2_ITERATIONS = 390_000
MIN_PASSWORD_LENGTH = 8
_USERS_TTL_SECONDS = 30          # users are re-read from the store at most this often (writes refresh at once)
_MAX_FAILURES, _FAILURE_WINDOW = 8, 15 * 60   # failed logins per email before a 15-minute pause

_lock = threading.Lock()
_failures: Dict[str, List[float]] = {}


# ------------------------------------------------------------------ passwords
def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), base64.b64decode(salt), int(iterations))
        return hmac.compare_digest(calc, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


def _check_password_rules(password: str) -> None:
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise InvalidFilterError(f"The password must have at least {MIN_PASSWORD_LENGTH} characters.",
                                 code="WEAK_PASSWORD")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def public(user: dict) -> dict:
    """A user without the password hash (what the API returns)."""
    return {k: user.get(k) for k in ("id", "email", "name", "role", "active", "created_at", "last_login_at")}


def read_log(store: BlobStore) -> List[dict]:
    raw = store.read(LOG_PATH)
    return json.loads(raw) if raw else []


def _log(store: BlobStore, actor: Optional[dict], action: str, user: dict, details: str = "") -> None:
    """One line of account history (no passwords), then the Excel register is rewritten."""
    entry = {"at": _now(), "by": (actor or {}).get("email") or "system", "action": action,
             "email": user.get("email"), "name": user.get("name"), "role": user.get("role"), "details": details}
    try:
        store.write(LOG_PATH, json.dumps(read_log(store) + [entry], indent=1).encode("utf-8"))
    except Exception:  # the history must never block a sign-in or a user change
        log.exception("Could not write the users log")
    _refresh_register(store)


def _refresh_register(store: BlobStore) -> None:
    from app.services import user_register     # late import: the register reads users through this module
    try:
        user_register.save(store)
    except Exception:
        log.exception("Could not update the Excel user register")


# ------------------------------------------------------------------ user store
def _read_users(store: BlobStore) -> List[dict]:
    cached = getattr(store, "_bo_users", None)
    if cached and time.time() - cached[0] < _USERS_TTL_SECONDS:
        return cached[1]
    raw = store.read(USERS_PATH)
    users = json.loads(raw) if raw else []
    store._bo_users = (time.time(), users)  # type: ignore[attr-defined]
    return users


def _write_users(store: BlobStore, users: List[dict]) -> None:
    store.write(USERS_PATH, json.dumps(users, indent=2).encode("utf-8"))
    store._bo_users = (time.time(), users)  # type: ignore[attr-defined]


def list_users(store: BlobStore, settings: Settings) -> List[dict]:
    with _lock:
        users = _read_users(store)
        if not users and settings.ADMIN_EMAIL and settings.ADMIN_PASSWORD:
            # first start: the admin from backend/.env
            users = [_new_user(settings.ADMIN_EMAIL, settings.ADMIN_NAME or "Administrator", "admin",
                               settings.ADMIN_PASSWORD, check_rules=False)]
            _write_users(store, users)
            first = users[0]
        else:
            first = None
    if first:
        _log(store, None, "Created", first, "first admin, from backend/.env")
        account_book.record(settings, "Created", first, password=settings.ADMIN_PASSWORD, details="first admin")
    return users


def _new_user(email: str, name: str, role: str, password: str, check_rules: bool = True) -> dict:
    if check_rules:
        _check_password_rules(password)
    return {"id": secrets.token_hex(6), "email": email.strip().lower(), "name": name.strip() or email.strip(),
            "role": role, "active": True, "password_hash": hash_password(password), "created_at": _now(),
            "last_login_at": None, "password_set_at": _now()}


def _find(users: List[dict], user_id: str) -> dict:
    user = next((u for u in users if u["id"] == user_id), None)
    if user is None:
        raise NotFoundError(f"User '{user_id}' was not found.", details={"id": user_id})
    return user


def _clean_email(email: str) -> str:
    email = (email or "").strip().lower()
    if "@" not in email or email.startswith("@") or email.endswith("@") or " " in email:
        raise InvalidFilterError("Enter a valid email address.", details={"email": email})
    return email


def _clean_role(role: str) -> str:
    role = (role or "").strip().lower()
    if role not in ROLES:
        raise InvalidFilterError(f"Role must be one of: {', '.join(ROLES)}.", details={"role": role})
    return role


def _active_admins(users: List[dict]) -> int:
    return sum(1 for u in users if u.get("role") == "admin" and u.get("active"))


# ------------------------------------------------------------------ tokens
def _secret(store: BlobStore, settings: Settings) -> bytes:
    if settings.AUTH_SECRET:
        return settings.AUTH_SECRET.encode("utf-8")
    cached = getattr(store, "_bo_secret", None)
    if cached:
        return cached
    raw = store.read(SECRET_PATH)
    secret = json.loads(raw)["secret"] if raw else None
    if not secret:
        secret = secrets.token_urlsafe(48)
        store.write(SECRET_PATH, json.dumps({"secret": secret, "created_at": _now()}).encode("utf-8"))
    store._bo_secret = secret.encode("utf-8")  # type: ignore[attr-defined]
    return store._bo_secret  # type: ignore[attr-defined]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _password_version(user: dict) -> str:
    """Changes whenever the password changes, so older tokens stop working."""
    return hashlib.sha256(user["password_hash"].encode()).hexdigest()[:12]


def issue_token(store: BlobStore, settings: Settings, user: dict) -> Tuple[str, datetime]:
    exp = int(time.time()) + settings.AUTH_TOKEN_HOURS * 3600
    body = _b64(json.dumps({"sub": user["id"], "exp": exp, "pv": _password_version(user)}).encode())
    sig = _b64(hmac.new(_secret(store, settings), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}", datetime.fromtimestamp(exp, tz=timezone.utc)


def user_for_token(store: BlobStore, settings: Settings, token: Optional[str]) -> dict:
    if not token:
        raise UnauthorizedError("Please sign in.")
    try:
        body, sig = token.split(".")
        good = _b64(hmac.new(_secret(store, settings), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, good):
            raise ValueError("bad signature")
        claims = json.loads(_unb64(body))
    except (ValueError, TypeError, json.JSONDecodeError):
        raise UnauthorizedError("Your sign-in is not valid. Please sign in again.") from None
    if claims.get("exp", 0) < time.time():
        raise UnauthorizedError("Your session has expired. Please sign in again.")
    user = next((u for u in list_users(store, settings) if u["id"] == claims.get("sub")), None)
    if user is None or not user.get("active"):
        raise UnauthorizedError("This account is no longer active.")
    if claims.get("pv") != _password_version(user):
        raise UnauthorizedError("The password was changed. Please sign in again.")
    return user


# ------------------------------------------------------------------ login / own account
def login(store: BlobStore, settings: Settings, email: str, password: str) -> dict:
    email = (email or "").strip().lower()
    now = time.time()
    with _lock:
        recent = [t for t in _failures.get(email, []) if now - t < _FAILURE_WINDOW]
        _failures[email] = recent
        if len(recent) >= _MAX_FAILURES:
            raise TooManyAttemptsError("Too many failed sign-ins for this email. Try again in 15 minutes.")
    users = list_users(store, settings)
    if not users:
        raise UnauthorizedError("No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env and "
                                "restart the backend to create the first admin.", code="NO_USERS")
    user = next((u for u in users if u["email"] == email), None)
    if user is None or not verify_password(password or "", user["password_hash"]) or not user.get("active"):
        with _lock:
            _failures.setdefault(email, []).append(now)
        if user is not None and not user.get("active") and verify_password(password or "", user["password_hash"]):
            raise UnauthorizedError("This account has been deactivated. Ask an admin to activate it.")
        raise UnauthorizedError("Wrong email or password.")
    with _lock:
        _failures.pop(email, None)
        users = _read_users(store)
        stored = _find(users, user["id"])
        stored["last_login_at"] = _now()
        _write_users(store, users)
    # the register's "Last sign-in" column, in the background so signing in stays quick
    threading.Thread(target=_refresh_register, args=(store,), name="user-register", daemon=True).start()
    token, expires = issue_token(store, settings, stored)
    return {"token": token, "expires_at": expires, "user": public(stored)}


def change_own_password(store: BlobStore, settings: Settings, user: dict, current: str, new: str) -> dict:
    if not verify_password(current or "", user["password_hash"]):
        raise ForbiddenError("The current password is wrong.", code="WRONG_PASSWORD")
    _check_password_rules(new)
    with _lock:
        users = _read_users(store)
        stored = _find(users, user["id"])
        stored["password_hash"] = hash_password(new)
        stored["password_set_at"] = _now()
        _write_users(store, users)
    _log(store, stored, "Password changed", stored, "by the user")
    account_book.record(settings, "Password changed by user", stored, by=stored)
    token, expires = issue_token(store, settings, stored)   # old tokens stop working; this one replaces them
    return {"token": token, "expires_at": expires, "user": public(stored)}


# ------------------------------------------------------------------ admin: manage users
def create_user(store: BlobStore, settings: Settings, email: str, name: str, role: str, password: str,
                actor: Optional[dict] = None) -> dict:
    email, role = _clean_email(email), _clean_role(role)
    with _lock:
        users = list(_read_users(store))
        if any(u["email"] == email for u in users):
            raise ConflictError(f"A user with the email {email} already exists.", details={"email": email})
        user = _new_user(email, name or "", role, password)
        users.append(user)
        _write_users(store, users)
    _log(store, actor, "Created", user)
    account_book.record(settings, "Created", user, password=password, by=actor)
    return public(user)


def update_user(store: BlobStore, settings: Settings, actor: dict, user_id: str, *, name: Optional[str] = None,
                email: Optional[str] = None, role: Optional[str] = None, active: Optional[bool] = None,
                password: Optional[str] = None) -> dict:
    with _lock:
        users = [dict(u) for u in _read_users(store)]
        user = _find(users, user_id)
        before = dict(user)
        if name is not None:
            user["name"] = name.strip() or user["email"]
        if email is not None:
            email = _clean_email(email)
            if any(u["email"] == email and u["id"] != user_id for u in users):
                raise ConflictError(f"A user with the email {email} already exists.", details={"email": email})
            user["email"] = email
        if role is not None:
            user["role"] = _clean_role(role)
        if active is not None:
            user["active"] = bool(active)
        if password:
            _check_password_rules(password)
            user["password_hash"] = hash_password(password)
            user["password_set_at"] = _now()
        if user_id == actor["id"] and (user["role"] != "admin" or not user["active"]):
            raise ForbiddenError("You cannot remove your own admin access or deactivate yourself.",
                                 code="SELF_LOCKOUT")
        if _active_admins(users) == 0:
            raise ForbiddenError("At least one active admin must remain.", code="LAST_ADMIN")
        _write_users(store, users)
    changes = [f"{k} {before.get(k)} → {user.get(k)}" for k in ("name", "email", "role") if before.get(k) != user.get(k)]
    if before.get("active") != user.get("active"):
        changes.append("activated" if user.get("active") else "deactivated")
    if password:
        changes.append("password reset by an admin")
    if changes:
        _log(store, actor, "Changed", user, "; ".join(changes))
        account_book.record(settings, "Password reset" if password else "Changed", user, password=password or None,
                            by=actor, details="; ".join(c for c in changes if not c.startswith("password")))
    return public(user)


def delete_user(store: BlobStore, settings: Settings, actor: dict, user_id: str) -> None:
    if user_id == actor["id"]:
        raise ForbiddenError("You cannot delete your own account.", code="SELF_LOCKOUT")
    with _lock:
        users = _read_users(store)
        gone = _find(users, user_id)
        rest = [u for u in users if u["id"] != user_id]
        if _active_admins(rest) == 0:
            raise ForbiddenError("At least one active admin must remain.", code="LAST_ADMIN")
        _write_users(store, rest)
    _log(store, actor, "Deleted", gone)
    account_book.record(settings, "Deleted", gone, by=actor)
