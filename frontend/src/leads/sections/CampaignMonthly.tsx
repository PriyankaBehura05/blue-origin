// Campaign performance over time (Campaign performance page): each campaign month by month - spend, leads, CPL or budget used -
// up to the end of the selected period. Same campaign figures as the Overview and the comparison table (gt.ts).
import { useMemo, useState } from 'react';
import { gtMonthly } from '../gt';
import { monthName } from '../model';
import type { BudgetPayload } from '../types';
import { Card, MiniSelect, Table, csvRows, inr, num, useLeads, type Col } from '../ui';

type Metric = 'spend' | 'leads' | 'cpl' | 'util';
const OPTIONS: { value: Metric; label: string }[] = [
  { value: 'spend', label: 'Spend' }, { value: 'leads', label: 'Leads' }, { value: 'cpl', label: 'CPL' }, { value: 'util', label: 'Budget used' },
];
interface Row { key: string; name: string; platform: string; months: Map<string, { spend: number; leads: number; budget: number }> }

export default function CampaignMonthly({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg } = useLeads();
  const [metric, setMetric] = useState<Metric>('spend');
  const gm = useMemo(() => gtMonthly(budget, M, f), [budget, M, f]);
  const rows: Row[] = [...gm.byCampaign.entries()].map(([key, c]) => ({ key, ...c }));
  // the months with campaign activity, up to the end of the period (at most the last 12, so the table stays readable)
  const end = M.p.months[Math.min(rg[1], M.nM - 1)];
  const months = [...new Set(rows.flatMap((r) => [...r.months.keys()]))].filter((m) => m <= end).sort().slice(-12);
  const value = (r: Row, m: string): number | null => {
    const e = r.months.get(m);
    if (!e) return null;
    if (metric === 'spend') return e.spend;
    if (metric === 'leads') return e.leads;
    if (metric === 'cpl') return e.leads ? e.spend / e.leads : null;
    return e.budget ? (100 * e.spend) / e.budget : null;
  };
  const fmt = (v: number | null, has: boolean) => {
    if (v === null) return has && metric === 'cpl' ? 'N/A' : '—';
    return metric === 'spend' ? inr(v) : metric === 'leads' ? num(Math.round(v)) : metric === 'cpl' ? `₹${v.toFixed(0)}` : `${v.toFixed(0)}%`;
  };
  const label = (m: string) => monthName(M, M.p.months.indexOf(m) >= 0 ? M.p.months.indexOf(m) : 0);
  const cols: Col<Row>[] = [
    { key: 'name', label: 'Campaign', render: (r) => <><i className={`ld-dot ${r.platform === 'Meta' ? 'meta' : 'google'}`} />{r.name}<span className="ld-muted"> · {r.platform}</span></>, sort: (r) => r.name, csv: (r) => `${r.name} (${r.platform})` },
    ...months.map((m) => ({ key: m, label: M.p.months.includes(m) ? label(m) : m, num: true, render: (r: Row) => fmt(value(r, m), r.months.has(m)), sort: (r: Row) => value(r, m) ?? -1, csv: (r: Row) => value(r, m) ?? '' })),
  ];
  return (
    <Card wide title="Campaign performance over time" uses={['source', 'campaign']}
      actions={<MiniSelect label="Show" value={metric} onChange={setMetric} options={OPTIONS} />}
      info={{ what: 'Every campaign month by month, up to the end of the selected period (the last 12 months with activity). CPL = that month’s spend ÷ its leads (N/A with no leads); budget used = spend ÷ (daily budget × days in the month).', source: 'Saved ad data (Ad budget page)' }}
      csv={{ name: `campaigns_by_month_${metric}`, rows: () => csvRows(rows, cols) }}>
      {!rows.length ? <div className="ld-empty-s">No campaign data saved yet.</div> : <Table rows={rows} cols={cols} />}
    </Card>
  );
}
