# Effectiveness of Paid Lead Gen Campaigns: the brief

Saved as given. Nothing in it is built yet except the empty page shells (see `pages.ts`). No data is loaded.

## Role
Senior growth analyst and BI developer at Technosport (sportswear brand, B2B retail network across GT/distributor
channels). Build a leadership-grade interactive dashboard: "Effectiveness of Paid Lead Gen Campaigns". Every number must
reconcile; every insight must end in an action with an owner. Flag anything that doesn't reconcile, never smooth it over.

## Inputs
1. Lead dump (Meta/Google forms, JustDial, Print): lead date, mobile, name, city, pincode, source, campaign, ad set
2. Sales register (invoice level): retailer code, mobile(s), invoice date, net value, category, distributor, ASM/RSM, state/city
3. Retailer master: first billing date, alternate numbers, onboarding source (if available)
4. Marketing spend by campaign x month (if missing: flag it, skip ROI tiles)
5. Lead follow-up log (if available): assigned to ASM/distributor, contact date, status
6. Targets sheet (if available; else placeholders that can be edited): conversion %, paid share of new retailers,
   cost per converted retailer, new retailers/quarter

## Data prep
- Normalise mobiles: last 10 digits, strip +91/0, validate. Report rows dropped at each step.
- Lead -> retailer matching in 3 passes: (1) exact mobile, (2) alternate/distributor numbers, (3) fuzzy name + city +
  pincode with confidence score. Report counts per pass. Show base-case vs upper-bound conversion to size undercount risk.
- Deduplicate leads to unique mobiles. Repeat rate = (total - unique) / total, by campaign.
- One fixed reporting window for all acquisition counts; state it on every page.

## Lead classification (mutually exclusive, must sum to total unique leads)
- Existing active: billed in 90 days before lead date
- Dormant -> reactivated: prior billing, inactive > 90 days, billed after lead
- New -> converted: first-ever bill within attribution window after lead (default 60 days, adjustable 30/60/90)
- Not converted
- Unmatchable: invalid/missing number
Include a reconciliation table proving buckets = total.

## Retailer classification
- Acquisition source: Paid / Print / Distributor-led / ASM-RSM / Unattributed-WoM
- Health: Active (< 45 days since order), At-risk (45-90), Churned (> 90)

## Pages
1. **Executive cover** (one screen)
   - Answer: Is paid lead gen working? Where should the next rupee go? What's at risk?
   - 6 KPI tiles with RAG vs target and QoQ delta: unique leads, lead -> transaction conversion %, new retailers from paid
     (and % of all new), retention revenue %, cost per converted retailer, revenue at risk
   - Max 5 headline insights, format: Insight -> Number -> Action -> Owner
   - One sequenced recommendation (this quarter vs next), no parallel priorities
   - Run-rate projection: "At current pace Q_ adds N retailers vs target M"
2. **Lead funnel**
   - Leads -> unique -> matchable -> converted -> repeat (2+ orders), by source/campaign/month
   - Repeat-lead rate by campaign; new-acquisition vs reactivation split
   - Time-to-first-order distribution + lead-age decay curve (when to retarget)
3. **Acquisition mix**
   - New retailers per quarter stacked by source
   - Quality comparison, marketing vs organic: AOV, orders in first 90 days, 90-day revenue, M1/M3 retention, category
     mix; note small-sample significance
   - LTV by acquisition source
4. **Campaign scorecard**
   - Per campaign: spend, leads, CPL, repeat %, converted, cost per converted retailer, 90-day revenue, payback months,
     6-month ROI
   - Auto-tag Scale / Fix / Kill with the rule shown
5. **Field & distributor leaderboards**
   - ASM/RSM: new retailers, activation rate, retention, leads assigned vs converted
   - Distributor: new outlets added, lead follow-up conversion
6. **Lead ageing & follow-up SLA**
   - Unconverted leads by age: 0-7 / 8-30 / 31-60 / 60+ days
   - Assigned vs no follow-up recorded; SLA breaches by owner
