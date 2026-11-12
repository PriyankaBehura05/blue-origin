import { useMemo } from 'react';
import { ArrowRight, FileText, IndianRupee, Percent, Phone, Presentation, RefreshCw, Store, TriangleAlert, Wallet } from 'lucide-react';
import { Card, Delta, Kpi, NeedsData, Pct, Section, STROKE, inr, num, pctTxt, useLeads, type KpiProps } from '../ui';
import { Donut, HBars, StackedBars } from '../charts';
import { categoryColor, OUTCOME_COLORS, SECTIONS, SOURCE_COLORS } from '../sections';
import { leadOk, monthName, NEW, NOT_CONVERTED, PENDING, REACTIVATED, wasCalled, prevPeriod, rangeOf, ORGANIC, outcomeOf, LEVEL_NAMES, periodMonths, periodName, quarterName, rag, spendIn, wilson, type Filters, type Model, type Range } from '../model';
import { leadStats, monthlySeries, newPerMonth, retailerStats, runRate } from '../calc';

export interface Insight {
  insight: string;
  number: string;
  action: string;
  owner: string;
}

function useCover() {
  const { M, f, rg, prev } = useLeads();
  return useMemo(() => {
    const t = M.p.targets;
    const scale = periodMonths(rg) / 3;
    const L = leadStats(M, f, rg);
    const Lp = prev ? leadStats(M, f, prev) : null;
    const S = retailerStats(M, f, rg, prev);
    const p1 = prevPeriod(M, f.period);
    const p2 = p1 ? prevPeriod(M, p1) : null;
    const Sp = prev ? retailerStats(M, f, prev, p2 ? rangeOf(M, p2) : null) : null;
    const spend = spendIn(M, rg, f.campaign);
    const spendP = prev ? spendIn(M, prev, f.campaign) : 0;
    const rr = runRate(M, f);
    const series = monthlySeries(M, f);
    const npm = newPerMonth(M, f);
    // period views for the charts: call results, top states, ASMs
    const LL = M.p.leads;
    const cat = new Map<number, number>();
    const st = new Map<number, { n: number; k: number }>();
    const asm = new Map<number, { n: number; called: number }>();
    const bySrc = M.p.dims.source.map(() => ({ n: 0, judged: 0, k: 0 }));
    let unassigned = 0;
    for (let i = 0; i < M.nL; i++) {
      if (!LL.uniq[i] || !leadOk(M, f, i, rg)) continue;
      if (LL.status[i] >= 0) cat.set(LL.status[i], (cat.get(LL.status[i]) ?? 0) + 1);
      const o = outcomeOf(M, i, f.level, f.window);
      const src = bySrc[LL.src[i]];
      src.n++;
      if (LL.valid[i] && o !== PENDING) src.judged++;
      if (o === NEW) src.k++;
      const s = LL.s[i];
      if (s >= 0) {
        const e = st.get(s) ?? { n: 0, k: 0 };
        e.n++;
        if (outcomeOf(M, i, f.level, f.window) === NEW) e.k++;
        st.set(s, e);
      }
      if (LL.owner[i] >= 0) {
        const e = asm.get(LL.owner[i]) ?? { n: 0, called: 0 };
        e.n++;
        if (wasCalled(M, i)) e.called++;
        asm.set(LL.owner[i], e);
      } else if (LL.valid[i]) unassigned++;
    }
    const views = {
      cats: [...cat.entries()].sort((x, y) => y[1] - x[1]).map(([j, v]) => ({ key: String(j), label: M.p.dims.status[j], value: v, color: categoryColor(M.p.dims.status[j]) })),
      states: [...st.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 8).map(([j, e]) => ({ key: String(j), label: M.p.dims.state[j], value: e.n, note: `${num(e.k)} new` })),
      asms: [...asm.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 10).map(([j, e]) => ({ key: String(j), label: M.p.dims.owner[j], value: e.n, note: `${pctTxt(e.called, e.n, 0)} called`, color: 'var(--ld-seq-3)' })),
      unassigned,
      sources: bySrc.map((e, j) => ({ ...e, j })).filter((e) => e.n > 0),
    };
    return { t, scale, L, Lp, S, Sp, spend, spendP, rr, series, npm, views };
  }, [M, f, rg, prev]);
}

