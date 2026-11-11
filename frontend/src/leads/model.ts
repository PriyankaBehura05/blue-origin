// The lead dashboard's model: indexes built once from the payload, the global filters, and the shared definitions
// every section uses. Definitions match backend/app/leads/pipeline (classify.py, metrics.py): keep them in step.
import type { LeadsPayload } from './types';

export const EXISTING = 0;
export const REACTIVATED = 1;
export const NEW = 2;
export const NOT_CONVERTED = 3;
export const UNMATCHABLE = 4;
export const PENDING = 5; // too recent to judge: its window runs past the last month of sales data
/** A lead someone can still work: not converted (yet), whether or not its window has closed. */
export const isOpen = (o: number) => o === NOT_CONVERTED || o === PENDING;
export const ORGANIC = 5; // source filter value / acquisition source for retailers no lead brought in

export type FilterKey = 'period' | 'source' | 'campaign' | 'state' | 'city' | 'dist' | 'tier' | 'outcome' | 'level' | 'window';
export interface Filters {
  period: string; // 'all' | 'q:Q2_FY27' | 'm:<month index>'
  source: number; // -1 all, 0..4 lead source, 5 Organic
  campaign: number;
  state: number;
  city: number;
  dist: number;
  tier: number;
  outcome: number;
  level: number; // 0 floor, 1 likely, 2 ceiling
  window: number; // 30 | 60 | 90
}
export const FILTER_LABELS: Record<FilterKey, string> = {
  period: 'Period', source: 'Source', campaign: 'Campaign', state: 'State', city: 'City', dist: 'Distributor',
  tier: 'Tier', outcome: 'What happened', level: 'Matching', window: 'Sale within',
};
/** How sure a lead-to-retailer match must be: floor / likely / ceiling in the pipeline. */
export const LEVEL_NAMES = ['Strict', 'Normal', 'Loose'];
export const LEVEL_HELP = [
  'Strict: only the same mobile number',
  'Normal: same main or other mobile number, or a near-identical shop name in the same area',
  'Loose: also shop names that are only similar',
];
// filters that always have a value (not "active" in the sense of narrowing the data)
export const ALWAYS_ON: FilterKey[] = ['period', 'level', 'window'];

export interface Model {
  p: LeadsPayload;
  nR: number;
  nM: number;
  nL: number;
  rev: Float64Array; // nR * nM
  qMonths: Record<string, number[]>;
  tierQ: Record<string, number>; // quarter -> character position in retailers.tiers
  asOfDay: number;
  ret: number[][]; // matched retailer per level
  acqCache: Map<string, { lead: Int32Array; src: Int8Array }>;
  latestQuarter: string; // latest quarter with sales
}

export function buildModel(p: LeadsPayload): Model {
  const nR = p.retailers.id.length;
  const nM = p.months.length;
  const rev = new Float64Array(nR * nM);
  const { r, m, v } = p.rm;
  for (let i = 0; i < r.length; i++) rev[r[i] * nM + m[i]] += v[i];
  const qMonths: Record<string, number[]> = {};
  p.monthQuarter.forEach((q, i) => (qMonths[q] ??= []).push(i));
  const tierQ: Record<string, number> = {};
  p.tierQuarters.forEach((q, i) => (tierQ[q] = i));
  return {
    p, nR, nM, nL: p.leads.day.length, rev, qMonths, tierQ,
    asOfDay: Math.floor(Date.parse(p.asOf + 'T00:00:00Z') / 86400000),
    ret: [p.leads.rf, p.leads.rl, p.leads.rc],
    acqCache: new Map(),
    latestQuarter: p.monthQuarter[p.salesEnd],
  };
}

export const defaultFilters = (M: Model): Filters => ({
  period: `q:${M.latestQuarter}`, source: -1, campaign: -1, state: -1, city: -1, dist: -1, tier: -1, outcome: -1, level: 1, window: 60,
});

