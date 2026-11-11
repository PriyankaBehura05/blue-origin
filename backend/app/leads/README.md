# Lead Generation (backend)

Everything for this module lives in this package. The brief is in `frontend/src/leads/SPEC.md`.

    app/leads/
      router.py              /api/leads/... : data, status, rebuild, inbox upload/remove, reconciliation, memo,
                             actions, targets (mounted in app/api/router.py behind sign-in; changes need editor/admin)
      services/leads_service.py   store layout, build-on-change (fingerprint), actions tracker, targets
      pipeline/              the pandas pipeline (see pipeline/__init__.py for the steps)

Store layout (`<DROPBOX_ROOT>/...`)

    leads/inbox/        drop lead exports, spend, follow-up log, targets here (CSV / Excel); any name
    leads/out/          dashboard.json.gz, reconciliation.xlsx, memo.md, build.json   (written by the pipeline)
    leads/actions.json  actions tracker      leads/targets.json  targets saved in the dashboard
    network/            the BO Dashboard's outputs: only ever READ here (retailers, retailer_month, retailer_quarter)

Rerun: a new or changed file in the inbox (or a new BO build) changes the fingerprint; the next request rebuilds
(~20 s). "Rebuild now" on the dashboard forces it. On local folders, without Dropbox:

    python -m app.leads.pipeline --inbox <folder> --sales <folder with the network csvs> --out <folder>

Rules
- Nothing in here imports from the BO Dashboard code (`app/pipeline`, `app/services/network_service`, ...).
  Shared basics (`app.core`, `app.storage`, `app.api.deps`) are fine. The BO Dashboard never imports from here.
- Definitions (outcomes, health, retention, revenue at risk) are mirrored in frontend/src/leads/model.ts and calc.ts;
  change both together. The payload shape is mirrored in frontend/src/leads/types.ts.
- Tests: tests/leads/ (small fictional data only).

## Google Sheets (automatic)

Lead, spend, follow-up and targets tabs can stay in Google Sheets: paste the links on the **Data quality & method**
page (or PUT /api/leads/sheets). The backend re-reads them every `LEADS_SHEETS_MINUTES` (default 10), saves a copy of
each tab in `<DROPBOX_ROOT>/leads/sheets/` only when it changed, and rebuilds the dashboard. Access uses the BO
service-account key (`BO_GOOGLE_KEY`): share each sheet with that account's email as Viewer. Without the key only
sheets shared as "Anyone with the link can view" are read. Code: `services/sheets_source.py`.

## ASM columns on the lead sheet, and the link to BO (read-only)

A lead tab may carry its own follow-up: `ASM NAME`, `Calling Done`, `Visit Done`, `Order Placed`, `Order Value`,
`Category`, and the lead's answer `retailer` / `Existing Retailer` (exact headers only). One set per mobile: yes on any
row counts, the latest ASM and category win. A separate follow-up log, when present, takes precedence.

Links to the BO data, which is only ever read (`network/*.csv`):
* **Matching** - every lead to a BO retailer (phone, alternate phone, fuzzy name in the same pincode/city): outcomes,
  distributor, tier and billing come from BO.
* **BO territory distributor** - an unmatched lead gets the distributor with the most BO retailers in its pincode,
  else its city (`zdist`), so every lead rolls up to a distributor.
* **Reported orders vs BO billing** - an ASM's "Order placed" is confirmed when the matched retailer billed in the lead
  month or the 2 after it; "too recent" when those months are past the last sales month.
* **"Already a retailer" vs BO** - the lead's own answer against a BO first bill before the lead month.
* **Too recent to judge** - leads whose window runs past the last BO sales month stay out of conversion rates.
