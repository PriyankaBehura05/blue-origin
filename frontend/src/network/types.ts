// BO Retailer Network: shape of the consolidated payload (bo_pipeline.py -> GET /api/network/data)
// and of the report views built from it in the browser.

export interface RawRetailer {
  id: string;
  n: string; // name
  d: number; // index into distributors
  m: number[]; // revenue per month (order of `months`)
  t: number[]; // tier index per quarter, -1 = not listed that quarter
  fl: number; // first listed quarter
  ds?: string; // district
  ct?: string; // city / locality (filled from /INFORMATION/BO_Consolidate_Final.xlsx)
  pin?: string;
  ph?: string;
  pa?: string; // alternate phones, " | " joined
  rt?: number[]; // tier reported in the distributor sheet
  b?: number[]; // tier basis per quarter when it differs from the month sum
  bn?: string[]; // benefits per quarter: one char per benefit, 0 = no, 1 = yes, 2 = cancelled
  dl?: string;
}

export interface Payload {
  generated: string;
  months: string[]; // "Sept_24", "Oct_24", ...
  quarters: string[]; // "Q3_FY25", ...
  monthQ: number[];
  tiers: string[]; // "Untiered", "Yellow", ... "Platinum"
  slabs: Record<string, number>;
  tierFrom?: Record<string, string>; // first quarter of a tier that starts later: { Platinum: "Q1_FY27" }
  slabsByQuarter?: Record<string, Record<string, number>>; // minimum per tier in each quarter (Silver 2.5 L until Q1 FY 27, 3 L after)
  benefits: string[];
  distributors: { n: string; s: string; r: string }[];
  regions: string[];
  scheme: Record<string, Record<string, string>>;
  retailers: RawRetailer[];
  stats: {
    source_rows: number;
    retailers: number; // one per Code name (shop name + distributor): no duplicate merging
  };
}

export interface Retailer extends RawRetailer {
  dist: string;
  state: string;
  region: string;
  q: number[]; // revenue per quarter
  basis: number[]; // tier basis per quarter
  first: number; // first active month index (-1 = none)
  firstQ: number;
  life: number;
  lastQ: number;
  best: number;
  key: string; // search text
  nameKey: string; // cleaned name, to match live sheet rows
  phones: string[];
}

export interface Model {
  p: Payload;
  R: Retailer[];
  byId: Map<string, Retailer>;
  Q: string[];
  M: string[];
  MQ: number[];
  TIERS: string[];
  LQ: number;
}

export type ColType = 'text' | 'inr' | 'num' | 'pct' | 'tier' | 'link' | 'status' | 'wrap';
export interface Col {
  k: string;
  label: string;
  type?: ColType;
  w?: number; // Excel column width
}
export type Row = Record<string, unknown>;
export interface Table {
  id: string;
  title: string;
  caption?: string;
  cols: Col[];
  rows: Row[];
  matrix?: boolean;
  total?: boolean; // summary table: the Excel download gets a TOTAL row
}
export interface Kpi {
  label: string;
  value: string;
  delta?: number | null;
  sub?: string;
  tone?: 'up' | 'down';
}
export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
}
export interface Chart {
  id: string;
  title: string;
  caption?: string;
  kind: 'bar' | 'stack' | 'group' | 'line';
  labels: string[];
  series: Series[];
  fmt?: 'inr' | 'num' | 'pct';
  wide?: boolean;
  highlight?: number[];
  onClickKey?: 'month' | 'quarter';
  // extra figures shown only in the hover tooltip (not drawn), one value per label
  tipExtra?: { name: string; values: number[]; fmt: 'inr' | 'num' }[];
  colors?: string[]; // one colour per bar (single-series bar charts)
}
export interface View {
  lead?: string;
  note?: string;
  kpis?: Kpi[];
  charts?: Chart[];
  tables: Table[];
}

export interface Filters {
  region: string;
  state: string;
  dist: string;
  q: number; // -1 = all quarters
  tier: string; // '' | 'tiered' | tier name
  m: number; // month index (New retailers)
  near: number; // % of next slab (Upgrade pipeline)
  mv: string; // tier movement category (Tier movement), '' = all
}
