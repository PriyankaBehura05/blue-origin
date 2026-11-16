// Where retailers come from, in six sections on one page:
//   1 Verdict & KPIs        which channels bring retailers, and which bring good ones
//   2 Volume by source      new retailers of the period by source, the marketing share; quarter by quarter
//   3 Retailer quality      the first 90 days of each source's retailers
//   4 LTV curve             cumulative billing per retailer by months since the first bill
//   5 Quarterly cohorts     each quarter's new retailers and how they have done since
// A retailer's source is that of the lead that brought it in (acquisition, model.ts); Organic = no lead did. The BO retailer
// data has no onboarding source: an organic retailer with no lead record showing how it came is counted as source unknown.
import { useMemo, useState } from 'react';
import { Award, Gauge, GitBranch, Layers, Megaphone, Sigma, Sprout, Store } from 'lucide-react';
import { Card, Delta, IconToggle, Kpi, MiniSelect, Pct, Section, Table, csvRows, inr, num, pctTxt, useLeads, type Col } from '../ui';
import { HBars, Lines, StackedBars } from '../charts';
import { SECTIONS, SOURCE_COLORS, SOURCE_NAMES } from '../sections';
import { acquisition, monthName, ORGANIC, periodName, quarterShort, retailerOk, revIn, SMALL_SAMPLE, wilson, type Model } from '../model';
import { earlyQuality } from '../calc';

type View = 'split' | 'source';
type VolumeView = 'total' | 'quarter';
const RET_USES = ['source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window'] as const;

// Organic: how a shop came is only known where a lead record proves it (never guessed); the rest is source unknown

/** For each organic retailer: 0 ASM/RSM, 1 Distributor, 3 Unknown (2 Word of mouth is never recorded). */
function organicOrigin(M: Model, level: number, src: Int8Array): Int8Array {
  const out = new Int8Array(M.nR).fill(3);
  const L = M.p.leads;
  const ret = M.ret[level];
  const distVisit = M.p.dims.status.indexOf('Distributor visit');
  for (let i = 0; i < M.nL; i++) {
    const r = ret[i];
    if (r < 0 || src[r] !== ORGANIC) continue;
    const first = M.p.retailers.first[r];
    if (first < 0 || L.m[i] > first) continue;           // only evidence from before (or in) the month of the first bill
    if ((distVisit >= 0 && L.status[i] === distVisit) || L.fdist[i] >= 0) out[r] = Math.min(out[r], 1);
    else if (L.owner[i] >= 0 && (L.called?.[i] === 1 || L.visited?.[i] === 1 || L.ordered?.[i] === 1 || L.contact[i] >= 0)) out[r] = 0;
  }
  return out;
}

