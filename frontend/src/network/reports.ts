// Report views of the BO Retailer Network dashboard, computed in the browser from the consolidated payload.
// Definitions follow the BO dashboard: a retailer is "new" in the month of its first purchase; "active" in a
// quarter when it bought in it; tiers are recomputed on the consolidated quarterly purchase.
import type { Chart, Col, Filters, Kpi, Model, Retailer, Row, Section, Table, View } from './types';
import { fmtINR, fmtN, fmtSlab, mLabel, MOVE_COLOR, MOVES, moveOf, pct, qLabel, qSel, slabAt, slabText, tierAt, tierFrom, tierInForce, type Move } from './model';

const TIER_KEYS = ['Platinum', 'Gold', 'Silver', 'Green', 'Yellow'];
const tierColor = (i: number) => `var(--t${Math.max(0, i)})`;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const qRev = (rs: Retailer[], qi: number) => rs.reduce((s, r) => s + r.q[qi], 0);
const active = (r: Retailer, qi: number) => r.q[qi] > 0;

export const base = (r: Retailer): Row => ({
  ID: r.id, Retailer: r.n, Distributor: r.dist, Region: r.region, State: r.state, District: r.ds ?? '', City: r.ct ?? '',
  Pincode: r.pin ?? '', Phone: r.ph ?? '', AltPhone: r.pa ?? '',
});
export const baseCols: Col[] = [
  { k: 'Retailer', label: 'Retailer', type: 'link', w: 36 }, { k: 'Distributor', label: 'Distributor', w: 22 },
  { k: 'District', label: 'District', w: 16 }, { k: 'City', label: 'City / area', w: 16 }, { k: 'Phone', label: 'Phone', w: 13 }, { k: 'AltPhone', label: 'Alt phone', w: 16 },
];
export const geoCols: Col[] = [{ k: 'State', label: 'State', w: 14 }, { k: 'Region', label: 'Region', w: 8 }, { k: 'Pincode', label: 'Pincode', w: 9 }];
const n = (k: string, label: string): Col => ({ k, label, type: 'num' });
const inr = (k: string, label: string): Col => ({ k, label, type: 'inr' });
const tier = (k: string, label: string): Col => ({ k, label, type: 'tier' });
const pc = (k: string, label: string): Col => ({ k, label, type: 'pct' });
const kpi = (label: string, value: string, delta?: number | null, sub?: string, tone?: Kpi['tone']): Kpi => ({ label, value, delta, sub, tone });
const round1 = (v: number) => Math.round(v * 10) / 10;

/* ------------------------------------------------------------ 1. overview */
// Position of a quarter key ('Q3_FY27') in time: one step per quarter, and the calendar month it starts in.
function quarterSpan(qk: string): { ord: number; start: Date; end: Date } | null {
  const mt = /^Q([1-4])_FY(\d{2})$/.exec(qk);
  if (!mt) return null;
  const qn = Number(mt[1]);
  const fy = 2000 + Number(mt[2]);
  const start = new Date(qn === 4 ? fy : fy - 1, [3, 6, 9, 0][qn - 1], 1);
  return { ord: fy * 4 + qn, start, end: new Date(start.getFullYear(), start.getMonth() + 3, 1) };
}

// The latest 4 completed consecutive quarters: a quarter is completed once its last month is over and the data
// holds its months. It moves by itself whenever a newer quarter completes in the data. null = fewer than 4 (or a gap).
export function latestCompletedFour(m: Model, now = new Date()): number[] | null {
  const done = m.Q.map((qk, i) => ({ i, span: quarterSpan(qk) }))
    .filter((x) => x.span && now >= x.span.end && m.MQ.filter((q) => q === x.i).length >= 3);
  const win = done.slice(-4);
  if (win.length < 4 || win.some((x, k) => k > 0 && x.span!.ord !== win[k - 1].span!.ord + 1)) return null;
  return win.map((x) => x.i);
}

