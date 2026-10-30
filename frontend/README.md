# BLUE ORIGIN — Frontend

React + TypeScript + Vite. All data comes from the FastAPI backend, which stores it in Dropbox.
The frontend holds no business data.

```bash
npm install
npm run dev        # http://localhost:5173  (start the backend on :8000 first)
npm run build      # type-check + production build
```

In development Vite proxies `/api` to `http://localhost:8000` (override with `VITE_PROXY_TARGET`).
For a separately hosted backend set `VITE_API_BASE_URL=https://<host>/api` in `.env`.

## Structure

| Path | Purpose |
|---|---|
| `src/types/` | TypeScript interfaces matching the API responses (camelCase) |
| `src/services/api.ts` | `ApiClient` interface — the only thing pages depend on |
| `src/services/httpApi.ts` | `fetch` implementation; unwraps `{ success, data }`, surfaces API error messages |
| `src/pages/` | Dashboard, Sales, Retailers, Distributors, Tiers, Benefits, Reports, **Data** |
| `src/components/RecordForm.tsx` | Create / edit drawer used for benefits and fulfilments |
| `src/hooks/` | `useAsync` (with `reload`), `useListQuery` (search / filters / sort / paging, data-driven defaults) |

## Getting data in

Open **Data** → choose a dataset → pick an `.xlsx`/`.csv` file → **Validate only** to check it, or
**Upload & activate** to store it in Dropbox and make it live (replace or append). Each dataset has a
**Template** with the expected columns. Benefits and fulfilments can also be added and edited
on their own pages.

Dropdown options (quarters, regions, tiers, statuses …), quarter labels and tier thresholds all come from
`GET /api/meta/filters` and `GET /api/tiers/definitions`; only badge colours live in `src/utils/tiers.ts`.
