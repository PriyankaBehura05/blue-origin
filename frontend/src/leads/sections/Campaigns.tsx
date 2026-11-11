import { useMemo, useState } from 'react';
import { Card, Crumbs, NeedsData, Pct, Section, Table, csvRows, inr, num, useLeads, type Col } from '../ui';
import { SECTIONS } from '../sections';
import { leadOk, NEW, outcomeOf, PENDING, revIn, SMALL_SAMPLE, spendIn, type Model } from '../model';

interface Row {
  key: number;
  name: string;
  spend: number;
  rows: number;
  unique: number;
  valid: number;
  conv: number;
  rev90: number;
  rev180: number;
}
type Tag = 'Scale' | 'Fix' | 'Kill' | 'Too early';

function tagOf(r: Row, t: Record<string, number>, hasSpend: boolean): Tag {
  if (r.valid < SMALL_SAMPLE) return 'Too early';
  const rate = (100 * r.conv) / r.valid;
  const cpr = r.conv ? r.spend / r.conv : Infinity;
  if (rate >= t.conversion_pct && (!hasSpend || cpr <= t.cost_per_retailer)) return 'Scale';
  if (rate < 0.5 * t.conversion_pct && (!hasSpend || cpr > 2 * t.cost_per_retailer)) return 'Kill';
  return 'Fix';
}

function aggregate(M: Model, idx: number[], level: number, window: number) {
  let rows = 0, unique = 0, valid = 0, conv = 0, rev90 = 0, rev180 = 0;
  const ret = M.ret[level];
  for (const i of idx) {
    rows++;
    if (!M.p.leads.uniq[i]) continue;
    unique++;
    if (M.p.leads.valid[i] && outcomeOf(M, i, level, window) !== PENDING) valid++; // judged leads only
    if (outcomeOf(M, i, level, window) === NEW) {
      conv++;
      const r = ret[i];
      const first = M.p.retailers.first[r];
      rev90 += revIn(M, r, first, first + 2);
      rev180 += revIn(M, r, first, first + 5);
    }
  }
  return { rows, unique, valid, conv, rev90, rev180 };
}

