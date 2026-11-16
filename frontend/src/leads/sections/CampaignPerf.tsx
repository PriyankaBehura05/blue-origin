// Campaign performance, sections 1-8 (the existing spend, budget and lead detail stays below them on the same page):
//   1 KPI strip  2 Campaign scorecard (one row per campaign, expandable to ad sets)  3 Recommendation rules
//   4 Weekly trend (leads, conversions, spend; top 5 campaigns)  5 Campaign funnel  6 Spend vs outcome
//   7 Geographic performance  8 Data scope (DataScope, placed at the end of the page)
// Every figure comes from campaignStats.ts; campaigns and sources that are not linked to one campaign are never mixed.
import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Coins, IndianRupee, Megaphone, Percent, Target, TrendingUp, Users, UserCheck, Wallet } from 'lucide-react';
import { CartesianGrid, ComposedChart, Legend as RLegend, Line, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis, Bar as RBar } from 'recharts';
import { HelpTip } from '@/components/HelpTip';
import { adSpendIn } from '../adSpend';
import {
  callOf, campaignStats, convRate, costPerRetailer, KILL_PAYBACK, MIN_LEADS, medianGap, paybackMonths, repeatPct, roi90, spendByCampaign, type CampRow, type Call,
} from '../campaignStats';
import { NEW, outcomeOf, REACTIVATED } from '../model';
import type { BudgetPayload } from '../types';
import { Bar as InBar, Card, IconToggle, Kpi, MiniSelect, Pct, inr, num, pctTxt, useLeads } from '../ui';

const USES = ['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window'] as const;
const CALL_CLASS: Record<Call, string> = { Scale: 'scale', Fix: 'fix', Kill: 'kill', 'Too early': 'early', 'Needs spend data': 'nodata' };
const PALETTE = ['var(--ld-src-meta)', 'var(--ld-src-google)', 'var(--ld-src-jd)', 'var(--ld-src-print)', 'var(--ld-seq-4)'];
const months = (v: number | null) => (v === null ? '—' : v < 0.5 ? 'same month' : `${v.toFixed(1)} mo`);

type SortKey = 'name' | 'leads' | 'converted' | 'rate' | 'gap' | 'repeat' | 'rev90' | 'spend' | 'cpr' | 'payback' | 'call';

export function useCampaignRows(budget: BudgetPayload | null) {
  const { M, f, rg } = useLeads();
  return useMemo(() => {
    const ad = adSpendIn(budget, M, f, rg);
    const block = ad.reason ?? (ad.unsplit.length ? `Ad spend cannot be split by ${ad.unsplit.join(', ')}` : null);
    const spend = block ? new Map<string, number>() : spendByCampaign(budget, M, rg);
    return { rows: campaignStats(M, f, rg, spend), block, hasSpend: !block && spend.size > 0 };
  }, [budget, M, f, rg]);
}

