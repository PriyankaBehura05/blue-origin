// Ad spend and budget for the Overview's Campaign Performance cards. They read what the Ad budget page last saved
// (GET /api/ads/budget): opening a dashboard page never calls Meta or Google. They follow the dashboard filters only where that
// is honest:
//   period -> spend of the calendar months of the period      source -> that platform (Meta = Meta Ads, Google = Google Ads)
//   campaign -> that campaign's spend and budget (leads carry the campaign the attribution linked them to; Unmatched / Non-paid have none)
// Ad spend and budgets cannot be split by state, city, distributor, tier or campaign here (per-campaign cost is worked out on the
// Campaign attribution page, backend spend_service.py), so with
// one of those filters on, the cost figures are withheld instead of dividing the whole spend by a part of the leads.
// Budgets are today's settings: neither Meta nor Google keeps the budget a campaign had last quarter.
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { adsApi } from './api';
import { activeFilters, FILTER_LABELS, type Filters, type FilterKey, type Model, type Range } from './model';
import type { BudgetPayload } from './types';

type Platform = 'meta' | 'google';
const PLATFORM_OF: Record<string, Platform> = { Meta: 'meta', Google: 'google' };
const NAME: Record<Platform, string> = { meta: 'Meta Ads', google: 'Google Ads' };
const UNSPLIT: FilterKey[] = ['state', 'city', 'dist', 'tier', 'outcome'];

/** The ad campaign ids of an account that the Campaign filter keeps (all when no campaign is picked). */
function campaignIds(M: Model, f: Filters, a: { campaigns: { campaign_id: string; name: string }[] }): Set<string> | null {
  if (f.campaign < 0) return null;
  const name = M.p.dims.campaign[f.campaign];
  return new Set(a.campaigns.filter((c) => c.name === name).map((c) => c.campaign_id));
}
const noCampaignSpend = (M: Model, f: Filters) => `No ad spend belongs to “${M.p.dims.campaign[f.campaign]}”: it is not one ad campaign`;

/** Loads the saved ad data once while `enabled`; null until it arrives (or if it cannot be read). */
export function useAdBudget(enabled: boolean): BudgetPayload | null {
  const [data, setData] = useState<BudgetPayload | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const read = () => adsApi.budget().then((d) => { if (live) setData(d); }).catch(() => undefined);
    void read();
    const t = setInterval(() => void read(), 5 * 60 * 1000); // the server refreshes the saved data in the background; this only re-reads it
    return () => { live = false; clearInterval(t); };
  }, [enabled]);
  return data;
}

/** Which platforms the Source filter lets through, or why none. */
function scopeOf(b: BudgetPayload | null, M: Model, f: Filters): { platforms: Platform[]; reason: string | null } {
  if (!b) return { platforms: [], reason: 'Ad spend is not loaded' };
  // sample data (GOOGLE_ADS_MODE=sample) is a preview of the Ad budget page only: it never counts here
  const saved = (['meta', 'google'] as const).filter((p) => b[p].snapshot && !b[p].snapshot!.sample);
  if (f.source >= 0) {
    const name = M.p.dims.source[f.source] ?? '';
    const p = PLATFORM_OF[name];
    if (!p) return { platforms: [], reason: `No ad spend is tracked for ${name || 'this source'}` };
    if (!b[p].snapshot) return { platforms: [], reason: `${NAME[p]} is not connected yet, so there is no spend to show` };
    if (b[p].snapshot!.sample) return { platforms: [], reason: `${NAME[p]} is in sample mode: made-up figures are never used in the dashboard's numbers` };
    return { platforms: [p], reason: null };
  }
  return saved.length ? { platforms: saved, reason: null } : { platforms: [], reason: 'No ad spend saved yet. An admin can fetch it on the Ad budget page' };
}

const unsplitOf = (f: Filters) => activeFilters(f).filter((k) => UNSPLIT.includes(k)).map((k) => FILTER_LABELS[k]);

export interface AdSpend {
  total: number;
  /** of which Meta campaigns whose objective is Leads (the platform's own label) */
  leadObjective: number;
  platforms: Platform[];
  /** lead-source indexes (dims.source) the spend can be matched to */
  srcIdx: number[];
  /** why there is no usable spend, or null */
  reason: string | null;
  /** filters that stop spend being divided by the leads */
  unsplit: string[];
  fetchedAt: string | null;
}

export const platformsText = (a: { platforms: Platform[] }) => a.platforms.map((p) => NAME[p]).join(' + ');