export function activeFilters(f: Filters): FilterKey[] {
  return (Object.keys(FILTER_LABELS) as FilterKey[]).filter((k) => !ALWAYS_ON.includes(k) && (f[k] as number) !== -1);
}

// ---- periods ---------------------------------------------------------------------------------------------------
export type Range = [number, number];

export function rangeOf(M: Model, period: string): Range {
  if (period.startsWith('q:')) {
    const ms = M.qMonths[period.slice(2)] ?? [];
    return ms.length ? [ms[0], ms[ms.length - 1]] : [0, M.nM - 1];
  }
  if (period.startsWith('m:')) {
    const i = Number(period.slice(2));
    return [i, i];
  }
  return [0, M.nM - 1];
}

export function prevPeriod(M: Model, period: string): string | null {
  if (period.startsWith('q:')) {
    const i = M.p.quarters.indexOf(period.slice(2));
    return i > 0 ? `q:${M.p.quarters[i - 1]}` : null;
  }
  if (period.startsWith('m:')) {
    const i = Number(period.slice(2));
    return i > 0 ? `m:${i - 1}` : null;
  }
  return null;
}

export const periodMonths = (rg: Range) => rg[1] - rg[0] + 1;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthName(M: Model, i: number): string {
  const [y, mm] = M.p.months[i].split('-');
  return `${MON[Number(mm) - 1]} ${y}`;
}
export function quarterName(q: string): string {
  const m = /^Q([1-4])_FY(\d{2})$/.exec(q);
  if (!m) return q;
  const n = Number(m[1]);
  const y = 2000 + Number(m[2]) - (n === 4 ? 0 : 1);
  return `Q${n} FY ${m[2]} (${['Apr–Jun', 'Jul–Sep', 'Oct–Dec', 'Jan–Mar'][n - 1]} ${y})`;
}
export const quarterShort = (q: string) => q.replace(/^Q(\d)_FY(\d+)$/, 'Q$1 FY$2');
export function periodName(M: Model, period: string): string {
  if (period.startsWith('q:')) return quarterName(period.slice(2));
  if (period.startsWith('m:')) return monthName(M, Number(period.slice(2)));
  return `All (${monthName(M, 0)} – ${monthName(M, M.nM - 1)})`;
}

// ---- retailers -----------------------------------------------------------------------------------------------------
export const billed = (M: Model, r: number, m: number) => m >= 0 && m < M.nM && M.rev[r * M.nM + m] > 0;

export function revIn(M: Model, r: number, a: number, b: number): number {
  let s = 0;
  const base = r * M.nM;
  for (let m = Math.max(0, a); m <= Math.min(b, M.nM - 1); m++) s += M.rev[base + m];
  return s;
}

export function billedIn(M: Model, r: number, a: number, b: number): boolean {
  const base = r * M.nM;
  for (let m = Math.max(0, a); m <= Math.min(b, M.nM - 1); m++) if (M.rev[base + m] > 0) return true;
  return false;
}

export function lastBilledUpTo(M: Model, r: number, b: number): number {
  const base = r * M.nM;
  for (let m = Math.min(b, M.nM - 1); m >= 0; m--) if (M.rev[base + m] > 0) return m;
  return -1;
}

export type Health = 'Active' | 'At-risk' | 'Churned' | 'Not yet';
export function health(M: Model, r: number, end: number): Health {
  const l = lastBilledUpTo(M, r, end);
  if (l < 0) return 'Not yet';
  if (l >= end - 1) return 'Active';
  return l === end - 2 ? 'At-risk' : 'Churned';
}
// one quarter's run-rate: the 3 months of billing up to the last bill
export const riskRevenue = (M: Model, r: number, end: number) => {
  const l = lastBilledUpTo(M, r, end);
  return l < 0 ? 0 : revIn(M, r, l - 2, l);
};