export function overview(m: Model, f: Filters, rs: Retailer[]): View {
  const { Q, M, LQ } = m;
  const all = f.q < 0;
  const qi = qSel(m, f);
  const pq = qi - 1;
  const monthly = M.map((_, i) => sum(rs.map((r) => r.m[i])));
  const activeM = M.map((_, i) => rs.reduce((s, r) => s + (r.m[i] > 0 ? 1 : 0), 0));
  const tierSeries = [1, 2, 3, 4, 5].map((ti) => ({ name: m.TIERS[ti], color: tierColor(ti), values: Q.map((_, q) => rs.filter((r) => r.t[q] === ti).length) }));
  // the same tier mix in rupees: what the retailers on each tier bought in the quarter
  const tierRevSeries = [1, 2, 3, 4, 5].map((ti) => ({ name: m.TIERS[ti], color: tierColor(ti), values: Q.map((_, q) => qRev(rs.filter((r) => r.t[q] === ti), q)) }));
  const inQ = all ? undefined : M.map((_, i) => i).filter((i) => m.MQ[i] === qi);
  const charts: Chart[] = [
    { id: 'rev', title: 'Monthly revenue', caption: 'Purchases by the selected retailers', kind: 'bar', labels: M.map(mLabel), series: [{ name: 'Revenue', color: 'var(--brand)', values: monthly }], fmt: 'inr', highlight: inQ },
    { id: 'act', title: 'Active retailers per month', caption: 'Retailers with a purchase in the month', kind: 'line', labels: M.map(mLabel), series: [{ name: 'Active retailers', color: 'var(--brand)', values: activeM }] },
    { id: 'tier', title: 'Tier mix by quarter', caption: `Tiered retailers per quarter, on the consolidated quarterly purchase: ${slabText(m)}`, kind: 'stack', labels: Q.map(qLabel), series: tierSeries, wide: true, highlight: all ? undefined : [qi] },
    { id: 'tierRev', title: 'Tier mix by quarter: revenue', caption: 'What the retailers on each tier bought in the quarter (the tier mix above, in ₹)', kind: 'stack', labels: Q.map(qLabel), series: tierRevSeries, fmt: 'inr', wide: true, highlight: all ? undefined : [qi] },
  ];
  // Purchase frequency: in how many of the last (up to) 4 quarters, ending at the selected one, each retailer bought
  const wEnd = all ? LQ : qi;
  const wLen = Math.min(4, wEnd + 1);
  const win = Array.from({ length: wLen }, (_, i) => wEnd - wLen + 1 + i);
  const freq = win.length >= 2 ? purchaseFrequency(m, rs, win) : null;
  if (freq) charts.push(freq.chart);
  // The four retailer KPIs, all for the selected quarter (the latest when "All quarters" is chosen) and its financial year:
  // Total = every retailer listed up to that quarter, bought or not; Active / New / Consistent are counted from the
  // quarterly sales (a quarter counts when the retailer's sales in it are above zero).
  const fyOf = (qk: string) => qk.split('_')[1] ?? qk;
  const upTo = Q.map((_, i) => i).filter((i) => i <= qi);   // every quarter available, from the first in the data to the selected one
  const four = latestCompletedFour(m);
  const fourBefore = four && four[0] > 0 && quarterSpan(Q[four[0] - 1])?.ord === quarterSpan(Q[four[0]])!.ord - 1 ? four.map((i) => i - 1) : null;
  const inAll = (r: Retailer, qs: number[]) => qs.every((i) => active(r, i));
  const listedBy = (qx: number) => rs.filter((r) => r.fl <= qx).length;
  const totalR = listedBy(qi);
  const activeR = rs.filter((r) => active(r, qi)).length;
  const prevActive = pq >= 0 ? rs.filter((r) => active(r, pq)).length : null;
  const newR = qi > 0 ? rs.filter((r) => r.firstQ === qi && active(r, qi)).length : null;
  const prevNew = pq > 0 ? rs.filter((r) => r.firstQ === pq && active(r, pq)).length : null;
  const consistentR = rs.filter((r) => inAll(r, upTo)).length;
  const churnedList = pq >= 0 ? rs.filter((r) => active(r, pq) && !active(r, qi)) : null;   // bought last quarter, nothing in this one
  const fourR = four ? rs.filter((r) => inAll(r, four)).length : null;
  const fourPrev = fourBefore ? rs.filter((r) => inAll(r, fourBefore)).length : null;
  const vsPrev = pq >= 0 ? `vs ${qLabel(Q[pq])}` : '';
  const core: Kpi[] = [
    kpi('Total retailers', fmtN(totalR), pq >= 0 ? pct(totalR, listedBy(pq)) : null, `listed since the data began, up to ${qLabel(Q[qi])}, bought or not`),
    kpi('Active retailers', fmtN(activeR), prevActive == null ? null : pct(activeR, prevActive), `bought in ${qLabel(Q[qi])}${vsPrev ? `, ${vsPrev}` : ''}`),
    kpi('Consistent retailers', fmtN(consistentR), null,
      upTo.length === 1 ? `only ${qLabel(Q[0])} so far` : `bought in all ${upTo.length} quarters, ${qLabel(Q[0])} to ${qLabel(Q[qi])}`),
    kpi('Consistent, last 4 quarters', fourR == null ? '–' : fmtN(fourR), fourR == null || fourPrev == null ? null : pct(fourR, fourPrev),
      four ? `bought in each of ${qLabel(Q[four[0]])} to ${qLabel(Q[four[3]])}${fourPrev == null ? '' : ', vs the 4 before'}` : 'needs 4 completed quarters in a row'),
    kpi('Completely new retailers', newR == null ? '–' : fmtN(newR), prevNew == null || newR == null ? null : pct(newR, prevNew),
      newR == null ? 'first quarter of data' : `first-ever purchase in ${qLabel(Q[qi])}${vsPrev ? `, ${vsPrev}` : ''}`),
    kpi('Churned retailers', churnedList ? fmtN(churnedList.length) : '–', null,
      churnedList ? `bought in ${qLabel(Q[pq])}, nothing in ${qLabel(Q[qi])} · ${fmtINR(qRev(churnedList, pq))} bought in ${qLabel(Q[pq])}` : 'first quarter of data', 'down'),
  ];
  const yellow = fmtSlab(m.p.slabs.Yellow);
  let kpis: Kpi[];
  if (all) {
    const rev = sum(rs.map((r) => r.life));
    const buyers = rs.filter((r) => r.life > 0).length;
    const tiered = rs.filter((r) => r.t[LQ] > 0).length;
    const pt = rs.filter((r) => r.t[LQ - 1] > 0).length;
    kpis = [
      kpi('Revenue, all quarters', fmtINR(rev), null, `${qLabel(Q[0])} to ${qLabel(Q[LQ])}`),
      ...core,
      kpi(`Tiered in ${qLabel(Q[LQ])}`, fmtN(tiered), pct(tiered, pt), `vs ${qLabel(Q[LQ - 1])}`),
      kpi('Revenue per active retailer', fmtINR(buyers ? rev / buyers : 0), null, 'all quarters'),
    ];
  } else {
    const rev = qRev(rs, qi);
    const prev = pq >= 0 ? qRev(rs, pq) : null;
    const act = rs.filter((r) => active(r, qi)).length;
    const pact = pq >= 0 ? rs.filter((r) => active(r, pq)).length : null;
    const td = rs.filter((r) => r.t[qi] > 0).length;
    const ptd = pq >= 0 ? rs.filter((r) => r.t[pq] > 0).length : null;
    const vs = pq >= 0 ? `vs ${qLabel(Q[pq])}` : '';
    kpis = [
      kpi(`${qLabel(Q[qi])} revenue`, fmtINR(rev), prev == null ? null : pct(rev, prev), vs),
      ...core,
      kpi(`Tiered retailers (≥ ${yellow})`, fmtN(td), ptd == null ? null : pct(td, ptd), vs),
      kpi('Revenue per active retailer', fmtINR(act ? rev / act : 0), pact && prev != null ? pct(rev / act, prev / pact) : null, vs),
    ];
  }
  // The four KPIs for every quarter, grouped by financial year (same definitions as the cards above)
  const byQuarter: Row[] = Q.map((qk, i) => {
    const sofar = Q.map((_, j) => j).filter((j) => j <= i);
    const act = rs.filter((r) => active(r, i)).length;
    const prevAct = i > 0 ? rs.filter((r) => active(r, i - 1)).length : null;
    return {
      FY: `FY ${fyOf(qk).replace('FY', '')}`, Quarter: qLabel(qk), Total: listedBy(i), Active: act,
      Growth: prevAct == null ? null : pct(act, prevAct),
      New: i > 0 ? rs.filter((r) => r.firstQ === i && active(r, i)).length : null,
      Consistent: rs.filter((r) => sofar.every((j) => active(r, j))).length,
      Churned: i > 0 ? rs.filter((r) => active(r, i - 1) && !active(r, i)).length : null,
      Revenue: qRev(rs, i),
    };
  });
  const tables: Table[] = [{
    id: 'qtrkpi', title: 'Retailer KPIs by quarter and financial year',
    caption: 'Total = listed up to the quarter · Active = bought in the quarter · New = first-ever purchase in the quarter · Churned = bought in the previous quarter, nothing in this one · '
      + 'Consistent = bought in every quarter available, from the first quarter of the data up to this one',
    cols: [{ k: 'FY', label: 'Financial year', w: 14 }, { k: 'Quarter', label: 'Quarter', w: 12 }, n('Total', 'Total retailers'), n('Active', 'Active retailers'),
      pc('Growth', 'Active vs previous qtr'), n('Consistent', 'Consistent retailers'), n('New', 'Completely new'), n('Churned', 'Churned retailers'), inr('Revenue', 'Revenue')],
    rows: byQuarter,
  }];
  // breakdown one level below the current filter: region -> state -> distributor
  const byKey = f.dist ? null : f.state ? 'dist' : f.region ? 'state' : 'region';
  if (byKey) {
    const lbl = { dist: 'Distributor', state: 'State', region: 'Region' }[byKey];
    const groups = new Map<string, Retailer[]>();
    rs.forEach((r) => {
      const g = String(r[byKey as keyof Retailer]) || '(not set)';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(r);
    });
    const rows: Row[] = [...groups].map(([g, list]) => {
      const tc = (ti: number) => list.filter((r) => r.t[qi] === ti).length;
      const row: Row = {
        Group: g, Active: list.filter((r) => (all ? r.life > 0 : active(r, qi))).length,
        New: all ? list.filter((r) => r.firstQ > 0).length : qi > 0 ? list.filter((r) => r.firstQ === qi).length : 0,
        Platinum: tc(5), Gold: tc(4), Silver: tc(3), Green: tc(2), Yellow: tc(1), Listed: list.length,
      };
      if (all) {
        Q.forEach((q, i) => (row[q] = qRev(list, i)));
        row.Total = sum(list.map((r) => r.life));
        row.Growth = pct(qRev(list, LQ), qRev(list, LQ - 1));
      } else {
        row.Revenue = qRev(list, qi);
        row.Prev = pq >= 0 ? qRev(list, pq) : 0;
        row.Growth = pq >= 0 ? pct(qRev(list, qi), qRev(list, pq)) : null;
      }
      return row;
    }).sort((a, b) => Number(all ? b.Total : b.Revenue) - Number(all ? a.Total : a.Revenue));
    const tcols = TIER_KEYS.map((t) => n(t, all ? `${t} ${qLabel(Q[LQ])}` : t));
    tables.push({
      id: 'breakdown', total: true, title: `Revenue by ${lbl.toLowerCase()}`,
      caption: all ? `Quarter-wise revenue; growth is ${qLabel(Q[LQ])} vs ${qLabel(Q[LQ - 1])}; tier counts for ${qLabel(Q[LQ])}` : `${qLabel(Q[qi])} vs ${pq >= 0 ? qLabel(Q[pq]) : '–'}`,
      cols: all
        ? [{ k: 'Group', label: lbl, w: 28 }, ...Q.map((q) => inr(q, qLabel(q))), inr('Total', 'Total'), pc('Growth', 'Growth'), n('Active', 'Active (any qtr)'), n('New', 'New retailers'), ...tcols, n('Listed', 'Listed')]
        : [{ k: 'Group', label: lbl, w: 28 }, inr('Revenue', `${qLabel(Q[qi])} revenue`), inr('Prev', pq >= 0 ? `${qLabel(Q[pq])} revenue` : 'Previous'), pc('Growth', 'Growth'), n('Active', 'Active'), n('New', 'New'), ...tcols, n('Listed', 'Listed')],
      rows,
    });
  }
  const top = all
    ? rs.filter((r) => r.life > 0).sort((a, b) => b.life - a.life).map((r) => ({ ...base(r), Life: r.life, ...Object.fromEntries(Q.map((q, i) => [q, r.q[i]])), Tier: r.t[LQ], Best: r.best }))
    : rs.filter((r) => r.q[qi] > 0).sort((a, b) => b.q[qi] - a.q[qi]).map((r) => ({ ...base(r), Revenue: r.q[qi], Prev: pq >= 0 ? r.q[pq] : 0, Growth: pq >= 0 ? pct(r.q[qi], r.q[pq]) : null, Tier: r.t[qi] }));
  tables.push({
    id: 'top', title: 'Top retailers', caption: all ? 'Total revenue across all quarters, highest first' : `${qLabel(Q[qi])} revenue, highest first`,
    cols: all
      ? [...baseCols, inr('Life', 'Total revenue'), ...Q.map((q) => inr(q, qLabel(q))), tier('Tier', `Tier ${qLabel(Q[LQ])}`), tier('Best', 'Best tier'), ...geoCols]
      : [...baseCols, inr('Revenue', 'Revenue'), inr('Prev', 'Previous qtr'), pc('Growth', 'Growth'), tier('Tier', 'Tier'), ...geoCols],
    rows: top,
  });
  if (freq && freq.table.rows.length) tables.push(freq.table);
  return { kpis, charts, tables };
}

