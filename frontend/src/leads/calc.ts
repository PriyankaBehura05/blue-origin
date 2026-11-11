// Calculations shared by several sections (cover, forecast, distributors, memo-style insights).
import {
  acquisition, billedIn, health, lastBilledUpTo, leadAgg, leadOk, NEW, ORGANIC, retailerOk, revIn, riskRevenue,
  type Filters, type LeadAgg, type Model, type Range,
} from './model';

export interface RetailerStats {
  newAll: number; // first bill in the period
  newMkt: number; // ... of which a lead brought in
  revenue: number;
  revenueMkt: number; // revenue of retailers a lead brought in
  billed: number; // retailers billed in the period
  prevBilled: number; // retailers billed in the previous period
  retained: number; // ... who billed again in this period
  atRisk: number;
  atRiskRevenue: number;
  churned: number;
  active: number;
}

export function retailerStats(M: Model, f: Filters, rg: Range, prev: Range | null): RetailerStats {
  const R = M.p.retailers;
  const acq = acquisition(M, f.level, f.window);
  const s: RetailerStats = { newAll: 0, newMkt: 0, revenue: 0, revenueMkt: 0, billed: 0, prevBilled: 0, retained: 0, atRisk: 0, atRiskRevenue: 0, churned: 0, active: 0 };
  const end = Math.min(rg[1], M.p.salesEnd);
  for (let r = 0; r < M.nR; r++) {
    if (!retailerOk(M, f, r, end)) continue;
    const mkt = acq.src[r] !== ORGANIC;
    const first = R.first[r];
    if (first >= rg[0] && first <= rg[1]) {
      s.newAll++;
      if (mkt) s.newMkt++;
    }
    const v = revIn(M, r, rg[0], rg[1]);
    s.revenue += v;
    if (mkt) s.revenueMkt += v;
    const now = billedIn(M, r, rg[0], rg[1]);
    if (now) s.billed++;
    if (prev && billedIn(M, r, prev[0], prev[1])) {
      s.prevBilled++;
      if (now) s.retained++;
    }
    const h = health(M, r, end);
    if (h === 'At-risk') {
      s.atRisk++;
      s.atRiskRevenue += riskRevenue(M, r, end);
    } else if (h === 'Churned') s.churned++;
    else if (h === 'Active') s.active++;
  }
  return s;
}

export function leadStats(M: Model, f: Filters, rg: Range): LeadAgg {
  return leadAgg(M, f, rg);
}

/** New retailers per month (all and marketing-acquired), filters applied. */
export function newPerMonth(M: Model, f: Filters): { all: number[]; mkt: number[] } {
  const all = new Array(M.nM).fill(0);
  const mkt = new Array(M.nM).fill(0);
  const acq = acquisition(M, f.level, f.window);
  for (let r = 0; r < M.nR; r++) {
    const m = M.p.retailers.first[r];
    if (m < 0 || !retailerOk(M, f, r, m)) continue;
    all[m]++;
    if (acq.src[r] !== ORGANIC) mkt[m]++;
  }
  return { all, mkt };
}

export function nextQuarter(q: string): string {
  const m = /^Q([1-4])_FY(\d{2})$/.exec(q);
  if (!m) return q;
  const n = Number(m[1]);
  return n === 4 ? `Q1_FY${String(Number(m[2]) + 1).padStart(2, '0')}` : `Q${n + 1}_FY${m[2]}`;
}

/** Run-rate: average new retailers per month over the last 3 months with sales, × 3. */
export function runRate(M: Model, f: Filters) {
  const { all, mkt } = newPerMonth(M, f);
  const e = M.p.salesEnd;
  const months = [e - 2, e - 1, e].filter((m) => m >= 0);
  const avg = months.reduce((s, m) => s + all[m], 0) / Math.max(1, months.length);
  const avgM = months.reduce((s, m) => s + mkt[m], 0) / Math.max(1, months.length);
  return { quarter: nextQuarter(M.latestQuarter), projected: Math.round(avg * 3), projectedMkt: Math.round(avgM * 3), perMonth: avg };
}

/** Each retailer's first-3-month quality: revenue, billed months, M1/M3 retention (only when 3 months have passed). */
export function earlyQuality(M: Model, r: number) {
  const first = M.p.retailers.first[r];
  if (first < 0 || first + 3 > M.p.salesEnd) return null;
  let months = 0;
  for (let m = first; m <= first + 2; m++) if (M.rev[r * M.nM + m] > 0) months++;
  return {
    rev90: revIn(M, r, first, first + 2),
    months90: months,
    m1: M.rev[r * M.nM + first + 1] > 0,
    m3: M.rev[r * M.nM + first + 3] > 0,
  };
}

export { NEW, lastBilledUpTo };

/** Month-by-month series for trend charts and KPI sparklines: unique leads (total and per source) and sales, every
 * filter applied except the period (the trend is the point). */
export function monthlySeries(M: Model, f: Filters) {
  const leads = new Array(M.nM).fill(0) as number[];
  const bySrc = M.p.dims.source.map(() => new Array(M.nM).fill(0) as number[]);
  const L = M.p.leads;
  for (let i = 0; i < M.nL; i++) {
    if (!L.uniq[i] || !leadOk(M, f, i, null)) continue;
    leads[L.m[i]]++;
    bySrc[L.src[i]][L.m[i]]++;
  }
  const sales = new Array(M.nM).fill(0) as number[];
  for (let r = 0; r < M.nR; r++) {
    if (M.p.retailers.first[r] < 0 || !retailerOk(M, f, r, M.p.salesEnd)) continue;
    const base = r * M.nM;
    for (let m = 0; m <= M.p.salesEnd; m++) sales[m] += M.rev[base + m];
  }
  const firstLead = leads.findIndex((v) => v > 0);
  return { leads, bySrc, sales, firstLead };
}
