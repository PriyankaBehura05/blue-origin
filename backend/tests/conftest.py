"""Shared fixtures. All test data is small and fictional, written to a temp local store per test.

The local store has exactly the layout used in Dropbox (datasets/*.csv, uploads/, meta/), so the
same repository and services are exercised; only the BlobStore implementation differs.
"""
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["SYNC_INTERVAL_MINUTES"] = "0"   # no background pipeline during tests
os.environ["DATA_SOURCE"] = "local"

from app.api.deps import get_repository, get_settings  # noqa: E402
from app.core.config import Settings  # noqa: E402
from app.main import app  # noqa: E402
from app.repositories.store_repository import StoreRepository  # noqa: E402
from app.storage.local_store import LocalStore  # noqa: E402

# Latest valid sale is 12-03-2026 -> current quarter Q4 FY 26 (Jan-Mar 2026), previous Q3 FY 26.
SALES_CSV = """invoice_no,invoice_date,retailer_code,retailer_name,distributor_code,distributor_name,quantity,net_sales_amount,return_amount,channel,category,state,city,pincode
T-1,05-10-2025,R1,Test Store One,D1,Test Dist A,10,"60,000.00",0,GT,Footwear,Karnataka,Bengaluru,560001
T-2,15-01-2026,R1,Test Store One,D1,Test Dist A,5,160000,4000,GT,Apparel,Karnataka,Bengaluru,560001
T-3,20-02-2026,R2,Test Store Two,D2,Test Dist B,3,₹30000,0,MBO,Footwear,Tamil Nadu,Chennai,600001
T-4,bad-date,R2,Test Store Two,D2,Test Dist B,1,400,0,MBO,Footwear,Tamil Nadu,Chennai,600001
T-5,10-03-2026,R3,Test Store Three,D2,Test Dist B,2,,0,GT,Footwear,Tamil Nadu,Chennai,600001
T-6,12-03-2026,R4,Sales Only Store,D2,Test Dist B,1,1000,0,GT,Accessories,Tamil Nadu,Chennai,600001
"""

RETAILERS_CSV = """retailer_code,retailer_name,distributor_code,distributor_name,state,city,pincode,status,channel,region
R1,Test Store One,D1,Test Dist A,Karnataka,Bengaluru,560001,Active,GT,South
R2,Test Store Two,D2,Test Dist B,Tamil Nadu,Chennai,600001,active,MBO,South
R3,Test Store Three,D2,Test Dist B,Tamil Nadu,Chennai,600001,Inactive,GT,South
"""

DISTRIBUTORS_CSV = """distributor_code,distributor_name,state,city,status,region
D1,Test Dist A,Karnataka,Bengaluru,Active,South
D2,Test Dist B,Tamil Nadu,Chennai,Active,South
"""

BENEFITS_CSV = """id,name,tier,frequency,quantity,unit_cost,description
BEN-0001,Signage Board,Yellow,One-time,1,6000,Storefront board
BEN-0002,Display Stand,green,one-time,1,9000,Floor stand
"""

FULFILLMENTS_CSV = """id,benefit_id,retailer_code,planned_date,actual_date,status,cost
FUL-0001,BEN-0002,R1,2026-02-01,2026-02-05,,
FUL-0002,BEN-0001,R2,2026-01-10,,Planned,
FUL-0003,BEN-0001,R2,2026-12-01,,in progress,500
"""

TARGETS_CSV = """month,target_amount
2026-01,150000
2026-02,60000
"""

DATASETS = {"sales": SALES_CSV, "retailers": RETAILERS_CSV, "distributors": DISTRIBUTORS_CSV,
            "benefits": BENEFITS_CSV, "fulfillments": FULFILLMENTS_CSV,
            "targets": TARGETS_CSV}


@pytest.fixture
def data_dir(tmp_path) -> Path:
    ds = tmp_path / "store" / "datasets"
    ds.mkdir(parents=True)
    for name, content in DATASETS.items():
        (ds / f"{name}.csv").write_text(content, encoding="utf-8")
    return tmp_path


ADMIN_EMAIL, ADMIN_PASSWORD = "admin@test.local", "admin-pass-123"


@pytest.fixture
def settings(data_dir) -> Settings:
    return Settings(DATA_DIR=data_dir, DATA_SOURCE="local", ENVIRONMENT="test", MAX_UPLOAD_MB=1,
                    AUTH_SECRET="test-secret", ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD,
                    ADMIN_NAME="Test Admin", BO_DATA_FOLDER="")   # tests never use the real .env data folders


@pytest.fixture
def store(settings) -> LocalStore:
    return LocalStore(settings.local_store_dir)


@pytest.fixture
def repo(store) -> StoreRepository:
    return StoreRepository(store, cache_ttl_seconds=300)


@pytest.fixture
def anon(settings, repo):
    """A client that has not signed in."""
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def sign_in(c: TestClient, email: str, password: str) -> TestClient:
    r = c.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    c.headers["Authorization"] = f"Bearer {r.json()['data']['token']}"
    return c


@pytest.fixture
def client(anon):
    """Signed in as the first admin (created from ADMIN_EMAIL / ADMIN_PASSWORD)."""
    return sign_in(anon, ADMIN_EMAIL, ADMIN_PASSWORD)
