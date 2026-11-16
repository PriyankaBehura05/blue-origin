// Performance trends (Campaign performance page): cost, leads, CPL, impressions and CTR by platform, and revenue by platform.
// Daily and weekly look at the selected period day by day from the saved daily delivery (payload.adDaily); monthly runs from the
// first month with leads or spend to the end of the selected period. Same definitions as everywhere: spend, impressions, clicks and
// leads are what the platforms report (leads: Meta lead forms; Google conversions of the "Conversion" action); revenue = BO billing
// of retailers a lead of that source brought in or back (retailerStats + reactivatedRevenue), monthly because BO sales are monthly.
import { useMemo, useState } from 'react';
import { Calendar, CalendarDays, CalendarRange } from 'lucide-react';
import { Lines } from '../charts';
import { monthlySpend } from '../adSpend';
import { gtMonthly } from '../gt';
import { reactivatedRevenue, retailerStats } from '../calc';
import { monthName } from '../model';
import { SOURCE_COLORS } from '../sections';
import type { BudgetPayload } from '../types';
import { Card, IconToggle, inr, num, useLeads } from '../ui';

type Row = Record<string, number | string | null>;
type Grain = 'daily' | 'weekly' | 'monthly';
type Plat = 'Meta' | 'Google';
interface Pt { spend: number; leads: number; impressions: number; clicks: number }
const ZERO: Pt = { spend: 0, leads: 0, impressions: 0, clicks: 0 };
const PLATS: Plat[] = ['Meta', 'Google'];
const week = (day: number) => Math.floor((day + 3) / 7);   // Monday-based weeks (1970-01-01 was a Thursday)
const dayLabel = (d: number) => new Date(d * 864e5).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });

