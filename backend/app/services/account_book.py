"""
Admin's account book: an Excel file on this PC (ACCOUNT_BOOK_FILE, e.g. D:\\BLUE ORIGIN\\BO_User_Accounts.xlsx) with
every sign-in account's name, email, password, role and status, kept up to date by the backend (user request,
2026-10-22).

    - Adding a user, or an admin setting a new password on the Users page, records that password.
    - A password a user changes themselves is not recorded ("Changed by the user"): only they know it. An admin
      reset records the new one again.
    - Accounts made before this file existed show "Not known" until their password is reset.
    - A deleted account stays listed as Deleted, without its password.

The rows are kept in ACCOUNT_BOOK_STORE (backend/secrets/account_book.json, never committed) and the Excel file is
rewritten from them after every change. When the Excel file is open (locked) it is written at the next change or
backend start instead. Empty ACCOUNT_BOOK_FILE = off.
"""
import io
import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Optional

import xlsxwriter

from app.core.config import Settings

log = logging.getLogger("blue_origin.accounts")
_IST = timezone(timedelta(hours=5, minutes=30))
_BACKEND = Path(__file__).resolve().parents[2]
_lock = threading.Lock()

NOT_KNOWN = "Not known (set before this file existed: reset it on the Users page to record a new one)"
BY_USER = "Changed by the user (reset it on the Users page to record a new one)"
ROLE_TEXT = {"admin": "Everything, including adding and removing users",
             "editor": "View and change data: uploads, benefits, sync, rebuilds",
             "viewer": "View and download only"}


def _path(value: str) -> Path:
    p = Path(value)
    return p if p.is_absolute() else _BACKEND / p


def enabled(settings: Settings) -> bool:
    return bool(settings.ACCOUNT_BOOK_FILE.strip())


def _now() -> str:
    return datetime.now(_IST).strftime("%d %b %Y, %H:%M")


def _when(iso) -> str:
    try:
        return datetime.fromisoformat(str(iso)).astimezone(_IST).strftime("%d %b %Y, %H:%M") if iso else ""
    except ValueError:
        return str(iso)


def _load(settings: Settings) -> Dict[str, dict]:
    p = _path(settings.ACCOUNT_BOOK_STORE)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def _save(settings: Settings, rows: Dict[str, dict]) -> None:
    p = _path(settings.ACCOUNT_BOOK_STORE)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def to_xlsx(rows: Dict[str, dict]) -> bytes:
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "strings_to_formulas": False, "strings_to_urls": False,
                                   "strings_to_numbers": False})
    base = {"font_name": "Arial", "font_size": 10}
    title = wb.add_format({**base, "bold": True, "font_size": 12})
    note = wb.add_format({**base, "italic": True, "font_size": 9, "font_color": "#C00000"})
    head = wb.add_format({**base, "bold": True, "bg_color": "#F2F2F2", "border": 1, "border_color": "#BFBFBF"})
    text = wb.add_format(base)
    grey = wb.add_format({**base, "font_color": "#7F7F7F", "italic": True})
    ws = wb.add_worksheet("Accounts")
    ws.write(0, 0, "TECHNOSPORT  |  Dashboard accounts", title)
    ws.write(1, 0, f"Updated {_now()} (IST) automatically by the dashboard. Contains passwords: keep this file on "
                   "this PC only, do not email or share it.", note)
    cols = [("Name", 26), ("Email", 34), ("Password", 26), ("Role", 10), ("What the role can do", 46), ("Status", 12),
            ("Created", 20), ("Password set by", 26), ("Password set on", 20), ("Last change", 50)]
    for c, (label, width) in enumerate(cols):
        ws.write(3, c, label, head)
        ws.set_column(c, c, width)
    order = {"Active": 0, "Deactivated": 1, "Deleted": 2}
    roles = {"admin": 0, "editor": 1, "viewer": 2}
    ordered = sorted(rows.values(), key=lambda r: (order.get(r.get("status"), 9), roles.get(r.get("role"), 9),
                                                   str(r.get("name", "")).casefold()))
    for i, r in enumerate(ordered, start=4):
        known = bool(r.get("password"))
        vals = [r.get("name"), r.get("email"), r.get("password") or r.get("password_note") or "", r.get("role"),
                ROLE_TEXT.get(r.get("role"), ""), r.get("status"), r.get("created"), r.get("set_by"), r.get("set_on"),
                r.get("last_change")]
        for c, v in enumerate(vals):
            ws.write_string(i, c, "" if v is None else str(v), grey if (c == 2 and not known) else text)
    ws.freeze_panes(4, 2)
    ws.autofilter(3, 0, 3 + max(len(ordered), 1), len(cols) - 1)
    wb.close()
    return buf.getvalue()


def _write_excel(settings: Settings, rows: Dict[str, dict]) -> bool:
    target = _path(settings.ACCOUNT_BOOK_FILE)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f"~{target.stem}.tmp")
        tmp.write_bytes(to_xlsx(rows))
        os.replace(tmp, target)
        return True
    except OSError as exc:   # open in Excel (locked), or the drive is missing: retried at the next change / start
        log.warning("Could not write %s (%s); it is written at the next account change or backend start", target, exc)
        return False


def record(settings: Settings, action: str, user: dict, *, password: Optional[str] = None, by: Optional[dict] = None,
           details: str = "") -> None:
    """One account event: 'Created', 'Changed', 'Password reset', 'Password changed by user', 'Deleted'."""
    if not enabled(settings):
        return
    try:
        with _lock:
            rows = _load(settings)
            row = rows.get(user["id"]) or {"created": _when(user.get("created_at")) or _now(),
                                            "password": "", "password_note": NOT_KNOWN}
            row.update(name=user.get("name"), email=user.get("email"), role=user.get("role"),
                       status="Deleted" if action == "Deleted" else ("Active" if user.get("active", True) else "Deactivated"))
            who = (by or {}).get("email") or "backend/.env"
            if password:
                row.update(password=password, password_note="", set_by=who, set_on=_now())
            elif action == "Password changed by user":
                row.update(password="", password_note=BY_USER, set_by=user.get("email"), set_on=_now())
            if action == "Deleted":
                row.update(password="", password_note="Account deleted")
            row["last_change"] = f"{_now()}: {action}" + (f" ({details})" if details else "") + f" by {who}"
            rows[user["id"]] = row
            _save(settings, rows)
            _write_excel(settings, rows)
    except Exception:   # the book must never block a sign-in or a user change
        log.exception("Could not update the account book")


def refresh(settings: Settings, users: list) -> None:
    """At start: add accounts the book does not know yet (password 'Not known') and rewrite the Excel file."""
    if not enabled(settings):
        return
    try:
        with _lock:
            rows = _load(settings)
            for u in users:
                if u["id"] not in rows:
                    rows[u["id"]] = {"name": u.get("name"), "email": u.get("email"), "role": u.get("role"),
                                     "status": "Active" if u.get("active") else "Deactivated",
                                     "created": _when(u.get("created_at")), "password": "", "password_note": NOT_KNOWN,
                                     "last_change": f"{_now()}: added to this file"}
            _save(settings, rows)
            _write_excel(settings, rows)
    except Exception:
        log.exception("Could not refresh the account book")
