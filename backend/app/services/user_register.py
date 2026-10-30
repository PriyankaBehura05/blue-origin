"""
Excel register of the sign-in accounts: Users/BO_User_Register.xlsx in the store (Dropbox), rewritten after every
account change (auth_service._log) and downloadable on the Users page (GET /api/users/register).

    Users     one row per account: name, email, role, what the role may do, status, created, last sign-in,
              password last set
    History   every change: when, by whom, what (created, changed, password reset, deactivated, deleted)
    Roles     what admin, editor and viewer can do

Passwords are never in it: the app keeps only a one-way hash of each password, which cannot be turned back into
the password. A forgotten password is reset by an admin on the Users page.
"""
import io
from datetime import datetime, timedelta, timezone
from typing import List

import xlsxwriter

from app.services import auth_service
from app.storage.base import BlobStore

REGISTER_PATH = "Users/BO_User_Register.xlsx"
ROLE_TEXT = {"admin": "Everything, including adding and removing users",
             "editor": "View and change data: uploads, benefits, sync, rebuilds",
             "viewer": "View and download only"}
_IST = timezone(timedelta(hours=5, minutes=30))


def _when(iso) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(str(iso)).astimezone(_IST).strftime("%d %b %Y, %H:%M")
    except ValueError:
        return str(iso)


def to_xlsx(users: List[dict], history: List[dict]) -> bytes:
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "strings_to_formulas": False, "strings_to_urls": False})
    base = {"font_name": "Arial", "font_size": 10}
    title = wb.add_format({**base, "bold": True, "font_size": 12})
    note = wb.add_format({**base, "italic": True, "font_size": 9, "font_color": "#7F7F7F"})
    head = wb.add_format({**base, "bold": True, "bg_color": "#F2F2F2", "border": 1, "border_color": "#BFBFBF"})
    text = wb.add_format(base)
    stamp = datetime.now(_IST).strftime("%d %b %Y, %H:%M")

    def sheet(name: str, heading: str, cols: List[tuple], rows: List[list]):
        ws = wb.add_worksheet(name)
        ws.write(0, 0, f"TECHNOSPORT  |  {heading}", title)
        ws.write(1, 0, f"{len(rows)} rows · updated {stamp} (IST) · no passwords are stored in this file", note)
        for c, (label, width) in enumerate(cols):
            ws.write(3, c, label, head)
            ws.set_column(c, c, width)
        for r, row in enumerate(rows, start=4):
            for c, v in enumerate(row):
                ws.write_string(r, c, "" if v is None else str(v), text)
        ws.freeze_panes(4, 0)
        ws.autofilter(3, 0, 3 + max(len(rows), 1), len(cols) - 1)

    order = {"admin": 0, "editor": 1, "viewer": 2}
    us = sorted(users, key=lambda u: (order.get(u.get("role"), 9), str(u.get("name", "")).casefold()))
    sheet("Users", "Dashboard sign-in accounts",
          [("Name", 26), ("Email", 34), ("Role", 10), ("What the role can do", 50), ("Status", 12),
           ("Created", 20), ("Last sign-in", 20), ("Password last set", 20)],
          [[u.get("name"), u.get("email"), u.get("role"), ROLE_TEXT.get(u.get("role"), ""),
            "Active" if u.get("active") else "Deactivated", _when(u.get("created_at")), _when(u.get("last_login_at")),
            _when(u.get("password_set_at"))] for u in us])
    sheet("History", "Account history (newest first)",
          [("When (IST)", 20), ("Done by", 30), ("Action", 18), ("Account", 34), ("Name", 26), ("Role", 10),
           ("Details", 60)],
          [[_when(h.get("at")), h.get("by"), h.get("action"), h.get("email"), h.get("name"), h.get("role"),
            h.get("details")] for h in reversed(history)])
    sheet("Roles", "Roles", [("Role", 12), ("What it can do", 70)], [[k, v] for k, v in ROLE_TEXT.items()])
    wb.close()
    return buf.getvalue()


def build(store: BlobStore) -> bytes:
    return to_xlsx(auth_service._read_users(store), auth_service.read_log(store))


def save(store: BlobStore) -> None:
    store.write(REGISTER_PATH, build(store))
