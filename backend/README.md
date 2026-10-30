# Blue Origin — Backend

Python/FastAPI backend for the **Blue Origin Sales & Retailer Growth Management Platform**.
The React frontend talks only to this API. **Dropbox is the database**: every dataset, uploaded
file and manifest is a file in one Dropbox folder.

Endpoint reference: **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)** · Swagger: http://localhost:8000/docs

---

## 1. Architecture

```
BO Excel/CSV ─► POST /uploads ─► validate ─► stored unchanged in Dropbox uploads/
                                      │
                       POST /uploads/{id}/activate (replace | append)
                                      ▼
                     Dropbox datasets/<dataset>.csv   ◄── create / update / delete
                                      │                   (benefits, fulfilments)       
                 Repository: read → clean → validate → cache
                                      │
                 Analytics model (quarters, tiers, joins)  ── cached per data version
                                      │
React  ◄──  FastAPI routes  ◄──  Services (one per page)
```

| Layer | Folder | Responsibility |
|---|---|---|
| Storage | `app/storage/` | `BlobStore` interface; `DropboxStore` (normal use) and `LocalStore` (offline dev/tests) with the same layout |
| Repository | `app/repositories/` | `StoreRepository`: one CSV per dataset, processing pipeline on read, in-memory cache, writes |
| Processing | `app/processing/` | Read → normalise headers → clean → validate → transform. Used for uploads **and** stored data |
| Model | `app/services/model.py` | Joins datasets into the shapes the UI shows: quarter labels, tiers, retailer↔distributor links, derived statuses |
| Services | `app/services/` | Dashboard, sales, retailers, distributors, tiers, benefits, reports, uploads, filter options |
| Routes | `app/api/` | HTTP only: parse params, call a service, wrap response |
| Rules | `app/rules/` + `config/*.json` | Tier thresholds/colours, benefit categories, geography reference |

### Data store layout (inside `DROPBOX_ROOT`, default `/blue-origin`)

```
datasets/sales.csv  retailers.csv  distributors.csv  benefits.csv  fulfillments.csv  targets.csv
uploads/<timestamp>_<id>_<filename>     original uploaded files
uploads/_upload_history.json            upload manifest
meta/reports.json                       report "last generated" log
```

A brand-new (empty) Dropbox folder is valid: every page loads and shows no data until files are uploaded.

---

## 2. Install