// "How often do retailers actually buy?": retailers that bought in the whole window, in 2..n-1 of its n quarters,
// or in just one. Counted from the quarterly revenue (a quarter counts when its sales are above zero), over the
// retailers that bought at least once in the window. Retailers who bought only once, or who stopped after
// buying repeatedly, are listed as the retention opportunity.
function purchaseFrequency(m: Model, rs: Retailer[], win: number[]): { chart: Chart; table: Table } {
  const { Q } = m;
  const nq = win.length;
  const last = win[nq - 1];
  const hits = (r: Retailer) => win.filter((i) => active(r, i)).length;
  const buyers = rs.filter((r) => hits(r) > 0);
  const full = buyers.filter((r) => hits(r) === nq).length;
  const one = buyers.filter((r) => hits(r) === 1).length;
  const mid = buyers.length - full - one;
  const share = (v: number) => (buyers.length ? Math.round((v / buyers.length) * 100) : 0);
  const labels = [`Active all ${nq} quarters`];
  const values = [full];
  const colors = ['#ff6a3d'];
  if (nq >= 3) {
    labels.push(nq === 3 ? 'Active 2 of 3 quarters' : `Active 2–${nq - 1} of ${nq} quarters`);
    values.push(mid);
    colors.push('#1f2f5a');
  }
  labels.push('Active exactly 1 quarter');
  values.push(one);
  colors.push('#5b6b8a');
  const span = `${qLabel(Q[win[0]])} to ${qLabel(Q[last])}`;
  const chart: Chart = {
    id: 'freq', title: 'Retailer purchase frequency', kind: 'donut', labels, colors, wide: true,
    series: [{ name: 'Retailers', color: colors[0], values }],
    caption: `${fmtN(buyers.length)} retailers who bought in ${span} · ${share(buyers.length - one)}% bought in 2 or more of the ${nq} quarters (repeat buyers) · `
      + `${share(one)}% bought in only one: the retention opportunity`,
  };
  // healthy repeat buyers (2+ quarters, bought in the latest) are left out of the list
  const open = buyers.filter((r) => hits(r) === 1 || !active(r, last));
  const WIN_BACK = 'Stopped buying: win back';
  const REPEAT = 'Bought once, this quarter: get a repeat';
  const GONE = 'Bought once, not back';
  const status = (r: Retailer) => (hits(r) >= 2 ? WIN_BACK : active(r, last) ? REPEAT : GONE);
  const rank = (s: string) => [WIN_BACK, REPEAT, GONE].indexOf(s);
  const winRev = (r: Retailer) => sum(win.map((i) => r.q[i]));
  const rows: Row[] = open.map((r) => {
    const lastBought = [...win].reverse().find((i) => active(r, i));
    return { ...base(r), Status: status(r), Quarters: hits(r), Last: lastBought == null ? '' : qLabel(Q[lastBought]), Rev: winRev(r), ...Object.fromEntries(win.map((i) => [Q[i], r.q[i]])) };
  }).sort((a, b) => rank(String(a.Status)) - rank(String(b.Status)) || Number(b.Rev) - Number(a.Rev));
  const table: Table = {
    id: 'freq', title: 'Retention opportunities',
    caption: `Retailers who bought only once, or stopped buying, in ${span}. Stopped-buying repeat buyers come first, then by revenue in the period`,
    cols: [...baseCols, { k: 'Status', label: 'Why listed', w: 34 }, n('Quarters', `Quarters active (of ${nq})`), { k: 'Last', label: 'Last bought', w: 12 },
      inr('Rev', 'Revenue in period'), ...win.map((i) => inr(Q[i], qLabel(Q[i]))), ...geoCols],
    rows,
  };
  return { chart, table };
}

/* ------------------------------------------------------------ 2. new retailers */
// What a retailer is in quarter q: 'new' = its first-ever purchase falls in q; 'react' = it bought in q and before, but
// not in the quarter just before (inactive for at least one whole quarter); null = neither (a continuing buyer, or no
// purchase). The first quarter of the data cannot be classified: there is nothing before it.
type Kind = 'new' | 'react';
const kindIn = (r: Retailer, q: number): Kind | null => {
  if (q <= 0) return null;
  if (r.firstQ === q) return 'new';
  return active(r, q) && r.firstQ >= 0 && r.firstQ < q && !active(r, q - 1) ? 'react' : null;
};
const lastBoughtBefore = (r: Retailer, q: number) => {
  for (let j = q - 1; j >= 0; j--) if (active(r, j)) return j;
  return -1;
};

