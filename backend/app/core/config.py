"""
Application configuration.

All settings come from environment variables (or a local `.env` file).
Nothing secret is hard-coded here. See `.env.example` for the full list.
"""
from functools import lru_cache
from pathlib import Path
from typing import Annotated, List, Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# backend/app/
APP_DIR = Path(__file__).resolve().parent.parent
# backend/.env is found no matter which folder uvicorn is started from
ENV_FILE = APP_DIR.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # ---- App -------------------------------------------------------------
    APP_NAME: str = "Blue Origin API"
    APP_VERSION: str = "0.1.0"
    ENVIRONMENT: Literal["development", "staging", "production", "test"] = "development"
    DEBUG: bool = False
    API_PREFIX: str = "/api"
    LOG_LEVEL: str = "INFO"

    # ---- CORS (React / Vite dev server) ------------------------------------
    # Comma-separated in .env, e.g. http://localhost:5173,http://127.0.0.1:5173
    CORS_ORIGINS: Annotated[List[str], NoDecode] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # ---- Data store -----------------------------------------------------------
    # "dropbox" -> Dropbox is the database (production / normal use)
    # "local"   -> same layout in a local folder (offline development and tests)
    DATA_SOURCE: Literal["dropbox", "local"] = "dropbox"
    DATA_DIR: Path = APP_DIR / "data"          # root folder for DATA_SOURCE=local

    # Dropbox credentials. Prefer a long-lived refresh token (app key + secret + refresh token);
    # a short-lived access token works for quick testing. See README "Dropbox setup".
    DROPBOX_APP_KEY: str = ""
    DROPBOX_APP_SECRET: str = ""
    DROPBOX_REFRESH_TOKEN: str = ""
    DROPBOX_ACCESS_TOKEN: str = ""
    DROPBOX_ROOT: str = "/blue-origin"          # folder inside the Dropbox app / account
    DROPBOX_TIMEOUT_SECONDS: int = 60

    # Datasets read from the store are cached in memory; writes through the API refresh it at once.
    CACHE_TTL_SECONDS: int = 300

    # ---- Automatic pipeline (Dropbox inbox -> datasets) ----------------------
    # Drop Excel/CSV files into <DROPBOX_ROOT>/<SYNC_INBOX>/<dataset>/ (or the inbox root, matched by
    # file/sheet name). The backend checks every SYNC_INTERVAL_MINUTES and rebuilds changed datasets.
    SYNC_INBOX: str = "inbox"
    SYNC_INTERVAL_MINUTES: int = 1440      # 24 h; 0 = no automatic runs (POST /api/sync still works)
    # Between those runs the dashboard files (/Power BI/FY*_qtr*.csv written by BO_data.ipynb, a new quarter file
    # too) are checked every DATA_WATCH_MINUTES; a change is synced once no file changed for DATA_SETTLE_SECONDS,
    # so a notebook run that is still writing its files is not built half-way. 0 = no watching.
    DATA_WATCH_MINUTES: int = 2
    DATA_SETTLE_SECONDS: int = 120

    # BO Dashboard connector: consolidated Power BI files elsewhere in the same Dropbox (absolute paths).
    # Empty = connector off. See app/services/bo_dashboard_connector.py.
    BO_SOURCE_FOLDER: str = ""             # e.g. /Power BI/BO_Dashboard
    BO_TIER_SCHEME: str = ""               # e.g. /Power BI/Tier_scheme.xlsx

    # ---- BO Retailer Network dashboard ------------------------------------------
    # Folder holding the distributor quarterly files (FY27_qtr2.csv, ...), Dist-state.xlsx, Tier_scheme.xlsx,
    # (deliverables_consolidated.csv is not read). When set, every sync re-runs bo_pipeline.py
    # on them if any changed and stores the result in <DROPBOX_ROOT>/network/ (which the connector then
    # uses). Empty = the dashboard reads BO_SOURCE_FOLDER/dashboard_data.json written by the notebook.
    BO_PIPELINE_INPUT: str = ""            # e.g. /Power BI
    # MAIN DATA: the consolidated distributor sheets, one per quarter (FY25_Qtr3.csv ... FY27_Qtr2.csv). When set,
    # the dashboard, sales, tiers and benefits are built from these files (cleaned by pipeline/consolidated_prep.py);
    # BO_PIPELINE_INPUT then only supplies Dist-state.xlsx and Tier_scheme.xlsx.
    BO_DATA_FOLDER: str = ""               # e.g. /Power BI/Consolidated
    # Google Sheets download into BO_SHEETS_FOLDER (app/services/sheets_download.py), run by the sync: the
    # distributor list (Dropbox csv: Distributor, Sheet URL, Active) and the service-account key of BO_data.ipynb.
    BO_SHEETS_FOLDER: str = ""             # e.g. /Power BI/Consolidated; empty = BO_DATA_FOLDER
    BO_DISTRIBUTOR_SHEETS: str = ""        # e.g. /Power BI/BO_Dashboard/distributors.csv; empty = no download
    BO_GOOGLE_KEY: str = ""                # path to the key json; relative = inside backend/ (default secrets/...)
    SHEETS_DOWNLOAD_MINUTES: int = 360     # automatic runs download at most this often; "Sync now" always does
    # Reference workbook used to fill blank retailer city / pincode / phone (BO_Consolidate_Final.xlsx)
    BO_INFO_FOLDER: str = ""               # e.g. /INFORMATION

    @property
    def sheets_folder(self) -> str:
        """Where the Google Sheets download writes the consolidated sheets."""
        return (self.BO_SHEETS_FOLDER or self.BO_DATA_FOLDER).strip()

    # Admin's account book on this PC: name, email, PASSWORD, role and status of every account, rewritten after each
    # account change (app/services/account_book.py). Empty = off. The rows behind it: ACCOUNT_BOOK_STORE (gitignored).
    ACCOUNT_BOOK_FILE: str = ""            # e.g. D:\BLUE ORIGIN\BO_User_Accounts.xlsx
    ACCOUNT_BOOK_STORE: str = "secrets/account_book.json"   # relative = inside backend/

    # ---- Sign-in ------------------------------------------------------------
    # Users live in <DROPBOX_ROOT>/meta/users.json (managed on the Users page by an admin).
    # AUTH_SECRET signs the login tokens; empty = a random secret is created once and kept in the store.
    AUTH_SECRET: str = ""
    AUTH_TOKEN_HOURS: int = 12
    # First admin, created only while there are no users yet (then change the password in the app).
    ADMIN_EMAIL: str = ""
    ADMIN_PASSWORD: str = ""
    ADMIN_NAME: str = "Administrator"

    # ---- Uploads ------------------------------------------------------------
    MAX_UPLOAD_MB: int = 25
    VALIDATION_ISSUE_LIMIT: int = 500   # max issues returned in one report
    PREVIEW_ROWS: int = 20

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                import json
                return json.loads(v)
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @field_validator("DROPBOX_ROOT", mode="after")
    @classmethod
    def _normalise_root(cls, v: str) -> str:
        v = "/" + v.strip().strip("/")
        return "" if v == "/" else v

    # Convenience paths
    @property
    def local_store_dir(self) -> Path:
        return self.DATA_DIR / "store"

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
