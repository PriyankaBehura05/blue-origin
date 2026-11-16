// Repeat buying, shared by "Repeat buying & tiers" and "States & cities", so both pages count the same way.
//
// A purchase = a month in which the retailer has BO billing above ₹0. BO billing comes per retailer per month, so two
// invoices in one month are one purchase, and gaps between purchases are measured in months (day-level gaps: N/A).
//
// Lead-linked figures only use reliable links: a lead matched to its BO retailer by mobile number (the retailer's main or
// alternate number), never by a similar shop name. Every retailer is counted once: when several leads reach the same
// retailer, a "New retailer" result wins over "Came back", then the earliest lead; that lead credits the platform/campaign.
// Purchases of a lead-converted retailer are counted from its first purchase after the lead (its "conversion purchase").
//
// Repeat rate = retailers whose second purchase came within the repeat window (Repeat within N months, after the first
// purchase) ÷ retailers whose whole window is covered by the sales data. Retailers still inside their window are left
// out: they have not had the chance to fail yet.
import { leadOk, NEW, ORGANIC, outcomeOf, PENDING, REACTIVATED, retailerOk, revIn, type Filters, type Model, type Range } from './model';

export const STAGES = ['No purchase yet', 'First purchase only', 'Exactly 2 purchases', '3 or more purchases', 'Repeat buyers (2+ purchases)'];
export const REPEAT_WINDOWS = [3, 6, 12];

/** The last month with sales that the period reaches. */
export const endOf = (M: Model, rg: Range) => Math.min(rg[1], M.p.salesEnd);

/** Purchases (billed months) of retailer r from month a to month b. */
export function purchasesIn(M: Model, r: number, a: number, b: number): number {
  let n = 0;
  const base = r * M.nM;
  for (let m = Math.max(0, a); m <= Math.min(b, M.nM - 1); m++) if (M.rev[base + m] > 0) n++;
  return n;
}
/** First billed month at or after month m, -1 when none. */
export function firstBilledFrom(M: Model, r: number, m: number): number {
  const base = r * M.nM;
  for (let k = Math.max(0, m); k <= M.p.salesEnd; k++) if (M.rev[base + k] > 0) return k;
  return -1;
}
export function stageIndex(n: number): number {
  return Math.min(3, n);
}
/** Does a retailer with n purchases pass the Purchase stage filter? */
export function stageOk(f: Filters, n: number): boolean {
  switch (f.stage) {
    case 0: return n === 0;
    case 1: return n === 1;
    case 2: return n === 2;
    case 3: return n >= 3;
    case 4: return n >= 2;
    default: return true;
  }
}

/** A lead linked to its retailer by mobile number (main or alternate), at the selected matching level. */
export const phoneMatched = (M: Model, level: number, i: number) => {
  const p = M.p.leads.pass[i];
  return M.ret[level][i] >= 0 && (p === 1 || p === 2);
};

/** Which phone-matched "New retailer" lead brought each retailer in (any period): its lead, else -1 (no lead: organic). */
export function phoneCredit(M: Model, level: number, window: number): { lead: Int32Array; src: Int8Array } {
  const key = `phone:${level}:${window}`;
  const hit = M.acqCache.get(key);
  if (hit) return hit;
  const lead = new Int32Array(M.nR).fill(-1);
  const src = new Int8Array(M.nR).fill(ORGANIC);
  const L = M.p.leads;
  for (let i = 0; i < M.nL; i++) {
    if (!L.uniq[i] || !phoneMatched(M, level, i) || outcomeOf(M, i, level, window) !== NEW) continue;
    const r = M.ret[level][i];
    if (lead[r] < 0 || L.day[i] < L.day[lead[r]]) { lead[r] = i; src[r] = L.src[i]; }
  }
  const out = { lead, src };
  M.acqCache.set(key, out);
  return out;
}

