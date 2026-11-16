// ASM performance on the Lead journey page: leads assigned to each ASM, how many they contacted, how many were interested,
// what is still waiting for a call, the conversion rate and the new retailers - and the same by campaign, so ad performance
// can be read next to the sales team's follow-up. Stage rules: journey.ts; outcomes: the matching level and window of the bar.
import { useMemo, useState } from 'react';
import { Card, MiniSelect, Pct, Table, csvRows, num, useLeads, type Col } from '../ui';
import { leadOk, NEW, outcomeOf, PENDING, REACTIVATED, SMALL_SAMPLE, wasCalled } from '../model';
import { isInterested } from '../journey';

const USES = ['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window'] as const;

interface Acc { assigned: number; contacted: number; interested: number; pending: number; judged: number; converted: number; fresh: Set<number> }
const blank = (): Acc => ({ assigned: 0, contacted: 0, interested: 0, pending: 0, judged: 0, converted: 0, fresh: new Set() });

interface AsmRow extends Acc { o: number; name: string }

type CellMetric = 'assigned' | 'contact' | 'conv' | 'fresh';
const CELL: { value: CellMetric; label: string }[] = [
  { value: 'assigned', label: 'Leads assigned' }, { value: 'contact', label: 'Contact rate' },
  { value: 'conv', label: 'Conversion rate' }, { value: 'fresh', label: 'New retailers' },
];
const TOP_CAMPAIGNS = 6;

