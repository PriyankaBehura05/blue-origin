// Campaign insights from the platforms' own campaign figures (gt.ts):
//   CampaignInsights  Overview: top-performing campaigns and campaigns requiring attention, each with the reason, and a link to
//                     the full analysis on the Campaign performance page
//   PeriodComparison  Campaign performance: each platform's key figures this period against the previous period
// The rules are plain thresholds, stated in the info text of each card; nothing here is a score or a guess.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cpcOf, cplOf, cpmOf, ctrOf, freqOf, gtSummary, utilOf, type GtLine, type GtSummary, type Plat } from '../gt';
import type { BudgetPayload } from '../types';
import { Card, inr, num, useLeads } from '../ui';

const MIN_LEADS = 100;      // leads a campaign needs before its CPL can make it a top performer
const MIN_SPEND = 5000;
const CPL_FACTOR = 1.5;     // a CPL this many times the overall CPL needs attention
const UNDER = 50;           // % of budget spent below which a campaign is under-delivering
const OVER = 110;           // % above which it overspent
const FATIGUE = 3;          // Meta frequency above which ads are shown too often to the same people

const dot = (p: string) => <i className={`ld-dot ${p === 'Meta' ? 'meta' : 'google'}`} />;

/** The two lists, from the campaign figures: top performers by CPL, and campaigns that break a rule (each with its reasons). */
export function insightsOf(s: GtSummary) {
  const camps = s.lines.filter((l) => l.kind === 'campaign' && l.spend > 0);
  const all = s.total ?? s.platforms.Meta ?? s.platforms.Google ?? null;
  const overall = all ? cplOf(all) : null;
  const top = camps.filter((l) => l.leads >= MIN_LEADS && l.spend >= MIN_SPEND).sort((a, b) => (cplOf(a) ?? Infinity) - (cplOf(b) ?? Infinity)).slice(0, 3);
  const attention = camps.map((l) => {
    const why: string[] = [];
    if (l.leads === 0) why.push(`Spent ${inr(l.spend)} and brought no leads`);
    const c = cplOf(l);
    if (overall && c && l.leads >= MIN_LEADS && c > CPL_FACTOR * overall) why.push(`CPL ${inr(c)} is ${(c / overall).toFixed(1)}× the overall ${inr(overall)}`);
    const u = utilOf(l);
    if (u !== null && u < UNDER) why.push(`Spent only ${u.toFixed(0)}% of its budget`);
    if (u !== null && u > OVER) why.push(`Spent ${u.toFixed(0)}% of its budget`);
    const fr = freqOf(l);
    if (fr !== null && fr > FATIGUE) why.push(`Each person saw the ads ${fr.toFixed(1)} times: ad fatigue risk`);
    return { l, why };
  }).filter((x) => x.why.length).sort((a, b) => b.why.length - a.why.length || b.l.spend - a.l.spend);
  return { camps, overall, top, attention };
}

export default function CampaignInsights({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg } = useLeads();
  const go = useNavigate();
  const s = useMemo(() => gtSummary(budget, M, f, rg, false), [budget, M, f, rg]);
  const { camps, top, attention } = insightsOf(s);

  const link = <button type="button" className="ld-btn" onClick={() => go('/leads/performance')}>Full campaign analysis <ArrowRight size={14} aria-hidden /></button>;
  const row = (l: GtLine, extra: string[]) => (
    <li key={l.key} className="ld-ins-row">
      <div className="ld-ins-n">{dot(l.platform)}<b>{l.name}</b><span className="ld-muted"> · {l.platform}</span></div>
      <div className="ld-ins-m"><span>CPL <b>{cplOf(l) ? inr(cplOf(l)!) : 'N/A'}</b></span><span>Spend <b>{inr(l.spend)}</b></span><span>Leads <b>{num(Math.round(l.leads))}</b></span></div>
      {extra.length > 0 && <ul className="ld-ins-why">{extra.map((w) => <li key={w}>{w}</li>)}</ul>}
    </li>
  );

  return (
    <div className="ld-grid">
      <Card title="Top-performing campaigns" uses={['period', 'source', 'campaign']} actions={link}
        info={{ what: `The campaigns with the lowest cost per lead in the period, among those with at least ${MIN_LEADS} leads and ${inr(MIN_SPEND)} spend, so a campaign with a handful of leads never tops the list. Leads are the platforms' own counts.`, formula: 'CPL = spend ÷ leads',
          source: 'Meta and Google as saved on the Ad budget page' }}>
        {top.length ? <ol className="ld-ins">{top.map((l) => row(l, []))}</ol>
          : <div className="ld-empty-s">{camps.length ? `No campaign has ${MIN_LEADS}+ leads and ${inr(MIN_SPEND)} spend in this period yet.` : 'No campaign spend in this period.'}</div>}
      </Card>
      <Card title="Campaigns requiring attention" uses={['period', 'source', 'campaign']} actions={link}
        info={{ what: <>Campaigns that spent in the period and break one of these rules: no leads at all; CPL above {CPL_FACTOR}× the overall CPL (with {MIN_LEADS}+ leads); under {UNDER}% or over {OVER}% of the budget spent; Meta frequency above {FATIGUE} (the same people see the ads too often). Whether a campaign brings real retailers is judged on the Campaigns page scorecard from BO sales.</>,
          source: 'Meta and Google as saved on the Ad budget page' }}>
        {attention.length ? <ul className="ld-ins">{attention.slice(0, 6).map(({ l, why }) => row(l, why))}</ul>
          : <div className="ld-empty-s">{camps.length ? 'No campaign breaks these rules in this period.' : 'No campaign spend in this period.'}</div>}
        {attention.length > 6 && <div className="ld-note">{attention.length - 6} more are in the full analysis.</div>}
      </Card>
    </div>
  );
}