export function newRetailers(m: Model, f: Filters, rs: Retailer[]): View {
  const { Q, M, LQ, MQ } = m;
  const all = f.q < 0;
  const qi = qSel(m, f);
  // f.m is -1 until the provider has picked the latest month; never index months with it
  const mi = f.m >= 1 && f.m < M.length ? f.m : M.length - 1;
  const newM = M.map((_, i) => (i === 0 ? 0 : rs.filter((r) => r.first === i).length));
  const newQ = Q.map((_, q) => (q === 0 ? 0 : rs.filter((r) => r.firstQ === q).length));
  // sales value of those new retailers: their first month's purchase / their joining quarter's purchase
  const newMRev = M.map((_, i) => (i === 0 ? 0 : rs.reduce((s, r) => s + (r.first === i ? r.m[i] : 0), 0)));
  const newQRev = Q.map((_, q) => (q === 0 ? 0 : rs.reduce((s, r) => s + (r.firstQ === q ? r.q[q] : 0), 0)));
  const repeat = (q: number) => {
    const c = rs.filter((r) => r.firstQ === q);
    return q + 1 < Q.length && c.length ? (c.filter((r) => r.q[q + 1] > 0).length / c.length) * 100 : null;
  };
  const mRows = rs.filter((r) => r.first === mi).map((r) => ({ ...base(r), FirstRev: r.m[r.first], QRev: r.q[MQ[mi]], Tier: r.t[MQ[mi]], Since: sum(r.m.slice(mi)) })).sort((a, b) => b.FirstRev - a.FirstRev);
  const inScope = (r: Retailer) => (all ? r.firstQ > 0 : qi > 0 && r.firstQ === qi);
  const qRows = rs.filter(inScope).map((r) => ({
    ...base(r), FirstQ: qLabel(Q[r.firstQ]), FQ: r.firstQ, FirstMonth: mLabel(M[r.first]), QRev: r.q[r.firstQ], Tier: r.t[r.firstQ],
    Repeat: r.firstQ + 1 < Q.length ? (r.q[r.firstQ + 1] > 0 ? 'Yes' : 'No') : '–', Since: sum(r.m.slice(r.first)), Cur: r.t[LQ],
    ...(all ? {} : Object.fromEntries(M.map((_, i) => i).filter((i) => MQ[i] === qi).map((i) => [M[i], r.m[i]]))),
  })).sort((a, b) => (all ? b.FQ - a.FQ || b.Since - a.Since : b.QRev - a.QRev));
  const groups = new Map<string, Row>();
  rs.forEach((r) => {
    if (r.firstQ <= 0) return;
    const g = groups.get(r.dist) ?? { Distributor: r.dist, State: r.state, Region: r.region, Total: 0, ...Object.fromEntries(Q.slice(1).map((q) => [q, 0])) };
    g[Q[r.firstQ]] = Number(g[Q[r.firstQ]]) + 1;
    g.Total = Number(g.Total) + 1;
    groups.set(r.dist, g);
  });
  const piv = [...groups.values()].sort((a, b) => (all ? 0 : Number(b[Q[qi]]) - Number(a[Q[qi]])) || Number(b.Total) - Number(a.Total));
  const cohort = Q.slice(1).map((q, j) => {
    const i = j + 1;
    const c = rs.filter((r) => r.firstQ === i);
    const rp = repeat(i);
    return { Quarter: qLabel(q), New: c.length, Rev: sum(c.map((r) => r.q[i])), Repeat: rp == null ? null : round1(rp), StillActive: c.filter((r) => r.q[LQ] > 0).length, Tiered: c.filter((r) => r.t[LQ] > 0).length };
  });
  // ---- completely new vs reactivated, per quarter (see kindIn)
  const scopeQ = all ? Q.map((_, i) => i).filter((i) => i > 0) : qi > 0 ? [qi] : [];
  const qMonths = qi > 0 ? M.map((_, i) => i).filter((i) => MQ[i] === qi) : [];   // the months shown as columns for one quarter
  const stat = Q.map((_, q) => {
    const nw = rs.filter((r) => kindIn(r, q) === 'new');
    const re = rs.filter((r) => kindIn(r, q) === 'react');
    return { nw, re, nwS: qRev(nw, q), reS: qRev(re, q) };
  });
  const qIdx = Q.map((_, i) => i).filter((i) => i > 0);
  const nwCount = sum(scopeQ.map((q) => stat[q].nw.length));
  const nwSales = sum(scopeQ.map((q) => stat[q].nwS));
  const reSales = sum(scopeQ.map((q) => stat[q].reS));
  const reUnique = new Set(scopeQ.flatMap((q) => stat[q].re.map((r) => r.id))).size;
  const reEvents = sum(scopeQ.map((q) => stat[q].re.length));
  const salesBase = sum(scopeQ.map((q) => qRev(rs, q)));
  const share = (v: number) => (salesBase ? `${((v / salesBase) * 100).toFixed(1)}% of ${all ? 'all sales' : `${qLabel(Q[qi])} sales`}` : '');
  const reRows: Row[] = rs.flatMap((r) => scopeQ.filter((q) => kindIn(r, q) === 'react').map((q) => {
    const lb = lastBoughtBefore(r, q);
    const firstMonth = M.findIndex((_, i) => MQ[i] === q);
    return {
      ...base(r), ReactQ: qLabel(Q[q]), RQ: q, LastBefore: lb < 0 ? '' : qLabel(Q[lb]), Gap: lb < 0 ? null : q - lb - 1,
      QRev: r.q[q], Before: sum(r.m.slice(0, firstMonth)), Since: sum(r.m.slice(firstMonth)), Tier: r.t[q], Cur: r.t[LQ],
      ...(all ? {} : Object.fromEntries(qMonths.map((i) => [M[i], r.m[i]]))),
    };
  })).sort((a, b) => (all ? Number(b.RQ) - Number(a.RQ) : 0) || Number(b.QRev) - Number(a.QRev));
  const catQuarter: Row[] = qIdx.map((q) => ({
    Quarter: qLabel(Q[q]), NewN: stat[q].nw.length, NewS: stat[q].nwS, ReN: stat[q].re.length, ReS: stat[q].reS,
    Both: stat[q].nwS + stat[q].reS, AllS: qRev(rs, q),
  }));
  const catMonthIdx = M.map((_, i) => i).filter((i) => MQ[i] > 0 && (all || MQ[i] === qi));
  const catMonth: Row[] = catMonthIdx.map((i) => {
    const { nw, re } = stat[MQ[i]];
    return {
      Month: mLabel(M[i]), Quarter: qLabel(Q[MQ[i]]), NewA: nw.filter((r) => r.m[i] > 0).length, NewS: sum(nw.map((r) => r.m[i])),
      ReA: re.filter((r) => r.m[i] > 0).length, ReS: sum(re.map((r) => r.m[i])),
    };
  });
  const chartMonths = M.map((_, i) => i).filter((i) => MQ[i] > 0);
  const rr = all ? null : repeat(qi);
  const withRepeat = cohort.filter((c) => c.Repeat != null);
  const avgRepeat = withRepeat.length ? sum(withRepeat.map((c) => Number(c.Repeat))) / withRepeat.length : null;
  return {
    lead: `Two kinds of new business. Completely new = the retailer's first-ever purchase. Reactivated = it had bought before, had no purchase in the quarter just before, and bought again. ${qLabel(Q[0])} is the first quarter of data, so counting starts after it. Click a bar to select that month or quarter.`,
    kpis: [
      kpi(`New in ${mLabel(M[mi])}`, fmtN(newM[mi]), mi > 1 ? pct(newM[mi], newM[mi - 1]) : null, mi > 1 ? `vs ${mLabel(M[mi - 1])} (${fmtN(newM[mi - 1])})` : ''),
      kpi(all ? 'New, all quarters' : `New in ${qLabel(Q[qi])}`, fmtN(all ? sum(newQ) : newQ[qi]), all || qi < 2 ? null : pct(newQ[qi], newQ[qi - 1]), all || qi < 2 ? '' : `vs ${qLabel(Q[qi - 1])}`),
      kpi(all ? 'Reactivated, all quarters' : `Reactivated in ${qLabel(Q[qi])}`, !all && qi === 0 ? '–' : fmtN(all ? reUnique : stat[qi].re.length),
        all || qi < 2 ? null : pct(stat[qi].re.length, stat[qi - 1].re.length),
        all ? `${fmtN(reEvents)} reactivations (a retailer can come back more than once)` : qi === 0 ? 'first quarter of data' : `vs ${qLabel(Q[qi - 1])}: back after at least a quarter away`),
      kpi('Sales: completely new', fmtINR(nwSales), null, `${fmtN(nwCount)} retailers · ${share(nwSales)}`),
      kpi('Sales: reactivated', fmtINR(reSales), null, `${fmtN(all ? reEvents : stat[qi]?.re.length ?? 0)} retailers · ${share(reSales)}`),
      kpi('Bought again next quarter', rr != null ? `${rr.toFixed(1)}%` : all && avgRepeat != null ? `${avgRepeat.toFixed(1)}%` : '–', null,
        all ? 'average across cohorts' : rr == null ? 'next quarter not in the data yet' : `of the ${qLabel(Q[qi])} cohort`),
    ],
    charts: [
      { id: 'newM', title: 'New retailers by month', caption: `Selected: ${mLabel(M[mi])}`, kind: 'bar', labels: M.slice(1).map(mLabel), series: [{ name: 'New retailers', color: 'var(--brand)', values: newM.slice(1) }], highlight: [mi - 1], onClickKey: 'month',
        tipExtra: [{ name: 'Sales value (first month)', values: newMRev.slice(1), fmt: 'inr' }] },
      { id: 'newQ', title: 'New retailers by quarter', caption: all ? 'All quarters' : `Selected: ${qLabel(Q[qi])}`, kind: 'bar', labels: Q.slice(1).map(qLabel), series: [{ name: 'New retailers', color: 'var(--brand)', values: newQ.slice(1) }], highlight: all ? undefined : [qi - 1], onClickKey: 'quarter',
        tipExtra: [{ name: 'Sales value (joining quarter)', values: newQRev.slice(1), fmt: 'inr' }] },
      { id: 'catCount', title: 'Completely new vs reactivated retailers', caption: all ? 'All quarters' : `Selected: ${qLabel(Q[qi])}`, kind: 'stack', labels: qIdx.map((q) => qLabel(Q[q])),
        series: [{ name: 'Completely new', color: 'var(--brand)', values: qIdx.map((q) => stat[q].nw.length) }, { name: 'Reactivated', color: '#3b6fb6', values: qIdx.map((q) => stat[q].re.length) }],
        highlight: all || qi < 1 ? undefined : [qi - 1], onClickKey: 'quarter' },
      { id: 'catSalesQ', title: 'Sales from completely new vs reactivated retailers', caption: 'Purchases in the quarter by each group', kind: 'stack', labels: qIdx.map((q) => qLabel(Q[q])), fmt: 'inr',
        series: [{ name: 'Completely new', color: 'var(--brand)', values: qIdx.map((q) => stat[q].nwS) }, { name: 'Reactivated', color: '#3b6fb6', values: qIdx.map((q) => stat[q].reS) }],
        highlight: all || qi < 1 ? undefined : [qi - 1] },
      { id: 'catSalesM', title: 'Monthly sales: completely new vs reactivated', caption: 'Each month is split by how its quarter classed the retailer', kind: 'stack', labels: chartMonths.map((i) => mLabel(M[i])), fmt: 'inr', wide: true,
        series: [{ name: 'Completely new', color: 'var(--brand)', values: chartMonths.map((i) => sum(stat[MQ[i]].nw.map((r) => r.m[i]))) }, { name: 'Reactivated', color: '#3b6fb6', values: chartMonths.map((i) => sum(stat[MQ[i]].re.map((r) => r.m[i]))) }],
        highlight: all || qi < 1 ? undefined : chartMonths.map((i, k) => (MQ[i] === qi ? k : -1)).filter((k) => k >= 0) },
    ],
    tables: [
      { id: 'newQuarter', title: all ? 'Completely new retailers – all quarters' : `Completely new retailers – ${qLabel(Q[qi])}`,
        caption: all ? `${fmtN(qRows.length)} onboarded from ${qLabel(Q[1])} to ${qLabel(Q[LQ])}` : qi === 0 ? 'First quarter of data: no onboarding count' : `${fmtN(qRows.length)} onboarded in ${qLabel(Q[qi])}`,
        cols: [...baseCols, { k: 'FirstQ', label: 'Joined in' }, { k: 'FirstMonth', label: 'First month' }, inr('QRev', 'Joining qtr revenue'), ...(all ? [] : qMonths.map((i) => inr(M[i], mLabel(M[i])))), tier('Tier', 'Joining tier'), { k: 'Repeat', label: 'Bought next qtr' }, inr('Since', 'Revenue since joining'), tier('Cur', `Tier ${qLabel(Q[LQ])}`), ...geoCols], rows: qRows },
      { id: 'reactRows', title: all ? 'Reactivated retailers – all quarters' : `Reactivated retailers – ${qLabel(Q[qi])}`,
        caption: all ? `${fmtN(reRows.length)} reactivations by ${fmtN(reUnique)} retailers, ${qLabel(Q[1])} to ${qLabel(Q[LQ])}` : qi === 0 ? 'First quarter of data: nothing earlier to compare with' : `${fmtN(reRows.length)} retailers came back in ${qLabel(Q[qi])} after at least a quarter without a purchase`,
        cols: [...baseCols, { k: 'ReactQ', label: 'Reactivated in' }, { k: 'LastBefore', label: 'Last bought before' }, n('Gap', 'Quarters away'), inr('QRev', 'Reactivation qtr revenue'),
          ...(all ? [] : qMonths.map((i) => inr(M[i], mLabel(M[i])))), inr('Before', 'Revenue before the break'), inr('Since', 'Revenue since coming back'), tier('Tier', 'Tier that quarter'), tier('Cur', `Tier ${qLabel(Q[LQ])}`), ...geoCols],
        rows: reRows },
      { id: 'catQuarter', total: true, title: 'Completely new vs reactivated: sales by quarter', caption: 'Retailers and what they bought in each quarter. Continuing buyers are not in this table',
        cols: [{ k: 'Quarter', label: 'Quarter' }, n('NewN', 'Completely new retailers'), inr('NewS', 'Sales: completely new'), n('ReN', 'Reactivated retailers'), inr('ReS', 'Sales: reactivated'), inr('Both', 'Sales: both together'), inr('AllS', 'All sales in the quarter')], rows: catQuarter },
      { id: 'catMonth', total: true, title: all ? 'Completely new vs reactivated: sales by month' : `Completely new vs reactivated: sales by month, ${qLabel(Q[qi])}`,
        caption: 'Each month is split by how its quarter classed the retailer; retailers = those who bought in the month',
        cols: [{ k: 'Month', label: 'Month' }, { k: 'Quarter', label: 'Quarter' }, n('NewA', 'Completely new retailers'), inr('NewS', 'Sales: completely new'), n('ReA', 'Reactivated retailers'), inr('ReS', 'Sales: reactivated')], rows: catMonth },
      { id: 'newMonth', title: `New retailers – ${mLabel(M[mi])}`, caption: `${fmtN(mRows.length)} retailers made their first purchase in ${mLabel(M[mi])}`,
        cols: [...baseCols, inr('FirstRev', 'First month revenue'), inr('QRev', 'Quarter revenue'), inr('Since', 'Revenue since joining'), tier('Tier', 'Quarter tier'), ...geoCols], rows: mRows },
      { id: 'newCohorts', total: true, title: 'Onboarding cohorts', caption: `How each quarter's new retailers have done since. Still active and now tiered are for ${qLabel(Q[LQ])}.`,
        cols: [{ k: 'Quarter', label: 'Joined in' }, n('New', 'New retailers'), inr('Rev', 'Revenue in joining qtr'), n('Repeat', 'Bought again next qtr %'), n('StillActive', `Still active (${qLabel(Q[LQ])})`), n('Tiered', `Now tiered (${qLabel(Q[LQ])})`)], rows: cohort },
      { id: 'newByDist', total: true, title: 'New retailers by distributor and quarter', caption: 'Onboarding count per quarter',
        cols: [{ k: 'Distributor', label: 'Distributor', w: 28 }, { k: 'State', label: 'State' }, { k: 'Region', label: 'Region' }, ...Q.slice(1).map((q) => n(q, qLabel(q))), n('Total', 'Total')], rows: piv },
    ],
  };
}