export default function PlatformTrends({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg } = useLeads();
  const L = M.p.leads;
  const src = M.p.dims.source;
  const [grain, setGrain] = useState<Grain>('monthly');
  const ad = M.p.adDaily;
  const hasDaily = !!ad?.platforms && ad.rows.length > 0 && ad.rows[0].length >= 6;
  const g: Grain = hasDaily ? grain : 'monthly';

  // months shown for the monthly view: from the first month with leads or spend to the end of the selected period
  const spend = useMemo(() => monthlySpend(budget, M, f), [budget, M, f]);
  const months = useMemo(() => {
    const spentKeys = new Set(Object.values(spend.byPlatform).flatMap((m) => [...m!.keys()]));
    let first = M.p.months.findIndex((k) => spentKeys.has(k));
    for (let i = 0; i < M.nL; i++) if (first < 0 || L.m[i] < first) first = L.m[i];
    const end = Math.min(rg[1], M.nM - 1);
    return first < 0 ? [] : Array.from({ length: end - first + 1 }, (_, j) => first + j);
  }, [spend, M, rg, L]);
  const gm = useMemo(() => gtMonthly(budget, M, f), [budget, M, f]);

  // one series per platform: labels plus spend, leads, impressions and clicks per point
  const series = useMemo(() => {
    const campName = f.campaign >= 0 ? M.p.dims.campaign[f.campaign] : null;
    const srcName = f.source >= 0 ? src[f.source] : null;
    if (g === 'monthly' || !ad) {
      const by: Partial<Record<Plat, Pt[]>> = {};
      for (const p of PLATS) if (gm.by[p]) by[p] = months.map((m) => gm.by[p]!.get(M.p.months[m]) ?? ZERO);
      return { labels: months.map((m) => monthName(M, m)), by };
    }
    const [y0, m0] = M.p.months[rg[0]].split('-').map(Number);
    const [y1, m1] = M.p.months[Math.min(rg[1], M.nM - 1)].split('-').map(Number);
    const from = Date.UTC(y0, m0 - 1, 1) / 864e5;
    const to = Math.min(Date.UTC(y1, m1, 0) / 864e5, Math.floor(Date.now() / 864e5));
    const keyOf = (d: number) => (g === 'daily' ? d : week(d));
    const keys: number[] = [];
    for (let d = from; d <= to; d++) if (!keys.length || keys[keys.length - 1] !== keyOf(d)) keys.push(keyOf(d));
    const index = new Map(keys.map((k, i) => [k, i]));
    const by: Partial<Record<Plat, Pt[]>> = {};
    for (const p of PLATS) {
      if (srcName && srcName !== p) continue;
      const pts = keys.map(() => ({ ...ZERO }));
      let any = false;
      for (const [ci, day, s, im, cl, ld] of ad.rows) {
        if (ad.platforms![ci] !== p || day < from || day > to || (campName && ad.campaigns[ci] !== campName)) continue;
        const e = pts[index.get(keyOf(day))!];
        e.spend += s; e.impressions += im; e.clicks += cl; e.leads += ld;
        any = true;
      }
      if (any) by[p] = pts;
    }
    return { labels: keys.map((k) => (g === 'daily' ? dayLabel(k) : dayLabel(k * 7 - 3))), by };
  }, [g, ad, gm, months, M, f, rg, src]);
  const plats = PLATS.filter((p) => series.by[p]);
  const unsplit = spend.reason;   // the filters ad data cannot follow (state, city, distributor, tier), or no ad data

  const rows = (pick: (p: Pt) => number | null): Row[] => series.labels.map((x, i) => ({ x, ...Object.fromEntries(plats.map((p) => [p, pick(series.by[p]![i])])) }));
  const cost = rows((p) => p.spend);
  const leadRows = rows((p) => p.leads);
  const cplRows = rows((p) => (p.leads ? p.spend / p.leads : null));
  const impRows = rows((p) => p.impressions);
  const ctrRows = rows((p) => (p.impressions ? (100 * p.clicks) / p.impressions : null));
  const csv = (r: Row[], digits?: number) => r.map((x) => ({ [g === 'monthly' ? 'Month' : g === 'weekly' ? 'Week starting' : 'Day']: x.x, ...Object.fromEntries(plats.map((p) => [p, x[p] === null ? 'N/A' : digits !== undefined ? (x[p] as number).toFixed(digits) : x[p]])) }));
  const total = (r: Row[]) => r.reduce((s, x) => s + plats.reduce((t, p) => t + (typeof x[p] === 'number' ? (x[p] as number) : 0), 0), 0);
  const label = g === 'monthly' ? 'month' : g === 'weekly' ? 'week' : 'day';

  // lead-attributed revenue per month and source (sources with leads only; blank after the last month of BO sales)
  const sources = useMemo(() => src.map((_, j) => j).filter((j) => (f.source < 0 || f.source === j) && L.src.some((s) => s === j)), [src, f.source, L]);
  const revenue = useMemo<Row[]>(() => months.map((m) => {
    const row: Row = { x: monthName(M, m) };
    for (const j of sources) {
      if (m > M.p.salesEnd) { row[`s${j}`] = null; continue; }
      const f2 = { ...f, source: j };
      row[`s${j}`] = retailerStats(M, f2, [m, m], null).revenueMkt + reactivatedRevenue(M, f2, [m, m]);
    }
    return row;
  }), [months, sources, M, f]);
  const revenueTotal = revenue.reduce((s, r) => s + sources.reduce((t, j) => t + (typeof r[`s${j}`] === 'number' ? (r[`s${j}`] as number) : 0), 0), 0);
  const COLOR: Record<string, string> = { Meta: SOURCE_COLORS[0], Google: SOURCE_COLORS[1] };
  const inPeriod = `${monthName(M, rg[0])} – ${monthName(M, Math.min(rg[1], M.nM - 1))}`;
  const empty = <div className="ld-empty-s">{unsplit ?? 'No campaign data saved yet for these filters.'}</div>;
  const line = (r: Row[], fmt: (v: number) => string) => (!plats.length || unsplit ? empty
    : <Lines data={r} x="x" fmt={fmt} height={260} series={plats.map((p) => ({ key: p, label: `${p} Ads`, color: COLOR[p] }))} />);
  const SRC = 'Saved ad data (Ad budget page)';

  return (
    <>
      <div className="ld-toolrow">
        <span className="ld-note">{g === 'monthly' ? 'Every month up to the end of the selected period.' : `Each ${label} of the selected period (${inPeriod}).`}{!hasDaily ? ' Daily and weekly need the daily data, which arrives at the next data build after the ad data is fetched.' : ''}</span>
        <IconToggle label="Trend detail" value={g} onChange={setGrain} options={[
          { value: 'daily', icon: CalendarDays, label: 'Daily' }, { value: 'weekly', icon: CalendarRange, label: 'Weekly' }, { value: 'monthly', icon: Calendar, label: 'Monthly' }]} />
      </div>
      <div className="ld-grid">
        <Card title="Cost by platform" uses={['period', 'source', 'campaign']}
          info={{ what: `Ad spend per ${label} on Meta and Google, as the platforms report it. Follows the Source and Campaign filters; the platforms do not report spend by state, city or distributor.`, source: SRC }}
          csv={{ name: `cost_by_platform_${g}`, rows: () => csv(cost) }}
          soWhat={unsplit ?? (cost.length ? <>Total spend shown: <b>{inr(total(cost))}</b>.</> : undefined)}>{line(cost, inr)}</Card>
        <Card title="Leads by platform" uses={['period', 'source', 'campaign']}
          info={{ what: `Leads per ${label} as Meta and Google report them for the campaigns: Meta lead-form results, and Google conversions of the “Conversion” action.`, source: SRC }}
          csv={{ name: `leads_by_platform_${g}`, rows: () => csv(leadRows) }}
          soWhat={leadRows.length && !unsplit ? <>Leads shown: <b>{num(Math.round(total(leadRows)))}</b>.</> : undefined}>{line(leadRows, (v) => num(Math.round(v)))}</Card>
        <Card title="CPL by platform" uses={['period', 'source', 'campaign']}
          info={{ what: `Cost per lead each ${label}: that ${label}'s spend ÷ its leads, per platform. A gap in the line = no leads that ${label} (CPL N/A), not zero.`, formula: 'CPL = spend ÷ leads', source: SRC }}
          csv={{ name: `cpl_by_platform_${g}`, rows: () => csv(cplRows, 2) }}>{line(cplRows, inr)}</Card>
        <Card title="Impressions by platform" uses={['period', 'source', 'campaign']}
          info={{ what: `How often the ads were shown per ${label}, per platform.`, source: SRC }}
          csv={{ name: `impressions_by_platform_${g}`, rows: () => csv(impRows) }}>{line(impRows, (v) => num(Math.round(v)))}</Card>
        <Card title="CTR by platform" uses={['period', 'source', 'campaign']}
          info={{ what: `Click-through rate per ${label}: clicks ÷ impressions. A gap = nothing was shown.`, formula: 'CTR = clicks ÷ impressions × 100', source: SRC }}
          csv={{ name: `ctr_by_platform_${g}`, rows: () => csv(ctrRows, 2) }}>{line(ctrRows, (v) => `${v.toFixed(2)}%`)}</Card>
        <Card title="Revenue by platform (monthly)" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          info={{ what: "Lead-attributed BO sales per month, by the source of the lead: billing from completely new retailers a lead brought in (from their first bill) plus retailers a lead brought back (from the lead's month). Each retailer is credited to one source only. BO sales are monthly, so this card is always monthly. Months after the last BO sales month are left blank, not zero.",
            source: 'Lead sheets matched to BO sales' }}
          csv={{ name: 'revenue_by_platform', rows: () => revenue.map((r) => ({ Month: r.x, ...Object.fromEntries(sources.map((j) => [src[j], r[`s${j}`]])) })) }}
          soWhat={revenue.length ? <>Lead-attributed sales shown: <b>{inr(revenueTotal)}</b>{rg[1] > M.p.salesEnd ? ` · BO sales data runs to ${monthName(M, M.p.salesEnd)}` : ''}.</> : undefined}>
          {!sources.length ? <div className="ld-empty-s">No leads for these filters.</div>
            : <Lines data={revenue} x="x" fmt={inr} height={260} series={sources.map((j) => ({ key: `s${j}`, label: src[j], color: SOURCE_COLORS[j] }))} />}
        </Card>
      </div>
    </>
  );
}