export function adSpendIn(b: BudgetPayload | null, M: Model, f: Filters, rg: Range): AdSpend {
  const scope = scopeOf(b, M, f);
  const { reason } = scope;
  let { platforms } = scope;
  if (reason || !b) return { total: 0, leadObjective: 0, platforms: [], srcIdx: [], reason: reason ?? 'Ad spend is not loaded', unsplit: [], fetchedAt: null };
  const keys = new Set(M.p.months.slice(rg[0], rg[1] + 1));
  let total = 0;
  let leadObjective = 0;
  const hit: Platform[] = [];
  for (const p of platforms) {
    for (const a of b[p].snapshot!.accounts) {
      const only = campaignIds(M, f, a);
      if (only && !only.size) continue;
      if (!hit.includes(p)) hit.push(p);
      if (only) for (const m of a.campaign_monthly) { if (keys.has(m.period) && only.has(m.campaign_id)) total += m.spend; }
      else for (const m of a.monthly) if (keys.has(m.period)) total += m.spend;
      const leadCampaigns = new Set(a.campaigns.filter((c) => c.objective === 'OUTCOME_LEADS' && (!only || only.has(c.campaign_id))).map((c) => c.campaign_id));
      for (const m of a.campaign_monthly) if (keys.has(m.period) && leadCampaigns.has(m.campaign_id)) leadObjective += m.spend;
    }
  }
  if (f.campaign >= 0 && !hit.length) return { total: 0, leadObjective: 0, platforms: [], srcIdx: [], reason: noCampaignSpend(M, f), unsplit: [], fetchedAt: null };
  if (f.campaign >= 0) platforms = hit;
  const names = platforms.map((p) => (p === 'meta' ? 'Meta' : 'Google'));
  return {
    total, leadObjective, platforms, srcIdx: names.map((n) => M.p.dims.source.indexOf(n)).filter((i) => i >= 0), reason: null,
    unsplit: unsplitOf(f), fetchedAt: platforms.map((p) => b[p].snapshot!.fetched_at).sort()[0] ?? null,
  };
}

export interface AdBudget {
  /** daily budgets of campaigns that are active today (campaign-level, or the live ad sets added up) */
  daily: number;
  dailyCampaigns: number;
  /** total (lifetime) budgets of active campaigns, and what the platform says is still unspent */
  lifetime: number;
  lifetimeLeft: number;
  lifetimeCampaigns: number;
  platforms: Platform[];
  reason: string | null;
  unsplit: string[];
}

export function adBudgetNow(b: BudgetPayload | null, M: Model, f: Filters): AdBudget {
  const { platforms, reason } = scopeOf(b, M, f);
  const out: AdBudget = { daily: 0, dailyCampaigns: 0, lifetime: 0, lifetimeLeft: 0, lifetimeCampaigns: 0, platforms, reason, unsplit: unsplitOf(f) };
  if (reason || !b) return out;
  for (const p of platforms) {
    for (const a of b[p].snapshot!.accounts) {
      const only = campaignIds(M, f, a);
      for (const c of a.campaigns) {
        if (c.status_group !== 'active' || (only && !only.has(c.campaign_id))) continue;
        if (c.daily_budget) { out.daily += c.daily_budget; out.dailyCampaigns++; }
        if (c.lifetime_budget) { out.lifetime += c.lifetime_budget; out.lifetimeLeft += c.remaining_budget ?? 0; out.lifetimeCampaigns++; }
      }
    }
  }
  return out;
}

export interface PeriodBudget {
  total: number;
  campaigns: number;
  reason: string | null;
}

/** Budget allocated to the period: for every campaign that spent in a month of the period, its daily budget × the days of
 *  that month (to today in the current month), or its lifetime budget once for a campaign on a lifetime budget. Budgets are
 *  today's settings - Meta and Google keep no budget history - so a campaign whose budget changed is shown at today's level. */
export function periodBudget(b: BudgetPayload | null, M: Model, f: Filters, rg: Range): PeriodBudget {
  const { platforms, reason } = scopeOf(b, M, f);
  if (reason || !b) return { total: 0, campaigns: 0, reason: reason ?? 'Ad budget is not loaded' };
  const keys = new Set(M.p.months.slice(rg[0], rg[1] + 1));
  let total = 0;
  let campaigns = 0;
  let any = false;
  for (const p of platforms) {
    for (const a of b[p].snapshot!.accounts) {
      const only = campaignIds(M, f, a);
      if (only && !only.size) continue;
      any = true;
      const today = new Date(`${a.today}T00:00:00`);
      const ran = new Map<string, string[]>();
      for (const m of a.campaign_monthly) if (keys.has(m.period) && m.spend > 0 && (!only || only.has(m.campaign_id))) ran.set(m.campaign_id, [...(ran.get(m.campaign_id) ?? []), m.period]);
      for (const c of a.campaigns) {
        const ms = ran.get(c.campaign_id);
        if (!ms) continue;
        if (c.daily_budget) {
          for (const ym of ms) {
            const [y, mo] = ym.split('-').map(Number);
            const days = y === today.getFullYear() && mo === today.getMonth() + 1 ? today.getDate() : new Date(y, mo, 0).getDate();
            total += c.daily_budget * days;
          }
          campaigns++;
        } else if (c.lifetime_budget) {
          total += c.lifetime_budget;
          campaigns++;
        }
      }
    }
  }
  if (f.campaign >= 0 && !any) return { total: 0, campaigns: 0, reason: noCampaignSpend(M, f) };
  return { total, campaigns, reason: null };
}