export function tierAt(M: Model, r: number, month: number): number {
  const q = M.p.monthQuarter[Math.min(month, M.nM - 1)];
  const j = M.tierQ[q];
  if (j === undefined) return -1;
  const ch = M.p.retailers.tiers[r]?.[j];
  return ch && ch !== '-' ? Number(ch) : -1;
}

/** Which lead (if any) brought each retailer in, at a matching level + window; and its source (ORGANIC when none). */
export function acquisition(M: Model, level: number, window: number) {
  const key = `${level}:${window}`;
  const hit = M.acqCache.get(key);
  if (hit) return hit;
  const lead = new Int32Array(M.nR).fill(-1);
  const src = new Int8Array(M.nR).fill(ORGANIC);
  const L = M.p.leads;
  const ret = M.ret[level];
  for (let i = 0; i < M.nL; i++) {
    if (outcomeOf(M, i, level, window) !== NEW) continue;
    const r = ret[i];
    if (r < 0) continue;
    if (lead[r] < 0 || L.day[i] < L.day[lead[r]]) {
      lead[r] = i;
      src[r] = L.src[i];
    }
  }
  const out = { lead, src };
  M.acqCache.set(key, out);
  return out;
}

export function retailerOk(M: Model, f: Filters, r: number, end: number, skip: FilterKey[] = []): boolean {
  const R = M.p.retailers;
  if (f.state >= 0 && !skip.includes('state') && R.s[r] !== f.state) return false;
  if (f.city >= 0 && !skip.includes('city') && R.c[r] !== f.city) return false;
  if (f.dist >= 0 && !skip.includes('dist') && R.d[r] !== f.dist) return false;
  if (f.tier >= 0 && !skip.includes('tier') && tierAt(M, r, end) !== f.tier) return false;
  if ((f.source >= 0 && !skip.includes('source')) || (f.campaign >= 0 && !skip.includes('campaign'))) {
    const acq = acquisition(M, f.level, f.window);
    if (f.source >= 0 && !skip.includes('source') && acq.src[r] !== f.source) return false;
    if (f.campaign >= 0 && !skip.includes('campaign') && (acq.lead[r] < 0 || M.p.leads.camp[acq.lead[r]] !== f.campaign)) return false;
  }
  return true;
}

// ---- leads ---------------------------------------------------------------------------------------------------------
export function outcomeOf(M: Model, i: number, level: number, window: number): number {
  const o = M.p.leads.o[i];
  if (!o) return -1;
  const w = M.p.dims.windows.indexOf(window);
  return Number(o[level * 3 + (w < 0 ? 1 : w)]);
}

export function leadOk(M: Model, f: Filters, i: number, rg: Range | null, skip: FilterKey[] = []): boolean {
  const L = M.p.leads;
  if (rg && (L.m[i] < rg[0] || L.m[i] > rg[1])) return false;
  if (f.source >= 0 && !skip.includes('source') && (f.source === ORGANIC || L.src[i] !== f.source)) return false;
  if (f.campaign >= 0 && !skip.includes('campaign') && L.camp[i] !== f.campaign) return false;
  const r = M.ret[f.level][i];
  const R = M.p.retailers;
  if (f.state >= 0 && !skip.includes('state') && (L.s[i] >= 0 ? L.s[i] : r >= 0 ? R.s[r] : -1) !== f.state) return false;
  if (f.city >= 0 && !skip.includes('city') && (L.c[i] >= 0 ? L.c[i] : r >= 0 ? R.c[r] : -1) !== f.city) return false;
  if (f.dist >= 0 && !skip.includes('dist') && leadDist(M, i, r) !== f.dist) return false;
  if (f.tier >= 0 && !skip.includes('tier') && (r < 0 || tierAt(M, r, rg ? rg[1] : M.p.salesEnd) !== f.tier)) return false;
  if (f.outcome >= 0 && !skip.includes('outcome') && outcomeOf(M, i, f.level, f.window) !== f.outcome) return false;
  return true;
}

