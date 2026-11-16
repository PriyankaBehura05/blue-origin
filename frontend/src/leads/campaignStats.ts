// Campaign scorecard figures (Campaign performance page), one calculation for the KPI strip, the scorecard, the funnel, the
// bubble chart and the geography, so they always agree. Built from the lead sheet (each lead already linked to a campaign by
// the backend attribution), BO billing and the platforms' campaign spend.
//
// Rows are campaigns. Leads that are not linked to one campaign are NOT spread over campaigns: they get their own
// source-level rows (Meta / Google not linked to a campaign, Print, Other), kept apart from the campaign rows.
//
// Definitions:
//   leads              unique leads (first enquiry per mobile) whose lead date is in the period
//   converted leads    of those, leads whose BO retailer billed after the lead within the Window: new or came back
//   conversion rate    converted ÷ leads that can be judged (a working number, and BO sales reach the end of the Window)
//   converted retailers distinct BO retailers credited to the row; a retailer reached by several leads is credited once,
//                      to its earliest converting lead in the period and filters (a first-ever order wins over a came-back one),
//                      so the totals equal the Overview's converted / new retailers (retailerCounts)
//   time to convert    months from the lead's month to the credited retailer's start (BO sales are monthly: no days)
//   repeat purchase    credited retailers billed again in a later month ÷ credited retailers
//   90-day revenue     BO billing of the credited retailers in their first 3 months: from the first-ever bill (new
//                      retailers) or from the lead's month (came back). Only retailers with 3 full months of sales data
//                      count; `rev90New` is the part from new retailers only
//   cost per retailer  spend ÷ new retailers (first-ever order after a lead)
//   payback            spend ÷ (90-day revenue ÷ 3 × gross margin): months of margin needed to earn the spend back
//   ROI (90 days)      (90-day revenue × gross margin − spend) ÷ spend
import { leadOk, NEW, outcomeOf, PENDING, REACTIVATED, revIn, type Filters, type Model, type Range } from './model';
import { wasCalled } from './model';
import type { BudgetPayload } from './types';

export const MIN_LEADS = 100;   // below this many judged leads a campaign gets no strong recommendation
export const KILL_PAYBACK = 12; // months: a campaign that earns its spend back sooner is never Kill

export type Call = 'Scale' | 'Fix' | 'Kill' | 'Too early' | 'Needs spend data';

export interface CampRow {
  key: string;
  name: string;
  platform: string;        // Meta, Google, Print, Other …
  kind: 'campaign' | 'source';
  leads: number;
  judged: number;
  converted: number;       // converted leads
  contacted: number;
  contactTracked: boolean; // the leads carry ASM call data at all
  retailers: number;       // converted retailers credited (new + came back)
  fresh: number;           // new retailers credited
  repeat: number;          // credited retailers that bought again in a later month
  gaps: number[];          // months to convert, per credited retailer
  rev90: number;           // 90-day revenue of credited retailers with 3 full months
  rev90New: number;
  rev90Complete: number;   // credited retailers with 3 full months of data
  rev90Pending: number;    // credited retailers whose 3 months are not all in yet
  existing: number;        // leads whose shop was already buying (outcome Already buying)
  spend: number | null;    // null = no spend for this row
  leadIdx: number[];       // unique leads of the row (for the geography)
}

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const medianGap = (r: CampRow) => median(r.gaps);
export const convRate = (r: CampRow) => (r.judged ? (100 * r.converted) / r.judged : null);
export const repeatPct = (r: CampRow) => (r.retailers ? (100 * r.repeat) / r.retailers : null);
export const costPerRetailer = (r: CampRow) => (r.spend && r.fresh ? r.spend / r.fresh : null);
export const cplOf = (r: CampRow) => (r.spend && r.leads ? r.spend / r.leads : null);
export const paybackMonths = (r: CampRow, margin: number) => (r.spend && r.rev90 ? r.spend / ((r.rev90 / 3) * margin) : null);
export const roi90 = (r: { spend: number | null; rev90: number }, margin: number) => (r.spend ? (r.rev90 * margin - r.spend) / r.spend : null);

/** The recommendation. Never Kill on conversion alone: it also needs the cost per retailer far over target and no payback
 *  within KILL_PAYBACK months of 90-day margin. */
export function callOf(r: CampRow, targets: Record<string, number>): Call {
  const margin = (targets.gross_margin_pct ?? 30) / 100;
  if (r.kind !== 'campaign' || !r.spend) return 'Needs spend data';
  if (r.judged < MIN_LEADS) return 'Too early';
  const rate = convRate(r) ?? 0;
  const cpr = costPerRetailer(r) ?? Infinity;   // no new retailer yet = infinitely expensive so far
  const tc = targets.conversion_pct ?? 5;
  const tcost = targets.cost_per_retailer ?? 5000;
  if (rate >= tc && cpr <= tcost) return 'Scale';
  const payback = paybackMonths(r, margin) ?? Infinity;
  if (cpr > 2 * tcost && rate < tc / 2 && payback > KILL_PAYBACK) return 'Kill';
  return 'Fix';
}