/** Spend per calendar month ('YYYY-MM') for each platform the Source filter allows, following the Campaign filter like
 *  adSpendIn. `reason` says why there is none (not saved, or a filter that ad spend cannot follow). */
export function monthlySpend(b: BudgetPayload | null, M: Model, f: Filters): { byPlatform: Partial<Record<'Meta' | 'Google', Map<string, number>>>; reason: string | null } {
  const { platforms, reason } = scopeOf(b, M, f);
  if (reason || !b) return { byPlatform: {}, reason: reason ?? 'Ad spend is not loaded' };
  const unsplit = unsplitOf(f);
  if (unsplit.length) return { byPlatform: {}, reason: `Ad spend cannot be split by ${unsplit.join(', ')}` };
  const out: Partial<Record<'Meta' | 'Google', Map<string, number>>> = {};
  for (const p of platforms) {
    const name = p === 'meta' ? 'Meta' : 'Google';
    for (const a of b[p].snapshot!.accounts) {
      const only = campaignIds(M, f, a);
      if (only && !only.size) continue;
      const m = out[name] ?? new Map<string, number>();
      if (only) { for (const r of a.campaign_monthly) if (only.has(r.campaign_id)) m.set(r.period, (m.get(r.period) ?? 0) + r.spend); }
      else for (const r of a.monthly) m.set(r.period, (m.get(r.period) ?? 0) + r.spend);
      out[name] = m;
    }
  }
  if (f.campaign >= 0 && !Object.keys(out).length) return { byPlatform: {}, reason: noCampaignSpend(M, f) };
  return { byPlatform: out, reason: null };
}

/** A change vs the previous period with no good/bad colour: more spend is neither. */
export function NeutralDelta({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur === null || prev === null || !isFinite(cur) || !isFinite(prev) || prev === 0) return <span className="ld-delta none">no earlier period to compare</span>;
  const diff = (100 * (cur - prev)) / Math.abs(prev);
  const Icon = diff > 0.05 ? ArrowUp : diff < -0.05 ? ArrowDown : ArrowRight;
  return (
    <span className="ld-delta flat">
      <Icon size={13} strokeWidth={2} aria-hidden /> {diff > 0 ? '+' : ''}{diff.toFixed(0)}% <span className="ld-muted">vs last period</span>
    </span>
  );
}

const OBJECTIVE_NAMES: Record<string, string> = {
  OUTCOME_LEADS: 'Leads', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_SALES: 'Sales', OUTCOME_AWARENESS: 'Awareness',
  OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_APP_PROMOTION: 'App promotion',
};
export const objectiveName = (o: string | null | undefined) => (o ? OBJECTIVE_NAMES[o] ?? o.replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase() : 'Not stated');

export interface SpendBreakdown {
  byObjective: { label: string; value: number }[];
  campaigns: { id: string; name: string; objective: string; status: string; spend: number }[];
}

/** The period's spend by campaign objective and by campaign, for the platform(s) the Source filter allows. Spend of a
 *  campaign that no longer exists on the account is kept, under "Removed campaign". */
export function spendBreakdown(b: BudgetPayload | null, M: Model, f: Filters, rg: Range): SpendBreakdown | null {
  const { platforms, reason } = scopeOf(b, M, f);
  if (reason || !b) return null;
  const keys = new Set(M.p.months.slice(rg[0], rg[1] + 1));
  const obj = new Map<string, number>();
  const per = new Map<string, { id: string; name: string; objective: string; status: string; spend: number }>();
  for (const p of platforms) {
    for (const a of b[p].snapshot!.accounts) {
      const info = new Map(a.campaigns.map((c) => [c.campaign_id, c]));
      for (const m of a.campaign_monthly) {
        if (!keys.has(m.period) || !m.spend) continue;
        const c = info.get(m.campaign_id);
        const o = c ? objectiveName(c.objective) : 'Removed campaign';
        obj.set(o, (obj.get(o) ?? 0) + m.spend);
        const e = per.get(m.campaign_id) ?? { id: m.campaign_id, name: c?.name ?? 'Removed campaign', objective: o, status: c?.status_group ?? 'ended', spend: 0 };
        e.spend += m.spend;
        per.set(m.campaign_id, e);
      }
    }
  }
  return {
    byObjective: [...obj.entries()].map(([label, value]) => ({ label, value })).sort((x, y) => y.value - x.value),
    campaigns: [...per.values()].sort((x, y) => y.spend - x.spend),
  };
}