/** Retailer filters for the two pages: area, distributor and tier as everywhere, and Source / Campaign as the phone-matched
 *  lead that brought the retailer in. The purchase stage is checked by the caller (it depends on where purchases are counted from). */
export function retailerInScope(M: Model, f: Filters, r: number, end: number): boolean {
  if (!retailerOk(M, f, r, end, ['source', 'campaign'])) return false;
  if (f.source < 0 && f.campaign < 0) return true;
  const c = phoneCredit(M, f.level, f.window);
  if (f.source >= 0 && c.src[r] !== f.source) return false;
  if (f.campaign >= 0 && (c.lead[r] < 0 || M.p.leads.camp[c.lead[r]] !== f.campaign)) return false;
  return true;
}

export interface Conv {
  r: number;
  lead: number;
  c: number; // month of the first purchase after the lead
  kind: number; // NEW or REACTIVATED
  src: number;
  camp: number;
}

/** A lead's location: where the lead said it is, else its matched retailer's (the same rule as the State / City filters). */
export function leadPlace(M: Model, level: number, i: number): { s: number; c: number } {
  const L = M.p.leads;
  const R = M.p.retailers;
  const r = M.ret[level][i];
  return { s: L.s[i] >= 0 ? L.s[i] : r >= 0 ? R.s[r] : -1, c: L.c[i] >= 0 ? L.c[i] : r >= 0 ? R.c[r] : -1 };
}

/** The lead's purchase stage: purchases of its phone-matched retailer from the lead month to the end of the period. */
export function leadPurchases(M: Model, f: Filters, i: number, end: number): number {
  if (!phoneMatched(M, f.level, i)) return 0;
  return purchasesIn(M, M.ret[f.level][i], M.p.leads.m[i], end);
}

/** Leads of the period passing every filter (the purchase stage included). */
export function leadInScope(M: Model, f: Filters, i: number, rg: Range): boolean {
  if (!M.p.leads.uniq[i] || !leadOk(M, f, i, rg)) return false;
  return f.stage < 0 || stageOk(f, leadPurchases(M, f, i, endOf(M, rg)));
}

/** Retailers converted by the period's leads (phone-matched, New retailer or Came back), one per retailer. */
export function conversions(M: Model, f: Filters, rg: Range): Conv[] {
  const L = M.p.leads;
  const ret = M.ret[f.level];
  const by = new Map<number, Conv>();
  for (let i = 0; i < M.nL; i++) {
    if (!L.uniq[i] || !phoneMatched(M, f.level, i) || !leadOk(M, f, i, rg)) continue;
    const o = outcomeOf(M, i, f.level, f.window);
    if (o !== NEW && o !== REACTIVATED) continue;
    const r = ret[i];
    const cur = by.get(r);
    if (cur && !((o === NEW && cur.kind !== NEW) || (o === cur.kind && L.day[i] < L.day[cur.lead]))) continue;
    const c = firstBilledFrom(M, r, L.m[i]);
    if (c < 0) continue;
    by.set(r, { r, lead: i, c, kind: o, src: L.src[i], camp: L.camp[i] });
  }
  const end = endOf(M, rg);
  const out = [...by.values()];
  return f.stage < 0 ? out : out.filter((x) => stageOk(f, purchasesIn(M, x.r, x.c, end)));
}

/** Leads that can be judged (valid, sales data covers their window) and those of them that converted (phone-matched). */
export function leadTally(M: Model, f: Filters, rg: Range, pick?: (i: number) => boolean) {
  const L = M.p.leads;
  let leads = 0, judged = 0, converted = 0;
  for (let i = 0; i < M.nL; i++) {
    if (!leadInScope(M, f, i, rg) || (pick && !pick(i))) continue;
    leads++;
    const o = outcomeOf(M, i, f.level, f.window);
    if (!L.valid[i] || o === PENDING) continue;
    judged++;
    if ((o === NEW || o === REACTIVATED) && phoneMatched(M, f.level, i)) converted++;
  }
  return { leads, judged, converted };
}