/* ------------------------------------------------------------ 3. tier movement */
// Every retailer that bought in the quarter or the one before falls in one movement category (see moveOf).
// The Movement filter narrows the retailer list; the cards, chart, summary and distributor table show every category.
export function tierMovement(m: Model, f: Filters, rs: Retailer[]): View {
  const { Q, LQ, TIERS } = m;
  const below = `below ${fmtSlab(m.p.slabs.Yellow)}`;
  const all = f.q < 0;
  const qi = all ? LQ : f.q;
  const pq = qi - 1;
  if (pq < 0) return { lead: `${qLabel(Q[0])} is the first quarter of data. Select a later quarter (or All quarters) to see tier movement.`, tables: [] };
  const step = `${qLabel(Q[pq])} → ${qLabel(Q[qi])}`;
  const ti = (r: Retailer) => tierAt(r, qi);
  const tp = (r: Retailer) => tierAt(r, pq);

  // this quarter: the category of every moving retailer
  const mv = rs.map((r) => ({ r, mv: moveOf(r, qi) })).filter((x): x is { r: Retailer; mv: Move } => x.mv !== null);
  const byMove = (k: Move) => mv.filter((x) => x.mv === k).map((x) => x.r);
  const cnt = MOVES.map((k) => byMove(k).length);
  const curRev = MOVES.map((k) => sum(byMove(k).map((r) => r.q[qi])));
  const prevRev = MOVES.map((k) => sum(byMove(k).map((r) => r.q[pq])));
  const sel = f.mv ? MOVES.indexOf(f.mv as Move) : -1;

  const summary: Table = {
    id: 'moveSummary', total: true, title: `Tier movement summary, ${step}`,
    caption: 'Retailers that bought in either quarter, by movement. Sales are net purchases in each quarter.',
    cols: [{ k: 'Movement', label: 'Movement', w: 30 }, n('Retailers', 'Retailers'), n('Share', 'Share %'), inr('Cur', `${qLabel(Q[qi])} sales`),
      inr('Prev', `${qLabel(Q[pq])} sales`), inr('Change', 'Sales change')],
    rows: MOVES.map((k, i) => ({ Movement: k, Retailers: cnt[i], Share: mv.length ? round1((cnt[i] / mv.length) * 100) : 0, Cur: curRev[i], Prev: prevRev[i], Change: curRev[i] - prevRev[i] })),
  };
  const moveChart: Chart = {
    id: 'moveNow', title: `Retailers by tier movement, ${step}`, caption: 'Hover a bar for the number of retailers and their sales', kind: 'bar',
    labels: [...MOVES], series: [{ name: 'Retailers', color: 'var(--brand)', values: cnt }], colors: MOVES.map((k) => MOVE_COLOR[k]),
    highlight: sel >= 0 ? [sel] : undefined,
    tipExtra: [{ name: `${qLabel(Q[qi])} sales`, values: curRev, fmt: 'inr' }, { name: `${qLabel(Q[pq])} sales`, values: prevRev, fmt: 'inr' }],
  };

  // retailer list, narrowed by the Movement filter
  const listed = mv.filter((x) => !f.mv || x.mv === f.mv);
  const row = (x: { r: Retailer; mv: Move }) => ({
    ...base(x.r), Movement: x.mv, From: tp(x.r), To: ti(x.r), Prev: x.r.q[pq], Cur: x.r.q[qi], Change: x.r.q[qi] - x.r.q[pq], Growth: pct(x.r.q[qi], x.r.q[pq]),
  });
  const list: Table = {
    id: 'moveList', title: f.mv ? `${f.mv} – retailers, ${step}` : `Tier movement, ${step}`,
    caption: `${fmtN(listed.length)} retailers${f.mv ? '' : '. Use the Movement filter above to see one category'}`,
    cols: [...baseCols, { k: 'Movement', label: 'Movement', w: 26 }, tier('From', `${qLabel(Q[pq])} tier`), tier('To', `${qLabel(Q[qi])} tier`),
      inr('Prev', `${qLabel(Q[pq])} sales`), inr('Cur', `${qLabel(Q[qi])} sales`), inr('Change', 'Sales change'), pc('Growth', 'Change %'), ...geoCols],
    rows: listed.map(row).sort((a, b) => MOVES.indexOf(a.Movement) - MOVES.indexOf(b.Movement) || b.Cur - a.Cur),
  };

  // by distributor: one column per category
  const groups = new Map<string, Row>();
  mv.forEach(({ r, mv: k }) => {
    const g = groups.get(r.dist) ?? { Distributor: r.dist, State: r.state, Region: r.region, ...Object.fromEntries(MOVES.map((x) => [x, 0])), Total: 0 };
    g[k] = Number(g[k]) + 1;
    g.Total = Number(g.Total) + 1;
    groups.set(r.dist, g);
  });
  const byDist: Table = {
    id: 'tierByDist', total: true, title: `Tier movement by distributor, ${step}`, caption: 'Retailers per movement category',
    cols: [{ k: 'Distributor', label: 'Distributor', w: 28 }, { k: 'State', label: 'State' }, { k: 'Region', label: 'Region' }, ...MOVES.map((k) => n(k, k)), n('Total', 'Total')],
    rows: [...groups.values()].sort((a, b) => Number(b.Total) - Number(a.Total)),
  };

  const tone = (k: Move): Kpi['tone'] =>
    k === 'Upgraded' || k === 'New' ? 'up' : k === 'Downgraded' || k === 'Dropped from the tier' || k === 'No sales' ? 'down' : undefined;
  const kpis = MOVES.map((k, i) => kpi(k, fmtN(cnt[i]), null, k === 'No sales' ? `${fmtINR(prevRev[i])} bought last qtr` : `${fmtINR(curRev[i])} sales`, tone(k)));

  if (all) {
    // every quarter-to-quarter step, one bar segment per category
    const steps = Q.slice(1).map((q, j) => {
      const i = j + 1;
      const c = Object.fromEntries(MOVES.map((k) => [k, 0])) as Record<Move, number>;
      rs.forEach((r) => {
        const k = moveOf(r, i);
        if (k) c[k]++;
      });
      return { Period: `${qLabel(Q[i - 1])} → ${qLabel(q)}`, ...c, Total: sum(MOVES.map((k) => c[k])) };
    });
    const journey = rs.filter((r) => r.best > 0).map((r) => {
      let up = 0;
      let dn = 0;
      for (let i = 1; i < Q.length; i++) {
        if (tierAt(r, i) > tierAt(r, i - 1)) up++;
        else if (tierAt(r, i) < tierAt(r, i - 1)) dn++;
      }
      return { ...base(r), ...Object.fromEntries(Q.map((q, i) => [`T${q}`, r.t[i]])), Best: r.best, Cur: r.t[LQ], Ups: up, Downs: dn, Life: r.life };
    }).sort((a, b) => b.Cur - a.Cur || b.Life - a.Life);
    return {
      lead: `All quarters: how retailers moved in every quarter-to-quarter step. The cards, summary, retailer list and distributor table are for the latest step, ${step}; select a quarter to see another one. Untiered = buying ${below}.`,
      kpis,
      charts: [
        { id: 'moveSteps', title: 'Tier movement per quarter', caption: 'Retailers in each movement category, every quarter-to-quarter step', kind: 'stack', wide: true,
          labels: steps.map((s) => s.Period), series: MOVES.map((k) => ({ name: k, color: MOVE_COLOR[k], values: steps.map((s) => s[k]) })) },
        moveChart,
      ],
      tables: [
        { id: 'moveSteps', total: true, title: 'Tier movement, quarter by quarter', caption: 'Retailers per movement category in each step',
          cols: [{ k: 'Period', label: 'Period', w: 22 }, ...MOVES.map((k) => n(k, k)), n('Total', 'Total')], rows: steps },
        summary,
        list,
        byDist,
        { id: 'tierJourney', title: 'Tier by quarter, per retailer', caption: 'Every retailer that reached a tier at least once, current tier first',
          cols: [...baseCols, ...Q.map((q) => tier(`T${q}`, qLabel(q))), tier('Best', 'Best tier'), n('Ups', '# upgrades'), n('Downs', '# downgrades'), inr('Life', 'Total revenue'), ...geoCols], rows: journey },
      ],
    };
  }

  const mat = TIERS.map(() => TIERS.map(() => 0));
  mv.forEach(({ r }) => mat[tp(r)][ti(r)]++);
  return {
    lead: `${step}. Every retailer that bought in either quarter, in one movement category. Untiered = buying ${below}.`,
    kpis,
    charts: [moveChart],
    tables: [
      summary,
      list,
      { id: 'tierMatrix', title: 'Tier movement matrix', caption: `Rows: ${qLabel(Q[pq])} tier · Columns: ${qLabel(Q[qi])} tier. Green moved up, red moved down. Untiered includes retailers that bought ${below} or nothing.`, matrix: true,
        cols: [{ k: 'From', label: `${qLabel(Q[pq])} ↓   ${qLabel(Q[qi])} →` }, ...TIERS.map((t) => n(t, t)), n('Total', 'Total')],
        rows: TIERS.map((t, i) => ({ From: t, FromIdx: i, ...Object.fromEntries(TIERS.map((u, j) => [u, mat[i][j]])), Total: sum(mat[i]) })) },
      byDist,
    ],
  };
}

