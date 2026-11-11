import { useMemo, useState } from 'react';
import { GitBranch, Layers } from 'lucide-react';
import { Card, IconToggle, Pct, Section, inr, num, useLeads } from '../ui';
import { Lines, StackedBars } from '../charts';
import { SECTIONS, SOURCE_COLORS, SOURCE_NAMES } from '../sections';
import { acquisition, ORGANIC, quarterShort, retailerOk, SMALL_SAMPLE, wilson } from '../model';
import { earlyQuality } from '../calc';

type View = 'split' | 'source';
const RET_USES = ['source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window'] as const;

export default function Mix() {
  const { M, f } = useLeads();
  const [view, setView] = useState<View>('split');
  const acq = acquisition(M, f.level, f.window);
  const groupOf = (r: number) => (view === 'split' ? (acq.src[r] === ORGANIC ? 1 : 0) : acq.src[r]);
  const groups = view === 'split'
    ? [{ g: 0, name: 'Marketing (all lead sources)', color: SOURCE_COLORS[0] }, { g: 1, name: 'Organic', color: SOURCE_COLORS[ORGANIC] }]
    : SOURCE_NAMES.map((name, g) => ({ g, name, color: SOURCE_COLORS[g] }));

  const perQuarter = useMemo(() => {
    const rows = M.p.quarters.map((q) => ({ q: quarterShort(q), ...Object.fromEntries(SOURCE_NAMES.map((_, j) => [`s${j}`, 0])) })) as Record<string, number | string>[];
    const qi = Object.fromEntries(M.p.quarters.map((q, i) => [q, i]));
    for (let r = 0; r < M.nR; r++) {
      const m = M.p.retailers.first[r];
      if (m < 0 || !retailerOk(M, f, r, m)) continue;
      const row = rows[qi[M.p.monthQuarter[m]]];
      row[`s${acq.src[r]}`] = (row[`s${acq.src[r]}`] as number) + 1;
    }
    return rows.filter((r) => SOURCE_NAMES.some((_, j) => (r[`s${j}`] as number) > 0));
  }, [M, f, acq]);

  const quality = useMemo(() => {
    const n = view === 'split' ? 2 : SOURCE_NAMES.length;
    const acc = Array.from({ length: n }, () => ({ n: 0, rev: 0, months: 0, m1: 0, m3: 0 }));
    for (let r = 0; r < M.nR; r++) {
      if (!retailerOk(M, f, r, M.p.salesEnd)) continue;
      const q = earlyQuality(M, r);
      if (!q) continue;
      const a = acc[groupOf(r)];
      a.n++;
      a.rev += q.rev90;
      a.months += q.months90;
      if (q.m1) a.m1++;
      if (q.m3) a.m3++;
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, f, acq, view]);

  const ltv = useMemo(() => {
    const K = 12;
    const n = view === 'split' ? 2 : SOURCE_NAMES.length;
    const sum = Array.from({ length: n }, () => new Array(K + 1).fill(0) as number[]);
    const cnt = Array.from({ length: n }, () => new Array(K + 1).fill(0) as number[]);
    for (let r = 0; r < M.nR; r++) {
      const first = M.p.retailers.first[r];
      if (first < 0 || !retailerOk(M, f, r, M.p.salesEnd)) continue;
      const g = groupOf(r);
      let cum = 0;
      for (let k = 0; k <= K && first + k <= M.p.salesEnd; k++) {
        cum += M.rev[r * M.nM + first + k];
        sum[g][k] += cum;
        cnt[g][k]++;
      }
    }
    return Array.from({ length: K + 1 }, (_, k) => {
      const row: Record<string, number | string | null> = { k: String(k) };
      for (let g = 0; g < n; g++) row[`g${g}`] = cnt[g][k] >= 5 ? sum[g][k] / cnt[g][k] : null;
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, f, acq, view]);

  const toggle = <IconToggle label="Compare" value={view} onChange={setView} options={[
    { value: 'split', icon: GitBranch, label: 'Marketing vs organic' }, { value: 'source', icon: Layers, label: 'By source' }]} />;
  const shown = groups.filter((g) => quality[g.g]?.n > 0);
  const mkt = quality[0];
  const org = view === 'split' ? quality[1] : null;

  return (
    <Section def={SECTIONS[2]} n={3}>
      <div className="ld-grid">
        <Card title="New retailers per quarter, by source" wide uses={[...RET_USES]}
          info={{ what: 'Retailers by the quarter of their first-ever bill, coloured by the source that brought them in. Organic = no lead converted them (includes distributor-led, ASM-led and word of mouth, which the data cannot separate).', source: 'retailer_month.csv first bills + lead outcomes' }}
          csv={{ name: 'new_retailers_by_source', rows: () => perQuarter.map((r) => ({ Quarter: r.q, ...Object.fromEntries(SOURCE_NAMES.map((s, j) => [s, r[`s${j}`]])) })) }}
          soWhat={!M.p.hasLeads ? 'Every new retailer shows as Organic until lead files are loaded.' : undefined}>
          <StackedBars data={perQuarter} x="q" fmt={num} series={SOURCE_NAMES.map((s, j) => ({ key: `s${j}`, label: s, color: SOURCE_COLORS[j] })).filter((s) => perQuarter.some((r) => (r[s.key] as number) > 0))} />
        </Card>
        <Card title="Quality: first 90 days" uses={[...RET_USES]} actions={toggle}
          info={{ what: 'All retailers whose first bill is at least 3 months before the last sales month (the period filter is not applied, so cohorts are complete). AOV = revenue per billing month; orders = billing months in the first 3; M1/M3 = billed 1 / 3 months after the first bill.', formula: 'M1 = retailers billed in month first+1 ÷ retailers in the group', source: 'retailer_month.csv' }}
          csv={{ name: 'quality_first_90_days', rows: () => shown.map((g) => { const q = quality[g.g]; return { Group: g.name, Retailers: q.n, 'AOV (₹/billing month)': q.months ? Math.round(q.rev / q.months) : '', 'Orders in 90 days': q.n ? (q.months / q.n).toFixed(2) : '', '90-day revenue (₹)': q.n ? Math.round(q.rev / q.n) : '', 'M1 %': q.n ? ((100 * q.m1) / q.n).toFixed(1) : '', 'M3 %': q.n ? ((100 * q.m3) / q.n).toFixed(1) : '' }; }) }}
          soWhat={org && mkt.n ? (mkt.n < SMALL_SAMPLE ? `Only ${mkt.n} marketing-sourced retailers so far: too few to call a difference.` : wilson(mkt.m3, mkt.n)[1] < wilson(org.m3, org.n)[0] ? 'Marketing-sourced retailers keep buying less than organic ones: fix onboarding before scaling.' : 'No significant M3 gap between marketing and organic retailers.') : undefined}>
          <div className="ld-table-wrap"><table className="ld-table">
            <thead><tr><th>Group</th><th className="num">Retailers</th><th className="num">AOV</th><th className="num">Orders / 90d</th><th className="num">90-day revenue</th><th className="num">M1</th><th className="num">M3</th></tr></thead>
            <tbody>
              {shown.map((g) => {
                const q = quality[g.g];
                return (
                  <tr key={g.g}>
                    <td><span className="ld-legend" style={{ margin: 0 }}><span><i style={{ background: g.color }} />{g.name}</span></span>{q.n < SMALL_SAMPLE && <span className="ld-muted"> · small sample</span>}</td>
                    <td className="num">{num(q.n)}</td>
                    <td className="num">{q.months ? inr(q.rev / q.months) : '—'}</td>
                    <td className="num">{q.n ? (q.months / q.n).toFixed(2) : '—'}</td>
                    <td className="num">{q.n ? inr(q.rev / q.n) : '—'}</td>
                    <td className="num"><Pct k={q.m1} n={q.n} label="Billed in month 2 ÷ group" /></td>
                    <td className="num"><Pct k={q.m3} n={q.n} label="Billed in month 4 ÷ group" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <div className="ld-note">Point at a % to see the numbers behind it and its likely range. Groups under {SMALL_SAMPLE} are greyed: too few to be sure.</div>
        </Card>
        <Card title="LTV by acquisition source" uses={[...RET_USES]} actions={toggle}
          info={{ what: 'Average cumulative billing per retailer by months since the first bill. Each point averages only the retailers observed that long (at least 5).', formula: 'Σ cumulative revenue at month k ÷ retailers observed k months', source: 'retailer_month.csv' }}>
          <Lines data={ltv} x="k" fmt={inr} xLabel={(k) => `M${k}`}
            series={groups.filter((g) => ltv.some((r) => r[`g${g.g}`] !== null)).map((g) => ({ key: `g${g.g}`, label: g.name, color: g.color }))} />
        </Card>
      </div>
    </Section>
  );
}
