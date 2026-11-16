// The campaign figures every Lead Generation page shows (Overview, Campaign performance, Platform comparison): one calculation,
// so the KPI cards, the comparison chart, the campaign table and the trends always agree. The backend saves only the GT team's
// campaigns (the filter is applied when Meta and Google are fetched, app/ads), with display names; this file only adds up.
//   spend, impressions, clicks, reach, leads   the platforms' own figures per campaign and month (BudgetAccount.gt)
//   leads    Meta: lead-form results; Google: conversions of the "Conversion" action (see leadsBasis)
//   budget   daily budget × the days the campaign actually delivered (spent on) in the period (today's settings: no budget history is
//            kept); without the daily delivery, × every day of each month it spent in
//   CPL      spend ÷ leads, added up first (never an average of CPLs); null (shown N/A) when there are no leads
//   ROAS     lead-attributed BO sales ÷ spend: retailers the campaign's leads brought in or back (calc.ts), null when the
//            period has no BO sales data yet
import { reactivatedRevenue, retailerStats } from './calc';
import type { Filters, Model, Range } from './model';
import type { BudgetPayload, GtMetrics } from './types';

export type Plat = 'Meta' | 'Google';
export interface GtLine {
  key: string;
  name: string;
  platform: Plat | 'All';
  kind: 'campaign' | 'platform' | 'total';
  status?: string;
  campaignId?: string;     // the platform's campaign ID (campaign rows)
  objective?: string | null; // Meta objective / Google campaign type
  dailyBudget: number | null;
  budget: number | null;
  spend: number;
  reach: number | null;
  reachApprox: boolean;
  impressions: number;
  clicks: number;
  leads: number;
  revenue: number | null;
}
export interface GtSummary {
  lines: GtLine[];
  platforms: Partial<Record<Plat, GtLine>>;
  total: GtLine | null;       // both platforms together (only when both are in)
  leadsBasis: Partial<Record<Plat, string>>;
  googleAllConversions: boolean; // Google leads are still all conversions (the script's conversion-action tab is missing)
  saved: string | null;
}

export const cplOf = (l: { spend: number; leads: number }) => (l.leads ? l.spend / l.leads : null);
export const ctrOf = (l: { clicks: number; impressions: number }) => (l.impressions ? (100 * l.clicks) / l.impressions : null);
export const cpcOf = (l: { spend: number; clicks: number }) => (l.clicks ? l.spend / l.clicks : null);
export const roasOf = (l: { spend: number; revenue: number | null }) => (l.revenue !== null && l.spend ? l.revenue / l.spend : null);
export const utilOf = (l: { spend: number; budget: number | null }) => (l.budget ? (100 * l.spend) / l.budget : null);
export const cpmOf = (l: { spend: number; impressions: number }) => (l.impressions ? (1000 * l.spend) / l.impressions : null);
/** impressions ÷ reach, only when reach is exact (several months added up are not) */
export const freqOf = (l: { impressions: number; reach: number | null; reachApprox: boolean }) => (l.reach && !l.reachApprox ? l.impressions / l.reach : null);
/** leads ÷ clicks: how many clicks turn into a lead (Google: conversion rate) */
export const leadRateOf = (l: { leads: number; clicks: number }) => (l.clicks ? (100 * l.leads) / l.clicks : null);

/** Days each campaign actually spent in each month ('YYYY-MM'), counted from the saved daily delivery; null before it exists. A budget is
 *  daily budget × these days, so a campaign started on the 29th is budgeted for 2 days of that month, not 30. */
const delivered = new WeakMap<object, Map<string, Map<string, number>> | null>();
export function deliveredDays(M: Model): Map<string, Map<string, number>> | null {
  const d = M.p.adDaily;
  if (!d || !d.rows.length) return null;
  const hit = delivered.get(d);
  if (hit !== undefined) return hit;
  const seen = new Map<string, Map<string, Set<number>>>();
  for (const [ci, day, spend] of d.rows) {
    if (spend <= 0) continue;
    const name = d.campaigns[ci];
    const ym = new Date(day * 864e5).toISOString().slice(0, 7);
    const byMonth = seen.get(name) ?? seen.set(name, new Map()).get(name)!;
    (byMonth.get(ym) ?? byMonth.set(ym, new Set()).get(ym)!).add(day);
  }
  const out = new Map([...seen].map(([n, m]) => [n, new Map([...m].map(([ym, set]) => [ym, set.size]))]));
  delivered.set(d, out);
  return out;
}

