// States & cities. The drill-down IS the State and City filter of the filter bar: clicking a state sets the State filter,
// clicking a city sets the City filter, so the KPIs, every card here and the Repeat buying page all follow the same place.
// Path: India -> state -> city -> retailer -> purchase history. Lead figures use mobile-number matches only (repeat.ts).
import { useMemo, useState } from 'react';
import { Card, Crumbs, NeedsData, Pct, Table, Section, csvRows, inr, num, useLeads, type Col } from '../ui';
import { heat, StackedBars } from '../charts';
import { SECTIONS, SOURCE_NAMES, TIER_COLORS } from '../sections';
import { health, leadOk, NEW, outcomeOf, PENDING, REACTIVATED, revIn, tierAt } from '../model';
import { activeRetailers, addRetailer, conversions, emptyStats, endOf, leadInScope, leadPlace, phoneCredit, phoneMatched, type RepeatStats } from '../repeat';
import { CrossLink, PurchaseHistory, ScopeKpis } from './RepeatParts';

type Level = 'state' | 'city' | 'retailer';
interface Side { leads: number; judged: number; conv: number; retailers: number; repeat: number }
interface Area {
  key: number; name: string;
  leads: number; judged: number; convLeads: number; // leads, judged leads, converted leads (mobile match)
  conv: number; fresh: number; s: RepeatStats; // converted retailers (one each) and their repeat buying
  billed: number; sales: number; tiers: number[]; // retailers that bought in the period, their billing and tiers
  plat: Record<'Meta' | 'Google', Side>;
}
const USES = ['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window', 'stage', 'rwin'] as const;
const MIN_JUDGED = 30;
const side = (): Side => ({ leads: 0, judged: 0, conv: 0, retailers: 0, repeat: 0 });
const rate = (k: number, n: number) => (n ? k / n : -1);

