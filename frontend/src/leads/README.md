# Lead Generation Dashboard (frontend)

12 pages, one per section (`/leads/<section>`), opened from the icon menu in the sidebar like the BO Dashboard, with a
sticky global filter bar. Data loads once and stays while moving between pages, so filters and unsaved actions carry
over. No tabs inside pages: alternate views are icon toggles or dropdowns inside a card.

    leads/
      SPEC.md          the brief, including the layout / navigation addendum
      LeadsPage.tsx    loads the data, filter bar, renders the page named in the address
      sections.ts      page ids (addresses), menu icons, titles, one-line "so what"; colours per source / outcome / tier
      sections/*.tsx   one file per section (Cover ... Quality)
      model.ts         indexes over the payload, filters, periods, health, acquisition source, Wilson CI, RAG
      calc.ts          calculations shared by several sections (retailer stats, run-rate, first-90-day quality)
      ui.tsx           Card (info "i", filter-not-applied icon, CSV export), Kpi tile, Pct (n ÷ d + 95% CI), Table,
                       IconToggle, MiniSelect, Crumbs, Section frame
      charts.tsx       recharts wrappers: stacked bars, lines, waterfall, heat-cell shading
      api.ts, types.ts the /api/leads calls and the payload shape (mirrors backend/app/leads/pipeline/payload.py)
      leads.css        all styles, scoped under .ld (light and dark)

Every card lists the global filters it responds to (`uses`); an active filter outside that list shows the
"filter not applied" icon. /leads opens the cover; old addresses (simulator, actions, list) redirect.

Rules
- Nothing in here imports from the BO Dashboard (`pages/`, `network/`). Shared basics (`@/components/ui`,
  `@/components/HelpTip`, `@/services/session`, `@/utils`) are fine.
- The BO Dashboard never imports from here. Only `App.tsx` and `components/Layout.tsx` use `@/leads`.