const daysIn = (ym: string, today: Date) => {
  const [y, mo] = ym.split('-').map(Number);
  return y === today.getFullYear() && mo === today.getMonth() + 1 ? today.getDate() : new Date(y, mo, 0).getDate();
};

/** Lead-attributed BO sales in the period for the leads the filters pick (source / campaign), or null when there is no
 *  sales data for the period. */
function revenueOf(M: Model, f: Filters, rg: Range): number | null {
  if (rg[0] > M.p.salesEnd) return null;
  return retailerStats(M, f, rg, null).revenueMkt + reactivatedRevenue(M, f, rg);
}

export function gtSummary(budget: BudgetPayload | null, M: Model, f: Filters, rg: Range, withRevenue = true): GtSummary {
  const inPeriod = new Set(M.p.months.slice(rg[0], Math.min(rg[1], M.nM - 1) + 1));
  const srcName = f.source >= 0 ? M.p.dims.source[f.source] : null;
  const campName = f.campaign >= 0 ? M.p.dims.campaign[f.campaign] : null;
  const out: GtSummary = { lines: [], platforms: {}, total: null, leadsBasis: {}, googleAllConversions: false, saved: null };
  const days = deliveredDays(M);
  for (const p of ['meta', 'google'] as const) {
    const plat: Plat = p === 'meta' ? 'Meta' : 'Google';
    const snap = budget?.[p]?.snapshot;
    if (!snap || snap.sample || (srcName && srcName !== plat)) continue;
    out.saved = out.saved ?? snap.fetched_at;
    const own: GtLine[] = [];
    let gtAny: GtMetrics | undefined;
    let combinedReach = 0;
    let combinedApprox = false;
    for (const a of snap.accounts) {
      const gt = a.gt;
      if (!gt) continue;
      gtAny = gt;
      out.leadsBasis[plat] = gt.leads_basis;
      if (plat === 'Google' && /^All /.test(gt.leads_basis)) out.googleAllConversions = true;
      const today = new Date(`${a.today}T00:00:00`);
      const lifeReach = new Map(gt.lifetime_reach.map((x) => [x.campaign_id, x.reach]));
      for (const c of a.campaigns) {
        if (campName && c.name !== campName) continue;
        const ms = gt.campaign_monthly.filter((r) => r.campaign_id === c.campaign_id && inPeriod.has(r.period));
        const sum = (k: 'spend' | 'impressions' | 'clicks' | 'leads') => ms.reduce((s, r) => s + (r[k] ?? 0), 0);
        // reach counts people: the whole life or one month is exact; several months add monthly reach (≈)
        const allMonths = gt.campaign_monthly.filter((r) => r.campaign_id === c.campaign_id).every((r) => inPeriod.has(r.period));
        const reach = !gt.has_reach ? null : allMonths ? lifeReach.get(c.campaign_id) ?? null : ms.reduce((s, r) => s + (r.reach ?? 0), 0);
        let bud = 0;
        if (c.daily_budget) for (const r of ms) if (r.spend > 0) bud += c.daily_budget * (days?.get(c.name)?.get(r.period) ?? daysIn(r.period, today));
        const ci = withRevenue ? M.p.dims.campaign.indexOf(c.name) : -1;
        own.push({
          key: `${p}:${c.campaign_id}`, name: c.name, platform: plat, kind: 'campaign', status: c.status_group, campaignId: c.campaign_id, objective: c.objective, dailyBudget: c.daily_budget,
          budget: c.daily_budget ? bud : c.lifetime_budget, spend: sum('spend'), reach, reachApprox: !!reach && !allMonths && ms.length > 1,
          impressions: sum('impressions'), clicks: sum('clicks'), leads: sum('leads'),
          revenue: !withRevenue ? null : ci >= 0 ? revenueOf(M, { ...f, campaign: ci }, rg) : rg[0] > M.p.salesEnd ? null : 0,
        });
      }
      if (gt.has_reach) {
        const months = gt.combined_monthly_reach.filter((r) => inPeriod.has(r.period));
        const all = gt.combined_monthly_reach.every((r) => inPeriod.has(r.period));
        combinedReach += all && gt.combined_lifetime_reach !== null ? gt.combined_lifetime_reach : months.reduce((s, r) => s + r.reach, 0);
        combinedApprox = combinedApprox || (!all && months.length > 1);
      }
    }
    if (!gtAny || !own.length) continue;
    own.sort((x, y) => y.spend - x.spend);
    const add = (k: 'spend' | 'impressions' | 'clicks' | 'leads') => own.reduce((s, l) => s + l[k], 0);
    const budgets = own.map((l) => l.budget).filter((b): b is number => b !== null);
    const platLine: GtLine = {
      key: `${p}:all`, name: `${plat} combined`, platform: plat, kind: 'platform', dailyBudget: own.reduce((s, l) => s + (l.dailyBudget ?? 0), 0) || null,
      budget: budgets.length ? budgets.reduce((s, b) => s + b, 0) : null, spend: add('spend'),
      reach: gtAny.has_reach ? (campName ? own[0]?.reach ?? null : combinedReach) : null, reachApprox: campName ? own[0]?.reachApprox ?? false : combinedApprox,
      impressions: add('impressions'), clicks: add('clicks'), leads: add('leads'),
      revenue: !withRevenue ? null : campName ? own[0]?.revenue ?? null : revenueOf(M, { ...f, source: M.p.dims.source.indexOf(plat) }, rg),
    };
    out.lines.push(...own, platLine);
    out.platforms[plat] = platLine;
  }
  const ps = Object.values(out.platforms) as GtLine[];
  if (ps.length > 1) {
    const add = (k: 'spend' | 'impressions' | 'clicks' | 'leads') => ps.reduce((s, l) => s + l[k], 0);
    const rev = ps.map((l) => l.revenue);
    out.total = {
      key: 'all', name: 'All campaigns', platform: 'All', kind: 'total', dailyBudget: ps.reduce((s, l) => s + (l.dailyBudget ?? 0), 0) || null,
      budget: ps.reduce((s, l) => s + (l.budget ?? 0), 0), spend: add('spend'), reach: null, reachApprox: false,
      impressions: add('impressions'), clicks: add('clicks'), leads: add('leads'),
      revenue: rev.some((v) => v === null) ? null : rev.reduce((s, v) => s! + v!, 0),
    };
    out.lines.push(out.total);
  }
  return out;
}

