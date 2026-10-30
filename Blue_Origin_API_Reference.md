# Blue Origin API — Reference

**Base URL:** `http://localhost:8000/api` · **Interactive docs:** `/docs` (Swagger), `/redoc`
**Data store:** Dropbox (`DATA_SOURCE=dropbox`) or a local folder with the same layout (`DATA_SOURCE=local`)
**Auth:** sign in with `POST /auth/login`, then send `Authorization: Bearer <token>` on every request. Only `/health` and `/auth/login` are open. Roles: **admin** (everything + `/users`), **editor** (view and change data), **viewer** (GET only; other methods return 403). Missing / expired / revoked token → 401.

## 1. Conventions

**Success envelope** — `{ "success": true, "data": …, "meta": { "data_source"?, "notes": [] } }`
**Error envelope** — `{ "success": false, "error": { "code", "message", "details" } }` (no stack traces)

Fields consumed by the React app are **camelCase** (`netAmount`, `currentQuarter`). Upload endpoints keep snake_case.

**List endpoints** accept `search`, `sort_by` (any returned field), `sort_dir` (`asc`|`desc`), `page` (≥1),
`page_size` (1–500, default 15) plus their own filters, and return
`data = { items, total, page, pageSize }` (some add `summary`). Filters are exact, case-insensitive matches.

**Quarters** follow the financial year April–March, named after the year it ends in: `Q1 FY 27` = Apr–Jun 2026, `Q2` Jul–Sep, `Q3` Oct–Dec, `Q4 FY 27` = Jan–Mar 2027 (dashboard keys: `Q1_FY27`). The current quarter = quarter of the latest valid sale.

**Tiers** are decided on each quarter's net sales with the tiers in force in that quarter: Platinum applies from Q1 FY 27 (April 2026, `effective_from` in `rules/config/tiers.json`); earlier quarters top out at Gold.

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + data store connectivity (`store_ok`, `store_error`) — open |
| POST | `/auth/login` | `{email, password}` → `{token, expiresAt, user}` — open |
| GET | `/auth/me` | The signed-in user |
| POST | `/auth/change-password` | `{currentPassword, newPassword}` → new token (older tokens stop working) |
| GET / POST | `/users` | List / add users `{email, name, role, password}` — admin only |
| PUT / DELETE | `/users/{id}` | Change `{name, email, role, active, password}` / delete — admin only; you cannot demote, deactivate or delete yourself, one active admin always remains |
| GET | `/meta/filters` | Dropdown options and period context (`currentQuarter`, `previousQuarter`, `quarters`, `tiers`, `regions`, statuses …) |
| GET | `/dashboard?region=&channel=` | KPIs (with `deltaPct` vs previous period, null when not comparable), monthly sales vs target, tier mix, region/channel split, top retailers/distributors |
| GET | `/sales` | Sales rows. Filters: `quarter`, `month`, `region`, `state`, `channel`, `category`, `distributorId`, `retailerId`. Adds `summary {gross, returns, net, quantity, records}` |
| GET | `/retailers` | Retailers with `currentTier`, `previousTier`, `currentQuarterSales`, `fySales`. Filters: `region`, `state`, `channel`, `tier`, `status`, `distributorId` |
| GET | `/retailers/{id}` | `{ retailer, sales, fulfillments }` (404 if unknown) |
| GET | `/distributors` | Distributors with `retailerCount`, `currentQuarterSales`. Filters: `region`, `state`, `status` |
| GET | `/tiers` | Tier configuration (reference) |
| GET | `/tiers/classify?amount=` | Classify one amount |
| GET | `/tiers/definitions` | Tier ladder (incl. Unranked) with colours and current retailer counts |
| GET | `/tiers/movements` | Previous → current quarter tier per retailer. Filters: `direction`, `tier` |
| GET | `/benefits` | Benefit catalogue. Filters: `tier`, `frequency` |
| POST / PUT / DELETE | `/benefits`, `/benefits/{id}` | Manage the catalogue (`{name, tier, frequency, quantity, unitCost, description}`); delete refuses benefits in use (`IN_USE`) |
| GET | `/benefits/categories` | Reference benefit categories (config) |
| GET | `/benefits/fulfillments` | Fulfilment records. Filters: `quarter`, `tier`, `status`, `retailerId`, `benefitId`. Adds `summary {cost, fulfilled, pending, overdue, records}` |
| POST / PUT / DELETE | `/benefits/fulfillments`, `/benefits/fulfillments/{id}` | `{benefitId, retailerId, plannedDate, actualDate?, status?, cost?}`; `Overdue` is derived |
| GET | `/reports` | Report catalogue with `lastGenerated` |
| GET | `/reports/{id}/preview?limit=25` | `{reportId, columns, rows, totalRows}` |
| GET | `/reports/{id}/download?format=xlsx\|csv` | Full report file; logs the generation time |
| GET | `/datasets` | Stored state of each dataset (rows, valid rows, last modified, columns) |
| POST | `/datasets/reload` | Drop the cache and re-read the store |
| GET | `/datasets/{dataset}/template` | Empty CSV with the dataset's columns |
| GET | `/datasets/{dataset}/download` | The stored dataset CSV |
| POST | `/uploads/validate` | Multipart `file`, `dataset`, `sheet_name?` → validation report (nothing stored) |
| POST | `/uploads?allow_duplicate=false` | Store the file in `uploads/` and validate it → `{upload, report}`; identical file for the same dataset → 409 |
| POST | `/uploads/{upload_id}/activate?mode=replace\|append` | Write the upload to `datasets/<dataset>.csv` |
| GET | `/uploads` | Upload history (newest first) |
| GET | `/geography/states` | Reference list of Indian states/UTs |

