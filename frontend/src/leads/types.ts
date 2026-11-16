// The lead dashboard payload (GET /api/leads/data), written by backend/app/leads/pipeline/payload.py: keep in sync.
// Rows are column arrays; dimension values are stored once in `dims` and rows refer to them by index (-1 = blank).
// Month fields are indexes into `months` (0 = monthStart).

export interface LeadsPayload {
  version: number;
  builtAt: string;
  asOf: string; // ISO date: the later of the last sales month and the newest lead
  monthStart: number;
  months: string[]; // '2024-09'
  monthQuarter: string[]; // quarter key per month, 'Q3_FY25'
  quarters: string[];
  tierQuarters: string[]; // the quarters retailers.tiers characters refer to
  salesEnd: number; // last month with sales
  hasLeads: boolean;
  hasSpend: boolean;
  hasFollowup: boolean;
  hasContactDates?: boolean; // false when follow-up comes from ASM columns without a call date
  dims: {
    dist: string[];
    state: string[];
    city: string[];
    cityTier: number[]; // per city, index into cityTiers
    cityTiers: string[];
    source: string[]; // Meta, Google, JustDial, Print, Other
    campaign: string[];
    adset: string[];
    owner: string[];
    status: string[];
    tiers: string[]; // Untiered .. Platinum
    outcomes: string[];
    levels: string[]; // floor, likely, ceiling
    windows: number[]; // 30, 60, 90
  };
  retailers: {
    id: string[];
    name: string[];
    d: number[];
    s: number[];
    c: number[];
    pin: string[];
    phone: string[];
    tiers: string[]; // one char per quarter in `quarters` of the sales data: '-' none, '0'..'5'
    first: number[];
    last: number[];
    life: number[];
  };
  rm: { r: number[]; m: number[]; v: number[] };
  leads: {
    day: number[]; // days since 1970-01-01
    m: number[];
    src: number[];
    camp: number[];
    adset: number[];
    s: number[];
    c: number[];
    pin: string[];
    mob: string[];
    name: string[];
    valid: number[];
    uniq: number[];
    pass: number[]; // 0 none, 1 exact, 2 alternate, 3 fuzzy
    conf: number[];
    rf: number[]; // matched retailer per level: floor, likely, ceiling
    rl: number[];
    rc: number[];
    o: string[]; // 9 outcome digits: level-major, window-minor; '' on repeat rows
    gap: number[];
    owner: number[];
    fdist: number[];
    contact: number[]; // first contact day, -1 none
    status: number[]; // follow-up status, or the Category column of an ASM lead sheet
    // ASM columns of the lead sheet (1 yes, 0 no, -1 not filled), one set per mobile
    called: number[];
    visited: number[];
    ordered: number[];
    ordv: number[]; // order value the ASM reported, ₹
    selfEx: number[]; // the lead said it is already a retailer
    zdist: number[]; // BO territory: distributor with the most BO retailers in the lead's pincode, else its city
    att?: number[]; // campaign attribution: 0 Matched, 1 Unmatched, 2 Non-paid (attribution.statuses)
    meth?: number[]; // how it was matched: index into attribution.methods, -1 when not matched
  };
  spend: { camp: number[]; m: number[]; v: number[] };
  targets: Record<string, number>;
  targetsFromFile: string[];
  targetsSet?: string[];
  files: { file: string; kind: string; rows: number; note: string }[];
  steps: { table: string; step: string; rows_in: number; rows_out: number; dropped: number; note: string }[];
  gaps: string[];
  assumptions: string[];
  attribution?: Attribution | null;
  matchReview?: MatchReview[];
  /** spend per campaign and day (days since 1970-01-01), for the weekly trend; absent in data built before it existed */
  adDaily?: { campaigns: string[]; platforms?: string[]; rows: number[][] };   // row: campaign index, day, spend, impressions, clicks, platform leads (older builds: first 3 only)
}

