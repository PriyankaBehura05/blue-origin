// The repeat-buying part of "Repeat buying & tiers" (engine: repeat.ts). Every card follows every filter, the Purchase
// stage and the Repeat-within window included. Drill path: tier -> repeat buyers -> retailer -> purchase history.
import { useMemo, useRef, useState } from 'react';
import { CalendarClock, IndianRupee, Layers3, Repeat, UserPlus } from 'lucide-react';
import { Card, Kpi, Pct, Table, csvRows, inr, num, pctTxt, useLeads, type Col } from '../ui';
import { HBars, StackedBars } from '../charts';
import { SOURCE_NAMES, TIER_COLORS } from '../sections';
import { health, monthName, NEW, quarterShort, revIn, tierAt } from '../model';
import { activeRetailers, avgGap, conversions, emptyStats, addRetailer, endOf, newRetailers, phoneCredit, STAGES, statsOf, type RepeatStats } from '../repeat';
import { CrossLink, PurchaseHistory, ScopeKpis } from './RepeatParts';

const USES = ['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window', 'stage', 'rwin'] as const;
const LEAD_USES = [...USES, 'outcome'] as const;
const months = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} months`);

interface Group { key: number; name: string; s: RepeatStats; fresh: number }

/** Columns shared by the tier, platform and campaign tables. */
function statCols<T extends { s: RepeatStats }>(rwin: number, extra: Col<T>[] = []): Col<T>[] {
  return [
    ...extra,
    { key: 'n', label: 'Retailers', num: true, render: (g) => num(g.s.n), sort: (g) => g.s.n },
    { key: 'second', label: '2nd purchase', num: true, render: (g) => num(g.s.second), sort: (g) => g.s.second },
    { key: 'third', label: '3+ purchases', num: true, render: (g) => num(g.s.third), sort: (g) => g.s.third },
    { key: 'rate', label: `Repeat within ${rwin} mo`, num: true,
      render: (g) => (g.s.eligible ? <Pct k={g.s.repeatIn} n={g.s.eligible} label={`Bought again within ${rwin} months ÷ retailers whose ${rwin}-month window is complete`} /> : <span className="ld-muted">N/A</span>),
      sort: (g) => (g.s.eligible ? g.s.repeatIn / g.s.eligible : -1), csv: (g) => (g.s.eligible ? ((100 * g.s.repeatIn) / g.s.eligible).toFixed(1) : 'N/A') },
    { key: 'elig', label: 'Window complete', num: true, render: (g) => num(g.s.eligible), sort: (g) => g.s.eligible },
    { key: 'gap', label: '1st → 2nd', num: true, render: (g) => months(avgGap(g.s)), sort: (g) => avgGap(g.s) ?? -1, csv: (g) => avgGap(g.s)?.toFixed(2) ?? 'N/A' },
    { key: 'first', label: 'First-purchase billing', num: true, render: (g) => inr(g.s.revFirst), sort: (g) => g.s.revFirst, csv: (g) => Math.round(g.s.revFirst) },
    { key: 'after', label: 'Repeat revenue', num: true, render: (g) => inr(g.s.revAfter), sort: (g) => g.s.revAfter, csv: (g) => Math.round(g.s.revAfter) },
  ];
}

export default function RepeatBuying() {
  const { M, f, rg, set } = useLeads();
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const d = M.p.dims;
  const R = M.p.retailers;
  const end = endOf(M, rg);
  const lastQ = quarterShort(M.p.monthQuarter[end]);
  const sales = monthName(M, M.p.salesEnd);

  const cohort = useMemo(() => newRetailers(M, f, rg), [M, f, rg]);
  const cs = useMemo(() => statsOf(M, cohort, f.rwin), [M, cohort, f.rwin]);
  const active = useMemo(() => activeRetailers(M, f, rg), [M, f, rg]);
  const conv = useMemo(() => conversions(M, f, rg), [M, f, rg]);
  const credit = phoneCredit(M, f.level, f.window);
  const fromLeads = cohort.filter((x) => credit.lead[x.r] >= 0).length;

  // tier distribution of the retailers that bought in the period: first-time (1 purchase so far) vs repeat (2+)
  const tierDist = useMemo(() => {
    const rows = [-1, ...d.tiers.map((_, i) => i)].map((t) => ({ t, label: t < 0 ? `No tier in ${lastQ}` : d.tiers[t], first: 0, repeat: 0 }));
    for (const x of active) {
      const row = rows[tierAt(M, x.r, end) + 1];
      if (x.n >= 2) row.repeat++; else row.first++;
    }
    return rows.filter((r) => r.first + r.repeat > 0).reverse();
  }, [M, active, end, d.tiers, lastQ]);

  // repeat buying of the period's new retailers, by their tier at the end of the period
  const byTier = useMemo(() => {
    const g = new Map<number, Group>();
    for (const x of cohort) {
      const t = tierAt(M, x.r, end);
      const e = g.get(t) ?? g.set(t, { key: t, name: t < 0 ? `No tier in ${lastQ}` : d.tiers[t], s: emptyStats(), fresh: 0 }).get(t)!;
      addRetailer(M, e.s, x.r, x.c, f.rwin);
    }
    return [...g.values()].sort((a, b) => b.key - a.key);
  }, [M, cohort, end, f.rwin, d.tiers, lastQ]);

  const group = (keyOf: (x: (typeof conv)[number]) => number, nameOf: (k: number) => string) => {
    const g = new Map<number, Group>();
    for (const x of conv) {
      const k = keyOf(x);
      const e = g.get(k) ?? g.set(k, { key: k, name: nameOf(k), s: emptyStats(), fresh: 0 }).get(k)!;
      addRetailer(M, e.s, x.r, x.c, f.rwin);
      if (x.kind === NEW) e.fresh++;
    }
    return [...g.values()];
  };
  const byPlatform = useMemo(() => group((x) => x.src, (k) => SOURCE_NAMES[k] ?? d.source[k] ?? '—'), [conv, f.rwin]); // eslint-disable-line react-hooks/exhaustive-deps
  const byCampaign = useMemo(() => group((x) => x.camp, (k) => d.campaign[k] ?? '(no campaign)'), [conv, f.rwin]); // eslint-disable-line react-hooks/exhaustive-deps

  const repeaters = useMemo(() => active.filter((x) => x.n >= 2).map((x) => x.r), [active]);
  const nOf = useMemo(() => new Map(active.map((x) => [x.r, x.n])), [active]);
  const goRepeaters = (t: number) => {
    set({ tier: t, stage: 4 });
    setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const tierCols = statCols<Group>(f.rwin, [{ key: 'name', label: 'Tier', render: (g) => <TierName t={g.key} name={g.name} />, sort: (g) => g.key, csv: (g) => g.name }]);
  const platCols = statCols<Group>(f.rwin, [
    { key: 'name', label: 'Platform', render: (g) => g.name, sort: (g) => g.name },
    { key: 'fresh', label: 'Of which new', num: true, render: (g) => num(g.fresh), sort: (g) => g.fresh },
  ]);
  const campCols = statCols<Group>(f.rwin, [
    { key: 'name', label: 'Campaign', render: (g) => g.name, sort: (g) => g.name },
    { key: 'fresh', label: 'Of which new', num: true, render: (g) => num(g.fresh), sort: (g) => g.fresh },
  ]);
  const retCols: Col<number>[] = [
    { key: 'name', label: 'Retailer', render: (r) => <button type="button" className="ld-link" onClick={() => setOpen(r)}>{R.name[r]}</button>, sort: (r) => R.name[r], csv: (r) => R.name[r] },
    { key: 'id', label: 'ID', render: (r) => R.id[r], sort: (r) => R.id[r] },
    { key: 'tier', label: `Tier ${lastQ}`, render: (r) => d.tiers[tierAt(M, r, end)] ?? '—', sort: (r) => tierAt(M, r, end) },
    { key: 'n', label: 'Purchases', num: true, render: (r) => num(nOf.get(r) ?? 0), sort: (r) => nOf.get(r) ?? 0 },
    { key: 'src', label: 'Brought in by', render: (r) => (credit.lead[r] >= 0 ? SOURCE_NAMES[credit.src[r]] : 'Organic'), sort: (r) => credit.src[r] },
    { key: 'place', label: 'City, state', render: (r) => [d.city[R.c[r]], d.state[R.s[r]]].filter(Boolean).join(', ') || '—', sort: (r) => d.state[R.s[r]] ?? '' },
    { key: 'period', label: 'Billing in period', num: true, render: (r) => inr(revIn(M, r, rg[0], end)), sort: (r) => revIn(M, r, rg[0], end), csv: (r) => Math.round(revIn(M, r, rg[0], end)) },
    { key: 'life', label: 'Lifetime', num: true, render: (r) => inr(revIn(M, r, 0, M.p.salesEnd)), sort: (r) => revIn(M, r, 0, M.p.salesEnd), csv: (r) => Math.round(revIn(M, r, 0, M.p.salesEnd)) },
    { key: 'health', label: 'Status', render: (r) => health(M, r, M.p.salesEnd), sort: (r) => health(M, r, M.p.salesEnd) },
  ];
  const repeatShare = active.length ? tierDist.reduce((s, r) => s + r.repeat, 0) : 0;

  return (
    <>
      <ScopeKpis />
      <div className="ld-related"><span className="ld-muted">Same filters, by place:</span><CrossLink to="geography" label="States & cities" /></div>

      <h3 className="ld-subhead">New retailers: do they buy again? <span>first-ever purchase in the period, every source · repeat window {f.rwin} months (change it under More filters)</span></h3>
      <div className="ld-kpis ld-kpis-5">
        <Kpi icon={UserPlus} label="New retailers" rag="none" value={num(cohort.length)} sub={`${num(fromLeads)} brought in by a lead (mobile match)`}
          info="BO retailers whose first-ever purchase falls in the period and that pass the filters. Source and Campaign filters use the lead that brought the retailer in (mobile-number match)." />
        <Kpi icon={Repeat} label={`Repeat rate, ${f.rwin} months`} rag="none" value={cs.eligible ? <Pct k={cs.repeatIn} n={cs.eligible} label={`Bought again within ${f.rwin} months ÷ retailers whose window is complete`} /> : 'N/A'}
          sub={cs.eligible ? `${num(cs.repeatIn)} of ${num(cs.eligible)} with a complete window` : `no retailer has ${f.rwin} months of sales data after its first purchase yet`}
          info={`New retailers whose second purchase came within ${f.rwin} months of the first ÷ new retailers whose ${f.rwin} months after the first purchase are all in the sales data (to ${sales}). Retailers still inside the window are left out, not counted as failures.`} />
        <Kpi icon={Layers3} label="3 or more purchases" rag="none" value={num(cs.third)} sub={`${pctTxt(cs.third, cs.n)} of new retailers · ${num(cs.second)} made a 2nd`}
          info={`New retailers with a third (or later) purchase up to ${sales}.`} />
        <Kpi icon={CalendarClock} label="Time to 2nd purchase" rag="none" value={months(avgGap(cs))} sub="days: N/A (BO billing is monthly)"
          info="Average months from the first to the second purchase, over the new retailers that made a second purchase. BO billing comes per month, so the gap in days is not available." />
        <Kpi icon={IndianRupee} label="Repeat revenue" rag="none" value={cohort.length ? inr(cs.revAfter) : 'N/A'} sub={`after the first purchase · first purchases: ${inr(cs.revFirst)}`}
          info={`BO billing of the new retailers after their first-purchase month, up to ${sales}.`} />
      </div>

      <div className="ld-grid">
        <Card title="Tier distribution: first-time vs repeat buyers" uses={[...USES]}
          info={{ what: `Retailers that bought in the period, by their tier in ${lastQ} (the period's last quarter with sales). First-time = one purchase so far; repeat = two or more. Click a tier to list its repeat buyers.`, source: 'BO billing (retailer × month), recomputed tiers' }}
          csv={{ name: 'tier_first_vs_repeat', rows: () => tierDist.map((r) => ({ Tier: r.label, 'First-time buyers': r.first, 'Repeat buyers': r.repeat })) }}
          soWhat={active.length ? <>{pctTxt(repeatShare, active.length)} of the {num(active.length)} retailers that bought in the period are repeat buyers.</> : undefined}>
          <StackedBars data={tierDist.map((r) => ({ tier: r.label, first: r.first, repeat: r.repeat }))} x="tier" fmt={num} height={220}
            series={[{ key: 'repeat', label: 'Repeat buyers (2+)', color: 'var(--ld-seq-5)' }, { key: 'first', label: 'First-time buyers', color: 'var(--ld-seq-2)' }]} />
          <div className="ld-chipline">
            {tierDist.filter((r) => r.t >= 0 && r.repeat).map((r) => (
              <button key={r.t} type="button" className="ld-chip" onClick={() => goRepeaters(r.t)} title={`List the ${r.label} repeat buyers`}>
                <i style={{ background: TIER_COLORS[r.t] }} />{r.label}: {num(r.repeat)} repeat →
              </button>
            ))}
          </div>
        </Card>
        <Card title="Second and third purchase" uses={[...USES]}
          info={{ what: `The period's new retailers: how many made a first, second and third (or later) purchase, up to ${sales}. Each step shows the share of the step before.`, source: 'BO billing (retailer × month)' }}
          csv={{ name: 'purchase_steps', rows: () => [{ Step: 'First purchase', Retailers: cs.n }, { Step: 'Second purchase', Retailers: cs.second }, { Step: 'Third or more', Retailers: cs.third }] }}>
          {!cs.n ? <div className="ld-empty-s">No new retailers for these filters.</div> : (
            <HBars fmt={num} rows={[
              { label: 'First purchase', value: cs.n, color: 'var(--ld-seq-3)' },
              { label: 'Second purchase', value: cs.second, color: 'var(--ld-seq-4)', note: pctTxt(cs.second, cs.n) },
              { label: 'Third or more', value: cs.third, color: 'var(--ld-seq-5)', note: pctTxt(cs.third, cs.second) },
            ]} />
          )}
        </Card>
        <Card title="Repeat buying by tier" wide uses={[...USES]}
          info={{ what: `The period's new retailers by their tier in ${lastQ}: how many bought a second and a third time, the repeat rate within ${f.rwin} months (only retailers whose window is complete), the months to the second purchase, and what they billed in the first-purchase month and after it. Click a row to list the tier's repeat buyers.`,
            formula: `repeat rate = 2nd purchase within ${f.rwin} months ÷ retailers whose ${f.rwin}-month window is complete`, source: 'BO billing, recomputed tiers' }}
          csv={{ name: 'repeat_by_tier', rows: () => csvRows(byTier, tierCols) }}>
          <Table rows={byTier} cols={tierCols} onRow={(g) => g.key >= 0 && goRepeaters(g.key)} empty="No new retailers for these filters." />
        </Card>
        <Card title="Meta vs Google: repeat retailers" wide uses={[...LEAD_USES]}
          info={{ what: 'Retailers converted by the period\'s leads (mobile-number match, New retailer or Came back), credited to the platform of the lead that converted them, one retailer once. Purchases are counted from the first purchase after the lead.', source: 'Lead sheet, BO billing' }}
          csv={{ name: 'repeat_by_platform', rows: () => csvRows(byPlatform, platCols) }}>
          {!M.p.hasLeads ? <div className="ld-empty-s">No leads loaded.</div> : <Table rows={byPlatform} cols={platCols} initialSort={{ key: 'n', dir: 'desc' }} empty="No converted retailers for these filters." />}
        </Card>
        <Card title="Campaigns: repeat buying" wide uses={[...LEAD_USES]}
          info={{ what: 'The same as the platform table, per campaign of the converting lead. Click a campaign to filter the whole dashboard to it. Rates from fewer than 30 retailers are shown faded: too few to be sure.', source: 'Lead sheet, BO billing' }}
          csv={{ name: 'repeat_by_campaign', rows: () => csvRows(byCampaign, campCols) }}>
          {!M.p.hasLeads ? <div className="ld-empty-s">No leads loaded.</div> : <Table rows={byCampaign} cols={campCols} initialSort={{ key: 'n', dir: 'desc' }} limit={12} onRow={(g) => g.key >= 0 && set({ campaign: g.key })} empty="No converted retailers for these filters." />}
        </Card>
        <div ref={listRef} className="ld-anchor" style={{ gridColumn: '1 / -1' }}>
          <Card title="Repeat buyers" wide uses={[...USES]}
            info={{ what: `Retailers that bought in the period and have made two or more purchases up to the end of the period${f.stage >= 0 ? ` (Purchase stage: ${STAGES[f.stage]})` : ''}. Click a name for the retailer's details and purchase history.`, source: 'BO billing, lead sheet' }}
            csv={{ name: 'repeat_buyers', rows: () => csvRows(repeaters, retCols) }}>
            <Table rows={repeaters} cols={retCols} initialSort={{ key: 'period', dir: 'desc' }} limit={15} empty="No repeat buyers for these filters." />
          </Card>
        </div>
      </div>
      {open !== null && <PurchaseHistory r={open} onClose={() => setOpen(null)} />}
      <h3 className="ld-subhead">Revenue flow, cohorts and tier movement <span>every quarter; these cards do not use the Purchase stage filter</span></h3>
    </>
  );
}

function TierName({ t, name }: { t: number; name: string }) {
  return <span className="ld-legend" style={{ margin: 0 }}><span>{t >= 0 && <i style={{ background: TIER_COLORS[t] }} />}{name}</span></span>;
}