export function buildInsights(M: Model, c: ReturnType<typeof useCover>, f: Filters, rg: Range): Insight[] {
  const out: Insight[] = [];
  const { L, S, t } = c;
  const noSales = rg[0] > M.p.salesEnd; // the sales data has not reached this period at all
  const undecided = L.out[PENDING] > 0 && L.out[NEW] + L.out[NOT_CONVERTED] === 0; // no lead can be judged yet
  if (!M.p.hasLeads) {
    out.push({ insight: 'No leads yet', number: 'No lead sheet is linked',
      action: 'Link the lead Google Sheet on the Data & settings page', owner: 'Marketing Lead' });
  } else {
    const conv = L.judged ? (100 * L.out[NEW]) / L.judged : 0;
    if (undecided) out.push({ insight: 'Waiting for sales data',
      number: `${num(L.out[PENDING])} leads are pending sales data (sales run to ${monthName(M, M.p.salesEnd)}); we cannot tell yet who became a retailer`,
      action: 'Keep calling the new leads now; results fill in by themselves when the sales data arrives', owner: 'Marketing Lead + RSMs' });
    else out.push({ insight: conv >= t.conversion_pct ? 'More leads than planned are becoming retailers' : 'Too few leads are becoming retailers',
      number: `${conv.toFixed(1)}% of ${num(L.judged)} leads became new retailers (target ${t.conversion_pct}%)${L.out[PENDING] ? `; ${num(L.out[PENDING])} leads are pending sales data` : ''}`,
      action: conv >= t.conversion_pct ? 'Put more budget into the best campaigns' : 'Call every new lead within 2 days before spending more on ads',
      owner: 'Marketing Lead + RSMs' });
    // best and worst campaign by conversion (30+ valid unique leads)
    const per = new Map<number, { n: number; k: number }>();
    for (let i = 0; i < M.nL; i++) {
      if (!M.p.leads.uniq[i] || !M.p.leads.valid[i] || outcomeOf(M, i, f.level, f.window) === PENDING || !leadOk(M, f, i, rg, ['campaign', 'outcome'])) continue;
      const e = per.get(M.p.leads.camp[i]) ?? { n: 0, k: 0 };
      e.n++;
      if (outcomeOf(M, i, f.level, f.window) === NEW) e.k++;
      per.set(M.p.leads.camp[i], e);
    }
    const ranked = [...per.entries()].filter(([, e]) => e.n >= 30).map(([cmp, e]) => ({ cmp, r: e.k / e.n, ...e })).sort((a, b) => b.r - a.r);
    if (ranked.length >= 2) {
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      out.push({ insight: 'Some campaigns work much better than others', number: `'${M.p.dims.campaign[best.cmp]}' ${(100 * best.r).toFixed(1)}% vs '${M.p.dims.campaign[worst.cmp]}' ${(100 * worst.r).toFixed(1)}%`,
        action: 'Move budget from the weakest campaign to the best one this month', owner: 'Marketing Lead' });
    }
    const share = S.newAll ? (100 * S.newMkt) / S.newAll : 0;
    if (!noSales) out.push({ insight: 'How many new retailers came from leads', number: `${num(S.newMkt)} of ${num(S.newAll)} new retailers (${share.toFixed(0)}%; target ${t.marketing_share_pct}%)`,
      action: share >= t.marketing_share_pct ? 'Keep the mix and check cost per lead monthly' : 'Spend more on the sources and campaigns that bring the most new retailers',
      owner: 'Marketing Lead' });
  }
  if (S.prevBilled && !noSales) {
    const ret = (100 * S.retained) / S.prevBilled;
    out.push({ insight: ret >= t.retention_pct ? 'Retailers keep buying, on target' : 'Fewer retailers bought again than planned',
      number: `${ret.toFixed(1)}% of ${num(S.prevBilled)} retailers who bought last period bought again (target ${t.retention_pct}%)`,
      action: 'Plan ASM visits for the at-risk list (Retailers & actions page)', owner: 'RSMs' });
  }
  if (!noSales) out.push({ insight: 'Sales at risk', number: `${num(S.atRisk)} retailers have not ordered for 2 months; they used to buy ${inr(S.atRiskRevenue)} a quarter`,
    action: 'WhatsApp and an ASM call within 2 weeks; note who comes back in the action list', owner: 'ASMs via RSMs' });
  return out.slice(0, 5);
}