// Lead -> campaign attribution (backend/app/leads/services/attribution.py summary)
export interface Attribution {
  statuses: string[]; // Matched, Unmatched, Non-paid
  methods: string[]; // Lead ID, Campaign ID, Campaign name, Campaign name + date, Date
  exact_methods: number[]; // the methods that are exact links (the rest are fallbacks)
  rows: { source: string; status: number; method: number; submissions: number; unique: number }[];
  reasons: { source: string; reason: string; submissions: number; unique: number }[];
  duplicates: number;
  platforms: Record<string, { saved: boolean; fetched_at: string | null; lead_id_lookup: boolean; lead_campaigns: number; notes: string[] }>;
}

// An ambiguous lead -> retailer match waiting for (or given) a person's decision
export interface MatchReview {
  mobile: string;
  date: string;
  lead_name: string;
  lead_city: string;
  lead_pin: string;
  source: string;
  reason: string;
  score: number;
  retailer_id: string;
  retailer_name: string;
  retailer_city: string;
  retailer_pin: string;
  decision: '' | 'approve' | 'reject';
}

// GET /api/leads/campaign-performance (backend/app/leads/services/spend_service.py)
export interface CampaignKpis {
  spend: number;
  submissions: number;
  unique_leads: number;
  duplicates: number;
  cpl: number | null;
  converted: number;
  judged: number;
  conversion_rate: number | null;
  new_retailers: number;
  cost_per_new_retailer: number | null;
  revenue: number;
  roas: number | null;
  active_days: number;
  spend_per_day: number | null;
  leads_per_day: number | null;
}
export interface CampaignRow extends CampaignKpis {
  key: string;
  name: string;
  platform: string;
  campaign_id: string;
  kind: 'campaign' | 'unmatched' | 'nonpaid';
  objective: string | null;
  status: string | null;
  lead_campaign: boolean;
  daily_budget: number | null;
  lifetime_budget: number | null;
  budget_utilisation: number | null;
  utilisation_basis: string | null;
  score: number | null;
  score_note: string;
}
export interface RankItem { key: string; name: string; platform: string; value: number }
export interface CampaignPerformance {
  period: { start: string; end: string; days: number };
  level: string;
  window: number;
  thresholds: { min_leads: number; min_spend: number; min_new_retailers: number };
  score_weights: Record<string, number>;
  campaigns: CampaignRow[];
  platforms: Record<string, CampaignKpis>;
  monthly: (CampaignKpis & { period: string; platform: string })[];
  quarterly: (CampaignKpis & { period: string; platform: string })[];
  rankings: Record<'lowest_cpl' | 'lowest_cost_per_new_retailer' | 'highest_conversion_rate' | 'highest_revenue' | 'best_overall', RankItem[]>;
  sales_end: string | null;
  spend_saved: Record<string, string | null>;
}