Datasets: `sales`, `retailers`, `distributors`, `benefits`, `fulfillments`, `targets` — columns in the backend README.

## 3. Error codes

| HTTP | code | When |
|---|---|---|
| 400 | `INVALID_FILTER` | Bad page/page_size, unknown sort field, invalid value |
| 400 | `IN_USE` | Deleting a benefit that has fulfilment records |
| 400 | `UPLOAD_NOT_PROCESSABLE` | Activating an upload with file-level errors |
| 400 | `INVALID_FILE` / `EMPTY_FILE` | Unsupported, corrupt or empty upload |
| 404 | `NOT_FOUND` | Unknown retailer, record, report or upload |
| 409 | `DUPLICATE_UPLOAD` | Same file already uploaded for that dataset |
| 413 | `FILE_TOO_LARGE` | Over `MAX_UPLOAD_MB` |
| 422 | `REQUEST_VALIDATION_ERROR` | Wrong parameter / body types |
| 503 | `STORAGE_ERROR` / `STORAGE_AUTH_FAILED` | Dropbox unreachable, misconfigured or credentials rejected |
| 503 | `DATA_NOT_AVAILABLE` | A stored dataset file cannot be processed |
| 500 | `INTERNAL_ERROR` | Unexpected error (details in server logs only) |

## 4. Validation issue codes (uploads)

`MISSING_REQUIRED_COLUMNS`, `NO_DATA_ROWS`, `UNRECOGNISED_COLUMN`, `REQUIRED_VALUE_MISSING`, `INVALID_DATE`,
`FUTURE_DATE`, `INVALID_NUMBER`, `NOT_WHOLE_NUMBER`, `NEGATIVE_VALUE`, `ZERO_VALUE`, `INVALID_MONTH`,
`INVALID_PINCODE`, `UNRECOGNISED_STATE`, `PINCODE_STATE_MISMATCH`, `DUPLICATE_ROW`, `NAME_NOT_UNIQUE`.
Rows are never deleted; each gets `_row_status` = `valid` | `invalid` | `missing` | `duplicate` | `needs_review`.
