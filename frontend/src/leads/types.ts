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
  };
  spend: { camp: number[]; m: number[]; v: number[] };
  targets: Record<string, number>;
  targetsFromFile: string[];
  targetsSet?: string[];
  files: { file: string; kind: string; rows: number; note: string }[];
  steps: { table: string; step: string; rows_in: number; rows_out: number; dropped: number; note: string }[];
  gaps: string[];
  assumptions: string[];
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
