"""Automatic pipeline: inbox files in the store -> datasets."""
from io import BytesIO

from openpyxl import Workbook

from app.core.constants import DatasetType
from app.services.sync_service import SyncRunner, detect_dataset
from tests.conftest import DISTRIBUTORS_CSV, RETAILERS_CSV, SALES_CSV


def _xlsx(sheets: dict) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, csv_text in sheets.items():
        ws = wb.create_sheet(name)
        for line in csv_text.strip().splitlines():
            ws.append(line.split(","))
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_detect_dataset_from_names():
    assert detect_dataset("Sales_Apr26.xlsx") == DatasetType.SALES
    assert detect_dataset("Retailer Master") == DatasetType.RETAILERS
    assert detect_dataset("Benefit Fulfilment Q2.csv") == DatasetType.FULFILLMENTS
    assert detect_dataset("distributor_list") == DatasetType.DISTRIBUTORS
    assert detect_dataset("random.xlsx") is None


def test_sync_builds_datasets_from_inbox(repo, store, settings):
    runner = SyncRunner(repo, settings)
    # dataset folder with two monthly CSV files -> combined
    header, *rows = SALES_CSV.strip().splitlines()
    store.write("inbox/sales/sales_part1.csv", "\n".join([header, *rows[:3]]).encode())
    store.write("inbox/sales/sales_part2.csv", "\n".join([header, *rows[3:]]).encode())
    # one workbook in the inbox root with a sheet per dataset (simple rows without quoted commas)
    store.write("inbox/BO_Masters.xlsx", _xlsx({"Retailers": RETAILERS_CSV, "Distributors": DISTRIBUTORS_CSV,
                                                 "Notes": "a,b\n1,2"}))
    store.write("inbox/~$BO_Masters.xlsx", b"lock file")  # Excel lock files are ignored

    run = runner.run("test")
    assert run["ok"], run
    by = {r["dataset"]: r for r in run["results"]}
    assert by["sales"]["status"] == "updated" and by["sales"]["rows"] == 6
    assert by["retailers"]["status"] == "updated" and by["retailers"]["rows"] == 3
    assert by["retailers"]["files"][0]["sheet"] == "Retailers"
    assert by["distributors"]["rows"] == 2
    assert len(repo.get_sales()) == 6

    # nothing changed -> nothing rebuilt
    again = {r["dataset"]: r["status"] for r in runner.run("test")["results"]}
    assert again == {"sales": "unchanged", "retailers": "unchanged", "distributors": "unchanged"}

    # a removed file triggers a rebuild from the remaining ones
    store.delete("inbox/sales/sales_part2.csv")
    third = {r["dataset"]: r for r in SyncRunner(repo, settings).run("test")["results"]}
    assert third["sales"]["status"] == "updated" and third["sales"]["rows"] == 3


def test_bad_file_is_skipped_and_reported(repo, store, settings):
    store.write("inbox/sales/good.csv", SALES_CSV.encode())
    store.write("inbox/sales/bad.csv", b"foo,bar\n1,2\n")
    store.write("inbox/mystery.csv", b"x\n1\n")
    run = SyncRunner(repo, settings).run("test")
    sales = next(r for r in run["results"] if r["dataset"] == "sales")
    assert sales["status"] == "partial" and sales["rows"] == 6
    bad = next(f for f in sales["files"] if f["path"].endswith("bad.csv"))
    assert "Required column" in bad["error"]
    assert any("mystery.csv" in w for w in run["warnings"])


def test_only_bad_files_leave_dataset_untouched(repo, store, settings):
    before = len(repo.get_sales())
    store.write("inbox/sales/bad.csv", b"foo,bar\n1,2\n")
    run = SyncRunner(repo, settings).run("test")
    assert run["results"][0]["status"] == "failed"
    repo.reload()
    assert len(repo.get_sales()) == before


def test_sync_api(client, store):
    store.write("inbox/distributors/dist.csv", DISTRIBUTORS_CSV.encode())
    r = client.post("/api/sync")
    assert r.status_code == 200 and r.json()["data"]["ok"]
    status = client.get("/api/sync").json()["data"]
    assert status["datasets"]["distributors"]["rows"] == 2
    assert status["last_run"]["trigger"] == "manual" and status["interval_minutes"] == 0
    forced = client.post("/api/sync?force=true").json()["data"]
    assert forced["results"][0]["status"] == "updated"