export default function CampaignPerf({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg } = useLeads();
  const { rows, block, hasSpend } = useCampaignRows(budget);
  const t = M.p.targets;
  const margin = (t.gross_margin_pct ?? 30) / 100;
  const L = M.p.leads;

  // ---- 1. KPI strip
  const camp = rows.filter((r) => r.kind === 'campaign');
  const paid = rows.filter((r) => r.platform === 'Meta' || r.platform === 'Google');   // the leads the spend can be divided by
  const sum = (rs: CampRow[], k: 'leads' | 'judged' | 'converted' | 'fresh' | 'rev90' | 'rev90New' | 'rev90Pending') => rs.reduce((s, r) => s + r[k], 0);
  const spendTotal = camp.reduce((s, r) => s + (r.spend ?? 0), 0);
  const totals = { leads: sum(rows, 'leads'), judged: sum(rows, 'judged'), converted: sum(rows, 'converted'), rev90: sum(rows, 'rev90'), rev90New: sum(rows, 'rev90New'), pending: sum(rows, 'rev90Pending') };
  const paidLeads = sum(paid, 'leads');
  const paidFresh = sum(paid, 'fresh');
  const paidRev = sum(paid, 'rev90');
  const money = hasSpend && spendTotal > 0;
  const noData = block ?? 'No spend saved for these campaigns';

  // ---- 2. scorecard
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'leads', dir: -1 });
  const [open, setOpen] = useState<string | null>(null);
  const val = (r: CampRow, k: SortKey): number | string => {
    switch (k) {
      case 'name': return r.name;
      case 'leads': return r.leads;
      case 'converted': return r.converted;
      case 'rate': return convRate(r) ?? -1;
      case 'gap': return medianGap(r) ?? 999;
      case 'repeat': return repeatPct(r) ?? -1;
      case 'rev90': return r.rev90;
      case 'spend': return r.spend ?? -1;
      case 'cpr': return costPerRetailer(r) ?? Infinity;
      case 'payback': return paybackMonths(r, margin) ?? Infinity;
      case 'call': return callOf(r, t);
    }
  };
  const sorted = (rs: CampRow[]) => [...rs].sort((a, b) => {
    const x = val(a, sort.k), y = val(b, sort.k);
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
  });
  const head = (k: SortKey, label: string, numeric = true, help?: string) => (
    <th className={numeric ? 'num' : ''} aria-sort={sort.k === k ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => setSort((s) => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : numeric ? -1 : 1 }))}>
        {label}{sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
      </button>
      {help && <HelpTip text={help} />}
    </th>
  );
  const adsets = (r: CampRow) => {
    const m = new Map<number, { leads: number; conv: number }>();
    for (const i of r.leadIdx) {
      const e = m.get(L.adset[i]) ?? { leads: 0, conv: 0 };
      e.leads++;
      const o = outcomeOf(M, i, f.level, f.window);
      if (o === NEW || o === REACTIVATED) e.conv++;
      m.set(L.adset[i], e);
    }
    return [...m.entries()].filter(([a]) => a >= 0 && M.p.dims.adset[a] !== '(no ad set)');
  };
  const rowCells = (r: CampRow) => {
    const call = callOf(r, t);
    return (
      <>
        <td className="num">{num(r.leads)}</td>
        <td className="num">{num(r.converted)}</td>
        <td className="num"><Pct k={r.converted} n={r.judged} label="Converted ÷ leads that can be judged" /></td>
        <td className="num">{months(medianGap(r))}</td>
        <td className="num">{r.retailers ? <Pct k={r.repeat} n={r.retailers} label="Credited retailers that bought again in a later month ÷ credited retailers" /> : '—'}</td>
        <td className="num">{r.rev90 ? inr(r.rev90) : '—'}{r.rev90Pending ? <div className="ld-muted">+{num(r.rev90Pending)} not 90 days yet</div> : null}</td>
        <td className="num">{r.spend !== null ? inr(r.spend) : <span className="ld-muted">no spend data</span>}</td>
        <td className="num">{costPerRetailer(r) !== null ? inr(costPerRetailer(r)!) : '—'}</td>
        <td className="num">{paybackMonths(r, margin) !== null ? `${paybackMonths(r, margin)!.toFixed(1)} mo` : '—'}</td>
        <td><span className={`ld-call ${CALL_CLASS[call]}`}>{call}</span></td>
      </>
    );
  };
  const csv = () => rows.map((r) => ({
    Type: r.kind === 'campaign' ? 'Campaign' : 'Source (no campaign)', Campaign: r.name, Platform: r.platform, Leads: r.leads, 'Leads that can be judged': r.judged,
    'Converted leads': r.converted, 'Conversion %': convRate(r)?.toFixed(2) ?? '', 'Median months to convert': medianGap(r) ?? '', 'Repeat purchase %': repeatPct(r)?.toFixed(1) ?? '',
    '90-day revenue (all converted)': Math.round(r.rev90), '90-day revenue (new retailers)': Math.round(r.rev90New), 'Converted retailers without 90 days of data': r.rev90Pending,
    Spend: r.spend ?? '', 'New retailers': r.fresh, 'Cost per new retailer': costPerRetailer(r)?.toFixed(0) ?? '', 'Payback (months)': paybackMonths(r, margin)?.toFixed(1) ?? '',
    Recommendation: callOf(r, t),
  }));

  // ---- 4. weekly trend
  const [trendView, setTrendView] = useState<'total' | 'top5'>('total');
  const [trendMetric, setTrendMetric] = useState<'leads' | 'conv'>('leads');
  const week = (day: number) => Math.floor((day + 3) / 7);           // Monday-based weeks (1970-01-01 was a Thursday)
  const weekLabel = (w: number) => new Date((w * 7 - 3) * 864e5).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const top5 = useMemo(() => [...camp].sort((a, b) => b.leads - a.leads).slice(0, 5), [camp]);
  const trend = useMemo(() => {
    const by = new Map<number, Record<string, number>>();
    const get = (w: number) => by.get(w) ?? by.set(w, { leads: 0, conv: 0, spend: 0 }).get(w)!;
    const inTop = new Map(top5.map((r, j) => [r.name, j]));
    for (const r of rows) for (const i of r.leadIdx) {
      const e = get(week(L.day[i]));
      const o = outcomeOf(M, i, f.level, f.window);
      const conv = o === NEW || o === REACTIVATED ? 1 : 0;
      e.leads++;
      e.conv += conv;
      const j = inTop.get(r.name);
      if (r.kind === 'campaign' && j !== undefined) e[`c${j}`] = (e[`c${j}`] ?? 0) + (trendMetric === 'leads' ? 1 : conv);
    }
    const d = M.p.adDaily;
    if (d && money) {
      const allowed = new Set(camp.map((r) => r.name));
      const from = new Date(`${M.p.months[rg[0]]}-01T00:00:00Z`).getTime() / 864e5;
      const [y, mo] = M.p.months[Math.min(rg[1], M.nM - 1)].split('-').map(Number);
      const to = Date.UTC(y, mo, 0) / 864e5;
      for (const [ci, day, s] of d.rows) if (day >= from && day <= to && allowed.has(d.campaigns[ci])) get(week(day)).spend += s;
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([w, e]) => ({ ...e, w: weekLabel(w) }) as Record<string, number> & { w: string });
  }, [rows, camp, top5, trendMetric, M, f, rg, L, money]);
  const spendWeekly = !!M.p.adDaily && money;

  // ---- 6. bubble chart: only campaigns with spend and at least one new retailer
  const bubbles = camp.filter((r) => r.spend && r.fresh).map((r) => ({ name: r.name, x: r.spend!, y: costPerRetailer(r)!, z: r.leads, platform: r.platform }));

  // ---- 7. geography of the selected campaign
  const [geoCamp, setGeoCamp] = useState<string>('');
  const geoRow = rows.find((r) => r.key === geoCamp) ?? camp[0] ?? rows[0];
  const geo = useMemo(() => {
    if (!geoRow) return null;
    const ret = M.ret[f.level];
    const R = M.p.retailers;
    const by = (pick: (i: number) => number, names: string[]) => {
      const m = new Map<number, { leads: number; conv: number; judged: number; existing: number }>();
      for (const i of geoRow.leadIdx) {
        const k = pick(i);
        const e = m.get(k) ?? { leads: 0, conv: 0, judged: 0, existing: 0 };
        e.leads++;
        const o = outcomeOf(M, i, f.level, f.window);
        if (o === NEW || o === REACTIVATED) e.conv++;
        if (o === 0) e.existing++;
        if (L.valid[i] && o !== 5) e.judged++;
        m.set(k, e);
      }
      return [...m.entries()].map(([k, e]) => ({ name: k >= 0 ? names[k] : 'Not given', ...e })).sort((a, b) => b.conv - a.conv || b.leads - a.leads).slice(0, 10);
    };
    return {
      states: by((i) => (L.s[i] >= 0 ? L.s[i] : ret[i] >= 0 ? R.s[ret[i]] : -1), M.p.dims.state),
      cities: by((i) => (L.c[i] >= 0 ? L.c[i] : ret[i] >= 0 ? R.c[ret[i]] : -1), M.p.dims.city),
    };
  }, [geoRow, M, f, L]);

  if (!M.p.hasLeads) return null;
  const campRows = sorted(camp);
  const srcRows = sorted(rows.filter((r) => r.kind === 'source'));
  const cols = 11;

  return (
    <>
      {/* 1 ------------------------------------------------------------------ KPI strip */}
      <h3 className="ld-subhead">1. Key numbers <span>leads in the period, their BO outcome and what they cost</span></h3>
      <div className="ld-kpis ld-kpis-4">
        <Kpi icon={Users} label="Total leads" rag="none" value={num(totals.leads)} sub="unique leads (first enquiry per mobile), every source" info="Unique leads in the lead sheet whose lead date is in the period, from every source (Meta, Google, Print, Other)." />
        <Kpi icon={UserCheck} label="Converted leads" rag="none" value={num(totals.converted)} sub="BO retailer billed after the lead" info={`Unique leads whose BO retailer billed within ${f.window} days of the lead: a completely new retailer, or one that came back after 3 quiet months.`} />
        <Kpi icon={Percent} label="Conversion rate" rag="none" value={pctTxt(totals.converted, totals.judged)} sub={`${num(totals.converted)} of ${num(totals.judged)} leads that can be judged`} info="Converted leads ÷ unique leads that can be judged (a working number, and BO sales cover the window)." />
        <Kpi icon={Wallet} label="Spend" rag="none" value={money ? inr(spendTotal) : '—'} sub={money ? `${num(camp.filter((r) => r.spend).length)} campaigns` : noData} info="What Meta and Google report as spent on the campaigns in the months of the period." />
        <Kpi icon={Target} label="Cost per lead" rag="none" value={money && paidLeads ? inr(spendTotal / paidLeads) : '—'} sub={money ? `${inr(spendTotal)} ÷ ${num(paidLeads)} Meta + Google leads in the lead sheet` : noData}
          info="Spend ÷ unique Meta and Google leads in the lead sheet (linked to a campaign or not). The Overview's CPL divides by the leads the platforms report, which are more, so it is lower." />
        <Kpi icon={Coins} label="Cost per retailer" rag="none" value={money && paidFresh ? inr(spendTotal / paidFresh) : '—'} sub={money ? `${inr(spendTotal)} ÷ ${num(paidFresh)} new retailers from Meta + Google leads` : noData}
          info="Spend ÷ new retailers (first-ever BO order after a Meta or Google lead). Reactivated retailers are not counted here." />
        <Kpi icon={IndianRupee} label="90-day revenue" rag="none" value={inr(totals.rev90)} sub={`${inr(totals.rev90New)} of it from new retailers${totals.pending ? ` · ${num(totals.pending)} retailers not 90 days yet` : ''}`}
          info="BO billing in the first 3 months of every retailer the period's leads converted (new: from its first-ever bill; came back: from the lead's month). Retailers without 3 full months of sales data are left out." />
        <Kpi icon={TrendingUp} label="ROI (90 days)" rag="none" value={money ? `${(100 * roi90({ spend: spendTotal, rev90: paidRev }, margin)!).toFixed(0)}%` : '—'}
          sub={money ? `(${inr(paidRev)} × ${t.gross_margin_pct ?? 30}% margin − ${inr(spendTotal)}) ÷ spend` : noData}
          info={`(90-day revenue of Meta and Google leads × gross margin ${t.gross_margin_pct ?? 30}% − spend) ÷ spend. Negative = the first 90 days do not yet pay back the spend. The margin is set on the Data & settings page.`} />
      </div>

      {/* 2 ------------------------------------------------------------------ scorecard */}
      <Card wide title="2. Campaign scorecard" uses={[...USES]}
        info={{ what: <>One row per campaign. Leads that are not linked to one campaign are listed after them as their own source rows and are never spread over campaigns. Click a campaign to see its ad sets where the lead sheet carries them. A strong recommendation needs at least {MIN_LEADS} leads that can be judged.</>,
          formula: 'conversion = converted ÷ judged leads · repeat = credited retailers that bought again ÷ credited retailers · cost per retailer = spend ÷ new retailers · payback = spend ÷ (90-day revenue ÷ 3 × margin)' }}
        csv={{ name: 'campaign_scorecard', rows: csv }}
        soWhat={block ?? (!hasSpend ? 'No campaign spend saved yet: every campaign shows Needs spend data.' : undefined)}>
        <div className="ld-table-wrap">
          <table className="ld-table ld-score">
            <thead><tr>
              {head('name', 'Campaign', false)}<th>Source</th>{head('leads', 'Leads')}{head('converted', 'Converted')}{head('rate', 'Conversion')}
              {head('gap', 'Median time to convert', true, 'Months from the lead to the first BO bill (new) or to the lead month (came back). BO sales are monthly, so days cannot be measured.')}
              {head('repeat', 'Repeat purchase')}{head('rev90', '90-day revenue', true, 'BO billing in the first 3 months of the converted retailers credited to the row (new and came back). Retailers without 3 full months yet are shown below the amount.')}
              {head('spend', 'Spend')}{head('cpr', 'Cost per retailer', true, 'Spend ÷ new retailers (first-ever order).')}{head('payback', 'Payback', true, `Spend ÷ (90-day revenue ÷ 3 × ${t.gross_margin_pct ?? 30}% margin): months of margin to earn the spend back.`)}
              {head('call', 'Recommendation', false)}
            </tr></thead>
            <tbody>
              {campRows.map((r) => {
                const sets = open === r.key ? adsets(r) : [];
                return (
                  <Fragment key={r.key}>
                    <tr className="click" onClick={() => setOpen(open === r.key ? null : r.key)}>
                      <td>{open === r.key ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {r.name}</td>
                      <td>{r.platform}</td>
                      {rowCells(r)}
                    </tr>
                    {open === r.key && (
                      <tr className="ld-score-detail"><td colSpan={cols + 1}>
                        {sets.length ? (
                          <table className="ld-table"><thead><tr><th>Ad set</th><th className="num">Leads</th><th className="num">Converted</th></tr></thead>
                            <tbody>{sets.map(([a, e]) => <tr key={a}><td>{M.p.dims.adset[a]}</td><td className="num">{num(e.leads)}</td><td className="num">{num(e.conv)}</td></tr>)}</tbody></table>
                        ) : <span className="ld-muted">Ad set and creative are not available for this campaign: the lead sheet carries no ad set or ad, and the Meta token cannot read lead forms (leads_retrieval).</span>}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {srcRows.length > 0 && <tr className="ld-score-sep"><td colSpan={cols + 1}>Leads not linked to one campaign: shown per source, not mixed with the campaigns above</td></tr>}
              {srcRows.map((r) => (
                <tr key={r.key} className="ld-score-src"><td>{r.name}</td><td>{r.platform}</td>{rowCells(r)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="ld-grid">
        {/* 3 ---------------------------------------------------------------- recommendation rules */}
        <Card title="3. How the recommendation is made" uses={[]}
          info={{ what: 'The rules behind each recommendation, with the targets set on the Data & settings page.' }}>
          <ul className="ld-rules">
            <li><span className="ld-call nodata">Needs spend data</span> no spend is saved for the row (Print, leads not linked to a campaign, or a filter ad spend cannot follow).</li>
            <li><span className="ld-call early">Too early</span> fewer than {MIN_LEADS} leads that can be judged: too few to call.</li>
            <li><span className="ld-call scale">Scale</span> conversion ≥ {t.conversion_pct ?? 5}% <b>and</b> cost per new retailer ≤ {inr(t.cost_per_retailer ?? 5000)}.</li>
            <li><span className="ld-call kill">Kill</span> cost per new retailer above {inr(2 * (t.cost_per_retailer ?? 5000))} (or no new retailer yet) <b>and</b> conversion under {((t.conversion_pct ?? 5) / 2).toFixed(1)}% <b>and</b> no payback within {KILL_PAYBACK} months. Never on conversion alone.</li>
            <li><span className="ld-call fix">Fix</span> everything in between: keep running, fix targeting, follow-up or landing.</li>
          </ul>
        </Card>
        {/* 5 ---------------------------------------------------------------- funnel */}
        <Card title="5. Campaign funnel" uses={[...USES]}
          info={{ what: 'Leads → contacted by an ASM → converted (BO billing) → repeat buyers (bought again in a later month), per campaign and per source. Contacted comes from the ASM columns of the lead sheet; where a source has none it says “not recorded” instead of 0.' }}
          csv={{ name: 'campaign_funnel', rows: () => rows.map((r) => ({ Row: r.name, Leads: r.leads, Contacted: r.contactTracked ? r.contacted : 'not recorded', Converted: r.converted, 'Repeat buyers': r.repeat })) }}>
          <div className="ld-cfun">
            {[...campRows, ...srcRows].map((r) => {
              const stages: [string, number | null][] = [['Leads', r.leads], ['Contacted', r.contactTracked ? r.contacted : null], ['Converted', r.converted], ['Repeat buyers', r.repeat]];
              return (
                <div key={r.key} className="ld-cfun-row">
                  <div className="ld-cfun-h"><b>{r.name}</b> <span className="ld-muted">{r.platform}{r.kind === 'source' ? ' · no campaign' : ''}</span></div>
                  {stages.map(([s, v]) => (
                    <div key={s} className="ld-cfun-s">
                      <span>{s}</span>
                      {v === null ? <em className="ld-muted">not recorded</em> : <><InBar value={v} max={Math.max(1, r.leads)} /><b>{num(v)}</b></>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* 4 ------------------------------------------------------------------ weekly trend */}
      <Card wide title="4. Weekly trend" uses={[...USES]}
        actions={<>
          {trendView === 'top5' && <MiniSelect label="Metric" value={trendMetric} onChange={setTrendMetric} options={[{ value: 'leads', label: 'Leads' }, { value: 'conv', label: 'Conversions' }]} />}
          <IconToggle label="Show" value={trendView} onChange={setTrendView} options={[{ value: 'total', icon: TrendingUp, label: 'All leads' }, { value: 'top5', icon: Megaphone, label: 'Top 5 campaigns' }]} />
        </>}
        info={{ what: 'Leads and conversions by the week of the lead (weeks start on Monday), with spend per week on the right axis where daily spend is saved. Top 5 compares the five campaigns with the most leads. Conversions of recent weeks fill in as BO sales arrive.' }}
        csv={{ name: 'weekly_trend', rows: () => trend.map((r) => ({ Week: r.w, Leads: r.leads, Conversions: r.conv, ...(spendWeekly ? { Spend: Math.round(r.spend) } : {}), ...Object.fromEntries(top5.map((c, j) => [c.name, (r as Record<string, unknown>)[`c${j}`] ?? 0])) })) }}
        soWhat={!spendWeekly ? (block ?? 'Weekly spend is not in the data yet: it is added at the next data build after the ad data is refreshed.') : undefined}>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trend} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--line-soft)" />
              <XAxis dataKey="w" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} interval="preserveStartEnd" />
              <YAxis yAxisId="n" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} width={48} />
              {trendView === 'total' && spendWeekly && <YAxis yAxisId="s" orientation="right" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => inr(Number(v))} />}
              <Tooltip formatter={(v: number, name: string) => (name === 'Spend' ? inr(v) : num(v))} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <RLegend wrapperStyle={{ fontSize: 12 }} />
              {trendView === 'total' ? (
                <>
                  {spendWeekly && <RBar yAxisId="s" dataKey="spend" name="Spend" fill="var(--ld-seq-2)" opacity={0.5} isAnimationActive={false} />}
                  <Line yAxisId="n" dataKey="leads" name="Leads" stroke="var(--ld-src-meta)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line yAxisId="n" dataKey="conv" name="Conversions" stroke="var(--ld-o-new)" strokeWidth={2} dot={false} isAnimationActive={false} />
                </>
              ) : top5.map((c, j) => <Line key={c.key} yAxisId="n" dataKey={`c${j}`} name={c.name} stroke={PALETTE[j]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="ld-grid">
        {/* 6 ---------------------------------------------------------------- spend vs outcome */}
        <Card title="6. Spend vs outcome" uses={[...USES]}
          info={{ what: 'Each bubble is a campaign: how much it spent (across) and what a new retailer cost (up), bubble size = its leads. Lower right = spends a lot but acquires cheaply. Only campaigns with spend and at least one new retailer are shown.', formula: 'cost per retailer = spend ÷ new retailers' }}>
          {!money || bubbles.length < 2 ? <div className="ld-empty-s">{!money ? noData : 'Needs at least two campaigns with spend and a new retailer to compare.'}</div> : (
            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke="var(--line-soft)" />
                  <XAxis type="number" dataKey="x" name="Spend" tickFormatter={(v) => inr(Number(v))} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                  <YAxis type="number" dataKey="y" name="Cost per retailer" tickFormatter={(v) => inr(Number(v))} tick={{ fontSize: 11, fill: 'var(--muted)' }} width={64} />
                  <ZAxis type="number" dataKey="z" range={[80, 900]} name="Leads" />
                  <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ payload }) => {
                    const p = payload?.[0]?.payload as (typeof bubbles)[number] | undefined;
                    return p ? <div className="ld-tip"><b>{p.name}</b><div>{p.platform}</div><div>Spend {inr(p.x)}</div><div>Cost per retailer {inr(p.y)}</div><div>{num(p.z)} leads</div></div> : null;
                  }} />
                  <Scatter data={bubbles} fill="var(--ld-src-meta)" fillOpacity={0.6} isAnimationActive={false} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        {/* 7 ---------------------------------------------------------------- geography */}
        <Card title="7. Geographic performance" uses={[...USES]}
          actions={rows.length ? <MiniSelect label="Campaign" value={geoRow?.key ?? ''} onChange={setGeoCamp} options={[...campRows, ...srcRows].map((r) => ({ value: r.key, label: r.name }))} /> : undefined}
          info={{ what: 'Top states and cities of the selected campaign by converted leads. “Already buying” = leads whose shop was a BO retailer billing in the 3 months before the lead: the overlap with existing business, not new demand.' }}
          csv={{ name: 'campaign_geography', rows: () => (geo ? [...geo.states.map((g) => ({ Level: 'State', ...g })), ...geo.cities.map((g) => ({ Level: 'City', ...g }))] : []) }}>
          {!geo ? <div className="ld-empty-s">No leads for these filters.</div> : (
            <div className="ld-geo2">
              {(['states', 'cities'] as const).map((lvl) => (
                <table key={lvl} className="ld-table">
                  <thead><tr><th>{lvl === 'states' ? 'State' : 'City'}</th><th className="num">Leads</th><th className="num">Converted</th><th className="num">Conversion</th><th className="num">Already buying</th></tr></thead>
                  <tbody>{geo[lvl].map((g) => (
                    <tr key={g.name}><td>{g.name}</td><td className="num">{num(g.leads)}</td><td className="num">{num(g.conv)}</td>
                      <td className="num"><Pct k={g.conv} n={g.judged} label="Converted ÷ judged leads" /></td>
                      <td className="num">{num(g.existing)} <span className="ld-muted">({pctTxt(g.existing, g.leads, 0)})</span></td></tr>
                  ))}</tbody>
                </table>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/** 8. What every number covers: shown at the end of the Campaign performance page. */
export function DataScope() {
  const { M, f } = useLeads();
  const srcs = [...new Set(M.p.dims.source)].join(', ');
  return (
    <Card wide title="8. Data scope and accuracy" uses={[]}
      info={{ what: 'What each number on this page covers, and where it comes from.' }}>
      <ul className="ld-rules">
        <li><b>Leads</b>: the automated lead Google Sheet ({srcs}), one per mobile number (repeat enquiries removed), dated in the selected period.</li>
        <li><b>Campaign rows vs source rows</b>: a lead is shown under a campaign only when it is linked to exactly one campaign. Leads that are not (Print, Other, or Meta/Google leads the date rule could not link) are listed per source, never added to a campaign.</li>
        <li><b>90-day revenue, all converted</b>: BO billing in the first 3 months of every retailer the leads converted: new retailers from their first-ever bill, retailers that came back from the lead&apos;s month. <b>From new retailers</b>: only the first part. Each retailer is credited once, to its earliest converting lead. Retailers without 3 full months of BO sales (to {M.p.months[M.p.salesEnd]}) are counted separately, not as zero.</li>
        <li><b>Spend</b>: what Meta and Google report for the campaigns in the months of the period (weekly: per day where saved). Print, Other and unlinked leads have no spend.</li>
        <li><b>Conversion</b> uses the matching level and the {f.window}-day window of the filter bar; leads too recent for the sales data are left out of the rate.</li>
        <li><b>Cost per lead here</b> divides by leads in the lead sheet; the Overview&apos;s CPL divides by the leads the platforms report. Both are correct; they answer different questions.</li>
      </ul>
    </Card>
  );
}