export default function Mix() {
  const { M, f, rg, prev } = useLeads();
  const [view, setView] = useState<View>('split');
  const [vol, setVol] = useState<VolumeView>('total');
  const [cohortGroup, setCohortGroup] = useState<number>(-1);   // -1 all, -2 marketing, else a source index
  const acq = acquisition(M, f.level, f.window);
  const groupOf = (r: number) => (view === 'split' ? (acq.src[r] === ORGANIC ? 1 : 0) : acq.src[r]);
  const groups = view === 'split'
    ? [{ g: 0, name: 'Marketing (all lead sources)', color: SOURCE_COLORS[0] }, { g: 1, name: 'Organic', color: SOURCE_COLORS[ORGANIC] }]
    : SOURCE_NAMES.map((name, g) => ({ g, name, color: SOURCE_COLORS[g] }));
  const origin = useMemo(() => organicOrigin(M, f.level, acq.src), [M, f.level, acq]);

  // ---- new retailers of a period, by source and by organic origin
  const countIn = (a: number, b: number) => {
    const bySrc = new Array(SOURCE_NAMES.length).fill(0) as number[];
    const byOrg = [0, 0, 0, 0];
    for (let r = 0; r < M.nR; r++) {
      const first = M.p.retailers.first[r];
      if (first < a || first > b || !retailerOk(M, f, r, first)) continue;
      bySrc[acq.src[r]]++;
      if (acq.src[r] === ORGANIC) byOrg[origin[r]]++;
    }
    const all = bySrc.reduce((s, v) => s + v, 0);
    return { bySrc, byOrg, all, mkt: all - bySrc[ORGANIC] };
  };
  const cur = useMemo(() => countIn(rg[0], Math.min(rg[1], M.p.salesEnd)), [M, f, rg, acq, origin]); // eslint-disable-line react-hooks/exhaustive-deps
  const before = useMemo(() => (prev ? countIn(prev[0], Math.min(prev[1], M.p.salesEnd)) : null), [M, f, prev, acq, origin]); // eslint-disable-line react-hooks/exhaustive-deps
  const noSales = rg[0] > M.p.salesEnd;

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

  // quality by source whatever the toggle, for the verdict
  const bySource = useMemo(() => {
    const acc = SOURCE_NAMES.map(() => ({ n: 0, rev: 0, m3: 0 }));
    for (let r = 0; r < M.nR; r++) {
      if (!retailerOk(M, f, r, M.p.salesEnd)) continue;
      const q = earlyQuality(M, r);
      if (!q) continue;
      const a = acc[acq.src[r]];
      a.n++;
      a.rev += q.rev90;
      if (q.m3) a.m3++;
    }
    return acc;
  }, [M, f, acq]);

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

  // ---- quarterly cohorts: retailers by the quarter of their first bill, and how they have done since
  const cohorts = useMemo(() => {
    const qi = Object.fromEntries(M.p.quarters.map((q, i) => [q, i]));
    const rows = M.p.quarters.map((q) => ({ q, n: 0, mkt: 0, org: 0, unknown: 0, judged90: 0, m1: 0, m3: 0, rev90: 0, revToDate: 0, active: 0 }));
    const recent = Math.max(0, M.p.salesEnd - 2);
    for (let r = 0; r < M.nR; r++) {
      const first = M.p.retailers.first[r];
      if (first < 0 || !retailerOk(M, f, r, M.p.salesEnd)) continue;
      const s = acq.src[r];
      if (cohortGroup === -2 && s === ORGANIC) continue;
      if (cohortGroup >= 0 && s !== cohortGroup) continue;
      const row = rows[qi[M.p.monthQuarter[first]]];
      if (!row) continue;
      row.n++;
      if (s === ORGANIC) { row.org++; if (origin[r] === 3) row.unknown++; } else row.mkt++;
      const q = earlyQuality(M, r);
      if (q) { row.judged90++; row.rev90 += q.rev90; if (q.m1) row.m1++; if (q.m3) row.m3++; }
      row.revToDate += revIn(M, r, first, M.p.salesEnd);
      if (M.p.retailers.last[r] >= recent) row.active++;
    }
    return rows.filter((r) => r.n > 0);
  }, [M, f, acq, origin, cohortGroup]);

  const toggle = <IconToggle label="Compare" value={view} onChange={setView} options={[
    { value: 'split', icon: GitBranch, label: 'Marketing vs organic' }, { value: 'source', icon: Layers, label: 'By source' }]} />;
  const shown = groups.filter((g) => quality[g.g]?.n > 0);
  const mkt = quality[0];
  const org = view === 'split' ? quality[1] : null;

  // ---- verdict: biggest channel by volume, best by quality (enough retailers only)
  const period = periodName(M, f.period);
  const leadSources = SOURCE_NAMES.map((name, j) => ({ name, j })).filter((s) => s.j !== ORGANIC);
  const topVolume = leadSources.map((s) => ({ ...s, n: cur.bySrc[s.j] })).sort((a, b) => b.n - a.n)[0];
  const ranked = SOURCE_NAMES.map((name, j) => ({ name, j, ...bySource[j] })).filter((s) => s.n >= SMALL_SAMPLE);
  const bestM3 = [...ranked].sort((a, b) => b.m3 / b.n - a.m3 / a.n)[0];
  const bestRev = [...ranked].sort((a, b) => b.rev / b.n - a.rev / a.n)[0];
  const orgQ = bySource[ORGANIC];
  const mktQ = bySource.reduce((s, x, j) => (j === ORGANIC ? s : { n: s.n + x.n, rev: s.rev + x.rev, m3: s.m3 + x.m3 }), { n: 0, rev: 0, m3: 0 });
  const unknownShare = cur.all ? (100 * cur.byOrg[3]) / cur.all : null;

  const cohortCols: Col<(typeof cohorts)[number]>[] = [
    { key: 'q', label: 'First order in', render: (r) => quarterShort(r.q), sort: (r) => M.p.quarters.indexOf(r.q), csv: (r) => quarterShort(r.q) },
    { key: 'n', label: 'New retailers', num: true, render: (r) => num(r.n), sort: (r) => r.n },
    { key: 'mkt', label: 'From leads', num: true, render: (r) => <>{num(r.mkt)} <span className="ld-muted">({pctTxt(r.mkt, r.n, 1)})</span></>, sort: (r) => r.mkt, csv: (r) => r.mkt },
    { key: 'org', label: 'Organic', num: true, render: (r) => num(r.org), sort: (r) => r.org },
    { key: 'unk', label: 'Source unknown', num: true, render: (r) => num(r.unknown), sort: (r) => r.unknown },
    { key: 'm1', label: 'Bought again in month 2', num: true, render: (r) => (r.judged90 ? <Pct k={r.m1} n={r.judged90} label="Billed the month after the first bill ÷ cohort with 3 months of data" /> : <span className="ld-muted">too recent</span>), sort: (r) => (r.judged90 ? r.m1 / r.judged90 : -1), csv: (r) => (r.judged90 ? ((100 * r.m1) / r.judged90).toFixed(1) : '') },
    { key: 'm3', label: 'Still buying in month 4', num: true, render: (r) => (r.judged90 ? <Pct k={r.m3} n={r.judged90} label="Billed 3 months after the first bill ÷ cohort with 3 months of data" /> : <span className="ld-muted">too recent</span>), sort: (r) => (r.judged90 ? r.m3 / r.judged90 : -1), csv: (r) => (r.judged90 ? ((100 * r.m3) / r.judged90).toFixed(1) : '') },
    { key: 'r90', label: 'First 90 days, per retailer', num: true, render: (r) => (r.judged90 ? inr(r.rev90 / r.judged90) : '—'), sort: (r) => (r.judged90 ? r.rev90 / r.judged90 : -1), csv: (r) => (r.judged90 ? Math.round(r.rev90 / r.judged90) : '') },
    { key: 'rtd', label: 'Sales to date, per retailer', num: true, render: (r) => inr(r.revToDate / r.n), sort: (r) => r.revToDate / r.n, csv: (r) => Math.round(r.revToDate / r.n) },
    { key: 'act', label: 'Ordered in the last 3 months', num: true, render: (r) => <Pct k={r.active} n={r.n} label="Billed in the last 3 months of sales data ÷ cohort" />, sort: (r) => r.active / r.n, csv: (r) => ((100 * r.active) / r.n).toFixed(1) },
  ];

  return (
    <Section def={SECTIONS[2]} n={3}>
      {/* 1 ---------------------------------------------------------------- verdict & KPIs */}
      <h3 className="ld-subhead">1. Verdict &amp; key numbers <span>{period}{noSales ? ' · BO sales data does not reach this period yet' : ''}</span></h3>
      <div className="ld-kpis">
        <Kpi icon={Store} label="New retailers" rag="none" value={noSales ? '—' : num(cur.all)} sub="first-ever BO order in the period"
          delta={<Delta cur={noSales ? null : cur.all} prev={before?.all ?? null} />} info="Shops that placed their first-ever BO order in the period." />
        <Kpi icon={Megaphone} label="From marketing" rag="none" value={noSales ? '—' : num(cur.mkt)} sub={cur.all ? `${pctTxt(cur.mkt, cur.all, 1)} of new retailers` : ''}
          delta={<Delta cur={noSales || !cur.all ? null : (100 * cur.mkt) / cur.all} prev={before && before.all ? (100 * before.mkt) / before.all : null} asPoints />}
          info="New retailers whose first-ever order came after a lead (any lead source), within the Window." />
        <Kpi icon={Sprout} label="Organic" rag="none" value={noSales ? '—' : num(cur.bySrc[ORGANIC])} sub={`${num(cur.byOrg[3])} with no recorded source`}
          delta={<Delta cur={noSales ? null : cur.bySrc[ORGANIC]} prev={before?.bySrc[ORGANIC] ?? null} />} info="New retailers no lead brought in (no lead converted them within the Window)." />
        <Kpi icon={Award} label="Best quality source" rag="none" value={bestM3 ? bestM3.name : '—'}
          sub={bestM3 ? `${pctTxt(bestM3.m3, bestM3.n, 0)} still buying in month 4 (${num(bestM3.n)} retailers)` : `needs ${SMALL_SAMPLE}+ retailers per source`}
          info={`The source whose retailers most often still buy 3 months after their first order, among sources with at least ${SMALL_SAMPLE} retailers with 3 months of data (all cohorts).`} />
        <Kpi icon={Gauge} label="Source unknown" rag="none" value={unknownShare === null || noSales ? '—' : `${unknownShare.toFixed(1)}%`} sub={`${num(cur.byOrg[3])} of ${num(cur.all)} new retailers`}
          info="New retailers with no record of how they came to BO: organic, and no lead follow-up or distributor record. The BO retailer data has no onboarding source, so this stays high until one is added." />
      </div>
      <Card wide title="Verdict" uses={[...RET_USES, 'period']}
        info={{ what: 'A plain summary of the numbers below: which channel brings the most new retailers in the period, and which brings retailers who keep buying (all cohorts with 3 months of data, sources with enough retailers only).' }}>
        {noSales ? <p className="ld-verdict">BO sales data does not reach {period} yet, so no first orders can be counted. Pick an earlier period.</p> : (
          <ul className="ld-verdict">
            <li><b>{num(cur.all)}</b> shops placed their first BO order in {period}: <b>{num(cur.mkt)}</b> ({pctTxt(cur.mkt, cur.all, 1)}) came from leads
              {topVolume && topVolume.n ? <>, most of them from <b>{topVolume.name}</b> ({num(topVolume.n)})</> : ''}, and <b>{num(cur.bySrc[ORGANIC])}</b> were organic.</li>
            {bestM3 && <li>Best at keeping retailers: <b>{bestM3.name}</b>, {pctTxt(bestM3.m3, bestM3.n, 0)} still buying in month 4{bestRev && bestRev.j !== bestM3.j ? <>; highest first-90-day sales: <b>{bestRev.name}</b> ({inr(bestRev.rev / bestRev.n)} per retailer)</> : <> and the highest first-90-day sales ({inr(bestM3.rev / bestM3.n)} per retailer)</>}.</li>}
            {mktQ.n >= SMALL_SAMPLE && orgQ.n >= SMALL_SAMPLE && (
              <li>Lead-sourced retailers: {pctTxt(mktQ.m3, mktQ.n, 0)} still buying in month 4 and {inr(mktQ.rev / mktQ.n)} in their first 90 days, against {pctTxt(orgQ.m3, orgQ.n, 0)} and {inr(orgQ.rev / orgQ.n)} for organic ones
                {wilson(mktQ.m3, mktQ.n)[1] < wilson(orgQ.m3, orgQ.n)[0] ? ': they keep buying less, so fix onboarding before scaling ads.' : wilson(mktQ.m3, mktQ.n)[0] > wilson(orgQ.m3, orgQ.n)[1] ? ': they keep buying more.' : ': no clear difference yet.'}</li>
            )}
            <li>{unknownShare !== null ? `${unknownShare.toFixed(0)}% of new retailers have no recorded source` : 'Most organic retailers have no recorded source'}: the BO data does not say whether an ASM, a distributor or word of mouth brought them in.</li>
          </ul>
        )}
      </Card>

      {/* 2 ---------------------------------------------------------------- volume by source */}
      <h3 className="ld-subhead">2. Volume by source <span>new retailers and the share marketing brought in</span></h3>
      <Card wide title={vol === 'total' ? `New retailers by source, ${period}` : 'New retailers per quarter, by source'} uses={vol === 'total' ? [...RET_USES, 'period'] : [...RET_USES]}
        actions={<IconToggle label="Volume" value={vol} onChange={setVol} options={[{ value: 'total', icon: Sigma, label: 'This period' }, { value: 'quarter', icon: Layers, label: 'By quarter' }]} />}
        info={{ what: 'Retailers by the source that brought them in: the lead source of the lead whose shop placed its first-ever order within the Window, else Organic (no lead did). Marketing = every lead source together.', formula: 'marketing share = new retailers from leads ÷ all new retailers', source: 'BO first orders + lead outcomes' }}
        csv={{ name: vol === 'total' ? 'new_retailers_by_source' : 'new_retailers_by_source_quarter', rows: () => (vol === 'total'
          ? SOURCE_NAMES.map((s, j) => ({ Source: s, 'New retailers': cur.bySrc[j], 'Share %': cur.all ? ((100 * cur.bySrc[j]) / cur.all).toFixed(1) : '' }))
          : perQuarter.map((r) => ({ Quarter: r.q, ...Object.fromEntries(SOURCE_NAMES.map((s, j) => [s, r[`s${j}`]])) }))) }}
        soWhat={!M.p.hasLeads ? 'Every new retailer shows as Organic until lead files are loaded.' : vol === 'total' && cur.all ? <>Marketing brought in <b>{pctTxt(cur.mkt, cur.all, 1)}</b> of the period&apos;s new retailers ({num(cur.mkt)} of {num(cur.all)}).</> : undefined}>
        {vol === 'total' ? (noSales ? <div className="ld-empty-s">BO sales data does not reach this period yet.</div> : (
          <HBars fmt={num} rows={SOURCE_NAMES.map((name, j) => ({ key: name, label: name, value: cur.bySrc[j], color: SOURCE_COLORS[j], note: ` ${pctTxt(cur.bySrc[j], cur.all, 1)}` })).filter((r) => r.value > 0 || r.key !== 'Other')} />
        )) : (
          <StackedBars data={perQuarter} x="q" fmt={num} series={SOURCE_NAMES.map((s, j) => ({ key: `s${j}`, label: s, color: SOURCE_COLORS[j] })).filter((s) => perQuarter.some((r) => (r[s.key] as number) > 0))} />
        )}
      </Card>

      <div className="ld-grid">
        {/* 3 -------------------------------------------------------------- retailer quality */}
        <Card title="3. Retailer quality: first 90 days" uses={[...RET_USES]} actions={toggle}
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
        {/* 4 -------------------------------------------------------------- LTV curve */}
        <Card title="4. LTV curve by acquisition source" uses={[...RET_USES]} actions={toggle}
          info={{ what: 'Average cumulative billing per retailer by months since the first bill. Each point averages only the retailers observed that long (at least 5).', formula: 'Σ cumulative revenue at month k ÷ retailers observed k months', source: 'retailer_month.csv' }}>
          <Lines data={ltv} x="k" fmt={inr} xLabel={(k) => `M${k}`}
            series={groups.filter((g) => ltv.some((r) => r[`g${g.g}`] !== null)).map((g) => ({ key: `g${g.g}`, label: g.name, color: g.color }))} />
        </Card>
      </div>

      {/* 5 ---------------------------------------------------------------- quarterly cohorts */}
      <Card wide title="5. Quarterly cohorts" uses={[...RET_USES]}
        actions={<MiniSelect label="Cohort" value={cohortGroup} onChange={setCohortGroup} options={[
          { value: -1, label: 'All new retailers' }, { value: -2, label: 'From marketing' },
          ...SOURCE_NAMES.map((s, j) => ({ value: j, label: j === ORGANIC ? 'Organic' : `From ${s}` }))]} />}
        info={{ what: `Retailers grouped by the quarter of their first-ever BO order, and how each group has done since. Month 2 / month 4 = billed 1 / 3 months after the first order (only cohorts with 3 months of sales data). Sales to date and the last-3-months check run to ${monthName(M, M.p.salesEnd)}.`, source: 'BO first orders and monthly billing + lead outcomes' }}
        csv={{ name: 'quarterly_cohorts', rows: () => csvRows(cohorts, cohortCols) }}>
        <Table rows={cohorts} cols={cohortCols} limit={20} initialSort={{ key: 'q', dir: 'desc' }} />
      </Card>
    </Section>
  );
}