Requires **Python 3.10+**.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env               # macOS/Linux: cp .env.example .env
```

## 3. Dropbox setup (once)

1. Go to <https://www.dropbox.com/developers/apps> → **Create app** → *Scoped access* → *App folder* → give it a name.
2. **Permissions** tab: tick `files.metadata.read`, `files.content.read`, `files.content.write` → **Submit**.
3. **Settings** tab: copy the *App key* and *App secret*.
4. Get a long-lived refresh token:
   ```bash
   python scripts/dropbox_auth.py <APP_KEY> <APP_SECRET>
   ```
   Open the printed link, click **Allow**, paste the code. The script saves the keys into `backend/.env`:
   ```
   DATA_SOURCE=dropbox
   DROPBOX_APP_KEY=...
   DROPBOX_APP_SECRET=...
   DROPBOX_REFRESH_TOKEN=...
   ```
   (For a quick test you can instead paste a short-lived token from the app console into `DROPBOX_ACCESS_TOKEN`; it expires after ~4 hours.)
5. Optional: `DROPBOX_ROOT` (default `/blue-origin`) — the folder inside the app folder that holds the data.

Offline development without Dropbox: `DATA_SOURCE=local` stores the same layout in `backend/app/data/store/`.

## 4. Run

```bash
uvicorn app.main:app --reload --port 8000
```

| What | URL |
|---|---|
| Health (incl. Dropbox connectivity) | http://localhost:8000/api/health |
| Swagger UI | http://localhost:8000/docs |

## 5. Loading data

### Automatic pipeline (recommended)

Put the BO Excel/CSV files in the Dropbox inbox. The backend fetches them by itself, at startup and
every `SYNC_INTERVAL_MINUTES` (default 1440 = 24 hours). It validates them, rebuilds the affected datasets, and every page updates.

```
Dropbox/Apps/<your app>/blue-origin/inbox/
├── sales/          Sales_Apr26.xlsx, Sales_May26.xlsx …   every file in a folder is combined
├── retailers/      Retailer_Master.xlsx
├── distributors/   …  (benefits/, fulfillments/, targets/ too)
└── BO_Data.xlsx    or one workbook with sheets named "Sales", "Retailers", "Distributors", …
```

- The inbox folders are created automatically on the first run.
- Excel lock files (`~$…`) are ignored.
- Files in the inbox root are matched by sheet name, then by file name.
- Only datasets whose files were added, changed or removed are rebuilt.
- A file with file-level errors (e.g. missing required columns) is skipped and reported, and the other files still load.
- When a dataset's inbox files change, the dataset is rebuilt from them. Edits made in the UI to that dataset are replaced at that point.
- Run it now: the **Sync now** button on the Data page, or `POST /api/sync` (`?force=true` rebuilds everything).
- See the result: `GET /api/sync`. The run log is kept in `meta/sync_state.json`.

### Main data: `/Power BI/Consolidated`

Main data (since 2026-10-22): the cleaned files `BO_data.ipynb` writes into `/Power BI` (`FY25_qtr3.csv` …
`FY27_qtr2.csv`, the same figures as `Monthwise.csv`), with `BO_DATA_FOLDER` left empty and
`BO_PIPELINE_INPUT=/Power BI`. They feed the BO Dashboard pages and the BO_Data report; `deliverables_consolidated.csv`
is not read. The Google Sheets download writes into `BO_SHEETS_FOLDER=/Power BI/Consolidated`.

There is **no duplicate merging**: every Code name (shop name + distributor) is one retailer, exactly as in the
BO_Data report, and every rupee of the files is kept (rows without a shop name become "(Name missing) <phone>").

`BO_DATA_FOLDER=/Power BI/Consolidated` instead builds from the raw distributor sheets: `app/pipeline/consolidated_prep.py`
cleans them the way `BO_data.ipynb` does (month columns get their year, column spellings fixed, names trimmed,
benefit cells → Yes / No / Cancelled, `Code name` = Retailer Name-Distributor) before `bo_pipeline.py` sums them.

Run it by hand: `python app/pipeline/consolidated_prep.py <Consolidated folder> <output folder>`.

### BO Dashboard connector (Power BI files)

With `BO_SOURCE_FOLDER=/Power BI/BO_Dashboard` and `BO_TIER_SCHEME=/Power BI/Tier_scheme.xlsx`, each sync run
also checks the consolidated Power BI files. When `retailers.csv`, `retailer_month.csv`, `retailer_quarter.csv` or
the tier scheme change, it rebuilds:

| Dataset | Built from |
|---|---|
| retailers | `retailers.csv` (Retailer_ID, distributor, state, region, pincode, first active month) |
| distributors | its retailers (code = Retailer_ID prefix; state/region = most common) |
| sales | `retailer_month.csv`, one row per retailer per month, dated the 1st |
| benefits | `Tier_scheme.xlsx`, one per tier × required benefit |
| fulfillments | `retailer_quarter.csv`, quarters with Deliverables = Yes: benefit Yes → Fulfilled, No → open (Overdue after quarter end), Cancelled → skipped |

The following are derived, because the files don't contain them:
- **Retailer status:** Active if the retailer billed in the latest 6 months, otherwise Inactive.
- **Benefit cost:** 0, because the files have no costs.

### Manual upload

Use the frontend **Data** page, or the API:

```bash
# store + validate
curl -F "file=@Sales_Q2.xlsx" -F "dataset=sales" http://localhost:8000/api/uploads
# make it live (replace the dataset, or append its rows)
curl -X POST "http://localhost:8000/api/uploads/<upload_id>/activate?mode=replace"
```

`GET /api/datasets/<dataset>/template` returns an empty CSV with the expected columns.

| Dataset | Required columns | Optional columns |
|---|---|---|
| sales | invoice_date, retailer_name, distributor_name, net_sales_amount | invoice_no, retailer_code, distributor_code, quantity, state, city, pincode, asm, rsm, region, channel, category, gross_amount, return_amount |
| retailers | retailer_name, distributor_name | retailer_code, distributor_code, state, city, pincode, asm, rsm, onboarding_date, status, region, channel |
| distributors | distributor_name | distributor_code, state, city, pincode, asm, rsm, onboarding_date, status, region |
| benefits | name, tier | id, frequency, quantity, unit_cost, description |
| fulfillments | benefit_id, planned_date | id, retailer_code, retailer_name, tier, quarter, actual_date, status, cost, owner, remarks |
| targets | month, target_amount | region, channel |

Headers are matched loosely (`"Net Sales (₹)"` → `net_sales_amount`); add real BO header spellings to the
`aliases` in `app/processing/dataset_specs.py`. Benefits and fulfilments can also be managed
directly in the UI; rows without an `id` get one (`BEN-0001`, `FUL-0001`) when stored.

## 6. How figures are calculated

- **Only VALID sales rows are counted.** Rows flagged invalid / missing / duplicate / needs_review stay in the store
  and are listed in the upload validation report.
- **Periods** use the Indian FY: `Q1 FY26-27` = Apr–Jun 2026. The *current quarter* is the quarter of the latest valid
  sales date; the previous quarter is the one before it.
- **Tiers** are classified on current-quarter net sales using `app/rules/config/tiers.json`. Below the lowest
  threshold → `Unranked`. An amount exactly on a boundary is flagged `tierStatus = needs_review` while
  `boundary_rule` is `unconfirmed`.
- **Region** comes from the file's `region` column, else `state_to_region` in `geography.json` (empty until the
  business defines it), else the distributor's region.
- **Fulfilment status**: actual date present → Fulfilled; planned date passed → Overdue; otherwise Planned / In Progress.
- **Retailers / distributors** seen only in sales data are listed too, with `inMaster = false`.
- IDs are technical keys derived from the source code column (`tmp-ret-…`); without a code they fall back to name / row.

## 7. Caching and concurrency

Datasets are cached in memory for `CACHE_TTL_SECONDS` (default 300). Writes through the API refresh immediately.
After editing a file directly in Dropbox, use **Reload from store** on the Data page (`POST /api/datasets/reload`).
Edits are serialised per process; run **one backend instance per Dropbox folder**.

## 8. Test

```bash
pytest -q
```

Tests use a temporary local store (same layout as Dropbox) plus a fake Dropbox client for `DropboxStore`.

## 9. Requires business confirmation

| Topic | Where | Current behaviour |
|---|---|---|
| Tier boundary inclusivity | `rules/config/tiers.json` → `boundary_rule` | Exact-boundary amounts → `needs_review` |
| Tier basis: gross vs net of returns | `tiers.json` | Uses net sales |
| State → region mapping | `rules/config/geography.json` | Empty; region taken from data files |
| Official retailer/distributor ID | `processing/data_transformer.py` | Technical id from code |
| Real BO column names | `processing/dataset_specs.py` | Provisional spec + aliases |
| Access control | — | None: every page and API call is open to anyone who can reach the app |
