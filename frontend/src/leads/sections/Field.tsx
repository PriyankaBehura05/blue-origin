import { useMemo } from 'react';
import { Card, NeedsData, Pct, Section, Table, csvRows, inr, num, useLeads, type Col } from '../ui';
import { SECTIONS } from '../sections';
import { StackedBars } from '../charts';
import { acquisition, billedIn, boOrderCheck, health, leadAgeDays, leadDist, leadOk, NEW, ORGANIC, outcomeOf, retailerOk, revIn, wasCalled } from '../model';

interface DistRow {
  d: number;
  name: string;
  retailers: number;
  billed: number;
  fresh: number;
  freshMkt: number;
  active: number;
  prev: number;
  retained: number;
  revenue: number;
  assigned: number;
  assignedConv: number;
}
interface OwnerRow {
  o: number;
  name: string;
  assigned: number;
  contacted: number;
  converted: number;
  breaches: number;
  days: number[];
  visited: number;
  claimed: number;
  claimedValue: number;
  boBilled: number;
  boNotBilled: number;
  boPending: number;
}

export default function Field() {
  const { M, f, rg, prev } = useLeads();
  const end = Math.min(rg[1], M.p.salesEnd);
  const sla = M.p.targets.sla_days ?? 2;

  const dists = useMemo(() => {
    const acq = acquisition(M, f.level, f.window);
    const rows = new Map<number, DistRow>();
    const get = (d: number) => rows.get(d) ?? rows.set(d, { d, name: M.p.dims.dist[d] ?? '(none)', retailers: 0, billed: 0, fresh: 0, freshMkt: 0, active: 0, prev: 0, retained: 0, revenue: 0, assigned: 0, assignedConv: 0 }).get(d)!;
    const R = M.p.retailers;
    for (let r = 0; r < M.nR; r++) {
      if (R.first[r] < 0 || R.first[r] > end || !retailerOk(M, f, r, end)) continue;
      const row = get(R.d[r]);
      row.retailers++;
      const now = billedIn(M, r, rg[0], rg[1]);
      if (now) row.billed++;
      if (R.first[r] >= rg[0] && R.first[r] <= rg[1]) {
        row.fresh++;
        if (acq.src[r] !== ORGANIC) row.freshMkt++;
      }
      if (health(M, r, end) === 'Active') row.active++;
      if (prev && billedIn(M, r, prev[0], prev[1])) {
        row.prev++;
        if (now) row.retained++;
      }
      row.revenue += revIn(M, r, rg[0], rg[1]);
    }
    const L = M.p.leads;
    const ret = M.ret[f.level];
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !leadOk(M, f, i, rg)) continue;
      const d = leadDist(M, i, ret[i]);
      if (d < 0) continue;
      const row = get(d);
      row.assigned++;
      if (outcomeOf(M, i, f.level, f.window) === NEW) row.assignedConv++;
    }
    return [...rows.values()];
  }, [M, f, rg, prev, end]);

  const owners = useMemo(() => {
    const L = M.p.leads;
    const rows = new Map<number, OwnerRow>();
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || L.owner[i] < 0 || !leadOk(M, f, i, rg)) continue;
      const row = rows.get(L.owner[i]) ?? rows.set(L.owner[i], { o: L.owner[i], name: M.p.dims.owner[L.owner[i]], assigned: 0, contacted: 0, converted: 0, breaches: 0, days: [], visited: 0, claimed: 0, claimedValue: 0, boBilled: 0, boNotBilled: 0, boPending: 0 }).get(L.owner[i])!;
      row.assigned++;
      const contactDays = L.contact[i] >= 0 ? L.contact[i] - L.day[i] : -1;
      if (contactDays >= 0) row.days.push(contactDays);
      if (wasCalled(M, i)) row.contacted++;
      if ((contactDays >= 0 && contactDays > sla) || (!wasCalled(M, i) && leadAgeDays(M, i) > sla)) row.breaches++;
      if (L.visited?.[i] === 1) row.visited++;
      if (L.ordered?.[i] === 1) {
        row.claimed++;
        row.claimedValue += L.ordv[i] || 0;
        const c = boOrderCheck(M, i, f.level);
        if (c === 'billed') row.boBilled++;
        else if (c === 'pending') row.boPending++;
        else row.boNotBilled++;
      }
      if (outcomeOf(M, i, f.level, f.window) === NEW) row.converted++;
    }
    return [...rows.values()];
  }, [M, f, rg, sla]);

  const dcols: Col<DistRow>[] = [
    { key: 'name', label: 'Distributor', render: (r) => r.name, sort: (r) => r.name },
    { key: 'fresh', label: 'New shops', num: true, render: (r) => num(r.fresh), sort: (r) => r.fresh },
    { key: 'mkt', label: 'From leads', num: true, render: (r) => num(r.freshMkt), sort: (r) => r.freshMkt },
    { key: 'billed', label: 'Shops that ordered', num: true, render: (r) => num(r.billed), sort: (r) => r.billed },
    { key: 'act', label: 'Still active', num: true, render: (r) => <Pct k={r.active} n={r.retailers} label="Active at period end ÷ retailers ever billed" />, sort: (r) => (r.retailers ? r.active / r.retailers : 0), csv: (r) => (r.retailers ? ((100 * r.active) / r.retailers).toFixed(1) : '') },
    { key: 'ret', label: 'Ordered again', num: true, render: (r) => <Pct k={r.retained} n={r.prev} label="Billed again ÷ billed last period" />, sort: (r) => (r.prev ? r.retained / r.prev : 0), csv: (r) => (r.prev ? ((100 * r.retained) / r.prev).toFixed(1) : '') },
    { key: 'rev', label: 'Sales', num: true, render: (r) => inr(r.revenue), sort: (r) => r.revenue },
    ...(M.p.hasLeads ? [
      { key: 'asg', label: 'Leads', num: true, render: (r: DistRow) => num(r.assigned), sort: (r: DistRow) => r.assigned },
      { key: 'asgc', label: 'Leads → retailers', num: true, render: (r: DistRow) => <Pct k={r.assignedConv} n={r.assigned} label="New retailers ÷ unique leads of this distributor" />, sort: (r: DistRow) => (r.assigned ? r.assignedConv / r.assigned : 0), csv: (r: DistRow) => r.assignedConv },
    ] : []),
  ];
  const ocols: Col<OwnerRow>[] = [
    { key: 'name', label: 'ASM', render: (r) => r.name, sort: (r) => r.name },
    { key: 'asg', label: 'Leads', num: true, render: (r) => num(r.assigned), sort: (r) => r.assigned },
    { key: 'con', label: 'Called', num: true, render: (r) => <Pct k={r.contacted} n={r.assigned} label="Contacted ÷ assigned" />, sort: (r) => (r.assigned ? r.contacted / r.assigned : 0), csv: (r) => r.contacted },
    { key: 'vis', label: 'Visited', num: true, render: (r) => <Pct k={r.visited} n={r.assigned} label="Visited ÷ assigned" />, sort: (r) => (r.assigned ? r.visited / r.assigned : 0), csv: (r) => r.visited },
    { key: 'clm', label: 'Orders reported', num: true, render: (r) => num(r.claimed), sort: (r) => r.claimed },
    { key: 'clv', label: 'Order value reported', num: true, render: (r) => inr(r.claimedValue), sort: (r) => r.claimedValue },
    { key: 'bo', label: 'Order confirmed in BO', num: true, render: (r) => <Pct k={r.boBilled} n={r.boBilled + r.boNotBilled} label="Reported orders whose retailer billed in BO within 3 months ÷ reported orders old enough to check" />, sort: (r) => (r.boBilled + r.boNotBilled ? r.boBilled / (r.boBilled + r.boNotBilled) : -1), csv: (r) => r.boBilled },
    { key: 'conv', label: 'New retailers', num: true, render: (r) => <Pct k={r.converted} n={r.assigned} label="New retailers (BO first bill in the window) ÷ assigned" />, sort: (r) => (r.assigned ? r.converted / r.assigned : 0), csv: (r) => r.converted },
    ...(M.p.hasContactDates ? [
      { key: 'med', label: 'Median days to contact', num: true, render: (r: OwnerRow) => (r.days.length ? median(r.days).toFixed(0) : '—'), sort: (r: OwnerRow) => (r.days.length ? median(r.days) : 999) },
    ] : []),
    { key: 'sla', label: `Not called after ${sla} days`, num: true, render: (r) => num(r.breaches), sort: (r) => r.breaches },
  ];

  // every reported order, checked against BO billing
  const orders = useMemo(() => {
    const out = { billed: 0, notBilled: 0, pending: 0, value: [0, 0, 0], billedUnreported: 0 };
    const L = M.p.leads;
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !L.valid[i] || !leadOk(M, f, i, rg)) continue;
      const c = boOrderCheck(M, i, f.level);
      if (L.ordered?.[i] === 1) {
        const j = c === 'billed' ? 0 : c === 'not billed' ? 1 : 2;
        if (j === 0) out.billed++; else if (j === 1) out.notBilled++; else out.pending++;
        out.value[j] += L.ordv[i] || 0;
      } else if (L.ordered?.[i] === 0 && c === 'billed' && outcomeOf(M, i, f.level, f.window) === NEW) out.billedUnreported++;
    }
    return out;
  }, [M, f, rg]);
  const orderRows = [
    { k: 'Reported, and the retailer billed in BO', n: orders.billed, v: orders.value[0] },
    { k: 'Reported, no BO billing within 3 months', n: orders.notBilled, v: orders.value[1] },
    { k: 'Reported, too recent to check', n: orders.pending, v: orders.value[2] },
    { k: 'Not reported, but a new retailer billed in BO', n: orders.billedUnreported, v: 0 },
  ];

  return (
    <Section def={SECTIONS[4]} n={5}>
      <div className="ld-grid">
        <Card title="Distributors" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          info={{ what: 'Per distributor: outlets whose first bill falls in the period (and how many a lead brought in), retailers billed, active rate at the period end, retention from the previous period, sales; with the follow-up log, leads assigned and converted.', formula: 'Retention = billed in both periods ÷ billed in the previous period', source: 'retailer_month.csv, retailers.csv, follow-up log' }}
          csv={{ name: 'distributor_leaderboard', rows: () => csvRows(dists, dcols) }}
          soWhat={dists.length ? (() => { const top = [...dists].sort((a, b) => b.fresh - a.fresh)[0]; return <>{top.name} added the most new shops ({num(top.fresh)}). See the States & cities page for where.</>; })() : undefined}>
          <Table rows={dists} cols={dcols} initialSort={{ key: 'fresh', dir: 'desc' }} />
        </Card>
        <Card title="ASM follow-up at a glance" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
          info={{ what: 'Leads each ASM owns, split into called and not called yet (Calling Done on the lead sheet). The 12 ASMs with the most leads.', source: 'Lead sheet ASM columns' }}
          soWhat={owners.length ? (() => { const w = [...owners].filter((o) => o.assigned >= 30).sort((x, y) => x.contacted / x.assigned - y.contacted / y.assigned)[0]; return w ? <>{w.name} has called the smallest share of their leads ({Math.round((100 * w.contacted) / w.assigned)}% of {num(w.assigned)}).</> : undefined; })() : undefined}>
          {!M.p.hasFollowup ? <NeedsData what="followup" /> : (
            <StackedBars height={250} x="name" fmt={num}
              data={[...owners].sort((x, y) => y.assigned - x.assigned).slice(0, 12).map((o) => ({ name: o.name, called: o.contacted, open: o.assigned - o.contacted }))}
              series={[{ key: 'called', label: 'Called', color: 'var(--ld-seq-5)' }, { key: 'open', label: 'Not called yet', color: 'var(--ld-cat-lost)' }]} />
          )}
        </Card>
        <Card title="ASM leaderboard" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
          info={{ what: 'Leads each ASM owns (ASM NAME on the lead sheet, or the follow-up log): called, visited, orders they report and how many of those the BO billing confirms (the matched retailer billed within 3 months of the lead), and new retailers per BO first bills. Leads not called after the SLA are counted from the lead date.', formula: 'Seen in BO billing = reported orders whose retailer billed ÷ reported orders old enough to check', source: 'Lead sheet ASM columns / follow-up log, matched to BO retailer_month.csv' }}
          csv={{ name: 'field_leaderboard', rows: () => csvRows(owners, ocols) }}>
          {!M.p.hasFollowup ? <NeedsData what="followup" /> : <Table rows={owners} cols={ocols} initialSort={{ key: 'asg', dir: 'desc' }} />}
        </Card>
        <Card title="Reported orders vs BO billing" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level']}
          info={{ what: 'Every order an ASM marked "Order placed", checked against the BO sales data: did the lead\'s matched retailer bill in the lead month or the 2 months after? The last line counts leads marked "no order" that still became new retailers in BO. Nothing is changed in the BO data: it is only read.', formula: 'retailer billed in BO in months L..L+2 (L = lead month); too recent = L+2 after the last sales month', source: 'Lead sheet Order Placed / Order Value + BO retailer_month.csv' }}
          csv={{ name: 'orders_vs_bo', rows: () => orderRows.map((r) => ({ Check: r.k, Leads: r.n, 'Reported value (₹)': r.v })) }}
          soWhat={orders.billed + orders.notBilled ? <>{num(orders.billed)} of {num(orders.billed + orders.notBilled)} reported orders that can be checked show up in BO billing. The rest: the shop may bill under another name or number, or the order never reached a distributor.</> : undefined}>
          {!M.p.hasFollowup ? <NeedsData what="followup" /> : (
            <Table rows={orderRows} cols={[
              { key: 'k', label: '', render: (r) => r.k },
              { key: 'n', label: 'Leads', num: true, render: (r) => num(r.n) },
              { key: 'v', label: 'Reported value', num: true, render: (r) => (r.v ? inr(r.v) : '—') },
            ]} />
          )}
        </Card>
      </div>
    </Section>
  );
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
