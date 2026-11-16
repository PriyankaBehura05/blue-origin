// Lead-to-retailer counts and the conversion funnel that joins them. Every number follows the page filters (period,
// platform/source, campaign, state, city, distributor, match level, window) because it is computed from the same filtered leads as
// the rest of the dashboard (leadAgg / retailerCounts in model.ts), and each has the previous selected period for comparison.
// Nothing is stored or changed. useLeadCounts() computes once; LeadKpis and LeadFunnel are placed by the pages that need them.
import { useMemo } from 'react';
import { BadgeCheck, Inbox, RotateCcw, Sparkles, Store } from 'lucide-react';
import { leadAgg, retailerCounts, type LeadAgg, type RetailerCounts } from '../model';
import { Card, Delta, Kpi, Pct, num, useLeads } from '../ui';

const USES = ['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window'] as const;

export interface LeadCountsData { a: LeadAgg; r: RetailerCounts; ap: LeadAgg | null; rp: RetailerCounts | null }

export function useLeadCounts(): LeadCountsData | null {
  const { M, f, rg, prev } = useLeads();
  return useMemo(() => (M.p.hasLeads
    ? { a: leadAgg(M, f, rg), r: retailerCounts(M, f, rg), ap: prev ? leadAgg(M, f, prev) : null, rp: prev ? retailerCounts(M, f, prev) : null }
    : null), [M, f, rg, prev]);
}

const share = (k: number, n: number) => `${n ? ((100 * k) / n).toFixed(0) : 0}% of converted`;

export type LeadKpiId = 'submissions' | 'prospects' | 'converted' | 'new' | 'reactivated';

/** The count tiles, in the order asked for. Previous-period comparison where the previous period has data. */
export function LeadKpis({ lc, show }: { lc: LeadCountsData | null; show: LeadKpiId[] }) {
  if (!lc) return null;
  const { a, r, ap, rp } = lc;
  const tiles: Record<LeadKpiId, JSX.Element> = {
    submissions: (
      <Kpi key="submissions" icon={Inbox} label="Total lead submissions" value={num(a.rows)} rag="none" delta={<Delta cur={a.rows} prev={ap?.rows ?? null} />}
        sub={a.rows > a.unique ? `${num(a.rows - a.unique)} repeat enquiries included` : 'every enquiry'}
        info="Every enquiry received, including the same person enquiring again. After the dashboard's existing clean-up, which removes rows the sheet copied twice (same lead ID)." />
    ),
    prospects: (
      <Kpi key="prospects" icon={Store} label="Unique prospective retailers" value={num(r.prospects)} rag="none" delta={<Delta cur={r.prospects} prev={rp?.prospects ?? null} />}
        sub={r.merged > 0 ? `${num(r.merged)} merged: same BO retailer, different number` : 'no leads share a BO retailer'}
        info="Distinct shops that could become retailers. Unique leads whose mobile number exactly matches the same retailer in BO (main or alternate number) count once. Name-based guesses are never merged." />
    ),
    converted: (
      <Kpi key="converted" icon={BadgeCheck} label="Converted retailers" value={num(r.converted)} rag="none" delta={<Delta cur={r.converted} prev={rp?.converted ?? null} />}
        sub={r.pending > 0 ? `${num(r.pending)} leads pending sales data` : 'counted once per BO retailer'}
        info="Distinct BO retailers that a lead brought in: a completely new retailer or a reactivated one. Each retailer is counted once, even if several leads point to it. Leads still waiting for sales data are not counted as failures, so recent periods fill in as sales arrive." />
    ),
    new: (
      <Kpi key="new" icon={Sparkles} label="Completely new retailers" value={num(r.fresh)} rag="none" delta={<Delta cur={r.fresh} prev={rp?.fresh ?? null} />} sub={share(r.fresh, r.converted)}
        info="Retailers whose first-ever bill came after the lead, within the chosen number of days (the Window filter)." />
    ),
    reactivated: (
      <Kpi key="reactivated" icon={RotateCcw} label="Reactivated retailers" value={num(r.reactivated)} rag="none" delta={<Delta cur={r.reactivated} prev={rp?.reactivated ?? null} />} sub={share(r.reactivated, r.converted)}
        info="Retailers that had billed before, went quiet for 3 months, and bought again after the lead. A retailer that counts as new is not counted here too." />
    ),
  };
  return <>{show.map((id) => tiles[id])}</>;
}

export function LeadFunnel({ lc }: { lc: LeadCountsData | null }) {
  if (!lc) return null;
  const { a, r } = lc;
  const stages = [
    { s: 'Total lead submissions', v: a.rows, tone: 1 },
    { s: 'Unique leads', v: a.unique, tone: 2 },
    { s: 'Unique prospective retailers', v: r.prospects, tone: 3 },
    { s: 'Converted retailers', v: r.converted, tone: 4 },
  ];
  const split = [{ s: 'Completely new', v: r.fresh, cls: 'new' }, { s: 'Reactivated', v: r.reactivated, cls: 'react' }];
  const max = Math.max(1, a.rows);
  const w = (v: number) => `${Math.max(v > 0 ? 1.2 : 0, (100 * v) / max)}%`; // true scale; a thin sliver stays visible
  const pendingNote = r.pending > 0
    ? `${num(r.pending)} leads are still Pending sales data and may convert later; the conversion counts will rise by themselves as sales data arrives.`
    : undefined;

  return (
    <Card title="Lead conversion funnel" wide uses={[...USES]}
      info={{
        what: 'From every enquiry to the retailers it produced. Each step is a count of different things: enquiries, then people, then shops, then BO retailers.',
        formula: 'each % = this step ÷ the step above. Converted = completely new + reactivated, each BO retailer once',
        source: 'Lead sheets, matched to the BO sales data. The Window and Match level filters change what counts as converted; the Campaign filter uses the campaign each lead was linked to (Campaign attribution page; unlinked leads show as Unmatched).',
      }}
      csv={{ name: 'lead_conversion_funnel', rows: () => [...stages, ...split.map((x) => ({ s: `of which ${x.s.toLowerCase()}`, v: x.v }))].map((x) => ({ Step: x.s, Count: x.v })) }}
      soWhat={a.rows ? <>{num(a.rows)} submissions came from {num(a.unique)} different people, who are {num(r.prospects)} prospective retailers; {num(r.converted)} of them became retailers ({num(r.fresh)} completely new, {num(r.reactivated)} reactivated). {pendingNote}</> : undefined}>
      {a.rows === 0 ? <div className="ld-needs">No leads match these filters.</div> : (
        <div className="ld-fun">
          {stages.map((s, j) => (
            <div className="ld-fun-row" key={s.s}>
              <div className="ld-fun-l">{s.s}</div>
              <div className="ld-fun-track"><div className={`ld-fun-bar t${s.tone}`} style={{ width: w(s.v) }} /></div>
              <div className="ld-fun-v"><b>{num(s.v)}</b>{j > 0 && <span className="ld-fun-p"><Pct k={s.v} n={stages[j - 1].v} label={`${s.s} ÷ ${stages[j - 1].s}`} /></span>}</div>
            </div>
          ))}
          <div className="ld-fun-split">
            {split.map((x) => (
              <div className={`ld-fun-chip ${x.cls}`} key={x.s}>
                <span>{x.s}</span><b>{num(x.v)}</b><em><Pct k={x.v} n={r.converted} label={`${x.s} ÷ converted retailers`} /></em>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
