import { useMemo, useState } from 'react';
import { CalendarDays, Layers, Megaphone, Sigma } from 'lucide-react';
import { Card, type Col, IconToggle, NeedsData, Pct, Section, Table, csvRows, num, useLeads, Bar as InBar } from '../ui';
import { Lines, StackedBars } from '../charts';
import { OUTCOME_COLORS, SECTIONS, SOURCE_COLORS } from '../sections';
import { boOrderCheck, EXISTING, leadAgg, leadOk, monthName, NEW, outcomeOf, REACTIVATED, wasCalled, type LeadAgg } from '../model';

type Group = 'total' | 'source' | 'campaign' | 'month';
const LEAD_USES = ['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window'] as const;

export default function Funnel() {
  const { M, f, rg } = useLeads();
  const [group, setGroup] = useState<Group>('source');
  const L = M.p.leads;

  const rows = useMemo(() => {
    if (!M.p.hasLeads) return [];
    const keyOf = (i: number) => (group === 'source' ? L.src[i] : group === 'campaign' ? L.camp[i] : group === 'month' ? L.m[i] : 0);
    const nameOf = (k: number) => (group === 'source' ? M.p.dims.source[k] : group === 'campaign' ? M.p.dims.campaign[k] ?? '(none)' : group === 'month' ? monthName(M, k) : 'All leads');
    const keys = new Set<number>();
    for (let i = 0; i < M.nL; i++) if (leadOk(M, f, i, rg)) keys.add(keyOf(i));
    return [...keys].map((k) => ({ k, name: nameOf(k), a: leadAgg(M, f, rg, (i) => keyOf(i) === k) }));
  }, [M, f, rg, group, L]);

  const total = useMemo(() => (M.p.hasLeads ? leadAgg(M, f, rg) : null), [M, f, rg]);

  const stages = (a: LeadAgg) => [
    { s: 'Enquiries', v: a.rows }, { s: 'Different people (one per mobile)', v: a.unique }, { s: 'With a working mobile number', v: a.valid },
    { s: 'Found in BO sales data', v: a.matched }, { s: 'Became a new retailer', v: a.out[NEW] }, { s: 'Ordered again (2+ months)', v: a.repeatRetailers },
  ];

  const cols: Col<(typeof rows)[number]>[] = [
    { key: 'name', label: group === 'total' ? '' : group[0].toUpperCase() + group.slice(1), render: (r) => r.name, sort: (r) => (group === 'month' ? r.k : r.name) },
    { key: 'rows', label: 'Leads', num: true, render: (r) => num(r.a.rows), sort: (r) => r.a.rows },
    { key: 'uniq', label: 'Unique', num: true, render: (r) => num(r.a.unique), sort: (r) => r.a.unique },
    { key: 'valid', label: 'Working number', num: true, render: (r) => <Pct k={r.a.valid} n={r.a.unique} label="Valid mobile ÷ unique" />, sort: (r) => r.a.valid, csv: (r) => r.a.valid },
    { key: 'matched', label: 'Matched', num: true, render: (r) => num(r.a.matched), sort: (r) => r.a.matched },
    { key: 'new', label: 'New retailers', num: true, render: (r) => num(r.a.out[NEW]), sort: (r) => r.a.out[NEW] },
    { key: 'conv', label: 'Became retailers', num: true, render: (r) => <Pct k={r.a.out[NEW]} n={r.a.judged} label="New retailers ÷ leads with a working number and sales data" />, sort: (r) => (r.a.judged ? r.a.out[NEW] / r.a.judged : 0), csv: (r) => (r.a.judged ? ((100 * r.a.out[NEW]) / r.a.judged).toFixed(2) : '') },
    { key: 'react', label: 'Came back', num: true, render: (r) => num(r.a.out[REACTIVATED]), sort: (r) => r.a.out[REACTIVATED] },
    { key: 'rep', label: 'Ordered again', num: true, render: (r) => <Pct k={r.a.repeatRetailers} n={r.a.out[NEW]} label="Billed 2+ months ÷ converted" />, sort: (r) => r.a.repeatRetailers, csv: (r) => r.a.repeatRetailers },
  ];

  // repeat-lead rate per campaign: rows whose mobile already came in earlier ÷ rows
  const repeatRows = useMemo(() => {
    const per = new Map<number, { rows: number; rep: number }>();
    for (let i = 0; i < M.nL; i++) {
      if (!leadOk(M, f, i, rg, ['outcome'])) continue;
      const e = per.get(L.camp[i]) ?? { rows: 0, rep: 0 };
      e.rows++;
      if (!L.uniq[i]) e.rep++;
      per.set(L.camp[i], e);
    }
    return [...per.entries()].map(([k, e]) => ({ name: M.p.dims.campaign[k] ?? '(none)', ...e }));
  }, [M, f, rg, L]);

  // new vs reactivation vs existing per lead month
  const splitData = useMemo(() => {
    const by = new Map<number, number[]>();
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !leadOk(M, f, i, rg)) continue;
      const o = outcomeOf(M, i, f.level, f.window);
      if (o !== NEW && o !== REACTIVATED && o !== EXISTING) continue;
      const e = by.get(L.m[i]) ?? [0, 0, 0];
      e[o]++;
      by.set(L.m[i], e);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([m, e]) => ({ month: monthName(M, m), existing: e[EXISTING], react: e[REACTIVATED], neu: e[NEW] }));
  }, [M, f, rg, L]);

  // time to first order (months from lead month to first bill) and the decay curve by source
  const { ttfo, decay } = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0];
    const maxK = 6;
    const bySrc = M.p.dims.source.map(() => ({ n: 0, k: new Array(maxK + 1).fill(0) as number[] }));
    const ret = M.ret[f.level];
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !L.valid[i] || !leadOk(M, f, i, rg)) continue;
      const r = ret[i];
      const first = r >= 0 ? M.p.retailers.first[r] : -1;
      const gap = first >= L.m[i] ? first - L.m[i] : -1;
      // decay: only leads old enough to have been observed for maxK months
      if (L.m[i] + maxK <= M.p.salesEnd) {
        bySrc[L.src[i]].n++;
        if (gap >= 0) for (let k = gap; k <= maxK; k++) bySrc[L.src[i]].k[k]++;
      }
      if (outcomeOf(M, i, f.level, f.window) === NEW && gap >= 0) buckets[Math.min(gap, 5)]++;
    }
    const ttfo = ['Same month', '1 month', '2 months', '3 months', '4 months', '5+ months'].map((label, j) => ({ label, leads: buckets[j] }));
    const decay = Array.from({ length: maxK + 1 }, (_, k) => {
      const row: Record<string, number | string | null> = { k: String(k) };
      bySrc.forEach((s, j) => (row[`s${j}`] = s.n ? (100 * s.k[k]) / s.n : null));
      return row;
    });
    return { ttfo, decay: { rows: decay, srcs: bySrc.map((s, j) => ({ j, n: s.n })).filter((s) => s.n > 0) } };
  }, [M, f, rg, L]);

  // field follow-up: unique leads with a valid mobile -> called -> visited -> order reported -> seen in BO billing
  const field = useMemo(() => {
    const st = [0, 0, 0, 0, 0];
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !L.valid[i] || !leadOk(M, f, i, rg)) continue;
      st[0]++;
      if (!wasCalled(M, i)) continue;
      st[1]++;
      if (L.visited?.[i] === 1) st[2]++;
      if (L.ordered?.[i] === 1) {
        st[3]++;
        if (boOrderCheck(M, i, f.level) === 'billed') st[4]++;
      }
    }
    return [
      { s: 'Unique leads (valid mobile)', v: st[0] }, { s: 'Called', v: st[1] }, { s: 'Visited', v: st[2] },
      { s: 'Order reported by ASM', v: st[3] }, { s: 'Retailer billed in BO', v: st[4] },
    ];
  }, [M, f, rg, L]);

  const max = total ? Math.max(1, total.rows) : 1;
  return (
    <Section def={SECTIONS[1]} n={2}>
      <div className="ld-grid">
        <Card title="From enquiry to first order" wide uses={[...LEAD_USES]}
          info={{ what: 'Each step a lead goes through: enquiry → one per mobile number → a working number → found in the BO sales data → first order (a new retailer) → ordered again in another month.', formula: 'each % = this step ÷ the step before', source: 'Lead sheets matched to BO sales' }}
          actions={<IconToggle label="Group by" value={group} onChange={setGroup} options={[
            { value: 'total', icon: Sigma, label: 'Total' }, { value: 'source', icon: Layers, label: 'Source' },
            { value: 'campaign', icon: Megaphone, label: 'Campaign' }, { value: 'month', icon: CalendarDays, label: 'Month' }]} />}
          csv={{ name: 'lead_funnel', rows: () => csvRows(rows, cols) }}
          soWhat={total && total.valid ? <>Of {num(total.valid)} leads with a working number, {num(total.out[NEW])} became new retailers and {num(total.repeatRetailers)} of them ordered again. The biggest drop is where the bar shrinks most.</> : undefined}>
          {!M.p.hasLeads || !total ? <NeedsData what="leads" /> : (
            <>
              <table className="ld-table" style={{ marginBottom: 12 }}>
                <tbody>
                  {stages(total).map((s, j, a) => (
                    <tr key={s.s}>
                      <td style={{ width: 210 }}>{s.s}</td>
                      <td className="num" style={{ width: 90 }}>{num(s.v)}</td>
                      <td style={{ width: 90 }} className="num">{j > 0 ? <Pct k={s.v} n={a[j - 1].v} label={`${s.s} ÷ ${a[j - 1].s}`} /> : ''}</td>
                      <td><InBar value={s.v} max={max} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {group !== 'total' && <Table rows={rows} cols={cols} initialSort={{ key: group === 'month' ? 'name' : 'rows', dir: group === 'month' ? 'asc' : 'desc' }} />}
            </>
          )}
        </Card>
        <Card title="Field follow-up funnel" uses={[...LEAD_USES]}
          info={{ what: 'What happened after the lead, as the ASMs record it on the lead sheet (Calling Done, Visit Done, Order Placed), with the last step checked in the BO sales data: the matched retailer billed in the lead month or the 2 months after. Visited and ordered are counted among called leads.', formula: 'each stage ÷ the stage before (visited ÷ called, order ÷ called, billed ÷ orders)', source: 'Lead sheet ASM columns + BO retailer_month.csv' }}
          csv={{ name: 'field_funnel', rows: () => field.map((s) => ({ Stage: s.s, Leads: s.v })) }}
          soWhat={field[0].v ? <>{num(field[1].v)} of {num(field[0].v)} leads were called; {num(field[4].v)} of {num(field[3].v)} reported orders show up in BO billing.</> : undefined}>
          {!M.p.hasFollowup ? <NeedsData what="followup" /> : (
            <table className="ld-table">
              <tbody>
                {field.map((s, j, a) => {
                  const base = j === 0 ? null : j === 1 ? a[0] : j === 4 ? a[3] : a[1];
                  return (
                    <tr key={s.s}>
                      <td style={{ width: 200 }}>{s.s}</td>
                      <td className="num" style={{ width: 80 }}>{num(s.v)}</td>
                      <td className="num" style={{ width: 80 }}>{base ? <Pct k={s.v} n={base.v} label={`${s.s} ÷ ${base.s}`} /> : ''}</td>
                      <td><InBar value={s.v} max={Math.max(1, a[0].v)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="People who enquired more than once" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level']}
          info={{ what: 'Share of each campaign\'s enquiries from a mobile number that had already enquired before. High = paying twice for the same people.', formula: 'repeat enquiries ÷ all enquiries' }}
          csv={{ name: 'repeat_lead_rate', rows: () => repeatRows.map((r) => ({ Campaign: r.name, Leads: r.rows, Repeats: r.rep, 'Repeat %': r.rows ? ((100 * r.rep) / r.rows).toFixed(2) : '' })) }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <Table rows={repeatRows} initialSort={{ key: 'rate', dir: 'desc' }} cols={[
              { key: 'name', label: 'Campaign', render: (r) => r.name, sort: (r) => r.name },
              { key: 'rows', label: 'Leads', num: true, render: (r) => num(r.rows), sort: (r) => r.rows },
              { key: 'rate', label: 'Asked before', num: true, render: (r) => <Pct k={r.rep} n={r.rows} label="Repeat rows ÷ rows" />, sort: (r) => (r.rows ? r.rep / r.rows : 0) },
            ]} />
          )}
        </Card>
        <Card title="New retailers vs old ones coming back" uses={[...LEAD_USES]}
          info={{ what: 'Leads per month that became new retailers, were old retailers who came back, or were already buying.', source: 'Lead sheets matched to BO sales' }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <StackedBars data={splitData} x="month" fmt={num} series={[
              { key: 'neu', label: 'New retailer', color: OUTCOME_COLORS[NEW] },
              { key: 'react', label: 'Came back', color: OUTCOME_COLORS[REACTIVATED] },
              { key: 'existing', label: 'Already buying', color: OUTCOME_COLORS[EXISTING] }]} />
          )}
        </Card>
        <Card title="How long until the first order" uses={[...LEAD_USES]}
          info={{ what: 'New retailers by how many months passed between the enquiry and their first order (sales are monthly, so "same month" = 0).', source: 'Lead date vs first order month' }}
          soWhat={ttfo.some((b) => b.leads) ? <>{num(ttfo[0].leads + ttfo[1].leads)} of {num(ttfo.reduce((s, b) => s + b.leads, 0))} ordered within a month: calling fast matters most.</> : undefined}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : <StackedBars data={ttfo} x="label" fmt={num} series={[{ key: 'leads', label: 'New retailers', color: OUTCOME_COLORS[NEW] }]} />}
        </Card>
        <Card title="When leads stop converting" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level']}
          info={{ what: 'Share of leads that had placed a first order within 0, 1, 2 … months, by source. Only leads at least 6 months old count. Where the line goes flat, leads have stopped converting: contact them again then.', formula: 'leads with a first order by month k ÷ leads 6+ months old' }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : decay.srcs.length === 0 ? <div className="ld-empty-s">No leads 6+ months old in this selection yet.</div> : (
            <Lines data={decay.rows} x="k" fmt={(v) => `${v.toFixed(0)}%`} xLabel={(k) => `${k} mo`}
              series={decay.srcs.map((s) => ({ key: `s${s.j}`, label: `${M.p.dims.source[s.j]} (n=${num(s.n)})`, color: SOURCE_COLORS[s.j] }))} />
          )}
        </Card>
      </div>
    </Section>
  );
}