/* ------------------------------------------------------------ 4a. retention & growth */
// New + Reactivated - Churned for every quarter-to-quarter step, with the cohort retention trend. Same meanings as
// the rest of the dashboard: new = first-ever purchase in the quarter; reactivated = bought in it and earlier but not in
// the quarter before; churned = bought in the quarter before and nothing in this one.
function growthSection(m: Model, f: Filters, rs: Retailer[]): Section | null {
  const { Q, LQ } = m;
  const all = f.q < 0;
  const qi = all ? LQ : f.q;
  if (qi < 1) return null;
  const newOf = (q: number) => rs.filter((r) => r.firstQ === q && active(r, q));
  const reactOf = (q: number) => rs.filter((r) => kindIn(r, q) === 'react');
  const churnOf = (q: number) => rs.filter((r) => active(r, q - 1) && !active(r, q));
  const qIdx = Q.map((_, i) => i).filter((i) => i > 0);
  const steps = qIdx.map((q) => {
    const nw = newOf(q);
    const re = reactOf(q);
    const ch = churnOf(q);
    const before = rs.filter((r) => active(r, q - 1)).length;
    return {
      q, nw: nw.length, re: re.length, ch: ch.length, net: nw.length + re.length - ch.length, before, after: rs.filter((r) => active(r, q)).length,
      nwS: qRev(nw, q), reS: qRev(re, q), chS: qRev(ch, q - 1), kept: before - ch.length,
    };
  });
  const cur = steps[qi - 1];
  const prv = qi >= 2 ? steps[qi - 2] : null;
  const signed = (v: number) => `${v > 0 ? '+' : ''}${fmtN(v)}`;
  const kpis: Kpi[] = [
    kpi('New retailers', fmtN(cur.nw), prv ? pct(cur.nw, prv.nw) : null, `${fmtINR(cur.nwS)} bought in ${qLabel(Q[qi])}`, 'up'),
    kpi('Reactivated retailers', fmtN(cur.re), prv ? pct(cur.re, prv.re) : null, `${fmtINR(cur.reS)} bought in ${qLabel(Q[qi])}`, 'up'),
    kpi('Churned retailers', fmtN(cur.ch), null, `${fmtINR(cur.chS)} bought in ${qLabel(Q[qi - 1])}`, 'down'),
    kpi('Net effective additions', signed(cur.net), null, `${fmtN(cur.before)} active in ${qLabel(Q[qi - 1])} → ${fmtN(cur.after)} in ${qLabel(Q[qi])}`, cur.net >= 0 ? 'up' : 'down'),
  ];
  // 'Q2→Q3 FY26' (or 'Q4 FY25→Q1 FY26' across a year end)
  const stepLabel = (q: number) => {
    const [aq, afy] = Q[q - 1].split('_');
    const [bq, bfy] = Q[q].split('_');
    return afy === bfy ? `${aq}→${bq} ${bfy}` : `${aq} ${afy}→${bq} ${bfy}`;
  };
  const label = qIdx.map(stepLabel);
  const hi = all ? undefined : [qi - 1];
  const NEW = '#1f2f5a';
  const REACT = '#ff5a36';
  const CHURN = '#9aa5b8';
  const charts: Chart[] = [
    { id: 'growthStack', title: 'New vs reactivated entrants, by quarter transition', caption: all ? 'All quarters' : `Selected: ${qLabel(Q[qi])}`, kind: 'stack', labels: label, valueLabels: true,
      series: [{ name: 'New', color: NEW, values: steps.map((s) => s.nw) }, { name: 'Reactivated', color: REACT, values: steps.map((s) => s.re) }],
      highlight: hi, onClickKey: 'quarter' },
    { id: 'growthCompare', title: 'New, reactivated and churned by quarter', caption: 'Quarter-wise comparison', kind: 'group', labels: label, wide: true,
      series: [{ name: 'New', color: NEW, values: steps.map((s) => s.nw) }, { name: 'Reactivated', color: REACT, values: steps.map((s) => s.re) },
        { name: 'Churned', color: CHURN, values: steps.map((s) => s.ch) }], highlight: hi, onClickKey: 'quarter' },
    { id: 'growthNet', title: 'Net effective additions by quarter', caption: 'New + Reactivated − Churned. Green = the active base grew, red = it shrank', kind: 'bar', labels: label, wide: true,
      series: [{ name: 'Net effective additions', color: 'var(--brand)', values: steps.map((s) => s.net) }],
      colors: steps.map((s) => (s.net >= 0 ? MOVE_COLOR.Upgraded : MOVE_COLOR.Downgraded)), highlight: hi, onClickKey: 'quarter' },
  ];

  // cohort retention: of the retailers that joined in a quarter, the % that bought again k quarters later
  const cohorts = qIdx.map((c) => {
    const grp = newOf(c);
    const row: Row = { Cohort: qLabel(Q[c]), Size: grp.length };
    const trend: (number | null)[] = [];
    for (let k = 1; k < Q.length; k++) {
      const v = c + k <= LQ && grp.length ? round1((grp.filter((r) => active(r, c + k)).length / grp.length) * 100) : null;
      row[`k${k}`] = v;
      trend.push(v);
    }
    return { row, trend, c };
  });
  const palette = ['#1f2f5a', '#ff5a36', '#4a7fd1', '#2a9d8f', '#e9a23b', '#8d6cab', '#9aa5b8'];
  if (cohorts.some((x) => x.trend.some((v) => v != null))) {
    charts.unshift({
      id: 'cohortTrend', title: 'Retention by cohort: % of cohort still active', caption: 'Period 1 is the joining quarter (100%); each later period is the share that bought in that quarter', kind: 'line', fmt: 'pct', domain: [0, 100],
      labels: Array.from({ length: Q.length }, (_, k) => `Period ${k + 1}`),
      series: cohorts.filter((x) => x.trend.some((v) => v != null)).map((x, i) => ({ name: `${qLabel(Q[x.c])} cohort`, color: palette[i % palette.length], values: [100, ...x.trend] })),
    });
  }

  const metrics: [string, (s: (typeof steps)[number]) => number][] = [['New (first-ever transaction)', (s) => s.nw], ['Reactivated (win-back)', (s) => s.re],
    ['Churned', (s) => s.ch], ['Net effective add', (s) => s.net]];
  const tables: Table[] = [
    { id: 'growthAdds', title: 'Effective retailers added per quarter = New + Reactivated − Churned',
      caption: 'One column per quarter transition. Churned = bought in the earlier quarter, nothing in the later one',
      cols: [{ k: 'Metric', label: 'Metric', w: 34 }, ...steps.map((s) => n(`s${s.q}`, stepLabel(s.q)))],
      rows: metrics.map(([name, pick]) => ({ Metric: name, ...Object.fromEntries(steps.map((s) => [`s${s.q}`, pick(s)])) })) },
    { id: 'growthQoQ', title: 'New, reactivated, churned and net additions, quarter on quarter',
      caption: 'Every quarter-to-quarter step. Active this quarter = active last quarter + new + reactivated − churned',
      cols: [{ k: 'Step', label: 'Quarter step', w: 26 }, n('Before', 'Active last qtr'), n('New', 'New'), n('React', 'Reactivated'), n('Churned', 'Churned'), n('Net', 'Net effective additions'),
        n('After', 'Active this qtr'), n('Rate', 'Retention %'), inr('NewS', 'Sales: new'), inr('ReS', 'Sales: reactivated'), inr('ChS', 'Churned: bought last qtr')],
      rows: steps.map((s) => ({
        Step: `${qLabel(Q[s.q - 1])} → ${qLabel(Q[s.q])}`, Before: s.before, New: s.nw, React: s.re, Churned: s.ch, Net: s.net, After: s.after,
        Rate: s.before ? round1((s.kept / s.before) * 100) : null, NewS: s.nwS, ReS: s.reS, ChS: s.chS,
      })) },
    { id: 'cohortRet', title: 'Cohort retention',
      caption: 'Each row is the retailers whose first-ever purchase was in that quarter; the columns are the % of them that bought in each later quarter',
      cols: [{ k: 'Cohort', label: 'Joined in' }, n('Size', 'Retailers'), ...Array.from({ length: Q.length - 1 }, (_, k) => n(`k${k + 1}`, `After ${k + 1} qtr${k ? 's' : ''} %`))],
      rows: cohorts.map((x) => x.row) },
  ];
  return {
    id: 'growth', title: 'Retention & Growth', kpis, charts, tables,
    lead: `Net effective additions ${prv ? (cur.net >= prv.net ? 'rose' : 'fell') : 'were'} ${prv ? `from ${signed(prv.net)} (${stepLabel(qi - 1)}) to ` : ''}${signed(cur.net)} in ${stepLabel(qi)}: `
      + `${fmtN(cur.nw + cur.re)} entered (${fmtN(cur.nw)} new + ${fmtN(cur.re)} reactivated) and ${fmtN(cur.ch)} churned. `
      + `The cards show this step${all ? ' (the latest: select a quarter for another one)' : ''}; the charts and tables compare every quarter.`,
  };
}