7. **Retention & churn**
   - Revenue split new vs existing retailers
   - Monthly cohort retention heatmap
   - Quarterly revenue waterfall: opening + new - churned +/- expansion = closing
   - At-risk retailer list with revenue at risk
8. **Geography**
   - State/city heat map: leads vs conversions vs existing retailer density
   - White-space cities: high leads, low retailer base
9. **Untapped pool**
   - Not-converted leads + JustDial/business-repo contacts, segmented by city tier and lead recency
   - Recommended channel per segment (WhatsApp blast / AI voice call / ASM visit)
   - Downloadable CSV call/blast lists
10. **What-if simulator**
    - Sliders: budget, conversion %, AOV, retention %
    - Output: projected new retailers, revenue, ROI next quarter
11. **Actions tracker**
    - Recommendation, owner, due date, status, expected vs achieved impact (editable, persists)
12. **Data quality & definitions**
    - Missing-mobile rows % and their revenue share, match rate by pass, confidence spread
    - Attribution-window sensitivity (30/60/90)
    - Glossary: lead, unique lead, converted, reactivated, organic, attribution window
    - Data refresh date and source per tile

## Interactivity
- Global filters: quarter/month, source, campaign, zone/state/city, distributor, ASM, attribution window
- Drill-down: Zone -> State -> City -> Distributor -> ASM -> Retailer; Source -> Campaign -> Ad set -> Lead, with breadcrumbs
- Hover on every % shows numerator/denominator
- "So what" line under every chart
- Export: cover page to PDF/PPT; all tables to CSV

## Design
- Clean board-review style, consistent colours per source across all charts, light/dark friendly, works on laptop and phone
- Indian number format (lakhs/crores), rupee sign

## Deliverables
1. The dashboard
2. Python/pandas pipeline that produces it, rerunnable monthly with new files
3. Methodology notes + reconciliation table
4. List of every assumption made and data gap found

## Addendum (2026-11-09): layout, navigation, interactivity, design, deliverables
- Single scrolling dashboard: the 12 sections one below another, no tab bar and no tabbed sub-views. Sections now:
  1 Executive cover · 2 Lead funnel & quality · 3 Organic vs marketing · 4 Campaign scorecard · 5 Distributors & field ·
  6 Lead ageing & scoring · 7 Retention & tiers · 8 Geography · 9 Untapped pool · 10 Forecast & what-if ·
  11 Retailer list & actions · 12 Data quality & method.
- Left icon rail (collapsible, sticky; bottom icon bar on mobile): one line icon per section, tooltip, active icon
  follows the scroll, click jumps. Section header = icon + title + one-line "so what".
- KPI tiles: icon + RAG dot + QoQ arrow. Alternate views: icon toggles or dropdowns inside the card, never tabs.
- Sticky global filter bar with a filter icon: quarter/month, source, campaign, state, city, distributor, tier, outcome,
  matching level (floor/likely/ceiling), attribution window. "Filter not applied" icon on cards a filter does not affect.
  "i" on every card: definition + numerator ÷ denominator. Download icon on every table (CSV); cover exports PDF/PPT.
- Drill-down: State → City → Distributor → Retailer; Source → Campaign → Lead, with breadcrumbs.
  Hover on every % shows numerator ÷ denominator; rates show the 95% CI.
- Design: board-review style, one colour per source / outcome / tier everywhere, monochrome icons (colour only for RAG),
  light/dark, laptop and phone.
- Deliverables: the dashboard; a rerunnable pandas pipeline (drop files → refreshed dashboard); a reconciliation sheet
  with every assumption and data gap; a one-page findings memo for leadership.

## Change (2026-11-09, user): separate pages, not one scrolling page
- Each section is its own page (`/leads/<section>`), opened from icon links in the sidebar, like the BO Dashboard.
  This replaces "single scrolling dashboard" and the in-page icon rail above; everything else in the addendum stands.
