// Campaign performance details, under the eight cost and volume cards: month by month spend, cost per lead and revenue vs
// spend, where the period's spend went (by objective and by campaign), a monthly metrics table, and what each number means.
// Spend comes from the saved ad data (useAdBudget), leads from the lead sheet and revenue from BO billing, with the same rules
// as the cards: the spend's platform(s) only, and no cost per lead when a filter that spend cannot follow is on.
import { useMemo } from 'react';
import { Card, Table, csvRows, inr, num, useLeads, type Col } from '../ui';
import { Donut, HBars, Lines, StackedBars } from '../charts';
import { adSpendIn, platformsText, spendBreakdown } from '../adSpend';
import { leadAgg, monthName } from '../model';
import { reactivatedRevenue, retailerStats } from '../calc';
import type { BudgetPayload } from '../types';

const C = { lead: 'var(--ld-src-jd)', other: 'var(--ld-seq-3)', spend: 'var(--ld-seq-5)', revenue: 'var(--ld-src-print)', cpl: 'var(--ld-src-google)', cpu: 'var(--ld-seq-4)', cplLead: 'var(--ld-src-jd)' };
const OBJ_COLORS = ['var(--ld-src-jd)', 'var(--ld-seq-4)', 'var(--ld-src-print)', 'var(--ld-src-google)', 'var(--ld-src-other)', 'var(--ld-seq-2)', 'var(--ld-src-organic)'];
const LEAD_USES = ['source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window'] as const;
// a month with only a handful of leads gives a cost per lead of lakhs that says nothing: such months stay off the chart
const MIN_LEADS = 50;

interface Row {
  m: number;
  month: string;
  spend: number | null;
  leadSpend: number | null;
  rows: number;
  unique: number;
  cpl: number | null;
  cplLead: number | null;
  cpu: number | null;
  newRev: number | null; // null = sales data not in yet
  reRev: number | null;
  revenue: number | null; // new + reactivated
  roas: number | null;
  roasLead: number | null;
}

const money = (v: number | null) => (v === null ? '—' : inr(v));

const DEFS: [string, string][] = [
  ['Total ad budget', "The budget set on campaigns that are active today: daily budgets per day, and lifetime (total) budgets with what is still unspent. Meta and Google only keep today's settings, so it does not change with the period."],
  ['Total ad spend', 'What the ad platform reports as spent in the months of the period, on every campaign of the connected account(s), whatever its objective. The Source filter picks the platform.'],
  ['Total lead submissions', "Every enquiry in the lead sheet, including the same person enquiring again (after the dashboard's existing clean-up of rows the sheet copied twice)."],
  ['Unique leads', 'Different people: the first enquiry from each mobile number.'],
  ['CPL · all campaigns', 'All ad spend ÷ lead submissions of the same platform(s) and months. Lower is better.'],
  ['CPL · lead campaigns', "Spend of lead campaigns only (objective Leads in the ad platform) ÷ lead submissions: what a lead costs on the campaigns meant to bring leads. Google Ads campaigns have no objective, so none count as lead campaigns yet."],
  ['ROAS · all campaigns', 'Total lead-attributed revenue ÷ all ad spend: sales for each ₹1 spent on every campaign. Revenue includes retailers won earlier, so read it as a trend.'],
  ['ROAS · lead campaigns', 'Total lead-attributed revenue ÷ the spend of lead campaigns only.'],
  ['Cost per unique lead', 'All ad spend ÷ unique leads of the same platform(s) and months (the card also shows the lead-campaign figure). Lower is better.'],
  ['New retailer revenue', 'BO billing in the period from retailers whose first-ever bill came after a lead (within the 60-day Window), including retailers won earlier.'],
  ['Reactivated retailer revenue', 'BO billing from retailers that had gone quiet for 3 months and bought again after a lead, counted from the month of that lead. A retailer counted as new is never counted here too.'],
  ['Total lead-attributed revenue', 'New retailer revenue + reactivated retailer revenue. Both ROAS figures use it.'],
];