/* ------------------------------------------------------------ 4. retention */
export function retention(m: Model, f: Filters, rs: Retailer[]): View {
  const { Q, LQ, M } = m;
  const growth = growthSection(m, f, rs);
  const rate = Q.map((_, q) => {
    if (q === 0) return null;
    const p = rs.filter((r) => active(r, q - 1));
    return p.length ? round1((p.filter((r) => active(r, q)).length / p.length) * 100) : null;
  });
  const chart: Chart = { id: 'ret', title: 'Retention % by quarter', caption: 'Share of the previous quarter’s buyers who bought again', kind: 'line', labels: Q.slice(1).map(qLabel), series: [{ name: 'Retention %', color: 'var(--brand)', values: rate.slice(1) }], fmt: 'pct', wide: true };
  const dormant = rs.filter((r) => r.life > 0 && r.lastQ < LQ).map((r) => ({ ...base(r), LastQ: qLabel(Q[r.lastQ]), LastRev: r.q[r.lastQ], Best: r.best, Life: r.life, Gap: LQ - r.lastQ })).sort((a, b) => a.Gap - b.Gap || b.Life - a.Life);
  const dormantTable: Table = { id: 'dormant', title: 'Dormant retailers', caption: `Bought before but not in ${qLabel(Q[LQ])} (the latest quarter). Most recently lapsed first.`,
    cols: [...baseCols, { k: 'LastQ', label: 'Last bought in' }, inr('LastRev', 'Last qtr revenue'), tier('Best', 'Best tier'), inr('Life', 'Lifetime revenue'), ...geoCols], rows: dormant };
  // per distributor: retention into quarter qi
  const byDist = (qi: number) => {
    const groups = new Map<string, Row>();
    rs.filter((r) => active(r, qi - 1)).forEach((r) => {
      const g = groups.get(r.dist) ?? { Distributor: r.dist, State: r.state, Region: r.region, Base: 0, Kept: 0, KeptRev: 0, Lost: 0, LostRev: 0 };
      g.Base = Number(g.Base) + 1;
      if (active(r, qi)) { g.Kept = Number(g.Kept) + 1; g.KeptRev = Number(g.KeptRev) + r.q[qi]; }
      else { g.Lost = Number(g.Lost) + 1; g.LostRev = Number(g.LostRev) + r.q[qi - 1]; }
      groups.set(r.dist, g);
    });
    return [...groups.values()].map((g) => ({ ...g, Rate: Number(g.Base) ? round1((Number(g.Kept) / Number(g.Base)) * 100) : 0 })).sort((a, b) => a.Rate - b.Rate);
  };
  const distCols = (qi: number): Col[] => [{ k: 'Distributor', label: 'Distributor', w: 28 }, { k: 'State', label: 'State' }, { k: 'Region', label: 'Region' }, n('Base', `Active ${qLabel(Q[qi - 1])}`), n('Kept', 'Retained'), n('Rate', 'Retention %'), inr('KeptRev', `Retained revenue (${qLabel(Q[qi])})`), n('Lost', 'Lapsed'), inr('LostRev', `Lapsed revenue (${qLabel(Q[qi - 1])})`)];
  if (f.q < 0) {
    const per = Q.slice(1).map((q, j) => {
      const i = j + 1;
      const p = rs.filter((r) => active(r, i - 1));
      const kept = p.filter((r) => active(r, i)).length;
      return { Quarter: qLabel(q), Base: p.length, Kept: kept, KeptRev: sum(p.filter((r) => active(r, i)).map((r) => r.q[i])), Lost: p.length - kept, Rate: p.length ? round1((kept / p.length) * 100) : 0,
        LostRev: sum(p.filter((r) => !active(r, i)).map((r) => r.q[i - 1])), React: rs.filter((r) => active(r, i) && !active(r, i - 1) && r.firstQ < i).length };
    });
    return {
      lead: `With All quarters selected, retention by distributor is for the latest step (${qLabel(Q[LQ - 1])} → ${qLabel(Q[LQ])}). Select a quarter for its lapsed and reactivated lists.`,
      kpis: [
        kpi(`Bought in ${qLabel(Q[LQ])}`, fmtN(rs.filter((r) => active(r, LQ)).length), null, 'latest quarter'),
        kpi('Average retention', per.length ? `${(sum(per.map((p) => p.Rate)) / per.length).toFixed(1)}%` : '–', null, 'across quarters'),
        kpi(`Dormant (nothing in ${qLabel(Q[LQ])})`, fmtN(dormant.length), null, `${fmtINR(sum(dormant.map((d) => d.Life)))} bought earlier`, 'down'),
      ],
      charts: [chart],
      tables: [
        { id: 'retByQuarter', total: true, title: 'Retention by quarter', cols: [{ k: 'Quarter', label: 'Quarter' }, n('Base', 'Active prev qtr'), n('Kept', 'Retained'), n('Rate', 'Retention %'), inr('KeptRev', 'Retained revenue (that qtr)'), n('Lost', 'Lapsed'), inr('LostRev', 'Lapsed revenue (prev qtr)'), n('React', 'Reactivated')], rows: per },
        ...(LQ > 0 ? [{ id: 'retByDist', total: true, title: `Retention by distributor – ${qLabel(Q[LQ])}`, caption: 'Lowest retention first', cols: distCols(LQ), rows: byDist(LQ) }] : []),
        dormantTable,
      ],
      sections: growth ? [growth] : undefined,
    };
  }
  const qi = f.q;
  const pq = qi - 1;
  if (pq < 0) return { lead: `${qLabel(Q[0])} is the first quarter of data. Select a later quarter (or All quarters) to see retention.`, tables: [dormantTable] };
  const prevAct = rs.filter((r) => active(r, pq));
  const kept = prevAct.filter((r) => active(r, qi));
  const lapsed = prevAct.filter((r) => !active(r, qi));
  const react = rs.filter((r) => active(r, qi) && !active(r, pq) && r.firstQ < qi);
  return {
    kpis: [
      kpi(`Active in ${qLabel(Q[pq])}`, fmtN(prevAct.length)),
      kpi(`Retained in ${qLabel(Q[qi])}`, `${prevAct.length ? ((kept.length / prevAct.length) * 100).toFixed(1) : 0}%`, null,
        `${fmtN(kept.length)} retailers · ${fmtINR(sum(kept.map((r) => r.q[qi])))} bought this quarter`, 'up'),
      kpi('Lapsed', fmtN(lapsed.length), null, `${fmtINR(sum(lapsed.map((r) => r.q[pq])))} bought last quarter`, 'down'),
      kpi('Reactivated', fmtN(react.length), null, 'bought again after a gap', 'up'),
    ],
    charts: [chart],
    tables: [
      { id: 'retByDist', total: true, title: 'Retention by distributor', caption: 'Lowest retention first', cols: distCols(qi), rows: byDist(qi) },
      { id: 'lapsed', title: 'Lapsed retailers', caption: `Bought in ${qLabel(Q[pq])}, nothing in ${qLabel(Q[qi])}`,
        cols: [...baseCols, tier('Tier', `${qLabel(Q[pq])} tier`), inr('Prev', `${qLabel(Q[pq])} revenue`), { k: 'LastMonth', label: 'Last purchase' }, inr('Life', 'Lifetime revenue'), ...geoCols],
        rows: lapsed.map((r) => ({ ...base(r), Tier: r.t[pq], Prev: r.q[pq], LastMonth: mLabel(M[r.m.reduce((a, v, i) => (v > 0 && i < M.length ? i : a), 0)]), Life: r.life })).sort((a, b) => b.Prev - a.Prev) },
      { id: 'reactivated', title: 'Reactivated retailers', caption: `Bought in ${qLabel(Q[qi])} after skipping ${qLabel(Q[pq])}`,
        cols: [...baseCols, inr('Cur', `${qLabel(Q[qi])} revenue`), tier('Tier', 'Tier'), inr('Life', 'Lifetime revenue'), ...geoCols],
        rows: react.map((r) => ({ ...base(r), Cur: r.q[qi], Tier: r.t[qi], Life: r.life })).sort((a, b) => b.Cur - a.Cur) },
      dormantTable,
    ],
    sections: growth ? [growth] : undefined,
  };
}