/** Month by month per platform (spend, leads, impressions, clicks), every month up to `end`, for the trend charts. Follows the
 *  Source and Campaign filters like gtSummary. */
export function gtMonthly(budget: BudgetPayload | null, M: Model, f: Filters) {
  const srcName = f.source >= 0 ? M.p.dims.source[f.source] : null;
  const campName = f.campaign >= 0 ? M.p.dims.campaign[f.campaign] : null;
  const days = deliveredDays(M);
  const by: Partial<Record<Plat, Map<string, { spend: number; leads: number; impressions: number; clicks: number }>>> = {};
  const byCampaign = new Map<string, { name: string; platform: Plat; months: Map<string, { spend: number; leads: number; budget: number }> }>();
  for (const p of ['meta', 'google'] as const) {
    const plat: Plat = p === 'meta' ? 'Meta' : 'Google';
    const snap = budget?.[p]?.snapshot;
    if (!snap || snap.sample || (srcName && srcName !== plat)) continue;
    for (const a of snap.accounts) {
      if (!a.gt) continue;
      const today = new Date(`${a.today}T00:00:00`);
      const info = new Map(a.campaigns.map((c) => [c.campaign_id, c]));
      const m = by[plat] ?? new Map();
      for (const r of a.gt.campaign_monthly) {
        const c = info.get(r.campaign_id);
        if (!c || (campName && c.name !== campName)) continue;
        const e = m.get(r.period) ?? { spend: 0, leads: 0, impressions: 0, clicks: 0 };
        e.spend += r.spend; e.leads += r.leads; e.impressions += r.impressions; e.clicks += r.clicks;
        m.set(r.period, e);
        const k = `${p}:${c.campaign_id}`;
        const cm = byCampaign.get(k) ?? { name: c.name, platform: plat, months: new Map() };
        cm.months.set(r.period, { spend: r.spend, leads: r.leads, budget: c.daily_budget && r.spend > 0 ? c.daily_budget * (days?.get(c.name)?.get(r.period) ?? daysIn(r.period, today)) : 0 });
        byCampaign.set(k, cm);
      }
      by[plat] = m;
    }
  }
  return { by, byCampaign };
}