export default function CampaignDetail({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg } = useLeads();
  const scope = useMemo(() => adSpendIn(budget, M, f, rg), [budget, M, f, rg]);
  const costOk = !scope.reason && scope.unsplit.length === 0;

  // every month with leads up to the end of the selected period, so the trend is visible whatever period is picked
  const rows = useMemo<Row[]>(() => {
    if (!budget || scope.reason) return [];
    const pick = (i: number) => scope.srcIdx.includes(M.p.leads.src[i]);
    const out: Row[] = [];
    for (let m = M.leadStart; m <= rg[1]; m++) {
      const ad = adSpendIn(budget, M, f, [m, m]);
      const la = leadAgg(M, f, [m, m], pick);
      const spend = ad.reason ? null : ad.total;
      const sales = m <= M.p.salesEnd;
      const newRev = sales ? scope.srcIdx.reduce((s, src) => s + retailerStats(M, { ...f, source: src }, [m, m], null).revenueMkt, 0) : null;
      const reRev = sales ? scope.srcIdx.reduce((s, src) => s + reactivatedRevenue(M, { ...f, source: src }, [m, m]), 0) : null;
      const revenue = newRev !== null && reRev !== null ? newRev + reRev : null;
      const leadSpend = ad.reason ? null : ad.leadObjective;
      out.push({
        m, month: monthName(M, m), spend, leadSpend, rows: la.rows, unique: la.unique,
        cpl: costOk && spend !== null && la.rows ? spend / la.rows : null,
        cplLead: costOk && leadSpend && la.rows ? leadSpend / la.rows : null,
        cpu: costOk && spend !== null && la.unique ? spend / la.unique : null,
        newRev, reRev, revenue,
        roas: costOk && revenue !== null && spend ? revenue / spend : null,
        roasLead: costOk && revenue !== null && leadSpend ? revenue / leadSpend : null,
      });
    }
    return out;
  }, [budget, scope, costOk, M, f, rg]);
  const br = useMemo(() => spendBreakdown(budget, M, f, rg), [budget, M, f, rg]);

  if (!budget) return <div className="ld-needs">Loading the saved ad spend…</div>;
  if (scope.reason) return <div className="ld-needs">Campaign cost details: {scope.reason}.</div>;

  const plat = platformsText(scope);
  const totSpend = rows.reduce((s, r) => s + (r.spend ?? 0), 0);
  const totLead = rows.reduce((s, r) => s + (r.leadSpend ?? 0), 0);
  const withSales = rows.filter((r) => r.revenue !== null);
  const salesSpend = withSales.reduce((s, r) => s + (r.spend ?? 0), 0);
  const salesRev = withSales.reduce((s, r) => s + (r.revenue ?? 0), 0);
  const salesLeadSpend = withSales.reduce((s, r) => s + (r.leadSpend ?? 0), 0);
  const bestCpl = rows.filter((r) => r.cpl !== null && r.rows >= MIN_LEADS).sort((a, b) => (a.cpl ?? 0) - (b.cpl ?? 0))[0];
  const periodSpend = br ? br.campaigns.reduce((s, c) => s + c.spend, 0) : 0;
  const leadObj = br?.byObjective.find((o) => o.label === 'Leads')?.value ?? 0;
  const span = rows.length ? `${rows[0].month} – ${rows[rows.length - 1].month}` : '';
  const few = rows.some((r) => r.cpl !== null && r.rows < MIN_LEADS);
  const revCell = (v: number | null) => (v === null ? <span className="ld-muted">pending</span> : inr(v));
  const costCell = (v: number | null, r: Row) => (v === null ? '—' : r.rows < MIN_LEADS ? <span className="ld-muted" title={`Only ${r.rows} submissions this month`}>{inr(v)}*</span> : inr(v));

  const cols: Col<Row>[] = [
    { key: 'month', label: 'Month', render: (r) => r.month, sort: (r) => r.m, csv: (r) => r.month },
    { key: 'spend', label: 'Ad spend', num: true, render: (r) => money(r.spend), sort: (r) => r.spend ?? -1, csv: (r) => r.spend },
    { key: 'lead', label: 'On lead campaigns', num: true, render: (r) => money(r.leadSpend), sort: (r) => r.leadSpend ?? -1, csv: (r) => r.leadSpend },
    { key: 'rows', label: 'Submissions', num: true, render: (r) => num(r.rows), sort: (r) => r.rows, csv: (r) => r.rows },
    { key: 'unique', label: 'Unique leads', num: true, render: (r) => num(r.unique), sort: (r) => r.unique, csv: (r) => r.unique },
    { key: 'cpl', label: 'CPL · all', num: true, render: (r) => costCell(r.cpl, r), sort: (r) => r.cpl ?? Infinity, csv: (r) => (r.cpl === null ? '' : Math.round(r.cpl)) },
    { key: 'cplLead', label: 'CPL · lead campaigns', num: true, render: (r) => costCell(r.cplLead, r), sort: (r) => r.cplLead ?? Infinity, csv: (r) => (r.cplLead === null ? '' : Math.round(r.cplLead)) },
    { key: 'cpu', label: 'Cost / unique lead', num: true, render: (r) => costCell(r.cpu, r), sort: (r) => r.cpu ?? Infinity, csv: (r) => (r.cpu === null ? '' : Math.round(r.cpu)) },
    { key: 'new', label: 'New retailer revenue', num: true, render: (r) => revCell(r.newRev), sort: (r) => r.newRev ?? -1, csv: (r) => r.newRev },
    { key: 're', label: 'Reactivated revenue', num: true, render: (r) => revCell(r.reRev), sort: (r) => r.reRev ?? -1, csv: (r) => r.reRev },
    { key: 'rev', label: 'Total lead-attributed', num: true, render: (r) => revCell(r.revenue), sort: (r) => r.revenue ?? -1, csv: (r) => r.revenue },
    { key: 'roas', label: 'ROAS · all', num: true, render: (r) => (r.roas === null ? '—' : `${r.roas.toFixed(2)}×`), sort: (r) => r.roas ?? -1, csv: (r) => (r.roas === null ? '' : r.roas.toFixed(2)) },
    { key: 'roasLead', label: 'ROAS · lead campaigns', num: true, render: (r) => (r.roasLead === null ? '—' : `${r.roasLead.toFixed(2)}×`), sort: (r) => r.roasLead ?? -1, csv: (r) => (r.roasLead === null ? '' : r.roasLead.toFixed(2)) },
  ];

  return (
    <div className="ld-grid">
      <Card title="Ad spend by month" wide uses={['source']}
        info={{ what: `What ${plat} spent each month, split into campaigns whose objective is Leads and all other campaigns (traffic, sales, awareness…). Every month with leads up to the end of the selected period.`, source: 'Ad budget data saved from the ad platform' }}
        csv={{ name: 'ad_spend_by_month', rows: () => rows.map((r) => ({ Month: r.month, 'Ad spend': r.spend, 'On lead campaigns': r.leadSpend })) }}
        soWhat={totSpend ? <>{span}: {inr(totLead)} of {inr(totSpend)} ({((100 * totLead) / totSpend).toFixed(0)}%) went to lead campaigns; the rest went to traffic, sales and awareness campaigns.</> : undefined}>
        <StackedBars data={rows.map((r) => ({ month: r.month, lead: r.leadSpend ?? 0, other: Math.max(0, (r.spend ?? 0) - (r.leadSpend ?? 0)) }))} x="month" fmt={inr}
          series={[{ key: 'lead', label: 'Lead campaigns', color: C.lead }, { key: 'other', label: 'Other campaigns', color: C.other }]} />
      </Card>

      <Card title="Cost per lead by month" uses={[...LEAD_USES]}
        info={{ what: `${plat} spend each month ÷ that month's lead submissions (CPL) and unique leads, for the same platform. Lower is better. Months with fewer than ${MIN_LEADS} submissions are left off the chart: their cost per lead is not comparable.`, formula: 'CPL = spend ÷ submissions; cost per unique lead = spend ÷ unique leads' }}
        soWhat={!costOk ? <>Not shown: ad spend cannot be split by {scope.unsplit.join(', ')}.</> : bestCpl ? <>Cheapest month: {bestCpl.month} at {inr(bestCpl.cpl!)} per lead.</> : undefined}>
        {costOk
          ? <Lines data={rows.map((r) => ({ month: r.month, cpl: r.rows >= MIN_LEADS ? r.cpl : null, cplLead: r.rows >= MIN_LEADS ? r.cplLead : null, cpu: r.rows >= MIN_LEADS ? r.cpu : null }))} x="month" fmt={inr}
              series={[{ key: 'cpl', label: 'CPL · all campaigns', color: C.cpl }, { key: 'cplLead', label: 'CPL · lead campaigns', color: C.cplLead }, { key: 'cpu', label: 'Cost per unique lead', color: C.cpu }]} />
          : <div className="ld-needs">Ad spend cannot be split by {scope.unsplit.join(', ')}, so there is no cost per lead for these filters.</div>}
      </Card>

      <Card title="Lead-generated revenue vs ad spend" uses={['source', 'state', 'city', 'dist', 'tier', 'level', 'window']}
        info={{ what: 'Each month: BO billing from retailers the leads brought in (new and reactivated) next to all ad spend and the spend of lead campaigns. Months after the last month of sales data are left out.', formula: 'ROAS = lead-attributed revenue ÷ spend (all campaigns, or lead campaigns only)' }}
        soWhat={costOk && salesSpend ? <>Over these months: {inr(salesRev)} lead-attributed revenue; ROAS {(salesRev / salesSpend).toFixed(2)}× on all spend ({inr(salesSpend)}){salesLeadSpend ? <>, {(salesRev / salesLeadSpend).toFixed(2)}× on lead-campaign spend ({inr(salesLeadSpend)})</> : null}. Sales data runs to {monthName(M, M.p.salesEnd)}.</> : undefined}>
        <StackedBars stacked={false} data={withSales.map((r) => ({ month: r.month, spend: r.spend ?? 0, lead: r.leadSpend ?? 0, revenue: r.revenue ?? 0 }))} x="month" fmt={inr}
          series={[{ key: 'spend', label: 'All ad spend', color: C.spend }, { key: 'lead', label: 'Lead-campaign spend', color: C.lead }, { key: 'revenue', label: 'Lead-attributed revenue', color: C.revenue }]} />
      </Card>

      <Card title="Where the spend went" uses={['period', 'source']}
        info={{ what: 'Spend in the selected period by the objective set on each campaign in the ad platform.', source: 'Ad budget data saved from the ad platform' }}
        soWhat={periodSpend ? <>{((100 * leadObj) / periodSpend).toFixed(0)}% of this period's spend was on Leads campaigns.</> : undefined}>
        {br && br.byObjective.length
          ? <Donut data={br.byObjective.map((o, j) => ({ label: o.label, value: o.value, color: OBJ_COLORS[j % OBJ_COLORS.length] }))} fmt={inr} center={<><b>{inr(periodSpend)}</b><span>spend</span></>} />
          : <div className="ld-empty-s">No spend in this period.</div>}
      </Card>

      <Card title="Top campaigns by spend" wide uses={['period', 'source']}
        info={{ what: 'The 10 campaigns that spent the most in the selected period, with their objective and status today.' }}
        csv={{ name: 'campaign_spend', rows: () => (br?.campaigns ?? []).map((c) => ({ 'Campaign ID': c.id, Campaign: c.name, Objective: c.objective, Status: c.status, Spend: c.spend })) }}>
        <HBars fmt={inr} rows={(br?.campaigns ?? []).slice(0, 10).map((c) => ({ key: c.id, label: c.name, value: c.spend, color: c.objective === 'Leads' ? C.lead : C.other, note: `${c.objective} · ${c.status}` }))} />
      </Card>

      <Card title="Monthly campaign metrics" wide uses={[...LEAD_USES]}
        info={{ what: 'The numbers behind the charts, one row per month: spend, leads, what a lead cost, the revenue the leads brought in and ROAS.', source: 'Ad platform (spend), lead sheet (leads), BO billing (revenue)' }}
        csv={{ name: 'campaign_metrics_by_month', rows: () => csvRows(rows, cols) }}
        soWhat={few ? <>* fewer than {MIN_LEADS} submissions that month, so its cost per lead is not comparable.</> : undefined}>
        <div className="ld-table-wrap"><Table rows={rows} cols={cols} limit={24} initialSort={{ key: 'month', dir: 'desc' }} /></div>
      </Card>

      <Card title="What each number means" wide uses={[]} info={{ what: 'How the cards at the top of this page are worked out.' }}>
        <dl className="ld-defs">
          {DEFS.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}
        </dl>
      </Card>
    </div>
  );
}