type Metric = { label: string; get: (l: GtLine) => number | null; fmt: (v: number) => string; better?: 'up' | 'down' };
const METRICS: Metric[] = [
  { label: 'Spend', get: (l) => l.spend, fmt: inr },
  { label: 'Leads', get: (l) => l.leads, fmt: (v) => num(Math.round(v)), better: 'up' },
  { label: 'CPL', get: (l) => cplOf(l), fmt: inr, better: 'down' },
  { label: 'Impressions', get: (l) => l.impressions, fmt: (v) => num(Math.round(v)) },
  { label: 'Clicks', get: (l) => l.clicks, fmt: (v) => num(Math.round(v)) },
  { label: 'CTR', get: (l) => ctrOf(l), fmt: (v) => `${v.toFixed(2)}%`, better: 'up' },
  { label: 'CPC', get: (l) => cpcOf(l), fmt: (v) => `₹${v.toFixed(2)}`, better: 'down' },
  { label: 'CPM', get: (l) => cpmOf(l), fmt: (v) => `₹${v.toFixed(2)}`, better: 'down' },
];

export function PeriodComparison({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg, prev } = useLeads();
  const cur = useMemo(() => gtSummary(budget, M, f, rg, false), [budget, M, f, rg]);
  const old = useMemo(() => (prev ? gtSummary(budget, M, f, prev, false) : null), [budget, M, f, prev]);
  const plats = (['Meta', 'Google'] as Plat[]).filter((p) => cur.platforms[p]);
  const delta = (m: Metric, a: number | null, b: number | null) => {
    if (a === null || b === null || !b) return <span className="ld-muted">—</span>;
    const d = (100 * (a - b)) / Math.abs(b);
    const tone = !m.better || Math.abs(d) < 0.05 ? 'flat' : (d > 0) === (m.better === 'up') ? 'good' : 'bad';
    return <span className={`ld-delta ${tone}`}>{d > 0 ? '▲' : d < 0 ? '▼' : '='} {Math.abs(d).toFixed(1)}%</span>;
  };
  return (
    <Card wide title="Period comparison" uses={['period', 'source', 'campaign']}
      info={{ what: 'Each platform this period against the previous period of the same length: spend, leads, cost per lead, impressions, clicks, CTR, CPC and CPM. Green = better, red = worse (lower is better for CPL, CPC and CPM); spend has no good or bad direction.', source: 'Meta and Google as saved on the Ad budget page' }}
      csv={{ name: 'period_comparison', rows: () => METRICS.map((m) => ({ Metric: m.label, ...Object.fromEntries(plats.flatMap((p) => [[`${p} this period`, m.get(cur.platforms[p]!) ?? ''], [`${p} previous period`, old?.platforms[p] ? m.get(old.platforms[p]!) ?? '' : '']])) })) }}>
      {!plats.length ? <div className="ld-empty-s">No campaign data saved yet for these filters.</div> : !prev ? <div className="ld-empty-s">There is no earlier period to compare with.</div> : (
        <div className="ld-table-wrap">
          <table className="ld-table">
            <thead>
              <tr><th rowSpan={2}>Metric</th>{plats.map((p) => <th key={p} colSpan={3} className="num">{p} Ads</th>)}</tr>
              <tr>{plats.map((p) => <><th key={`${p}a`} className="num">This period</th><th key={`${p}b`} className="num">Previous</th><th key={`${p}c`} className="num">Change</th></>)}</tr>
            </thead>
            <tbody>
              {METRICS.map((m) => (
                <tr key={m.label}>
                  <td>{m.label}</td>
                  {plats.map((p) => {
                    const a = m.get(cur.platforms[p]!);
                    const b = old?.platforms[p] ? m.get(old.platforms[p]!) : null;
                    return <><td key={`${p}a`} className="num">{a === null ? '—' : m.fmt(a)}</td><td key={`${p}b`} className="num">{b === null || b === undefined ? '—' : m.fmt(b)}</td><td key={`${p}c`} className="num">{delta(m, a, b ?? null)}</td></>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