/** The lead's distributor: the matched BO retailer's, else the one the follow-up log assigns, else the BO territory one. */
export function leadDist(M: Model, i: number, r: number): number {
  const L = M.p.leads;
  return r >= 0 ? M.p.retailers.d[r] : L.fdist[i] >= 0 ? L.fdist[i] : L.zdist?.[i] ?? -1;
}

export type BoCheck = 'billed' | 'not billed' | 'pending';
/** An ASM's "order placed" against BO billing: the matched retailer billed in the lead month or the 2 months after. */
export function boOrderCheck(M: Model, i: number, level: number): BoCheck {
  const r = M.ret[level][i];
  const m0 = M.p.leads.m[i];
  if (r >= 0) for (let m = m0; m <= Math.min(m0 + 2, M.nM - 1); m++) if (M.rev[r * M.nM + m] > 0) return 'billed';
  return m0 + 2 > M.p.salesEnd ? 'pending' : 'not billed';
}

/** Lead was contacted: a contact date in the follow-up log, or Calling Done = yes on the ASM sheet. */
export const wasCalled = (M: Model, i: number) => M.p.leads.contact[i] >= 0 || M.p.leads.called?.[i] === 1;

export interface LeadAgg {
  rows: number;
  unique: number;
  valid: number;
  judged: number; // valid unique leads whose window has closed: the denominator of every conversion rate
  matched: number;
  out: number[]; // per outcome, unique leads
  repeatRetailers: number; // new -> converted retailers billed in 2+ months
}

export function leadAgg(M: Model, f: Filters, rg: Range | null, pick?: (i: number) => boolean): LeadAgg {
  const L = M.p.leads;
  const a: LeadAgg = { rows: 0, unique: 0, valid: 0, judged: 0, matched: 0, out: [0, 0, 0, 0, 0, 0], repeatRetailers: 0 };
  const ret = M.ret[f.level];
  for (let i = 0; i < M.nL; i++) {
    if (!leadOk(M, f, i, rg) || (pick && !pick(i))) continue;
    a.rows++;
    if (!L.uniq[i]) continue;
    a.unique++;
    if (L.valid[i]) a.valid++;
    if (ret[i] >= 0) a.matched++;
    const o = outcomeOf(M, i, f.level, f.window);
    if (o >= 0) a.out[o]++;
    if (L.valid[i] && o !== PENDING) a.judged++;
    if (o === NEW && billedMonths(M, ret[i]) >= 2) a.repeatRetailers++;
  }
  return a;
}

export function billedMonths(M: Model, r: number): number {
  let n = 0;
  const base = r * M.nM;
  for (let m = 0; m < M.nM; m++) if (M.rev[base + m] > 0) n++;
  return n;
}

export const leadAgeDays = (M: Model, i: number) => M.asOfDay - M.p.leads.day[i];

// ---- statistics ----------------------------------------------------------------------------------------------------
/** 95% Wilson interval, as fractions. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export const SMALL_SAMPLE = 30;

// ---- RAG -----------------------------------------------------------------------------------------------------------
export type Rag = 'green' | 'amber' | 'red' | 'none';
/** green at/above target, amber within 20% short, red beyond (inverted when lower is better). */
export function rag(value: number | null, target: number | null, lowerIsBetter = false): Rag {
  if (value === null || target === null || !isFinite(value) || !isFinite(target) || target === 0) return 'none';
  const ratio = lowerIsBetter ? target / Math.max(value, 1e-9) : value / target;
  if (ratio >= 1) return 'green';
  return ratio >= 0.8 ? 'amber' : 'red';
}

// spend in a range (optionally one campaign)
export function spendIn(M: Model, rg: Range, campaign = -1): number {
  const S = M.p.spend;
  let s = 0;
  for (let i = 0; i < S.v.length; i++) {
    if (campaign >= 0 && S.camp[i] !== campaign) continue;
    if (S.m[i] >= 0 ? S.m[i] < rg[0] || S.m[i] > rg[1] : false) continue;
    s += S.v[i];
  }
  return s;
}