/* ------------------------------------------------------------ 5. upgrade pipeline */
const NEXT = ['Yellow', 'Green', 'Silver', 'Gold', 'Platinum'];
export function pipeline(m: Model, f: Filters, rs: Retailer[]): View {
  const qi = qSel(m, f);
  const band = f.near / 100;
  const slab = Object.fromEntries(NEXT.map((t) => [t, slabAt(m.p, t, m.Q[qi])]));   // the slabs of the selected quarter
  const rows: Row[] = [];
  rs.forEach((r) => {
    const cur = r.basis[qi];
    if (cur <= 0) return;
    const t = tierAt(r, qi);
    const nx = NEXT[t];
    if (!nx || !tierInForce(m.p, nx, m.Q[qi])) return; // no Platinum to move up to before Q1 FY 27
    const need = slab[nx] - cur;
    if (need <= 0 || need > slab[nx] * band) return;
    rows.push({ ...base(r), Tier: t, Next: nx, Cur: cur, Target: slab[nx], Pct: Math.floor((cur / slab[nx]) * 1000) / 10, Gap: need, PerMonth: need / 3 });
  });
  rows.sort((a, b) => Number(a.Gap) - Number(b.Gap));
  return {
    note: f.q < 0 ? `The upgrade pipeline looks at one quarter. With All quarters selected it uses the latest, ${qLabel(m.Q[m.LQ])}.` : undefined,
    lead: `Retailers whose ${qLabel(m.Q[qi])} purchase is within ${f.near}% of the next slab. Gap per month = gap ÷ 3, the extra monthly purchase needed over a quarter to move up.`,
    kpis: NEXT.map((t) => kpi(`Near ${t}`, tierInForce(m.p, t, m.Q[qi]) ? fmtN(rows.filter((r) => r.Next === t).length) : '–', null,
      tierInForce(m.p, t, m.Q[qi]) ? `slab ${fmtSlab(slab[t])}` : `tier starts in ${qLabel(tierFrom(m.p)[t])}`)),
    tables: [{ id: 'pipeline', title: 'Upgrade pipeline', caption: `${fmtN(rows.length)} retailers, smallest gap first`,
      cols: [...baseCols, tier('Tier', 'Current tier'), { k: 'Next', label: 'Next tier' }, inr('Cur', 'Quarter purchase'), inr('Target', 'Next slab'), n('Pct', '% of slab'), inr('Gap', 'Gap to slab'), inr('PerMonth', 'Gap per month'), ...geoCols], rows }],
  };
}

/* ------------------------------------------------------------ 8. retailer lookup */
export function lookup(m: Model, rs: Retailer[], search: string): View {
  const s = search.trim().toLowerCase();
  const hits = s ? rs.filter((r) => r.key.includes(s)) : rs.slice().sort((a, b) => b.life - a.life);
  return {
    tables: [{
      id: 'register', title: 'Retailer register', caption: s ? `${fmtN(hits.length)} matches for “${search.trim()}”` : 'All retailers, highest lifetime revenue first. Click a name for its detail panel.',
      cols: [{ k: 'ID', label: 'Retailer ID', w: 12 }, ...baseCols, ...geoCols, inr('Life', 'Lifetime revenue'), ...m.Q.flatMap((q) => [inr(q, qLabel(q)), tier(`T${q}`, `${qLabel(q)} tier`)])],
      rows: hits.map((r) => ({ ...base(r), Life: r.life, ...Object.fromEntries(m.Q.flatMap((q, i) => [[q, r.q[i]], [`T${q}`, r.t[i]]])) })),
    }],
  };
}

export type ViewKey = 'overview' | 'new' | 'tier' | 'retention' | 'pipeline';
export const VIEWS: Record<ViewKey, (m: Model, f: Filters, rs: Retailer[]) => View> = {
  overview, new: newRetailers, tier: tierMovement, retention, pipeline,
};
