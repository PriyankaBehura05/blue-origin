import { useMemo, useState } from 'react';
import { Card, Crumbs, NeedsData, Pct, Section, Table, csvRows, inr, num, useLeads, type Col } from '../ui';
import { heat } from '../charts';
import { SECTIONS } from '../sections';
import { billedIn, health, leadDist, leadOk, NEW, outcomeOf, PENDING, retailerOk, revIn, tierAt } from '../model';

type Level = 'state' | 'city' | 'dist' | 'retailer';
interface Agg { key: number; name: string; leads: number; conv: number; valid: number; retailers: number; fresh: number; revenue: number }

export default function Geography() {
  const { M, f, rg } = useLeads();
  const [path, setPath] = useState<{ state?: number; city?: number; dist?: number }>({});
  const level: Level = path.dist !== undefined ? 'retailer' : path.city !== undefined ? 'dist' : path.state !== undefined ? 'city' : 'state';
  const R = M.p.retailers;
  const L = M.p.leads;
  const end = Math.min(rg[1], M.p.salesEnd);

  const inPath = (s: number, c: number, d: number) =>
    (path.state === undefined || s === path.state) && (path.city === undefined || c === path.city) && (path.dist === undefined || d === path.dist);
  const keyAt = (s: number, c: number, d: number) => (level === 'state' ? s : level === 'city' ? c : d);
  const nameAt = (k: number) => (k < 0 ? '(blank)' : level === 'state' ? M.p.dims.state[k] : level === 'city' ? M.p.dims.city[k] : M.p.dims.dist[k]);

  const rows = useMemo(() => {
    if (level === 'retailer') return [];
    const by = new Map<number, Agg>();
    const get = (k: number) => by.get(k) ?? by.set(k, { key: k, name: nameAt(k), leads: 0, conv: 0, valid: 0, retailers: 0, fresh: 0, revenue: 0 }).get(k)!;
    for (let r = 0; r < M.nR; r++) {
      if (R.first[r] < 0 || R.first[r] > end || !inPath(R.s[r], R.c[r], R.d[r]) || !retailerOk(M, f, r, end)) continue;
      const a = get(keyAt(R.s[r], R.c[r], R.d[r]));
      if (billedIn(M, r, rg[0], rg[1])) a.retailers++;
      if (R.first[r] >= rg[0] && R.first[r] <= rg[1]) a.fresh++;
      a.revenue += revIn(M, r, rg[0], rg[1]);
    }
    const ret = M.ret[f.level];
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !leadOk(M, f, i, rg)) continue;
      const r = ret[i];
      const s = L.s[i] >= 0 ? L.s[i] : r >= 0 ? R.s[r] : -1;
      const c = L.c[i] >= 0 ? L.c[i] : r >= 0 ? R.c[r] : -1;
      const d = leadDist(M, i, r);
      if (!inPath(s, c, d)) continue;
      const a = get(keyAt(s, c, d));
      a.leads++;
      if (L.valid[i] && outcomeOf(M, i, f.level, f.window) !== PENDING) a.valid++; // judged leads only
      if (outcomeOf(M, i, f.level, f.window) === NEW) a.conv++;
    }
    return [...by.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, f, rg, path, level]);

  const retailers = useMemo(() => {
    if (level !== 'retailer') return [];
    const out: number[] = [];
    for (let r = 0; r < M.nR; r++) if (R.first[r] >= 0 && R.first[r] <= end && inPath(R.s[r], R.c[r], R.d[r]) && retailerOk(M, f, r, end)) out.push(r);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, f, rg, path, level]);

  const maxLeads = Math.max(1, ...rows.map((r) => r.leads));
  const maxRet = Math.max(1, ...rows.map((r) => r.retailers));
  const cols: Col<Agg>[] = [
    { key: 'name', label: { state: 'State', city: 'City / district', dist: 'Distributor', retailer: '' }[level], render: (r) => r.name, sort: (r) => r.name },
    ...(M.p.hasLeads ? [
      { key: 'leads', label: 'Unique leads', num: true, render: (r: Agg) => <span className="ld-heat-c" style={{ ...heat(r.leads / maxLeads), padding: '1px 6px', borderRadius: 4 }}>{num(r.leads)}</span>, sort: (r: Agg) => r.leads, csv: (r: Agg) => r.leads },
      { key: 'conv', label: 'Converted', num: true, render: (r: Agg) => num(r.conv), sort: (r: Agg) => r.conv },
      { key: 'rate', label: 'Conv. %', num: true, render: (r: Agg) => <Pct k={r.conv} n={r.valid} label="Converted ÷ valid unique leads with sales data (pending left out)" />, sort: (r: Agg) => (r.valid ? r.conv / r.valid : 0), csv: (r: Agg) => (r.valid ? ((100 * r.conv) / r.valid).toFixed(2) : '') },
    ] : []),
    { key: 'ret', label: 'Retailers billed', num: true, render: (r) => <span style={{ ...heat(r.retailers / maxRet), padding: '1px 6px', borderRadius: 4 }}>{num(r.retailers)}</span>, sort: (r) => r.retailers, csv: (r) => r.retailers },
    { key: 'fresh', label: 'New retailers', num: true, render: (r) => num(r.fresh), sort: (r) => r.fresh },
    { key: 'rev', label: 'Sales', num: true, render: (r) => inr(r.revenue), sort: (r) => r.revenue },
    ...(M.p.hasLeads ? [{ key: 'density', label: 'Leads / 100 retailers', num: true, render: (r: Agg) => (r.retailers ? ((100 * r.leads) / r.retailers).toFixed(0) : r.leads ? '∞' : '—'), sort: (r: Agg) => (r.retailers ? r.leads / r.retailers : r.leads ? 1e9 : 0) }] : []),
  ];
  const rcols: Col<number>[] = [
    { key: 'name', label: 'Retailer', render: (r) => `${R.name[r]} (${R.id[r]})`, sort: (r) => R.name[r] },
    { key: 'tier', label: 'Tier', render: (r) => M.p.dims.tiers[tierAt(M, r, end)] ?? '—', sort: (r) => tierAt(M, r, end) },
    { key: 'health', label: 'Health', render: (r) => health(M, r, end), sort: (r) => health(M, r, end) },
    { key: 'rev', label: 'Sales in period', num: true, render: (r) => inr(revIn(M, r, rg[0], rg[1])), sort: (r) => revIn(M, r, rg[0], rg[1]) },
    { key: 'life', label: 'Lifetime', num: true, render: (r) => inr(R.life[r]), sort: (r) => R.life[r] },
    { key: 'phone', label: 'Phone', render: (r) => R.phone[r] || '—', sort: (r) => R.phone[r] },
  ];

  const whiteSpace = useMemo(() => {
    if (!M.p.hasLeads) return [];
    const leads = new Map<number, number>();
    const ret = M.ret[f.level];
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !L.valid[i] || !leadOk(M, f, i, rg)) continue;
      const c = L.c[i] >= 0 ? L.c[i] : ret[i] >= 0 ? R.c[ret[i]] : -1;
      if (c >= 0) leads.set(c, (leads.get(c) ?? 0) + 1);
    }
    const active = new Map<number, number>();
    for (let r = 0; r < M.nR; r++) if (R.c[r] >= 0 && health(M, r, end) === 'Active') active.set(R.c[r], (active.get(R.c[r]) ?? 0) + 1);
    return [...leads.entries()].map(([c, n]) => ({ c, name: M.p.dims.city[c], leads: n, active: active.get(c) ?? 0, tier: M.p.dims.cityTiers[M.p.dims.cityTier[c]] }))
      .filter((x) => x.leads >= 10 && x.active <= 2);
  }, [M, f, rg, L, R, end]);

  const crumbs = [{ label: 'India', onClick: () => setPath({}) }];
  if (path.state !== undefined) crumbs.push({ label: M.p.dims.state[path.state] ?? '(blank)', onClick: () => setPath({ state: path.state }) });
  if (path.city !== undefined) crumbs.push({ label: M.p.dims.city[path.city] ?? '(blank)', onClick: () => setPath({ state: path.state, city: path.city }) });
  if (path.dist !== undefined) crumbs.push({ label: M.p.dims.dist[path.dist] ?? '(blank)', onClick: () => undefined });
  const down = (k: number) => setPath(level === 'state' ? { state: k } : level === 'city' ? { ...path, city: k } : { ...path, dist: k });

  return (
    <Section def={SECTIONS[7]} n={8}>
      <div className="ld-grid">
        <Card title="Leads vs conversions vs retailer base" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
          info={{ what: 'Click a row to drill down: State → City → Distributor → Retailer. Shading is relative within the column. A lead counts where the lead said it is; without a city, where its matched retailer is. 49% of retailers have no city or district, shown as (blank).', source: 'Lead dump, retailers.csv, retailer_month.csv' }}
          csv={{ name: `geography_${level}`, rows: () => (level === 'retailer' ? csvRows(retailers, rcols) : csvRows(rows, cols)) }}>
          <Crumbs items={crumbs} />
          {level === 'retailer'
            ? <Table rows={retailers} cols={rcols} initialSort={{ key: 'rev', dir: 'desc' }} limit={25} />
            : <Table rows={rows} cols={cols} initialSort={{ key: M.p.hasLeads ? 'leads' : 'rev', dir: 'desc' }} onRow={(r) => down(r.key)} limit={20} />}
        </Card>
        <Card title="White-space cities" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
          info={{ what: 'Cities with 10 or more valid unique leads but at most 2 active retailers: demand without coverage. Candidates for a new distributor or an ASM visit plan.', source: 'Lead dump, retailers.csv' }}
          csv={{ name: 'white_space_cities', rows: () => whiteSpace.map((w) => ({ City: w.name, 'City tier': w.tier, 'Unique leads': w.leads, 'Active retailers': w.active })) }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <Table rows={whiteSpace} initialSort={{ key: 'leads', dir: 'desc' }} empty="No city has 10+ leads with 2 or fewer active retailers." cols={[
              { key: 'name', label: 'City', render: (w) => w.name, sort: (w) => w.name },
              { key: 'tier', label: 'City tier', render: (w) => w.tier, sort: (w) => w.tier },
              { key: 'leads', label: 'Unique leads', num: true, render: (w) => num(w.leads), sort: (w) => w.leads },
              { key: 'active', label: 'Active retailers', num: true, render: (w) => num(w.active), sort: (w) => w.active },
            ]} />
          )}
        </Card>
      </div>
    </Section>
  );
}