export interface ActionItem {
  id: string;
  recommendation: string;
  owner: string;
  due: string;
  status: 'Not started' | 'In progress' | 'Done' | 'Dropped';
  expected: string;
  achieved: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface LeadsStatus {
  build: { fingerprint?: string; built_at?: string; seconds?: number; inbox?: string[]; lead_rows?: number };
  inbox: { name: string; size: number; modified: string | null }[];
  inbox_folder: string;
  sheets?: SheetsStatus;
}

export interface SheetSource { url: string; name: string }
export interface SheetsStatus {
  sources: SheetSource[];
  serviceAccount: string | null;
  everyMinutes: number;
  last: {
    checked_at?: string;
    sources?: { url: string; name: string; title?: string; error: string | null;
      tabs: { tab: string; file: string; rows: number; updated: boolean; note: string | null }[] }[];
  };
}

// ---- Ad budget screen (GET /api/ads/budget): what the last fetch from Meta / Google saved -----------------------------
export interface BudgetCampaign {
  campaign_id: string;
  name: string;
  status: string;
  status_group: 'active' | 'paused' | 'ended' | 'other';
  objective: string | null;
  daily_budget: number | null;
  daily_budget_source: 'campaign' | 'ad sets' | null;
  lifetime_budget: number | null;
  lifetime_budget_source: 'campaign' | 'ad sets' | null;
  remaining_budget: number | null;
  remaining_basis: string | null;
  adsets: number | null;
  live_adsets: number | null;
  start: string | null;
  end: string | null;
  shared_budget: boolean;
  spend_today: number;
  spend_mtd: number;
  spend_last_7d: number;
  spend_last_month: number;
  spend_this_quarter: number;
  spend_lifetime: number;
  utilization_pct: number | null;
  lifetime_utilization_pct: number | null;
  utilization_basis: string | null;
}
export interface BudgetAccount {
  account: { account_id: string; name: string | null; currency: string | null; timezone: string | null; status: string | null; created_time?: string | null; business_name?: string | null; is_manager?: boolean };
  campaigns: BudgetCampaign[];
  monthly: { period: string; spend: number }[];
  quarterly: { period: string; spend: number; first_month: string }[];
  campaign_monthly: { campaign_id: string; period: string; spend: number }[];
  campaign_quarterly: { campaign_id: string; period: string; spend: number }[];
  today: string;
  days_elapsed: number;
  /** Campaign performance (the campaigns the backend keeps), backend app/ads/gt.py; absent in data saved before it existed */
  gt?: GtMetrics;
}
export interface GtMetrics {
  filter: string;
  campaign_monthly: { campaign_id: string; period: string; spend: number; impressions: number; reach: number | null; clicks: number; link_clicks: number | null; leads: number; all_conversions?: number }[];
  lifetime_reach: { campaign_id: string; reach: number }[];
  combined_monthly_reach: { period: string; reach: number }[];
  combined_lifetime_reach: number | null;
  leads_basis: string;
  has_reach: boolean;
}
export interface BudgetSnapshot {
  platform: 'meta' | 'google';
  fetched_at: string;
  /** made-up figures (GOOGLE_ADS_MODE=sample): shown only on the Ad budget page, never in any total */
  sample?: boolean;
  note?: string;
  accounts: BudgetAccount[];
  unreachable: { account_id: string | null; error: string | null }[];
}
export interface BudgetPlatform {
  configured: boolean;
  missing: string[];
  refreshing: boolean;
  error: string | null;
  snapshot: BudgetSnapshot | null;
  auto_minutes: number;
  /** Google only: GOOGLE_ADS_MODE (off | sample | sheet | live); Meta is always live */
  mode?: 'off' | 'sample' | 'sheet' | 'live';
}
export type BudgetPayload = Record<'meta' | 'google', BudgetPlatform>;

// Ad detail (GET /api/ads/budget/detail, backend app/ads/detail.py): ad sets, ads, breakdowns, keywords ... as last saved.
export interface PerfRow { spend: number; impressions: number; reach: number; clicks: number; link_clicks: number; leads: number }
export interface MetaMonthly extends PerfRow { period: string; campaign_id: string; adset_id?: string; ad_id?: string }
export interface MetaLife extends PerfRow { campaign_id: string; adset_id?: string; ad_id?: string; frequency: number | null }
export interface MetaAdset {
  adset_id: string; campaign_id: string; name: string; status: string | null; daily_budget: number | null; lifetime_budget: number | null; optimization_goal: string | null;
  audience: { age: string; gender: string; locations: string; location_count: number; custom_audiences: number; excluded_audiences: number; interests: string[]; advantage_audience: boolean };
  placements: { text: string; positions: string[] };
}
export interface MetaAd { ad_id: string; adset_id: string; campaign_id: string; name: string; status: string | null; format: string | null; creative_name: string | null; headline: string | null; body: string | null; cta: string | null }
export interface MetaDetail {
  platform: 'meta'; fetched_at: string; adsets: MetaAdset[]; ads: MetaAd[]; adset_life: MetaLife[]; ad_life: MetaLife[]; adset_monthly: MetaMonthly[]; ad_monthly: MetaMonthly[];
  breakdowns: Record<'placement' | 'age_gender' | 'region' | 'device', (MetaMonthly & Record<string, string | number>)[]>;
  events: { campaign_id: string; action_type: string; value: number }[]; errors: Record<string, string>;
}
export interface GoogleTab { available: boolean; error: string | null; rows: Record<string, string | number>[]; capped?: number }
export interface GoogleDetail { platform: 'google'; fetched_at: string; tabs: Record<'keywords' | 'search_terms' | 'devices' | 'geo' | 'conversions', GoogleTab> | null; reason?: string; lead_action: string }
export interface AdDetail { meta: MetaDetail | null; google: GoogleDetail | null }
