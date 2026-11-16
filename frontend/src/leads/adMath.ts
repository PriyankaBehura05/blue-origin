// Pure maths of the ad detail cards (no browser, no API): adding months up for a period, and the ratios.
//   spend, impressions, clicks, leads  add up over the months of the period
//   reach  counts people, so it does not add up: the whole life of an entity is Meta's own figure, one month is exact, several
//          months are the sum of the months (shown with ≈ and without a frequency)
//   frequency  impressions ÷ reach, only when reach is exact
import type { MetaLife, MetaMonthly } from './types';

export interface Perf { spend: number; impressions: number; reach: number | null; reachApprox: boolean; clicks: number; linkClicks: number; leads: number }

export function perfOf(monthly: MetaMonthly[], life: MetaLife | undefined, months: Set<string>): Perf {
  const inP = monthly.filter((r) => months.has(r.period));
  const sum = (k: 'spend' | 'impressions' | 'clicks' | 'link_clicks' | 'leads' | 'reach') => inP.reduce((s, r) => s + (r[k] || 0), 0);
  const whole = monthly.length > 0 && monthly.every((r) => months.has(r.period));
  let reach: number | null = null;
  let approx = false;
  if (life && whole) reach = life.reach;
  else if (inP.length === 1) reach = inP[0].reach;
  else if (inP.length > 1) { reach = sum('reach'); approx = true; }
  return { spend: sum('spend'), impressions: sum('impressions'), reach, reachApprox: approx, clicks: sum('clicks'), linkClicks: sum('link_clicks'), leads: sum('leads') };
}

export const cpl = (p: { spend: number; leads: number }) => (p.leads ? p.spend / p.leads : null);
export const ctr = (p: { clicks: number; impressions: number }) => (p.impressions ? (100 * p.clicks) / p.impressions : null);
export const cpc = (p: { spend: number; clicks: number }) => (p.clicks ? p.spend / p.clicks : null);
export const cpm = (p: { spend: number; impressions: number }) => (p.impressions ? (1000 * p.spend) / p.impressions : null);
export const freq = (p: { impressions: number; reach: number | null; reachApprox: boolean }) => (p.reach && !p.reachApprox ? p.impressions / p.reach : null);
export const rate = (num: number, den: number) => (den ? (100 * num) / den : null);

export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return m;
}

const NICE: Record<string, string> = {
  'onsite_conversion.lead_grouped': 'Lead form submissions', lead: 'Leads (all kinds)', leadgen_grouped: 'Lead form leads (grouped)', link_click: 'Link clicks',
  landing_page_view: 'Landing page views', post_engagement: 'Post engagement', page_engagement: 'Page engagement', video_view: 'Video views', post_reaction: 'Reactions',
  comment: 'Comments', like: 'Page likes', 'onsite_conversion.messaging_conversation_started_7d': 'Messaging conversations started', 'onsite_conversion.total_messaging_connection': 'Messaging connections',
  omni_purchase: 'Purchases', omni_add_to_cart: 'Add to cart', omni_view_content: 'Content views', omni_initiated_checkout: 'Checkouts started', omni_search: 'Searches',
};
export const eventName = (t: string) => NICE[t] ?? t.replace(/^(onsite_conversion|offsite_conversion)\./, '').replace(/[_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const titleCase = (s: string | number | undefined) => String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