export default function Cover({ onAddAction }: { onAddAction: (i: Insight) => void }) {
  const ctx = useLeads();
  const { M, f, rg } = ctx;
  const c = useCover();
  const insights = useMemo(() => buildInsights(M, c, f, rg), [M, c, f, rg]);
  const { L, Lp, S, Sp, t, scale, spend, spendP, rr } = c;
  // no lead here can be judged new-or-not yet (only shops already buying are known): pending, not 0%
  const conv = L.judged && (L.out[NEW] + L.out[NOT_CONVERTED] > 0 || !L.out[PENDING]) ? (100 * L.out[NEW]) / L.judged : null;
  const convP = Lp && Lp.judged ? (100 * Lp.out[NEW]) / Lp.judged : null;
  const ret = S.prevBilled ? (100 * S.retained) / S.prevBilled : null;
  const retP = Sp && Sp.prevBilled ? (100 * Sp.retained) / Sp.prevBilled : null;
  const riskPct = S.revenue ? (100 * S.atRiskRevenue) / S.revenue : null;
  const cpr = L.out[NEW] ? spend / L.out[NEW] : null;
  const cprP = Lp && Lp.out[NEW] ? spendP / Lp.out[NEW] : null;
  const ci = conv !== null ? wilson(L.out[NEW], L.judged) : null;

  const ser = c.series;
  const lastLead = ser.leads.reduce((a, v, i) => (v > 0 ? i : a), -1);
  const tail = (a: number[], to: number) => a.slice(Math.max(0, to - 11), to + 1);
  const tiles: KpiProps[] = [
    { icon: Phone, label: 'Leads', value: M.p.hasLeads ? num(L.unique) : '—', sub: M.p.hasLeads ? `different mobile numbers · ${num(L.rows)} enquiries in all` : 'No lead sheet linked yet',
      rag: M.p.hasLeads ? rag(L.unique, t.unique_leads_quarter * scale) : 'none', ragNote: `Target ${num(t.unique_leads_quarter * scale)} for this period`,
      delta: <Delta cur={M.p.hasLeads ? L.unique : null} prev={Lp?.unique ?? null} />, spark: lastLead >= 0 ? tail(ser.leads, lastLead) : undefined,
      info: 'People who enquired, counted once per mobile number (their first enquiry). Trend: leads per month.' },
    { icon: Percent, label: 'Leads that became retailers', value: conv !== null ? <Pct k={L.out[NEW]} n={L.judged} label="New retailers ÷ leads with sales data" /> : L.out[PENDING] ? 'Pending sales data' : '—',
      sub: conv !== null ? `${num(L.out[NEW])} of ${num(L.judged)} leads${ci ? ` · likely ${(100 * ci[0]).toFixed(1)}–${(100 * ci[1]).toFixed(1)}%` : ''}${L.out[PENDING] ? ` · ${num(L.out[PENDING])} pending` : ''}`
        : L.out[PENDING] ? `${num(L.out[PENDING])} leads wait for sales after ${monthName(M, M.p.salesEnd)}` : 'Needs leads',
      rag: rag(conv, t.conversion_pct), ragNote: `Target ${t.conversion_pct}%`, delta: <Delta cur={conv} prev={convP} asPoints />,
      info: `A lead counts as a new retailer when its shop places its first-ever order (BO billing) within ${f.window} days. Leads pending sales data are left out (not counted as no sale) until the sales data catches up.` },
    { icon: Store, label: 'New retailers', value: num(S.newAll), sub: <>{num(S.newMkt)} came from leads (<Pct k={S.newMkt} n={S.newAll} label="From leads ÷ all new retailers" />)</>,
      rag: rag(S.newAll, t.new_retailers_quarter * scale), ragNote: `Target ${num(t.new_retailers_quarter * scale)} for this period`, delta: <Delta cur={S.newAll} prev={Sp?.newAll ?? null} />,
      spark: tail(c.npm.all, M.p.salesEnd), info: 'Shops that placed their first-ever order in this period (BO billing). Trend: new retailers per month.' },
    { icon: IndianRupee, label: 'Sales', value: inr(S.revenue), sub: `${inr(S.revenueMkt)} from retailers that came from leads`,
      rag: rag(S.revenue, Sp?.revenue ?? null), ragNote: 'Against the previous period (no sales target set)', delta: <Delta cur={S.revenue} prev={Sp?.revenue ?? null} />,
      spark: tail(ser.sales, M.p.salesEnd), info: 'Billing of all retailers in this period (BO sales data). Trend: sales per month.' },
    { icon: RefreshCw, label: 'Retailers who bought again', value: ret !== null ? <Pct k={S.retained} n={S.prevBilled} label="Bought again ÷ bought last period" /> : '—',
      sub: `${num(S.retained)} of ${num(S.prevBilled)} who bought last period`, rag: rag(ret, t.retention_pct), ragNote: `Target ${t.retention_pct}%`,
      delta: <Delta cur={ret} prev={retP} asPoints />, info: 'Of the retailers who bought in the previous period, the share that bought again in this one.' },
    { icon: TriangleAlert, label: 'Sales at risk', value: inr(S.atRiskRevenue), sub: `${num(S.atRisk)} retailers quiet for 2 months`,
      rag: rag(riskPct, t.revenue_at_risk_pct, true), ragNote: `Target: at most ${t.revenue_at_risk_pct}% of period sales`,
      delta: <Delta cur={S.atRiskRevenue} prev={Sp?.atRiskRevenue ?? null} lowerIsBetter />,
      info: 'Retailers whose last order was 2 months before the end of the period. The amount is what they used to buy in 3 months.' },
  ];
  if (M.p.hasSpend) {
    tiles.push({ icon: Wallet, label: 'Cost per new retailer', value: cpr !== null ? inr(cpr) : '—', sub: `${inr(spend)} spent`,
      rag: rag(cpr, t.cost_per_retailer, true), ragNote: `Target ≤ ${inr(t.cost_per_retailer)}`, delta: <Delta cur={cpr} prev={cprP} lowerIsBetter />,
      info: 'Marketing spend in the period ÷ new retailers that came from its leads.' });
  }

  // ---- charts: monthly leads by source, what happened, call results, states, ASMs
  const months = lastLead >= 0 ? Array.from({ length: lastLead - Math.max(0, ser.firstLead) + 1 }, (_, j) => Math.max(0, ser.firstLead) + j) : [];
  const srcIdx = M.p.dims.source.map((_, j) => j).filter((j) => ser.bySrc[j].some((v) => v > 0));
  const monthly = months.map((m) => Object.fromEntries([['month', monthName(M, m)], ...srcIdx.map((j) => [`s${j}`, ser.bySrc[j][m]])]));
  const outcomes = M.p.dims.outcomes.map((o, j) => ({ label: o, value: L.out[j] ?? 0, color: OUTCOME_COLORS[j] }));
  const views = c.views;

  const reco = !M.p.hasLeads
    ? { now: 'Link the lead sheet and win back the retailers at risk.', next: 'Judge ads on how many leads become retailers and what each costs, then set the budget.' }
    : conv !== null && conv < t.conversion_pct
      ? { now: 'Before spending more on ads, make sure every lead under 30 days old gets an ASM call, and pause the weakest campaigns.', next: 'Put more budget into the best campaigns once more leads become retailers.' }
      : { now: 'Move budget into the best campaigns and call every open lead under 30 days old.', next: 'Set next quarter\'s budget on the Forecast page.' };

  const exportPdf = () => {
    document.body.classList.add('ld-print-cover');
    const done = () => { document.body.classList.remove('ld-print-cover'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  };
  const exportPpt = async () => {
    const { default: PptxGenJS } = await import('pptxgenjs');
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    const s1 = pptx.addSlide();
    s1.addText('Lead generation — overview', { x: 0.4, y: 0.25, w: 12.5, h: 0.5, fontSize: 22, bold: true, color: '0F172A' });
    s1.addText(`${periodName(M, f.period)} · ${LEVEL_NAMES[f.level]} matching · sale within ${f.window} days`, { x: 0.4, y: 0.75, w: 12.5, h: 0.35, fontSize: 12, color: '64748B' });
    const plain = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
    const vals = [M.p.hasLeads ? num(L.unique) : '—', conv !== null ? `${conv.toFixed(1)}%` : '—', num(S.newAll), inr(S.revenue), ret !== null ? `${ret.toFixed(0)}%` : '—', inr(S.atRiskRevenue)];
    if (M.p.hasSpend) vals.push(cpr !== null ? inr(cpr) : '—');
    const ragHex: Record<string, string> = { green: '16A34A', amber: 'D97706', red: 'DC2626', none: '94A3B8' };
    tiles.forEach((k, i) => {
      const x = 0.4 + (i % 4) * 3.15;
      const y = 1.3 + Math.floor(i / 4) * 1.55;
      s1.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.0, h: 1.4, fill: { color: 'FFFFFF' }, line: { color: 'E2E8F0' }, rectRadius: 0.08 });
      s1.addShape(pptx.ShapeType.ellipse, { x: x + 2.7, y: y + 0.15, w: 0.14, h: 0.14, fill: { color: ragHex[k.rag] }, line: { color: ragHex[k.rag] } });
      s1.addText(k.label, { x: x + 0.12, y: y + 0.08, w: 2.5, h: 0.3, fontSize: 11, color: '64748B' });
      s1.addText(vals[i] ?? plain(k.value), { x: x + 0.12, y: y + 0.42, w: 2.8, h: 0.55, fontSize: 22, bold: true, color: '0F172A' });
      s1.addText(plain(k.sub), { x: x + 0.12, y: y + 0.98, w: 2.8, h: 0.35, fontSize: 9, color: '64748B' });
    });
    s1.addText(`Run-rate: at current pace ${quarterName(rr.quarter)} adds ${num(rr.projected)} retailers vs target ${num(t.new_retailers_quarter)}`,
      { x: 0.4, y: 4.6, w: 12.5, h: 0.4, fontSize: 13, color: '0F172A' });
    const s2 = pptx.addSlide();
    s2.addText('Key findings', { x: 0.4, y: 0.25, w: 12.5, h: 0.5, fontSize: 22, bold: true, color: '0F172A' });
    s2.addText(insights.map((i, n) => ({ text: `${n + 1}. ${i.insight} — ${i.number}. → ${i.action} (Owner: ${i.owner})`, options: { breakLine: true } })),
      { x: 0.4, y: 0.9, w: 12.5, h: 4.2, fontSize: 14, color: '0F172A', valign: 'top', paraSpaceAfter: 8 });
    s2.addText(`This quarter: ${reco.now}\nNext quarter: ${reco.next}`, { x: 0.4, y: 5.4, w: 12.5, h: 1.2, fontSize: 13, color: '1D4ED8' });
    await pptx.writeFile({ fileName: 'Lead_Gen_Executive_Cover.pptx' });
  };

  return (
    <Section def={SECTIONS[0]} n={1} actions={
      <>
        <button type="button" className="ld-btn" onClick={exportPdf} title="Export the cover to PDF"><FileText size={15} strokeWidth={STROKE} />PDF</button>
        <button type="button" className="ld-btn" onClick={() => void exportPpt()} title="Export the cover to PowerPoint"><Presentation size={15} strokeWidth={STROKE} />PPT</button>
      </>
    }>
      <div className="ld-kpis">{tiles.map((k) => <Kpi key={k.label} {...k} />)}</div>
      {!M.p.hasLeads ? <NeedsData what="leads" /> : (
        <div className="ld-grid">
          <Card title="Leads each month" wide uses={['source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'New leads (one per mobile number) per month, split by where they came from. Shows every month, whatever period is picked above.', source: 'Lead sheets' }}
            csv={{ name: 'leads_per_month', rows: () => monthly.map((r) => ({ Month: r.month, ...Object.fromEntries(srcIdx.map((j) => [M.p.dims.source[j], r[`s${j}`]])) })) }}
            soWhat={months.length ? <>{monthName(M, months.reduce((a, m) => (ser.leads[m] > ser.leads[a] ? m : a), months[0]))} brought the most leads ({num(Math.max(...months.map((m) => ser.leads[m])))}).</> : undefined}>
            <StackedBars data={monthly} x="month" fmt={num} height={230}
              series={srcIdx.map((j) => ({ key: `s${j}`, label: M.p.dims.source[j], color: SOURCE_COLORS[j] }))} />
          </Card>
          <Card title="What happened to the leads" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
            info={{ what: <>Each lead, checked against BO billing: <b>New retailer</b> = first-ever order within {f.window} days; <b>Came back</b> = an old retailer who had stopped and ordered again; <b>Already buying</b> = was ordering anyway; <b>No sale yet</b>; <b>Invalid number</b>; <b>Pending sales data</b> = the sales data does not reach that far yet, so it is not counted as no sale.</>, source: 'Lead sheets matched to BO sales' }}
            soWhat={L.unique ? <>{num(L.out[NEW])} leads became new retailers and {num(L.out[REACTIVATED])} old retailers came back.</> : undefined}>
            <Donut data={outcomes} fmt={num} center={<><b>{num(L.unique)}</b><span>leads</span></>} />
          </Card>
          <Card title="Call results" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'What the ASMs wrote in the Category column after calling, grouped into one short list (spelling differences fixed).', source: 'Lead sheet ASM columns' }}
            soWhat={views.cats.length ? <>Most common result: <b>{views.cats[0].label}</b> ({num(views.cats[0].value)} leads).</> : undefined}>
            {!M.p.hasFollowup ? <NeedsData what="followup" /> : <HBars rows={views.cats} fmt={num} />}
          </Card>
          <Card title="Top states" uses={['period', 'source', 'campaign', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'States with the most leads in the period, with how many became new retailers.', source: 'Lead sheets + BO sales' }}>
            <HBars rows={views.states} fmt={num} />
          </Card>
          <Card title="Calls by ASM" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'Leads each ASM owns in the period and the share they have called (Calling Done = Yes).', source: 'Lead sheet ASM columns' }}
            soWhat={views.asms.length ? <>{num(views.unassigned)} leads in this period have no ASM yet.</> : undefined}>
            {!M.p.hasFollowup ? <NeedsData what="followup" /> : <HBars rows={views.asms} fmt={num} />}
          </Card>
          <Card title="Where the leads came from" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'Leads in the period by source (Meta, Google, Print …), one per mobile number.', source: 'Lead sheets (the tab name tells the source)' }}>
            <Donut data={views.sources.map((e) => ({ label: M.p.dims.source[e.j], value: e.n, color: SOURCE_COLORS[e.j] }))} fmt={num}
              center={<><b>{num(L.unique)}</b><span>leads</span></>} />
          </Card>
          <Card title="Which source brings retailers" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
            info={{ what: `Share of each source\'s leads that became new retailers (first order within ${f.window} days). Leads pending sales data are left out.`, formula: 'new retailers ÷ leads with sales data' }}
            soWhat={views.sources.some((e) => e.judged < 30) ? <>Sources with under 30 leads with sales data are too small to compare yet.</> : undefined}>
            <HBars fmt={(v) => `${v.toFixed(1)}%`} max={Math.max(1, ...views.sources.map((e) => (e.judged ? (100 * e.k) / e.judged : 0)))}
              rows={views.sources.map((e) => ({ key: String(e.j), label: M.p.dims.source[e.j], value: e.judged ? (100 * e.k) / e.judged : 0, color: SOURCE_COLORS[e.j],
                note: e.judged ? `${num(e.k)} of ${num(e.judged)}` : 'pending sales data' }))} />
          </Card>
          <Card title="Key findings" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'Up to 5 findings for the filters above: what we see, the number behind it, what to do and who does it. "+ Action" adds one to the action list.' }}>
            <ol className="ld-insights">
              {insights.map((i, n) => (
                <li key={n}>
                  <span className="n">{n + 1}</span>
                  <div>
                    <div className="i">{i.insight}</div>
                    <div className="meta">{i.number}</div>
                    <div className="act"><ArrowRight size={13} strokeWidth={2} aria-hidden /> {i.action} <span className="ld-muted">· {i.owner}</span></div>
                  </div>
                  {ctx.canEdit && <button type="button" className="ld-btn" onClick={() => onAddAction(i)} title="Add to the action list">+ Action</button>}
                </li>
              ))}
            </ol>
          </Card>
          <Card title="Next steps" wide uses={['level', 'window', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'period']}
            info={{ what: 'What to do this quarter, then next, and where the current pace of new retailers lands.', formula: 'pace = new retailers in the last 3 months with sales ÷ 3 × 3' }}>
            <div className="ld-reco">
              <div><h4>This quarter</h4>{reco.now}</div>
              <div><h4>Next quarter</h4>{reco.next}</div>
              <div><h4>At the current pace</h4><b>{quarterName(rr.quarter)}</b> adds about <b>{num(rr.projected)}</b> new retailers (target {num(t.new_retailers_quarter)}{rr.projected >= t.new_retailers_quarter ? ', on track' : `, ${num(t.new_retailers_quarter - rr.projected)} short`}).</div>
            </div>
          </Card>
        </div>
      )}
      {f.source === ORGANIC && <div className="ld-note">Source = Organic: these retailers did not come from a lead, so lead numbers are empty.</div>}
    </Section>
  );
}
