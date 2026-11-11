"""python -m app.leads.pipeline --inbox DIR --sales DIR --out DIR : the pipeline on local folders."""
import argparse
import gzip
import json
from pathlib import Path

from .build import run
from .inputs import SALES_FILES


def main() -> None:
    ap = argparse.ArgumentParser(description="Lead Generation pipeline: lead files + BO sales outputs -> dashboard data")
    ap.add_argument("--inbox", type=Path, required=True, help="folder with the lead / spend / follow-up / target files")
    ap.add_argument("--sales", type=Path, required=True, help="folder with the BO Dashboard's network/*.csv outputs")
    ap.add_argument("--out", type=Path, required=True, help="where to write dashboard.json.gz, reconciliation.xlsx, memo.md")
    a = ap.parse_args()
    inbox = {p.name: p.read_bytes() for p in sorted(a.inbox.iterdir()) if p.is_file()} if a.inbox.exists() else {}
    sales = {n: (a.sales / n).read_bytes() for n in SALES_FILES if (a.sales / n).exists()}
    res = run(inbox, sales)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "dashboard.json.gz").write_bytes(gzip.compress(json.dumps(res.payload, separators=(",", ":")).encode()))
    (a.out / "reconciliation.xlsx").write_bytes(res.reconciliation)
    (a.out / "memo.md").write_text(res.memo, encoding="utf-8")
    p = res.payload
    print(f"{len(p['retailers']['id']):,} retailers, {len(p['leads']['day']):,} lead rows, {len(p['spend']['v']):,} spend rows")
    for g in p["gaps"]:
        print(" gap:", g)
    print("written to", a.out)


if __name__ == "__main__":
    main()