/** Spend per campaign name for the months of the period (GT campaigns as saved on the Ad budget page). */
export function spendByCampaign(budget: BudgetPayload | null, M: Model, rg: Range): Map<string, number> {
  const keys = new Set(M.p.months.slice(rg[0], Math.min(rg[1], M.nM - 1) + 1));
  const out = new Map<string, number>();
  for (const p of ['meta', 'google'] as const) {
    const snap = budget?.[p]?.snapshot;
    if (!snap || snap.sample) continue;
    for (const a of snap.accounts) {
      const name = new Map(a.campaigns.map((c) => [c.campaign_id, c.name]));
      for (const r of a.campaign_monthly) {
        const n = name.get(r.campaign_id);
        if (n && keys.has(r.period)) out.set(n, (out.get(n) ?? 0) + r.spend);
      }
    }
  }
  return out;
}

/** Which lead each converted retailer is credited to, among the leads of the period and filters: the earliest New-retailer
 *  lead, else the earliest Came-back lead. */
function credits(M: Model, f: Filters, rg: Range) {
  const L = M.p.leads;
  const ret = M.ret[f.level];
  const best = new Map<number, { i: number; o: number }>();
  for (let i = 0; i < M.nL; i++) {
    if (!L.uniq[i] || !leadOk(M, f, i, rg)) continue;
    const o = outcomeOf(M, i, f.level, f.window);
    if (o !== NEW && o !== REACTIVATED) continue;
    const r = ret[i];
    if (r < 0) continue;
    const cur = best.get(r);
    if (!cur || (o === NEW && cur.o !== NEW) || (o === cur.o && L.day[i] < L.day[cur.i])) best.set(r, { i, o });
  }
  return best;
}

export function campaignStats(M: Model, f: Filters, rg: Range, spend: Map<string, number>): CampRow[] {
  const L = M.p.leads;
  const src = M.p.dims.source;
  const rows = new Map<string, CampRow>();
  const keyOf = (i: number): [string, string, string, 'campaign' | 'source'] => {
    if (L.att?.[i] === 0) {
      const name = M.p.dims.campaign[L.camp[i]];
      return [`c:${name}`, name, src[L.src[i]], 'campaign'];
    }
    const s = src[L.src[i]];
    const label = L.att?.[i] === 2 ? `${s} (no ad platform)` : s === 'Other' ? 'Platform unknown' : `${s}, not linked to a campaign`;
    return [`s:${label}`, label, s, 'source'];
  };
  const blank = (key: string, name: string, platform: string, kind: 'campaign' | 'source'): CampRow => ({
    key, name, platform, kind, leads: 0, judged: 0, converted: 0, contacted: 0, contactTracked: false, retailers: 0, fresh: 0, repeat: 0,
    gaps: [], rev90: 0, rev90New: 0, rev90Complete: 0, rev90Pending: 0, existing: 0, spend: kind === 'campaign' ? spend.get(name) ?? null : null, leadIdx: [],
  });
  const leadRow = new Int32Array(M.nL).fill(-1);
  const list: CampRow[] = [];
  for (let i = 0; i < M.nL; i++) {
    if (!L.uniq[i] || !leadOk(M, f, i, rg)) continue;
    const [key, name, platform, kind] = keyOf(i);
    let row = rows.get(key);
    if (!row) { row = blank(key, name, platform, kind); rows.set(key, row); list.push(row); }
    leadRow[i] = list.indexOf(row);
    row.leads++;
    row.leadIdx.push(i);
    const o = outcomeOf(M, i, f.level, f.window);
    if (L.valid[i] && o !== PENDING) row.judged++;
    if (o === NEW || o === REACTIVATED) row.converted++;
    if (o === 0) row.existing++;   // Already buying
    if (L.called?.[i] !== -1 || L.contact[i] >= 0) row.contactTracked = true;
    if (wasCalled(M, i)) row.contacted++;
  }
  // converted retailers, each credited once
  for (const [r, { i, o }] of credits(M, f, rg)) {
    if (leadRow[i] < 0) continue;
    const row = list[leadRow[i]];
    row.retailers++;
    const start = o === NEW ? M.p.retailers.first[r] : L.m[i];
    if (o === NEW) row.fresh++;
    row.gaps.push(Math.max(0, start - L.m[i]));
    let later = false;
    for (let m = start + 1; m <= M.p.salesEnd; m++) if (M.rev[r * M.nM + m] > 0) { later = true; break; }
    if (later) row.repeat++;
    if (start + 2 <= M.p.salesEnd) {
      const v = revIn(M, r, start, start + 2);
      row.rev90 += v;
      if (o === NEW) row.rev90New += v;
      row.rev90Complete++;
    } else row.rev90Pending++;
  }
  return list;
}