export default function Geography() {
  const { M, f, rg, set } = useLeads();
  const [open, setOpen] = useState<number | null>(null);
  const level: Level = f.city >= 0 ? 'retailer' : f.state >= 0 ? 'city' : 'state';
  const groupLevel: 'state' | 'city' = level === 'state' ? 'state' : 'city';
  const R = M.p.retailers;
  const L = M.p.leads;
  const d = M.p.dims;
  const end = endOf(M, rg);
  const plats = { Meta: d.source.indexOf('Meta'), Google: d.source.indexOf('Google') };
  const platOf = (src: number) => (src === plats.Meta ? 'Meta' : src === plats.Google ? 'Google' : null);
  const nameOf = (k: number) => (k < 0 ? '(not set)' : groupLevel === 'state' ? d.state[k] : d.city[k]);
  const label = groupLevel === 'state' ? 'State' : 'City';

  const conv = useMemo(() => conversions(M, f, rg), [M, f, rg]);
  const active = useMemo(() => activeRetailers(M, f, rg), [M, f, rg]);
  const nOf = useMemo(() => new Map(active.map((x) => [x.r, x.n])), [active]);
  const credit = phoneCredit(M, f.level, f.window);

  const areas = useMemo(() => {
    const by = new Map<number, Area>();
    const get = (k: number) => by.get(k) ?? by.set(k, { key: k, name: nameOf(k), leads: 0, judged: 0, convLeads: 0, conv: 0, fresh: 0, s: emptyStats(), billed: 0, sales: 0, tiers: new Array(d.tiers.length + 1).fill(0), plat: { Meta: side(), Google: side() } }).get(k)!;
    for (let i = 0; i < M.nL; i++) {
      if (!leadInScope(M, f, i, rg)) continue;
      const p = leadPlace(M, f.level, i);
      const a = get(groupLevel === 'state' ? p.s : p.c);
      const o = outcomeOf(M, i, f.level, f.window);
      const judged = L.valid[i] && o !== PENDING;
      const won = judged && (o === NEW || o === REACTIVATED) && phoneMatched(M, f.level, i);
      a.leads++; if (judged) a.judged++; if (won) a.convLeads++;
      const pl = platOf(L.src[i]);
      if (pl) { a.plat[pl].leads++; if (judged) a.plat[pl].judged++; if (won) a.plat[pl].conv++; }
    }
    for (const x of conv) {
      const p = leadPlace(M, f.level, x.lead);
      const a = get(groupLevel === 'state' ? p.s : p.c);
      a.conv++;
      if (x.kind === NEW) a.fresh++;
      const before = a.s.second;
      addRetailer(M, a.s, x.r, x.c, f.rwin);
      const pl = platOf(x.src);
      if (pl) { a.plat[pl].retailers++; if (a.s.second > before) a.plat[pl].repeat++; }
    }
    for (const x of active) {
      const a = get(groupLevel === 'state' ? R.s[x.r] : R.c[x.r]);
      a.billed++;
      a.sales += revIn(M, x.r, rg[0], end);
      a.tiers[tierAt(M, x.r, end) + 1]++;
    }
    return [...by.values()];
  }, [M, f, rg, conv, active, groupLevel, end]); // eslint-disable-line react-hooks/exhaustive-deps

  const down = (k: number) => { if (k < 0) return; set(groupLevel === 'state' ? { state: k, city: -1 } : { city: k }); };
  const crumbs = [{ label: 'India', onClick: () => set({ state: -1, city: -1 }) }];
  if (f.state >= 0) crumbs.push({ label: d.state[f.state], onClick: () => set({ city: -1 }) });
  if (f.city >= 0) crumbs.push({ label: d.city[f.city], onClick: () => undefined });

  const maxLeads = Math.max(1, ...areas.map((a) => a.leads));
  const tierIdx = d.tiers.map((_, i) => i).filter((i) => i > 0).reverse(); // Platinum .. Yellow
  const cols: Col<Area>[] = [
    { key: 'name', label, render: (a) => a.name, sort: (a) => a.name },
    ...(M.p.hasLeads ? [
      { key: 'leads', label: 'Leads', num: true, render: (a: Area) => <span style={{ ...heat(a.leads / maxLeads), padding: '1px 6px', borderRadius: 4 }}>{num(a.leads)}</span>, sort: (a: Area) => a.leads, csv: (a: Area) => a.leads },
      { key: 'conv', label: 'Converted retailers', num: true, render: (a: Area) => num(a.conv), sort: (a: Area) => a.conv },
      { key: 'rate', label: 'Conv. %', num: true, render: (a: Area) => <Pct k={a.convLeads} n={a.judged} label="Converted leads ÷ leads that can be judged" />, sort: (a: Area) => rate(a.convLeads, a.judged), csv: (a: Area) => (a.judged ? ((100 * a.convLeads) / a.judged).toFixed(1) : 'N/A') },
      { key: 'repeat', label: 'Repeat buyers', num: true, render: (a: Area) => num(a.s.second), sort: (a: Area) => a.s.second },
      { key: 'rrate', label: `Repeat ${f.rwin} mo`, num: true, render: (a: Area) => (a.s.eligible ? <Pct k={a.s.repeatIn} n={a.s.eligible} label={`Bought again within ${f.rwin} months ÷ converted retailers whose window is complete`} /> : <span className="ld-muted">N/A</span>), sort: (a: Area) => rate(a.s.repeatIn, a.s.eligible), csv: (a: Area) => (a.s.eligible ? ((100 * a.s.repeatIn) / a.s.eligible).toFixed(1) : 'N/A') },
      { key: 'revc', label: 'Revenue, converted', num: true, render: (a: Area) => (a.conv ? inr(a.s.revFirst + a.s.revAfter) : '—'), sort: (a: Area) => a.s.revFirst + a.s.revAfter, csv: (a: Area) => Math.round(a.s.revFirst + a.s.revAfter) },
    ] : []),
    { key: 'billed', label: 'Retailers billed', num: true, render: (a) => num(a.billed), sort: (a) => a.billed },
    { key: 'sales', label: 'BO sales in period', num: true, render: (a) => inr(a.sales), sort: (a) => a.sales, csv: (a) => Math.round(a.sales) },
    { key: 'tiers', label: 'Tier mix', render: (a) => <TierMix t={a.tiers} />, sort: (a) => a.tiers.slice(2).reduce((s, v) => s + v, 0),
      csv: (a) => tierIdx.map((t) => `${d.tiers[t]} ${a.tiers[t + 1]}`).join(' · ') },
  ];

  // retailer level: the city's retailers that bought in the period
  const rcols: Col<number>[] = [
    { key: 'name', label: 'Retailer', render: (r) => R.name[r], sort: (r) => R.name[r] },
    { key: 'id', label: 'ID', render: (r) => R.id[r], sort: (r) => R.id[r] },
    { key: 'dist', label: 'Distributor', render: (r) => d.dist[R.d[r]] ?? '—', sort: (r) => d.dist[R.d[r]] ?? '' },
    { key: 'tier', label: 'Tier', render: (r) => d.tiers[tierAt(M, r, end)] ?? '—', sort: (r) => tierAt(M, r, end) },
    { key: 'n', label: 'Purchases', num: true, render: (r) => num(nOf.get(r) ?? 0), sort: (r) => nOf.get(r) ?? 0 },
    { key: 'src', label: 'Brought in by', render: (r) => (credit.lead[r] >= 0 ? SOURCE_NAMES[credit.src[r]] : 'Organic'), sort: (r) => credit.src[r] },
    { key: 'sales', label: 'Billing in period', num: true, render: (r) => inr(revIn(M, r, rg[0], end)), sort: (r) => revIn(M, r, rg[0], end), csv: (r) => Math.round(revIn(M, r, rg[0], end)) },
    { key: 'health', label: 'Status', render: (r) => health(M, r, M.p.salesEnd), sort: (r) => health(M, r, M.p.salesEnd) },
    { key: 'phone', label: 'Phone', render: (r) => R.phone[r] || '—', sort: (r) => R.phone[r] },
  ];
  const cityRetailers = useMemo(() => (level === 'retailer' ? active.map((x) => x.r) : []), [level, active]);

  // top / low performers: places with enough judged leads, by conversion rate
  const ranked = areas.filter((a) => a.key >= 0 && a.judged >= MIN_JUDGED).sort((a, b) => b.convLeads / b.judged - a.convLeads / a.judged);
  const top = ranked.slice(0, 5);
  const low = ranked.slice(-5).reverse().filter((a) => !top.includes(a));
  const tierChart = [...areas].filter((a) => a.key >= 0).sort((a, b) => b.billed - a.billed).slice(0, 12)
    .map((a) => ({ area: a.name, ...Object.fromEntries(tierIdx.map((t) => [d.tiers[t], a.tiers[t + 1]])) }));
  const platRows = areas.filter((a) => a.plat.Meta.leads + a.plat.Google.leads > 0);
  const platCols: Col<Area>[] = [
    { key: 'name', label, render: (a) => a.name, sort: (a) => a.name },
    ...(['Meta', 'Google'] as const).flatMap((p) => [
      { key: `${p}l`, label: `${p} leads`, num: true, render: (a: Area) => num(a.plat[p].leads), sort: (a: Area) => a.plat[p].leads },
      { key: `${p}c`, label: `${p} converted`, num: true, render: (a: Area) => num(a.plat[p].retailers), sort: (a: Area) => a.plat[p].retailers },
      { key: `${p}r`, label: `${p} conv. %`, num: true, render: (a: Area) => <Pct k={a.plat[p].conv} n={a.plat[p].judged} label={`${p}: converted leads ÷ leads that can be judged`} />, sort: (a: Area) => rate(a.plat[p].conv, a.plat[p].judged), csv: (a: Area) => (a.plat[p].judged ? ((100 * a.plat[p].conv) / a.plat[p].judged).toFixed(1) : 'N/A') },
      { key: `${p}x`, label: `${p} repeat buyers`, num: true, render: (a: Area) => num(a.plat[p].repeat), sort: (a: Area) => a.plat[p].repeat },
    ]),
  ];

  // campaign x place
  const campGeo = useMemo(() => {
    if (!M.p.hasLeads) return [];
    const by = new Map<string, { camp: number; area: number; leads: number; judged: number; convLeads: number; retailers: number; repeat: number; rev: number }>();
    const get = (camp: number, area: number) => {
      const k = `${camp}|${area}`;
      return by.get(k) ?? by.set(k, { camp, area, leads: 0, judged: 0, convLeads: 0, retailers: 0, repeat: 0, rev: 0 }).get(k)!;
    };
    for (let i = 0; i < M.nL; i++) {
      if (!leadInScope(M, f, i, rg) || L.camp[i] < 0) continue;
      const p = leadPlace(M, f.level, i);
      const e = get(L.camp[i], groupLevel === 'state' ? p.s : p.c);
      const o = outcomeOf(M, i, f.level, f.window);
      e.leads++;
      if (L.valid[i] && o !== PENDING) { e.judged++; if ((o === NEW || o === REACTIVATED) && phoneMatched(M, f.level, i)) e.convLeads++; }
    }
    for (const x of conv) {
      if (x.camp < 0) continue;
      const p = leadPlace(M, f.level, x.lead);
      const e = get(x.camp, groupLevel === 'state' ? p.s : p.c);
      const s = emptyStats();
      addRetailer(M, s, x.r, x.c, f.rwin);
      e.retailers++; e.repeat += s.second; e.rev += s.revFirst + s.revAfter;
    }
    return [...by.values()];
  }, [M, f, rg, conv, groupLevel, L]);
  type CG = (typeof campGeo)[number];
  const cgCols: Col<CG>[] = [
    { key: 'camp', label: 'Campaign', render: (x) => d.campaign[x.camp] ?? '—', sort: (x) => d.campaign[x.camp] ?? '' },
    { key: 'area', label, render: (x) => nameOf(x.area), sort: (x) => nameOf(x.area) },
    { key: 'leads', label: 'Leads', num: true, render: (x) => num(x.leads), sort: (x) => x.leads },
    { key: 'conv', label: 'Converted retailers', num: true, render: (x) => num(x.retailers), sort: (x) => x.retailers },
    { key: 'rate', label: 'Conv. %', num: true, render: (x) => <Pct k={x.convLeads} n={x.judged} />, sort: (x) => rate(x.convLeads, x.judged), csv: (x) => (x.judged ? ((100 * x.convLeads) / x.judged).toFixed(1) : 'N/A') },
    { key: 'repeat', label: 'Repeat buyers', num: true, render: (x) => num(x.repeat), sort: (x) => x.repeat },
    { key: 'rev', label: 'Revenue, converted', num: true, render: (x) => (x.retailers ? inr(x.rev) : '—'), sort: (x) => x.rev, csv: (x) => Math.round(x.rev) },
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
    const act = new Map<number, number>();
    for (let r = 0; r < M.nR; r++) if (R.c[r] >= 0 && health(M, r, end) === 'Active') act.set(R.c[r], (act.get(R.c[r]) ?? 0) + 1);
    return [...leads.entries()].map(([c, n]) => ({ c, name: d.city[c], leads: n, active: act.get(c) ?? 0, tier: d.cityTiers[d.cityTier[c]] }))
      .filter((x) => x.leads >= 10 && x.active <= 2);
  }, [M, f, rg, L, R, end, d]);

  const perfRow = (a: Area) => (
    <li key={a.key} className="ld-ins-row click" onClick={() => down(a.key)}>
      <div className="ld-ins-n"><b>{a.name}</b></div>
      <div className="ld-ins-m">
        <span>Conv. <b><Pct k={a.convLeads} n={a.judged} /></b></span><span>Leads <b>{num(a.leads)}</b></span>
        <span>Converted <b>{num(a.conv)}</b></span><span>Repeat <b>{num(a.s.second)}</b></span><span>BO sales <b>{inr(a.sales)}</b></span>
      </div>
    </li>
  );

  return (
    <Section def={SECTIONS[7]} n={8}>
      <ScopeKpis />
      <div className="ld-related"><span className="ld-muted">Same filters, by tier:</span><CrossLink to="retention" label="Repeat buying & tiers" /></div>
      <div className="ld-grid">
        <Card title={level === 'retailer' ? `Retailers in ${d.city[f.city]}` : `Leads, conversion, repeat buying and revenue by ${label.toLowerCase()}`} wide uses={[...USES]}
          info={{ what: <>Click a state, then a city, then a retailer for its purchase history. Clicking sets the State and City filters, so the whole dashboard follows. A lead counts where it said it is; without a city, where its matched retailer is. Converted retailers and repeat buyers use mobile-number matches only, one retailer once. Retailers billed, BO sales and the tier mix cover every BO retailer that bought in the period (tier in the period's last quarter with sales).</>,
            formula: `conversion = converted leads ÷ leads that can be judged · repeat = 2nd purchase within ${f.rwin} months ÷ converted retailers whose window is complete`, source: 'Lead sheet, BO billing, recomputed tiers' }}
          csv={{ name: `places_${level}`, rows: () => (level === 'retailer' ? csvRows(cityRetailers, rcols) : csvRows(areas, cols)) }}>
          <Crumbs items={crumbs} />
          {level === 'retailer'
            ? <Table rows={cityRetailers} cols={rcols} initialSort={{ key: 'sales', dir: 'desc' }} limit={25} onRow={(r) => setOpen(r)} empty="No retailer in this city bought in the period with these filters." />
            : <Table rows={areas} cols={cols} initialSort={{ key: M.p.hasLeads ? 'leads' : 'sales', dir: 'desc' }} onRow={(a) => down(a.key)} limit={20} />}
        </Card>
        {level !== 'retailer' && M.p.hasLeads && (
          <Card title={`Top and low-performing ${groupLevel === 'state' ? 'states' : 'cities'}`} uses={[...USES]}
            info={{ what: `Ranked by lead conversion rate, among places with at least ${MIN_JUDGED} leads that can be judged (fewer is too few to rank fairly). Click one to drill in.` }}>
            {!ranked.length ? <div className="ld-empty-s">No {groupLevel} has {MIN_JUDGED}+ leads that can be judged for these filters.</div> : (
              <>
                <div className="ld-subtle-h">Top</div><ul className="ld-ins">{top.map(perfRow)}</ul>
                {low.length > 0 && <><div className="ld-subtle-h">Lowest</div><ul className="ld-ins">{low.map(perfRow)}</ul></>}
              </>
            )}
          </Card>
        )}
        {level !== 'retailer' && (
          <Card title={`Retailer tiers by ${groupLevel}`} uses={[...USES]}
            info={{ what: `Retailers that bought in the period, by their tier in the period's last quarter with sales, for the 12 ${groupLevel === 'state' ? 'states' : 'cities'} with the most such retailers. Untiered retailers are left out of the chart (the table above has the full mix).` }}
            csv={{ name: `tiers_by_${groupLevel}`, rows: () => areas.map((a) => ({ [label]: a.name, ...Object.fromEntries([0, ...tierIdx].map((t) => [d.tiers[t], a.tiers[t + 1]])) })) }}>
            {!tierChart.length ? <div className="ld-empty-s">No retailers billed for these filters.</div>
              : <StackedBars data={tierChart} x="area" fmt={num} height={260} series={tierIdx.map((t) => ({ key: d.tiers[t], label: d.tiers[t], color: TIER_COLORS[t] }))} />}
          </Card>
        )}
        {level !== 'retailer' && M.p.hasLeads && (
          <Card title={`Meta vs Google by ${groupLevel}`} wide uses={[...USES]}
            info={{ what: 'Each platform\'s leads, converted retailers (mobile-number match, one retailer once, credited to the converting lead\'s platform), conversion rate and repeat buyers per place. Ad spend is not reported by state or city, so cost figures are N/A here.' }}
            csv={{ name: `meta_vs_google_by_${groupLevel}`, rows: () => csvRows(platRows, platCols) }}>
            <Table rows={platRows} cols={platCols} initialSort={{ key: 'Metal', dir: 'desc' }} onRow={(a) => down(a.key)} limit={15} empty="No Meta or Google leads for these filters." />
          </Card>
        )}
        {level !== 'retailer' && M.p.hasLeads && (
          <Card title={`Campaigns by ${groupLevel}`} wide uses={[...USES]}
            info={{ what: `Each campaign in each ${groupLevel}: leads, converted retailers, conversion rate, repeat buyers and their revenue. Click a row to filter the dashboard to that campaign and place.` }}
            csv={{ name: `campaigns_by_${groupLevel}`, rows: () => csvRows(campGeo, cgCols) }}>
            <Table rows={campGeo} cols={cgCols} initialSort={{ key: 'leads', dir: 'desc' }} limit={15}
              onRow={(x) => set(groupLevel === 'state' ? { campaign: x.camp, ...(x.area >= 0 ? { state: x.area, city: -1 } : {}) } : { campaign: x.camp, ...(x.area >= 0 ? { city: x.area } : {}) })}
              empty="No campaign leads for these filters." />
          </Card>
        )}
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
      {open !== null && <PurchaseHistory r={open} onClose={() => setOpen(null)} />}
    </Section>
  );
}

/** Platinum .. Yellow counts as a thin stacked bar, with the numbers on hover. */
function TierMix({ t }: { t: number[] }) {
  const { M } = useLeads();
  const d = M.p.dims.tiers;
  const idx = d.map((_, i) => i).filter((i) => i > 0).reverse();
  const tot = idx.reduce((s, i) => s + t[i + 1], 0);
  if (!tot) return <span className="ld-muted">—</span>;
  return (
    <span className="ld-tiermix" title={idx.map((i) => `${d[i]} ${t[i + 1]}`).join(' · ') + ` · Untiered ${t[1]}`}>
      {idx.map((i) => (t[i + 1] ? <i key={i} style={{ flexGrow: t[i + 1], background: TIER_COLORS[i] }} /> : null))}
    </span>
  );
}
