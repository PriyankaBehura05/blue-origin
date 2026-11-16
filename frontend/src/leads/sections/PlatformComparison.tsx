// Platform comparison (Campaign attribution page): Meta vs Google, with Print, JustDial and Other leads and Organic retailers
// kept as their own sources. One tile per source, the metric x source table, and totals. Every number follows the period and
// the filters, with the same functions as the Overview (adSpendIn / periodBudget for money, leadAgg / retailerCounts for leads
// and retailers), so the two pages always agree. Sources with no ad platform have no spend or budget ("no ad spend tracked").
import { useMemo } from 'react';
import { HelpTip } from '@/components/HelpTip';
import { adSpendIn, periodBudget } from '../adSpend';
import { retailerStats } from '../calc';
import { leadAgg, NEW, ORGANIC, REACTIVATED, retailerCounts } from '../model';
import { SOURCE_COLORS, SOURCE_NAMES } from '../sections';
import type { BudgetPayload } from '../types';
import { Card, inr, num, useLeads } from '../ui';

interface Col {
  src: number;
  name: string;
  paid: boolean;
  spend: number | null;
  budget: number | null;
  leads: number | null;
  cpl: number | null;
  fresh: number;
  cpn: number | null;
  conv: number | null;
  converted: number;
  judged: number;
  note: string | null; // why the money figures are blank
}

type Key = 'budget' | 'spend' | 'leads' | 'cpl' | 'fresh' | 'cpn' | 'conv';
const ROWS: { key: Key; label: string; fmt: (c: Col) => string; better?: 'up' | 'down'; info: string }[] = [
  { key: 'budget', label: 'Budget', fmt: (c) => (c.budget === null ? '—' : inr(c.budget)), info: "Budget of the platform's campaigns that ran in the period: daily budget × the days they actually spent in the period, or the lifetime budget (today's settings: no budget history is kept)." },
  { key: 'spend', label: 'Actual spend', fmt: (c) => (c.spend === null ? '—' : inr(c.spend)), info: 'What the platform reports as spent in the months of the period.' },
  { key: 'leads', label: 'Leads', fmt: (c) => (c.leads === null ? '—' : num(c.leads)), better: 'up', info: 'Unique leads: the first enquiry per mobile number.' },
  { key: 'cpl', label: 'CPL', fmt: (c) => (c.cpl === null ? '—' : inr(c.cpl)), better: 'down', info: 'Actual spend ÷ leads.' },
  { key: 'fresh', label: 'New retailers', fmt: (c) => num(c.fresh), better: 'up', info: 'Distinct shops whose first-ever BO bill came after a lead of this source. Organic = new BO retailers no lead brought in.' },
  { key: 'cpn', label: 'Cost per new retailer', fmt: (c) => (c.cpn === null ? '—' : inr(c.cpn)), better: 'down', info: 'Actual spend ÷ new retailers.' },
  { key: 'conv', label: 'Conversion rate', fmt: (c) => (c.conv === null ? '—' : `${c.conv.toFixed(1)}%`), better: 'up', info: 'Converted leads (new + came back) ÷ leads that can be judged against BO sales × 100.' },
];
const CHIP: Record<Key, string> = { budget: 'blue', spend: 'violet', leads: 'teal', cpl: 'amber', fresh: 'green', cpn: 'rose', conv: 'indigo' };