export default function Campaigns() {
  const { M, f, rg } = useLeads();
  const [src, setSrc] = useState<number | null>(null);
  const [camp, setCamp] = useState<number | null>(null);
  const t = M.p.targets;
  const margin = (t.gross_margin_pct ?? 30) / 100;
  const L = M.p.leads;

  const leadsIn = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < M.nL; i++) if (leadOk(M, f, i, rg)) out.push(i);
    return out;
  }, [M, f, rg]);

  const rows: Row[] = useMemo(() => {
    const by = new Map<number, number[]>();
    for (const i of leadsIn) {
      if (src !== null && L.src[i] !== src) continue;
      const k = src === null ? L.src[i] : L.camp[i];
      (by.get(k) ?? by.set(k, []).get(k)!).push(i);
    }
    return [...by.entries()].map(([key, idx]) => {
      const a = aggregate(M, idx, f.level, f.window);
      let spend = 0;
      if (src === null) {
        const camps = new Set(idx.map((i) => L.camp[i]));
        camps.forEach((c) => (spend += spendIn(M, rg, c)));
      } else spend = spendIn(M, rg, key);
      return { key, name: src === null ? M.p.dims.source[key] : M.p.dims.campaign[key] ?? '(none)', spend, ...a };
    });
  }, [M, f, rg, leadsIn, src, L]);

  const leadRows = useMemo(() => (camp === null ? [] : leadsIn.filter((i) => L.camp[i] === camp && (src === null || L.src[i] === src))), [leadsIn, camp, src, L]);

  const hasSpend = M.p.hasSpend;
  const cols: Col<Row>[] = [
    { key: 'name', label: src === null ? 'Source' : 'Campaign', render: (r) => r.name, sort: (r) => r.name },
    ...(hasSpend ? [{ key: 'spend', label: 'Spend', num: true, render: (r: Row) => inr(r.spend), sort: (r: Row) => r.spend }] : []),
    { key: 'rows', label: 'Leads', num: true, render: (r) => num(r.rows), sort: (r) => r.rows },
    ...(hasSpend ? [{ key: 'cpl', label: 'CPL', num: true, render: (r: Row) => (r.rows ? inr(r.spend / r.rows) : '—'), sort: (r: Row) => (r.rows ? r.spend / r.rows : 0) }] : []),
    { key: 'rep', label: 'Repeat %', num: true, render: (r) => <Pct k={r.rows - r.unique} n={r.rows} label="Repeat rows ÷ rows" ci={false} />, sort: (r) => (r.rows ? (r.rows - r.unique) / r.rows : 0) },
    { key: 'conv', label: 'Converted', num: true, render: (r) => num(r.conv), sort: (r) => r.conv },
    { key: 'rate', label: 'Conv. %', num: true, render: (r) => <Pct k={r.conv} n={r.valid} label="Converted ÷ valid unique leads old enough to judge" />, sort: (r) => (r.valid ? r.conv / r.valid : 0), csv: (r) => (r.valid ? ((100 * r.conv) / r.valid).toFixed(2) : '') },
    ...(hasSpend ? [{ key: 'cpr', label: 'Cost / converted', num: true, render: (r: Row) => (r.conv ? inr(r.spend / r.conv) : '—'), sort: (r: Row) => (r.conv ? r.spend / r.conv : Infinity) }] : []),
    { key: 'rev90', label: '90-day revenue', num: true, render: (r) => inr(r.rev90), sort: (r) => r.rev90 },
    ...(hasSpend ? [
      { key: 'payback', label: 'Payback (months)', num: true, render: (r: Row) => (r.rev90 ? ((r.spend / ((r.rev90 / 3) * margin))).toFixed(1) : '—'), sort: (r: Row) => (r.rev90 ? r.spend / ((r.rev90 / 3) * margin) : Infinity) },
      { key: 'roi', label: '6-month ROI', num: true, render: (r: Row) => (r.spend ? `${((100 * (r.rev180 * margin - r.spend)) / r.spend).toFixed(0)}%` : '—'), sort: (r: Row) => (r.spend ? (r.rev180 * margin - r.spend) / r.spend : 0) },
    ] : []),
    { key: 'tag', label: 'Call', render: (r) => { const g = tagOf(r, t, hasSpend); return <span className={`ld-tag ${g === 'Too early' ? 'early' : g.toLowerCase()}`}>{g}</span>; }, sort: (r) => tagOf(r, t, hasSpend) },
  ];

  const leadCols: Col<number>[] = [
    { key: 'date', label: 'Lead date', render: (i) => new Date(L.day[i] * 86400000).toLocaleDateString('en-IN'), sort: (i) => L.day[i] },
    { key: 'name', label: 'Name', render: (i) => L.name[i] || '—', sort: (i) => L.name[i] },
    { key: 'mob', label: 'Mobile', render: (i) => L.mob[i] || 'invalid', sort: (i) => L.mob[i] },
    { key: 'city', label: 'City', render: (i) => (L.c[i] >= 0 ? M.p.dims.city[L.c[i]] : '—'), sort: (i) => (L.c[i] >= 0 ? M.p.dims.city[L.c[i]] : '') },
    { key: 'adset', label: 'Ad set', render: (i) => M.p.dims.adset[L.adset[i]] ?? '—', sort: (i) => M.p.dims.adset[L.adset[i]] ?? '' },
    { key: 'out', label: 'Outcome', render: (i) => (L.uniq[i] ? M.p.dims.outcomes[outcomeOf(M, i, f.level, f.window)] : 'Repeat lead'), sort: (i) => outcomeOf(M, i, f.level, f.window) },
    { key: 'ret', label: 'Matched retailer', render: (i) => { const r = M.ret[f.level][i]; return r >= 0 ? `${M.p.retailers.name[r]} (${M.p.retailers.id[r]})` : '—'; }, sort: (i) => M.ret[f.level][i] },
    { key: 'pass', label: 'Match', render: (i) => (['—', 'exact', 'alternate', `fuzzy ${L.conf[i]}`][L.pass[i]]), sort: (i) => L.pass[i] },
  ];

  const crumbs = [{ label: 'All sources', onClick: () => { setSrc(null); setCamp(null); } }];
  if (src !== null) crumbs.push({ label: M.p.dims.source[src], onClick: () => setCamp(null) });
  if (camp !== null) crumbs.push({ label: M.p.dims.campaign[camp] ?? '(none)', onClick: () => undefined });

  return (
    <Section def={SECTIONS[3]} n={4}>
      <div className="ld-grid">
        <Card title="Scorecard: scale, fix or kill" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
          info={{
            what: <>Click a source to see its campaigns, then a campaign to see its leads. <b>Rule:</b> under {SMALL_SAMPLE} valid unique leads = Too early. Scale = conversion ≥ {t.conversion_pct}%{hasSpend ? ` and cost per converted ≤ ${inr(t.cost_per_retailer)}` : ''}. Kill = conversion &lt; {t.conversion_pct / 2}%{hasSpend ? ` and cost per converted > ${inr(2 * t.cost_per_retailer)}` : ''}. Everything else = Fix.</>,
            formula: hasSpend ? `CPL = spend ÷ leads; cost/converted = spend ÷ converted; payback = spend ÷ (90-day revenue ÷ 3 × ${t.gross_margin_pct}% margin); 6-month ROI = (6-month revenue × margin − spend) ÷ spend` : 'Conversion = converted ÷ valid unique leads',
            source: 'Lead dump, spend sheet, retailer_month.csv',
          }}
          csv={{ name: camp !== null ? 'campaign_leads' : src !== null ? 'campaign_scorecard' : 'source_scorecard', rows: () => (camp !== null ? csvRows(leadRows, leadCols) : csvRows(rows, cols).map((r, j) => ({ ...r, Call: tagOf(rows[j], t, hasSpend) }))) }}
          soWhat={!hasSpend && M.p.hasLeads ? 'No spend loaded: CPL, cost per converted retailer, payback and ROI are skipped; the call uses conversion only.' : undefined}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <>
              <Crumbs items={crumbs} />
              {camp === null
                ? <Table rows={rows} cols={cols} initialSort={{ key: 'rows', dir: 'desc' }} onRow={(r) => (src === null ? setSrc(r.key) : setCamp(r.key))} />
                : <Table rows={leadRows} cols={leadCols} initialSort={{ key: 'date', dir: 'desc' }} limit={25} />}
            </>
          )}
        </Card>
      </div>
    </Section>
  );
}
