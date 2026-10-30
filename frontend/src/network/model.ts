import { quarterLong } from '@/utils/format';
import type { Filters, Model, Payload, Retailer } from './types';

// Money in Indian units: ₹ K / L / Cr
export const fmtINR = (v: unknown) => {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)} K`;
  return `${s}₹${Math.round(a)}`;
};
export const fmtN = (v: unknown) => (Number(v) || 0).toLocaleString('en-IN');
export const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : null);
export const fmtPct = (p: number | null | undefined) => (p == null ? '–' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);
// 'Q2_FY27' -> 'Q2 FY 27' (same style as the rest of the app); 'Sept_24' -> 'Sep 24'
export const qLabel = (q: string) => q.replace(/_FY/, ' FY ');
// 'Q2_FY27' -> 'Q2 FY 27 (Jul–Sep 2026)' for dropdowns and captions (Q1 = Apr–Jun ... Q4 = Jan–Mar)
export const qLong = (q: string) => quarterLong(q);
// 'Q2_FY27' -> 27 * 10 + 2, so quarter keys compare in time order
export const qOrder = (q: string) => Number(q.slice(-2)) * 10 + Number(q[1]);

// Tiers that start later (Platinum from Q1 FY 27, April 2026). Older payloads do not carry it.
const TIER_FROM_DEFAULT: Record<string, string> = { Platinum: 'Q1_FY27' };
export const tierFrom = (p: Payload) => p.tierFrom ?? TIER_FROM_DEFAULT;
/** Is tier `name` in force in quarter key `q`? */
export const tierInForce = (p: Payload, name: string, q: string) => !tierFrom(p)[name] || qOrder(q) >= qOrder(tierFrom(p)[name]);
/** Minimum quarterly purchase of tier `name` in quarter key `q` (Silver: ₹2.5 L until Q1 FY 27, ₹3 L from Q2 FY 27). */
export const slabAt = (p: Payload, name: string, q: string) => p.slabsByQuarter?.[q]?.[name] ?? p.slabs[name];
export const mLabel = (m: string) => m.replace('Sept', 'Sep').replace('July', 'Jul').replace('_', ' ');

/** Same cleaning as norm_name/compact in bo_pipeline.py, used to match live sheet rows to retailers. */
const REP: Record<string, string> = {
  SPORT: 'SPORTS', GARMENT: 'GARMENTS', FASHIONS: 'FASHION', COLLECTIONS: 'COLLECTION', TRADER: 'TRADERS',
  ENTERPRISE: 'ENTERPRISES', HOSIERIES: 'HOSIERY', MENS: 'MEN', MENSWEAR: 'MEN WEAR', READYMADES: 'READYMADE',
  CLOTHINGS: 'CLOTHING', CENTER: 'CENTRE', SHREE: 'SRI', SHRI: 'SRI', SREE: 'SRI',
};
export function compactName(s: string) {
  let x = String(s).toUpperCase().replace(/â€™|’/g, "'").replace(/^\s*M\s*\/\s*S\.?\s*/, '').replace(/&/g, ' AND ');
  x = x.replace(/[^A-Z0-9]/g, ' ');
  return x.split(/\s+/).filter((t) => t && t !== 'THE' && t !== 'AND').map((t) => REP[t] ?? t).join('').replace(/\s/g, '');
}

export function buildModel(p: Payload): Model {
  const Q = p.quarters;
  const M = p.months;
  const MQ = p.monthQ;
  const LQ = Q.length - 1;
  // highest tier index allowed in each quarter: data built before the Platinum rule shows Gold until Q1 FY 27
  const cap = Q.map((q) => p.tiers.reduce((top, t, i) => (tierInForce(p, t, q) ? i : top), 0));
  const capT = (t: number[] | undefined) => t && (t.some((v, i) => v > cap[i]) ? t.map((v, i) => Math.min(v, cap[i])) : t);
  const R: Retailer[] = p.retailers.map((rawIn) => {
    const raw = { ...rawIn, t: capT(rawIn.t)!, rt: capT(rawIn.rt) };
    const di = p.distributors[raw.d];
    const q = Q.map((_, qi) => raw.m.reduce((s, v, mi) => s + (MQ[mi] === qi ? v : 0), 0));
    const first = raw.m.findIndex((v) => v > 0);
    const phones = [raw.ph, ...(raw.pa ? raw.pa.split(' | ') : [])].filter(Boolean) as string[];
    return {
      ...raw,
      dist: di.n,
      state: di.s || '',
      region: di.r || '',
      q,
      basis: raw.b || q,
      first,
      firstQ: first >= 0 ? MQ[first] : -1,
      life: raw.m.reduce((a, b) => a + b, 0),
      lastQ: q.reduce((a, v, i) => (v > 0 ? i : a), -1),
      best: Math.max(0, ...raw.t),
      key: `${raw.n} ${raw.id} ${raw.ds ?? ''} ${raw.ct ?? ''} ${raw.ph ?? ''} ${raw.pa ?? ''}`.toLowerCase(),
      nameKey: compactName(raw.n),
      phones,
    };
  });
  return { p, R, byId: new Map(R.map((r) => [r.id, r])), Q, M, MQ, TIERS: p.tiers, LQ };
}

export const qSel = (m: Model, f: Filters) => (f.q < 0 ? m.LQ : f.q);
export const tierAt = (r: Retailer, qi: number) => (r.t[qi] < 0 ? 0 : r.t[qi]);

// Tier movement of a retailer in quarter qi vs the quarter before (same rules as the Tiers page).
// First matching rule wins: New (first purchase ever), No sales (bought last quarter, not now),
// Upgraded / Downgraded / Stayed in same tier (on a tier now), Dropped from the tier (below the lowest
// tier now, but on a tier in an earlier quarter), else Never been on tier but some sales.
export const MOVES = ['Downgraded', 'Dropped from the tier', 'Never been on tier but some sales', 'New', 'No sales', 'Stayed in same tier', 'Upgraded'] as const;
export type Move = (typeof MOVES)[number];
export const MOVE_COLOR: Record<Move, string> = {
  Downgraded: 'var(--bad)', 'Dropped from the tier': 'var(--warn)', 'Never been on tier but some sales': 'var(--t0)', New: 'var(--info)',
  'No sales': 'var(--muted)', 'Stayed in same tier': 'var(--brand)', Upgraded: 'var(--good)',
};
/** null = no purchase in either quarter (not part of the movement) or no previous quarter */
export function moveOf(r: Retailer, qi: number): Move | null {
  if (qi < 1) return null;
  const cur = r.q[qi] > 0;
  if (!cur && !(r.q[qi - 1] > 0)) return null;
  if (r.firstQ === qi) return 'New';
  if (!cur) return 'No sales';
  const a = tierAt(r, qi - 1);
  const b = tierAt(r, qi);
  if (b > 0) return b > a ? 'Upgraded' : b < a ? 'Downgraded' : 'Stayed in same tier';
  for (let j = 0; j < qi; j++) if (tierAt(r, j) > 0) return 'Dropped from the tier';
  return 'Never been on tier but some sales';
}
// The tier filter uses the selected quarter's tier, or the latest quarter's with "All quarters".
export const tierFor = (m: Model, f: Filters, r: Retailer) => tierAt(r, qSel(m, f));

export function applyFilters(m: Model, f: Filters) {
  return m.R.filter(
    (r) =>
      (!f.region || r.region === f.region) &&
      (!f.state || r.state === f.state) &&
      (!f.dist || r.dist === f.dist) &&
      (!f.tier || (f.tier === 'tiered' ? tierFor(m, f, r) > 0 : m.TIERS[tierFor(m, f, r)] === f.tier)),
  );
}

// quarterLabel overrides the quarter part (the deliverables tracker has its own quarter)
export function filterText(m: Model, f: Filters, quarterLabel?: string) {
  return [
    f.region ? `${f.region} region` : 'All regions',
    f.state || 'All states',
    f.dist || 'All distributors',
    quarterLabel ?? (f.q < 0 ? 'All quarters' : qLong(m.Q[f.q])),
    f.tier ? (f.tier === 'tiered' ? 'Any tier' : `${f.tier} tier`) : 'All tiers',
  ].join(' · ');
}

// '₹50 K', '₹1.5 L', '₹10 L' for slab thresholds
export const fmtSlab = (v: number) => (v >= 1e5 ? `₹${+(v / 1e5).toFixed(2)} L` : `₹${+(v / 1e3).toFixed(1)} K`);
// 'Yellow ₹50 K · Green ₹1.5 L · Silver ₹2.5 L until Q1 FY 27, ₹3 L from Q2 FY 27 · Gold ₹5 L · Platinum ₹10 L (from Q1 FY 27)'
export const slabText = (m: Model) =>
  ['Yellow', 'Green', 'Silver', 'Gold', 'Platinum'].map((t) => {
    const steps: { q: string; v: number }[] = [];
    m.Q.forEach((q) => {
      if (!tierInForce(m.p, t, q)) return;
      const v = slabAt(m.p, t, q);
      if (!steps.length || steps[steps.length - 1].v !== v) steps.push({ q, v });
    });
    const text = steps.length > 1
      ? steps.map((s, i) => (i < steps.length - 1 ? `${fmtSlab(s.v)} until ${qLabel(m.Q[m.Q.indexOf(steps[i + 1].q) - 1])}` : `${fmtSlab(s.v)} from ${qLabel(s.q)}`)).join(', ')
      : fmtSlab(steps[0]?.v ?? m.p.slabs[t]);
    return `${t} ${text}${tierFrom(m.p)[t] ? ` (from ${qLabel(tierFrom(m.p)[t])})` : ''}`;
  }).join(' · ');