export interface RepeatStats {
  n: number; // retailers
  second: number; // made a 2nd purchase (any time up to the last sales month)
  third: number; // made a 3rd or later purchase
  eligible: number; // their repeat window is fully covered by the sales data
  repeatIn: number; // of the eligible: 2nd purchase within the window
  gapSum: number; // months from the first to the second purchase (repeaters only)
  gapN: number;
  revFirst: number; // billing in the first-purchase month
  revAfter: number; // billing after it, up to the last sales month
}
export const emptyStats = (): RepeatStats => ({ n: 0, second: 0, third: 0, eligible: 0, repeatIn: 0, gapSum: 0, gapN: 0, revFirst: 0, revAfter: 0 });

/** Adds one retailer whose first purchase (in this relationship) was in month c. */
export function addRetailer(M: Model, s: RepeatStats, r: number, c: number, rwin: number) {
  const end = M.p.salesEnd;
  const base = r * M.nM;
  let after = 0;
  let second = -1;
  for (let m = c + 1; m <= end; m++) {
    if (M.rev[base + m] > 0) {
      after++;
      if (second < 0) second = m;
    }
  }
  s.n++;
  if (after >= 1) s.second++;
  if (after >= 2) s.third++;
  if (c + rwin <= end) {
    s.eligible++;
    if (second > 0 && second - c <= rwin) s.repeatIn++;
  }
  if (second > 0) { s.gapSum += second - c; s.gapN++; }
  s.revFirst += M.rev[base + c];
  s.revAfter += revIn(M, r, c + 1, end);
}

export function statsOf(M: Model, list: { r: number; c: number }[], rwin: number): RepeatStats {
  const s = emptyStats();
  for (const x of list) addRetailer(M, s, x.r, x.c, rwin);
  return s;
}
export const avgGap = (s: RepeatStats) => (s.gapN ? s.gapSum / s.gapN : null);

/** New BO retailers of the period: first-ever purchase in the period (every source, lead or not), in the filters. */
export function newRetailers(M: Model, f: Filters, rg: Range): { r: number; c: number }[] {
  const R = M.p.retailers;
  const end = endOf(M, rg);
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < M.nR; r++) {
    const c = R.first[r];
    if (c < rg[0] || c > end || !retailerInScope(M, f, r, end)) continue;
    if (f.stage >= 0 && !stageOk(f, purchasesIn(M, r, c, end))) continue;
    out.push({ r, c });
  }
  return out;
}

/** Retailers that bought in the period, in the filters, with their purchases so far (up to the end of the period). */
export function activeRetailers(M: Model, f: Filters, rg: Range): { r: number; n: number }[] {
  const end = endOf(M, rg);
  const out: { r: number; n: number }[] = [];
  for (let r = 0; r < M.nR; r++) {
    if (M.p.retailers.first[r] < 0 || M.p.retailers.first[r] > end) continue;
    if (purchasesIn(M, r, rg[0], end) === 0 || !retailerInScope(M, f, r, end)) continue;
    const n = purchasesIn(M, r, 0, end);
    if (stageOk(f, n)) out.push({ r, n });
  }
  return out;
}

/** "Karnataka · Bengaluru · Meta · Gold" for the active filters, to say what the numbers are for. */
export function scopeText(M: Model, f: Filters): string {
  const d = M.p.dims;
  return [
    f.state >= 0 ? d.state[f.state] : 'All states',
    f.city >= 0 ? d.city[f.city] : '',
    f.dist >= 0 ? d.dist[f.dist] : '',
    f.source >= 0 ? (f.source === ORGANIC ? 'Organic' : d.source[f.source]) : 'All platforms',
    f.campaign >= 0 ? d.campaign[f.campaign] : '',
    f.tier >= 0 ? `${d.tiers[f.tier]} tier` : 'All tiers',
    f.stage >= 0 ? STAGES[f.stage] : '',
  ].filter(Boolean).join(' · ');
}