export default function JourneyAsm() {
  const { M, f, rg } = useLeads();
  const L = M.p.leads;
  const [cell, setCell] = useState<CellMetric>('contact');

  const { rows, camps, grid } = useMemo(() => {
    const per = new Map<number, Acc>();
    const byCamp = new Map<string, Acc>();           // `${owner}|${campaign}`
    const campLeads = new Map<number, number>();
    const ret = M.ret[f.level];
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !leadOk(M, f, i, rg)) continue;
      const o = L.owner[i];                           // -1 = no ASM
      const add = (a: Acc) => {
        a.assigned++;
        const called = wasCalled(M, i);
        const out = outcomeOf(M, i, f.level, f.window);
        if (called) a.contacted++;
        if (called && isInterested(M, i)) a.interested++;
        if (L.valid[i] && out !== PENDING) a.judged++;
        if (out === NEW || out === REACTIVATED) a.converted++;
        if (out === NEW && ret[i] >= 0) a.fresh.add(ret[i]);
        if (!called && out !== NEW && out !== REACTIVATED && L.valid[i]) a.pending++;
      };
      add(per.get(o) ?? per.set(o, blank()).get(o)!);
      if (o >= 0) {
        campLeads.set(L.camp[i], (campLeads.get(L.camp[i]) ?? 0) + 1);
        const k = `${o}|${L.camp[i]}`;
        add(byCamp.get(k) ?? byCamp.set(k, blank()).get(k)!);
      }
    }
    const rows: AsmRow[] = [...per.entries()].map(([o, a]) => ({ ...a, o, name: o >= 0 ? M.p.dims.owner[o] : 'No ASM assigned' }));
    const camps = [...campLeads.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_CAMPAIGNS).map(([c]) => c);
    return { rows, camps, grid: byCamp };
  }, [M, f, rg, L]);

  const rate = (k: number, n: number) => (n ? (100 * k) / n : -1);
  const cols: Col<AsmRow>[] = [
    { key: 'name', label: 'ASM', render: (r) => (r.o < 0 ? <em className="ld-muted">{r.name}</em> : r.name), sort: (r) => r.name },
    { key: 'asg', label: 'Leads assigned', num: true, render: (r) => num(r.assigned), sort: (r) => r.assigned },
    { key: 'con', label: 'Contact rate', num: true, render: (r) => <Pct k={r.contacted} n={r.assigned} label="Called ÷ assigned" />, sort: (r) => rate(r.contacted, r.assigned), csv: (r) => r.contacted },
    { key: 'int', label: 'Interested', num: true, render: (r) => num(r.interested), sort: (r) => r.interested },
    { key: 'pen', label: 'Follow-up pending', num: true, render: (r) => (r.pending ? <span className="ld-flag">{num(r.pending)}</span> : '0'), sort: (r) => r.pending, csv: (r) => r.pending },
    { key: 'cr', label: 'Conversion rate', num: true, render: (r) => <Pct k={r.converted} n={r.judged} label="Converted (new + came back) ÷ leads with sales data" />, sort: (r) => rate(r.converted, r.judged), csv: (r) => r.converted },
    { key: 'new', label: 'New retailers', num: true, render: (r) => num(r.fresh.size), sort: (r) => r.fresh.size, csv: (r) => r.fresh.size },
  ];

  const cellOf = (a: Acc | undefined) => {
    if (!a || !a.assigned) return <span className="ld-muted">—</span>;
    if (cell === 'assigned') return num(a.assigned);
    if (cell === 'fresh') return num(a.fresh.size);
    const [k, n] = cell === 'contact' ? [a.contacted, a.assigned] : [a.converted, a.judged];
    if (!n) return <span className="ld-muted">—</span>;
    const v = (100 * k) / n;
    return <span className={`ld-heat ${v >= 66 ? 'hi' : v >= 33 ? 'mid' : 'lo'}`} title={`${num(k)} of ${num(n)}${n < SMALL_SAMPLE ? ' (small sample)' : ''}`}>{v.toFixed(0)}%</span>;
  };
  const asms = rows.filter((r) => r.o >= 0).sort((a, b) => b.assigned - a.assigned);
  const campName = (c: number) => M.p.dims.campaign[c] ?? '(none)';
  const gridCols: Col<AsmRow>[] = [
    { key: 'name', label: 'ASM', render: (r) => r.name, sort: (r) => r.name },
    ...camps.map((c) => ({ key: `c${c}`, label: <span title={campName(c)}>{campName(c).length > 26 ? `${campName(c).slice(0, 24)}…` : campName(c)}</span>, num: true,
      render: (r: AsmRow) => cellOf(grid.get(`${r.o}|${c}`)), csv: (r: AsmRow) => {
        const a = grid.get(`${r.o}|${c}`);
        if (!a) return '';
        return cell === 'assigned' ? a.assigned : cell === 'fresh' ? a.fresh.size : cell === 'contact' ? (a.assigned ? ((100 * a.contacted) / a.assigned).toFixed(1) : '') : (a.judged ? ((100 * a.converted) / a.judged).toFixed(1) : '');
      } })),
  ];
  const unassigned = rows.find((r) => r.o < 0);

  return (
    <>
      <Card wide title="ASM performance" uses={[...USES]}
        info={{ what: 'Every ASM with the leads assigned to them in the period. Interested = called and visited, an order reported, or a positive call result. Follow-up pending = a working number not called yet and not converted. Conversion = BO confirms a new retailer or one that came back. New retailers = distinct shops whose first-ever BO bill came after the ASM\'s lead.',
          formula: 'contact rate = called ÷ assigned · conversion rate = converted ÷ leads with sales data', source: 'Lead sheet ASM columns + BO sales' }}
        csv={{ name: 'asm_performance', rows: () => csvRows(rows, cols) }}
        soWhat={unassigned && unassigned.assigned ? <>{num(unassigned.assigned)} leads have no ASM yet. {num(rows.reduce((s, r) => s + (r.o >= 0 ? r.pending : 0), 0))} assigned leads are still waiting for a call.</> : undefined}>
        <Table rows={rows} cols={cols} initialSort={{ key: 'asg', dir: 'desc' }} />
      </Card>
      <Card wide title="Campaign-wise ASM performance" uses={[...USES]}
        actions={<MiniSelect label="Show" value={cell} onChange={setCell} options={CELL} />}
        info={{ what: `Each ASM against the ${TOP_CAMPAIGNS} campaigns that gave them the most leads in the period: how the sales team followed up each campaign's leads. Green = 66% or more, amber = 33–65%, red = under 33%. Hover a cell for the count.`, source: 'Lead sheet ASM columns, campaign attribution, BO sales' }}
        csv={{ name: 'campaign_asm_performance', rows: () => csvRows(asms, gridCols) }}>
        {camps.length ? <Table rows={asms} cols={gridCols} /> : <div className="ld-empty-s">No ASM-assigned leads for these filters.</div>}
      </Card>
    </>
  );
}
