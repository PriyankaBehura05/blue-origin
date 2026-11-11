import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, MiniSelect, Section, inr, num, pctTxt, useLeads } from '../ui';
import { StackedBars, Waterfall, heat } from '../charts';
import { SECTIONS, TIER_COLORS } from '../sections';
import { acquisition, health, ORGANIC, quarterName, quarterShort, retailerOk, revIn, riskRevenue, tierAt } from '../model';

type Group = 'all' | 'mkt' | 'org';
const RET_USES = ['source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window'] as const;
const GROUPS = [{ value: 'all' as Group, label: 'All retailers' }, { value: 'mkt' as Group, label: 'Marketing-acquired' }, { value: 'org' as Group, label: 'Organic' }];

export default function Retention() {
  const { M, f } = useLeads();
  const navigate = useNavigate();
  const [cohortGroup, setCohortGroup] = useState<Group>('all');
  const [tierGroup, setTierGroup] = useState<Group>('all');
  const acq = acquisition(M, f.level, f.window);
  const inGroup = (r: number, g: Group) => g === 'all' || (g === 'mkt' ? acq.src[r] !== ORGANIC : acq.src[r] === ORGANIC);
  const qs = M.p.quarters.filter((q) => M.qMonths[q].some((m) => m <= M.p.salesEnd));
  // the waterfall / tier matrix quarter: the period's quarter, else the latest
  const focusQ = f.period.startsWith('q:') ? f.period.slice(2) : f.period.startsWith('m:') ? M.p.monthQuarter[Number(f.period.slice(2))] : M.latestQuarter;
  const qi = qs.indexOf(focusQ);
  const prevQ = qi > 0 ? qs[qi - 1] : null;
  const span = (q: string): [number, number] => [M.qMonths[q][0], M.qMonths[q][M.qMonths[q].length - 1]];

  const split = useMemo(() => qs.map((q) => {
    const [a, b] = span(q);
    let neu = 0, old = 0;
    for (let r = 0; r < M.nR; r++) {
      if (!retailerOk(M, f, r, b)) continue;
      const v = revIn(M, r, a, b);
      if (!v) continue;
      const first = M.p.retailers.first[r];
      if (first >= a && first <= b) neu += v; else old += v;
    }
    return { q: quarterShort(q), neu, old };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [M, f]);

  const cohorts = useMemo(() => {
    const qIndex = new Map(qs.map((q, i) => [q, i]));
    const size = qs.map(() => 0);
    const kept = qs.map(() => qs.map(() => 0));
    for (let r = 0; r < M.nR; r++) {
      const first = M.p.retailers.first[r];
      if (first < 0 || !inGroup(r, cohortGroup) || !retailerOk(M, f, r, first)) continue;
      const c = qIndex.get(M.p.monthQuarter[first]);
      if (c === undefined) continue;
      size[c]++;
      for (let k = 0; c + k < qs.length; k++) {
        const [a, b] = span(qs[c + k]);
        for (let m = a; m <= b; m++) if (M.rev[r * M.nM + m] > 0) { kept[c][k]++; break; }
      }
    }
    return { size, kept };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, f, acq, cohortGroup]);

  const fall = useMemo(() => {
    if (!prevQ || qi < 0) return null;
    const [a, b] = span(focusQ);
    const [pa, pb] = span(prevQ);
    let open = 0, close = 0, neu = 0, react = 0, exp = 0, con = 0, churn = 0;
    for (let r = 0; r < M.nR; r++) {
      if (!retailerOk(M, f, r, b)) continue;
      const now = revIn(M, r, a, b);
      const before = revIn(M, r, pa, pb);
      open += before;
      close += now;
      // every retailer's change goes to exactly one step, so opening + steps = closing to the paisa
      const diff = now - before;
      if (!diff) continue;
      if (before > 0 && now <= 0) churn -= diff;
      else if (before <= 0 && now > 0) { if (M.p.retailers.first[r] >= a) neu += diff; else react += diff; }
      else if (diff > 0) exp += diff;
      else con -= diff;
    }
    return { open, close, steps: [
      { label: quarterShort(prevQ), value: open, total: true }, { label: 'New', value: neu }, { label: 'Reactiv.', value: react },
      { label: 'Expand', value: exp }, { label: 'Contract', value: -con }, { label: 'Churn', value: -churn },
      { label: quarterShort(focusQ), value: close, total: true },
    ], check: open + neu + react + exp - con - churn - close };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, f, focusQ, prevQ]);

  const matrix = useMemo(() => {
    if (!prevQ) return null;
    const [, b] = span(focusQ);
    const [, pb] = span(prevQ);
    const grid = Array.from({ length: 7 }, () => new Array(7).fill(0) as number[]); // index 0 = no tier / not billed, 1..6 = tiers
    for (let r = 0; r < M.nR; r++) {
      if (!inGroup(r, tierGroup) || !retailerOk(M, f, r, b, ['tier'])) continue;
      const t0 = tierAt(M, r, pb) + 1;
      const t1 = tierAt(M, r, b) + 1;
      if (t0 === 0 && t1 === 0) continue;
      if (f.tier >= 0 && t1 !== f.tier + 1 && t0 !== f.tier + 1) continue;
      grid[t0][t1]++;
    }
    return grid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, f, focusQ, prevQ, acq, tierGroup]);

  const riskByTier = useMemo(() => {
    const end = M.p.salesEnd;
    const rows = M.p.dims.tiers.map((t, j) => ({ tier: t, j, n: 0, rev: 0 }));
    for (let r = 0; r < M.nR; r++) {
      if (!retailerOk(M, f, r, end) || health(M, r, end) !== 'At-risk') continue;
      const t = tierAt(M, r, end - 2);
      if (t < 0) continue;
      rows[t].n++;
      rows[t].rev += riskRevenue(M, r, end);
    }
    return rows;
  }, [M, f]);

  const tierNames = ['None', ...M.p.dims.tiers];
  return (
    <Section def={SECTIONS[6]} n={7}>
      <div className="ld-grid">
        <Card title="Revenue: new vs existing retailers" uses={[...RET_USES]}
          info={{ what: 'Each quarter\'s billing split into retailers billing for the first time that quarter (new) and everyone else (existing). Every quarter is shown, so the period filter is not applied.', source: 'retailer_month.csv' }}
          csv={{ name: 'revenue_new_vs_existing', rows: () => split.map((r) => ({ Quarter: r.q, 'New retailers (₹)': Math.round(r.neu), 'Existing retailers (₹)': Math.round(r.old) })) }}>
          <StackedBars data={split} x="q" fmt={inr} series={[{ key: 'old', label: 'Existing retailers', color: 'var(--ld-seq-5)' }, { key: 'neu', label: 'New retailers', color: 'var(--ld-src-google)' }]} />
        </Card>
        <Card title={`Revenue waterfall · ${quarterName(focusQ)}`} uses={['period', ...RET_USES]}
          info={{ what: 'Previous quarter\'s billing + new retailers + reactivated (billed before, not last quarter) + expansion − contraction − churned (billed last quarter, not this one) = this quarter\'s billing.', formula: 'opening + new + reactivated + expansion − contraction − churned = closing', source: 'retailer_month.csv' }}
          soWhat={fall ? <>Churn took {inr(-fall.steps[5].value)}; new retailers added {inr(fall.steps[1].value)}. Check: difference {inr(Math.abs(fall.check))}.</> : undefined}>
          {fall ? <Waterfall steps={fall.steps} fmt={inr} /> : <div className="ld-empty-s">No previous quarter to compare with.</div>}
        </Card>
        <Card title="Cohort retention (by first quarter)" wide uses={[...RET_USES]}
          actions={<MiniSelect label="Retailer group" value={cohortGroup} onChange={setCohortGroup} options={GROUPS} />}
          info={{ what: 'Rows: retailers grouped by the quarter of their first bill. Columns: quarters since then. Cell: % of the cohort that billed in that quarter.', formula: 'cohort retailers billed in quarter k ÷ cohort size', source: 'retailer_month.csv' }}
          csv={{ name: 'cohort_retention', rows: () => qs.map((q, c) => ({ Cohort: quarterShort(q), Retailers: cohorts.size[c], ...Object.fromEntries(qs.slice(c).map((_, k) => [`Q+${k}`, cohorts.size[c] ? ((100 * cohorts.kept[c][k]) / cohorts.size[c]).toFixed(1) : ''])) })) }}>
          <div className="ld-table-wrap">
            <table className="ld-table ld-heat">
              <thead><tr><th>Cohort</th><th className="num">Retailers</th>{qs.map((_, k) => <th key={k} className="num">Q+{k}</th>)}</tr></thead>
              <tbody>
                {qs.map((q, c) => (
                  <tr key={q}>
                    <td>{quarterShort(q)}</td>
                    <td className="num">{num(cohorts.size[c])}</td>
                    {qs.map((_, k) => {
                      if (c + k >= qs.length || !cohorts.size[c]) return <td key={k} />;
                      const v = cohorts.kept[c][k] / cohorts.size[c];
                      return <td key={k} className="cell" style={heat(k === 0 ? 0 : v)} title={`${num(cohorts.kept[c][k])} ÷ ${num(cohorts.size[c])}`}>{(100 * v).toFixed(0)}%</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={`Tier movement · ${prevQ ? quarterShort(prevQ) : '—'} → ${quarterShort(focusQ)}`} uses={['period', ...RET_USES]}
          actions={<MiniSelect label="Retailer group" value={tierGroup} onChange={setTierGroup} options={GROUPS} />}
          info={{ what: 'Retailers by tier last quarter (rows) and this quarter (columns). "None" = no billing that quarter. Above the diagonal = upgraded. With a tier filter, rows and columns touching that tier are kept.', source: 'retailer_quarter.csv (recomputed tiers; Platinum from Q1 FY 27)' }}
          csv={matrix ? { name: 'tier_matrix', rows: () => matrix.map((row, i) => ({ 'From \\ To': tierNames[i], ...Object.fromEntries(row.map((v, j) => [tierNames[j], v])) })) } : undefined}>
          {!matrix ? <div className="ld-empty-s">No previous quarter.</div> : (
            <div className="ld-table-wrap">
              <table className="ld-table ld-heat">
                <thead><tr><th>From ↓ / To →</th>{tierNames.map((t) => <th key={t} className="num">{t}</th>)}</tr></thead>
                <tbody>
                  {matrix.map((row, i) => {
                    const tot = row.reduce((s, v) => s + v, 0);
                    return (
                      <tr key={i}>
                        <td><span className="ld-legend" style={{ margin: 0 }}><span>{i > 0 && <i style={{ background: TIER_COLORS[i - 1] }} />}{tierNames[i]}</span></span></td>
                        {row.map((v, j) => <td key={j} className="cell" style={heat(tot ? v / tot : 0)} title={`${num(v)} of ${num(tot)} (${pctTxt(v, tot)})`}>{v ? num(v) : ''}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Revenue at risk by tier" uses={RET_USES.filter((k) => k !== 'tier') as never}
          info={{ what: 'At-risk retailers (last bill 2 months before the last sales month) by their tier at that time, with one quarter of their billing.', source: 'retailer_month.csv, retailer_quarter.csv' }}
          csv={{ name: 'revenue_at_risk_by_tier', rows: () => riskByTier.map((r) => ({ Tier: r.tier, Retailers: r.n, 'Revenue at risk (₹)': Math.round(r.rev) })) }}
          soWhat={(() => { const top = [...riskByTier].sort((a, b) => b.rev - a.rev)[0]; return top && top.rev ? <>{top.tier} retailers carry the most at-risk revenue ({inr(top.rev)}): call them first.</> : undefined; })()}>
          <table className="ld-table">
            <thead><tr><th>Tier</th><th className="num">At-risk retailers</th><th className="num">Revenue at risk</th></tr></thead>
            <tbody>{riskByTier.slice().reverse().map((r) => (
              <tr key={r.tier}><td><span className="ld-legend" style={{ margin: 0 }}><span><i style={{ background: TIER_COLORS[r.j] }} />{r.tier}</span></span></td><td className="num">{num(r.n)}</td><td className="num">{inr(r.rev)}</td></tr>
            ))}</tbody>
          </table>
          <button type="button" className="ld-btn" style={{ marginTop: 8 }} onClick={() => navigate('/leads/retailers')}>See the at-risk list</button>
        </Card>
      </div>
    </Section>
  );
}