export default function PlatformComparison({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg, prev } = useLeads();
  const cols = useMemo<Col[]>(() => {
    const out: Col[] = [];
    M.p.dims.source.forEach((name, src) => {
      if (f.source >= 0 && f.source !== src) return;
      const f2 = { ...f, source: src };
      const a = leadAgg(M, f2, rg);
      const paid = name === 'Meta' || name === 'Google';
      if (!paid && !a.rows) return;          // a source with no leads in the period is left out (Meta and Google always shown)
      const ad = paid ? adSpendIn(budget, M, f2, rg) : null;
      const bud = paid ? periodBudget(budget, M, f2, rg) : null;
      const note = !paid ? 'no ad spend tracked' : ad!.reason ?? (ad!.unsplit.length ? `ad spend cannot be split by ${ad!.unsplit.join(', ')}` : null);
      const spend = note ? null : ad!.total;
      const fresh = retailerCounts(M, f2, rg).fresh;
      const converted = a.out[NEW] + a.out[REACTIVATED];
      out.push({
        src, name, paid, note, spend, budget: note || bud!.reason ? null : bud!.total, leads: a.unique,
        cpl: spend && a.unique ? spend / a.unique : null, fresh, cpn: spend && fresh ? spend / fresh : null,
        conv: a.judged ? (100 * converted) / a.judged : null, converted, judged: a.judged,
      });
    });
    // Organic: new BO retailers that no lead brought in (no leads, no spend); only when no source or campaign is picked
    if (f.source < 0 && f.campaign < 0) {
      const s = retailerStats(M, f, rg, prev);
      out.push({ src: ORGANIC, name: SOURCE_NAMES[ORGANIC], paid: false, note: 'no ad spend tracked', spend: null, budget: null, leads: null, cpl: null,
        fresh: s.newAll - s.newMkt, cpn: null, conv: null, converted: 0, judged: 0 });
    }
    return out;
  }, [budget, M, f, rg, prev]);

  // the better of the sources that have the figure, bold in the table
  const best = (r: (typeof ROWS)[number]) => {
    if (!r.better) return -1;
    const vals = cols.map((c) => (c.src === ORGANIC && r.key !== 'fresh' ? null : (c[r.key] as number | null)));
    const ok = vals.filter((v): v is number => v !== null);
    if (ok.length < 2) return -1;
    const top = r.better === 'up' ? Math.max(...ok) : Math.min(...ok);
    return ok.filter((v) => v === top).length === 1 ? vals.indexOf(top) : -1;
  };
  const sum = (k: 'spend' | 'budget' | 'leads') => cols.reduce((s, c) => s + (c[k] ?? 0), 0);
  const anyMoney = cols.some((c) => c.spend !== null);
  const totalNew = cols.reduce((s, c) => s + c.fresh, 0);
  const sales = rg[0] > M.p.salesEnd;

  return (
    <Card wide title="Platform comparison" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
      info={{ what: 'Meta and Google side by side, with Print, JustDial, Other and Organic kept as separate sources. Leads, new retailers and conversion follow every filter; spend and budget follow the period, Source and Campaign filters only (the platforms do not report them by state, city or distributor). The best value of each row is in bold.',
        formula: 'CPL = actual spend ÷ leads · cost per new retailer = actual spend ÷ new retailers · conversion = (new + came back) ÷ leads with sales data × 100' }}
      csv={{ name: 'platform_comparison', rows: () => ROWS.map((r) => ({ Metric: r.label, ...Object.fromEntries(cols.map((c) => [c.name, r.fmt(c)])) })) }}
      soWhat={sales ? 'BO sales data does not reach this period yet: new retailers and conversion fill in as it arrives.' : undefined}>
      <div className="ld-pf-grid">
        {cols.map((c) => (
          <div key={c.src} className="ld-pf">
            <div className="ld-pf-h">
              <span className="ld-pf-logo" style={{ background: SOURCE_COLORS[c.src] }}>{c.name[0]}</span>
              <div className="ld-pf-t">
                <b>{c.name}{c.paid ? ' Ads' : ''}</b>
                <span>{c.src === ORGANIC ? 'Retailers no lead brought in' : `${num(c.converted)} converted · ${c.conv === null ? '—' : `${c.conv.toFixed(1)}%`}`}</span>
              </div>
              <div className="ld-pf-big">
                <b>{c.spend !== null ? inr(c.spend) : c.src === ORGANIC ? num(c.fresh) : num(c.leads ?? 0)}</b>
                <span>{c.spend !== null ? 'Spend' : c.src === ORGANIC ? 'New retailers' : 'Leads'}</span>
              </div>
            </div>
            <div className="ld-pf-chips">
              {ROWS.filter((r) => r.key !== 'spend' && !(c.src === ORGANIC && r.key !== 'fresh') && !(!c.paid && (r.key === 'budget' || r.key === 'cpl' || r.key === 'cpn'))).map((r) => (
                <div key={r.key} className={`ld-pf-chip ${CHIP[r.key]}`}><span>{r.label}</span><b>{r.fmt(c)}</b></div>
              ))}
            </div>
            {c.note && c.paid && <div className="ld-pf-note">{c.note}</div>}
          </div>
        ))}
      </div>

      <div className="ld-table-wrap">
        <table className="ld-table">
          <thead><tr><th>Metric</th>{cols.map((c) => <th key={c.src} className="num">{c.name}</th>)}</tr></thead>
          <tbody>
            {ROWS.map((r) => {
              const b = best(r);
              return (
                <tr key={r.key}>
                  <td>{r.label} <HelpTip text={r.info} /></td>
                  {cols.map((c, j) => {
                    const v = c.src === ORGANIC && r.key !== 'fresh' ? '—' : r.fmt(c);
                    return <td key={c.src} className="num" title={c.note && ['budget', 'spend', 'cpl', 'cpn'].includes(r.key) ? c.note : undefined}>{b === j ? <b>{v}</b> : v}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="ld-pf-totals">
        <div className="blue"><span>Total budget</span><b>{anyMoney ? inr(sum('budget')) : '—'}</b></div>
        <div className="violet"><span>Total actual spend</span><b>{anyMoney ? inr(sum('spend')) : '—'}</b></div>
        <div className="teal"><span>Total leads</span><b>{num(sum('leads'))}</b></div>
        <div className="green"><span>Total new retailers{cols.some((c) => c.src === ORGANIC) ? ' (incl. organic)' : ''}</span><b>{num(totalNew)}</b></div>
      </div>
    </Card>
  );
}
