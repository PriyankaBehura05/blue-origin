import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, BadgeCheck, FileText, IndianRupee, Inbox, Percent, Phone, PieChart, PiggyBank, Presentation, RefreshCw, RotateCcw, Sparkles, Store, Target, TrendingUp, TriangleAlert, UserCheck, Wallet, type LucideIcon } from 'lucide-react';
import { Card, Delta, Kpi, NeedsData, Pct, Section, STROKE, inr, num, pctTxt, useLeads, type KpiProps } from '../ui';
import { Donut, HBars, StackedBars } from '../charts';
import { categoryColor, OUTCOME_COLORS, SECTIONS, SOURCE_COLORS } from '../sections';
import { leadAgg, leadOk, monthName, NEW, NOT_CONVERTED, PENDING, REACTIVATED, wasCalled, prevPeriod, rangeOf, outcomeOf, LEVEL_NAMES, periodMonths, periodName, quarterName, rag, spendIn, wilson, type Filters, type Model, type Range } from '../model';
import { leadStats, monthlySeries, newPerMonth, reactivatedRevenue, retailerStats, runRate } from '../calc';
import { LeadFunnel, LeadKpis, useLeadCounts } from './LeadCounts';
import { adBudgetNow, adSpendIn, NeutralDelta, platformsText, useAdBudget } from '../adSpend';
import CampaignDetail from './CampaignDetail';
import CampaignOverview, { Change, HeroPanel, useAcquisitionCards, type HeroCard } from './CampaignOverview';
import GtCampaigns from './GtCampaigns';
import PlatformVs from './PlatformVs';
import PlatformTrends from './PlatformTrends';
import CampaignMonthly from './CampaignMonthly';
import CampaignInsights, { PeriodComparison } from './CampaignInsights';
import { GoogleAnalytics, JumpBar, MetaAnalytics } from './AdsDetail';
import { useAdDetail } from '../adDetail';

export type CoverView = 'overview' | 'performance' | 'impact';

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

export default function Cover({ onAddAction, view = 'overview' }: { onAddAction: (i: Insight) => void; view?: CoverView }) {
  const ctx = useLeads();
  const { M, f, rg } = ctx;
  const go = useNavigate();
  const c = useCover();
  const insights = useMemo(() => buildInsights(M, c, f, rg), [M, c, f, rg]);
  const lc = useLeadCounts();
  const budget = useAdBudget(view === 'overview' || view === 'performance');
  const detail = useAdDetail(view === 'performance');
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

  // ---- the Overview's eight KPIs: the tiles above, reused, plus lead-generated sales and its share of all BO sales
  const uniqueTile: KpiProps = { ...tiles[0], label: 'Unique leads' };
  const convTile: KpiProps = { ...tiles[1], label: 'Lead conversion rate' };
  // all BO sales, whatever the Source filter: with a source chosen, S.revenue only holds that source's retailers
  const p1b = prevPeriod(M, f.period);
  const p2b = p1b ? prevPeriod(M, p1b) : null;
  const Sbo = useMemo(() => (f.source >= 0 ? retailerStats(M, { ...f, source: -1 }, rg, ctx.prev) : S), [M, f, rg, ctx.prev, S]);
  const SboP = useMemo(() => (!ctx.prev ? null : f.source >= 0 ? retailerStats(M, { ...f, source: -1 }, ctx.prev, p2b ? rangeOf(M, p2b) : null) : Sp), [M, f, ctx.prev, p2b, Sp]);
  // lead-attributed revenue = completely new retailers (S.revenueMkt) + reactivated retailers (reactivatedRevenue): one definition everywhere
  const reAll = useMemo(() => (M.p.hasLeads ? reactivatedRevenue(M, f, rg) : 0), [M, f, rg]);
  const reAllP = useMemo(() => (M.p.hasLeads && ctx.prev ? reactivatedRevenue(M, f, ctx.prev) : null), [M, f, ctx.prev]);
  const leadRev = S.revenueMkt + reAll;
  const leadRevP = Sp && reAllP !== null ? Sp.revenueMkt + reAllP : null;
  const leadShare = Sbo.revenue ? (100 * leadRev) / Sbo.revenue : null;
  const leadShareP = SboP && SboP.revenue && leadRevP !== null ? (100 * leadRevP) / SboP.revenue : null;
  // sales data stops at salesEnd: a period after it has no sales yet (pending, not zero); one that straddles it is only partly in
  const noSales = rg[0] > M.p.salesEnd;
  const salesTo = monthName(M, M.p.salesEnd);
  const pendingSales = <span className="ld-delta none">sales data not in yet</span>;
  const REV_NOTE = "New retailers: all their BO billing in the period (their first-ever bill came after the lead). Reactivated retailers: their billing from the month of the lead that brought them back. A retailer is never counted in both. Retailers won in earlier periods count too.";
  const salesTile: KpiProps = { icon: IndianRupee, label: 'Lead-generated sales', value: noSales ? '—' : inr(leadRev), rag: 'none',
    sub: noSales ? `Pending: sales data runs to ${salesTo}` : `new ${inr(S.revenueMkt)} + reactivated ${inr(reAll)} · of ${inr(Sbo.revenue)} total BO sales${rg[1] > M.p.salesEnd ? ` · sales data to ${salesTo}` : ''}`,
    delta: noSales ? pendingSales : <Delta cur={leadRev} prev={leadRevP} />,
    info: `Total lead-attributed revenue: BO billing from retailers the leads brought in, new and reactivated, from every lead source. ${REV_NOTE}` };
  const contribTile: KpiProps = { icon: PieChart, label: 'Lead-generated sales contribution', value: !noSales && leadShare !== null ? `${leadShare.toFixed(1)}%` : '—', rag: 'none',
    sub: noSales ? `Pending: sales data runs to ${salesTo}` : `${inr(leadRev)} ÷ ${inr(Sbo.revenue)}`, delta: noSales ? pendingSales : <Delta cur={leadShare} prev={leadShareP} asPoints />,
    info: 'Lead-generated sales (new + reactivated retailers) as a share of all BO sales in the period.' };
  // ---- Overview, Campaign Performance: budget, spend, the two lead counts, what a lead costs, the revenue and the return
  const ad = useMemo(() => adSpendIn(budget, M, f, rg), [budget, M, f, rg]);
  const adP = useMemo(() => (ctx.prev ? adSpendIn(budget, M, f, ctx.prev) : null), [budget, M, f, ctx.prev]);
  // leads the spend can be matched to: the connected platforms only (with Meta alone, Meta's leads, not Google's or Print's)
  const cov = useMemo(() => {
    if (!M.p.hasLeads || ad.reason) return null;
    const pick = (i: number) => ad.srcIdx.includes(M.p.leads.src[i]);
    return { cur: leadAgg(M, f, rg, pick), prev: ctx.prev ? leadAgg(M, f, ctx.prev, pick) : null };
  }, [M, f, rg, ctx.prev, ad]);
  const costOk = !ad.reason && ad.unsplit.length === 0 && !!cov;
  const adPrevOk = !!adP && !adP.reason;
  // two views of every cost: all campaigns' spend, and only the spend of campaigns whose objective is Leads
  const per = (spend: number, n: number | undefined) => (spend > 0 && n ? spend / n : null);
  const cpl = costOk ? per(ad.total, cov!.cur.rows) : null;
  const cplP = costOk && adPrevOk ? per(adP!.total, cov!.prev?.rows) : null;
  const cplLead = costOk ? per(ad.leadObjective, cov!.cur.rows) : null;
  const cplLeadP = costOk && adPrevOk ? per(adP!.leadObjective, cov!.prev?.rows) : null;
  const cpu = costOk ? per(ad.total, cov!.cur.unique) : null;
  const cpuP = costOk && adPrevOk ? per(adP!.total, cov!.prev?.unique) : null;
  const cpuLead = costOk ? per(ad.leadObjective, cov!.cur.unique) : null;
  const partial = costOk && cov!.cur.rows < L.rows ? ` (${platformsText(ad)} leads only)` : '';
  const why = ad.reason ?? (ad.unsplit.length ? `Ad spend cannot be split by ${ad.unsplit.join(', ')}` : '');
  const say = (main: string, detail?: string) => <><div>{main}</div>{detail ? <div className="ld-note">{detail}</div> : null}</>;
  const SPEND_NOTE = 'Spend is for every campaign on the connected ad account(s), whatever its objective, as last saved on the Ad budget page. Cost per campaign, with each lead linked to its campaign, is on the Campaign attribution page.';
  const LEAD_NOTE = "Lead campaigns = campaigns whose objective in the ad platform is Leads (Meta's own label). Google Ads campaigns have no objective, so none count as lead campaigns yet.";
  // budget (today's settings) and revenue, to sit beside the spend
  const bud = useMemo(() => adBudgetNow(budget, M, f), [budget, M, f]);
  // revenue paired with the spend: retailers attributed to the platform(s) the spend covers (Meta alone for now), so the
  // returns compare like with like; with no spend it is simply all lead-attributed revenue
  const rev = useMemo(() => {
    if (!M.p.hasLeads) return null;
    if (ad.reason || !ad.srcIdx.length) return { nw: S.revenueMkt, re: reAll, nwP: Sp?.revenueMkt ?? null, reP: reAllP, covered: false };
    let nw = 0;
    let re = 0;
    let nwP: number | null = ctx.prev ? 0 : null;
    let reP: number | null = ctx.prev ? 0 : null;
    for (const src of ad.srcIdx) {
      const f2 = { ...f, source: src };
      nw += retailerStats(M, f2, rg, ctx.prev).revenueMkt;
      re += reactivatedRevenue(M, f2, rg);
      if (ctx.prev) {
        nwP! += retailerStats(M, f2, ctx.prev, p2b ? rangeOf(M, p2b) : null).revenueMkt;
        reP! += reactivatedRevenue(M, f2, ctx.prev);
      }
    }
    return { nw, re, nwP, reP, covered: true };
  }, [M, f, rg, ctx.prev, ad, S, Sp, reAll, reAllP, p2b]);
  const tot = rev ? rev.nw + rev.re : null;
  const totP = rev && rev.nwP !== null && rev.reP !== null ? rev.nwP + rev.reP : null;
  const ret_ = (spend: number) => (!noSales && costOk && rev?.covered && spend > 0 && tot !== null ? tot / spend : null);
  const retP_ = (spend: number | undefined) => (costOk && rev?.covered && adPrevOk && spend && totP !== null ? totP / spend : null);
  const roas = ret_(ad.total);
  const roasP = retP_(adP?.total);
  const roasLead = ret_(ad.leadObjective);
  const roasLeadP = retP_(adP?.leadObjective);
  const revScope = rev?.covered ? `${platformsText(ad)}-attributed retailers` : 'all lead sources';
  const partialSales = rg[1] > M.p.salesEnd ? ` · sales data to ${salesTo}` : '';
  const BUDGET_NOTE = "Budgets are today's settings: Meta and Google do not keep the budget a campaign had in an earlier period, so this does not change with the period. Campaigns on a daily budget and on a lifetime (total) budget are shown separately.";
  const revCard = (icon: LucideIcon, label: string, v: number | null, vp: number | null, main: string, info: string): KpiProps => ({
    icon, label, value: v !== null && !noSales ? inr(v) : '—', rag: 'none', delta: noSales ? pendingSales : <Delta cur={v} prev={vp} />,
    sub: say(main, noSales ? `Pending: sales data runs to ${salesTo}` : `${revScope}${partialSales}`), info,
  });
  const adCards: KpiProps[] = [
    { icon: PiggyBank, label: 'Total ad budget', rag: 'none',
      value: bud.reason ? '—' : bud.daily ? `${inr(bud.daily)}/day` : bud.lifetime ? inr(bud.lifetime) : '—',
      sub: say('Budget set on active campaigns today', bud.reason ?? ([bud.lifetimeCampaigns ? `${bud.daily ? '+ ' : ''}${inr(bud.lifetime)} lifetime budgets (${num(bud.lifetimeCampaigns)} campaigns), ${inr(bud.lifetimeLeft)} left` : '',
      ].filter(Boolean).join(' · ') || 'No budget found on active campaigns')),
      delta: <span className="ld-delta none">today's settings, not period-specific</span>,
      info: `Allocated budget of campaigns that are active now (Source filter: that platform only). ${BUDGET_NOTE}` },
    { icon: Wallet, label: 'Total ad spend', value: ad.reason ? '—' : inr(ad.total), rag: 'none',
      sub: say('Money spent on ad campaigns in this period', ad.reason ?? `${platformsText(ad)}${ad.leadObjective ? ` · ${inr(ad.leadObjective)} of it on lead campaigns` : ''}${ad.unsplit.length ? ` · not split by ${ad.unsplit.join(', ')}` : ''}`),
      delta: <NeutralDelta cur={ad.reason ? null : ad.total} prev={adPrevOk ? adP!.total : null} />,
      info: `Total spent in the months of the selected period (Source filter: that platform only). ${SPEND_NOTE}${ad.fetchedAt ? ` Saved ${ad.fetchedAt.slice(0, 10)}.` : ''}` },
    { icon: Inbox, label: 'Total lead submissions', value: num(L.rows), rag: 'none', delta: <Delta cur={L.rows} prev={Lp?.rows ?? null} />,
      sub: say('Every enquiry received, including repeat ones', `${num(Math.max(0, L.rows - L.unique))} repeat enquiries`),
      info: "Every enquiry received, including the same person enquiring again. After the dashboard's existing clean-up, which removes rows the sheet copied twice (same lead ID)." },
    { ...uniqueTile, sub: say('Different people, after removing repeat enquiries', 'first enquiry per mobile number') },
    { icon: Target, label: 'CPL · all campaigns', value: cpl !== null ? inr(cpl) : '—', rag: 'none', delta: <Delta cur={cpl} prev={cplP} lowerIsBetter />,
      sub: say('All ad spend ÷ total submissions', costOk ? `${inr(ad.total)} ÷ ${num(cov!.cur.rows)} submissions${partial}` : why),
      info: `Total ad spend (every campaign) ÷ total lead submissions, for the same platform(s) and months. With Meta the only connected platform, All sources uses Meta's submissions, not Google's or Print's. Lower is better. ${SPEND_NOTE}` },
    { icon: Target, label: 'CPL · lead campaigns', value: cplLead !== null ? inr(cplLead) : '—', rag: 'none', delta: <Delta cur={cplLead} prev={cplLeadP} lowerIsBetter />,
      sub: say('Lead-campaign spend ÷ total submissions', costOk ? (ad.leadObjective > 0 ? `${inr(ad.leadObjective)} ÷ ${num(cov!.cur.rows)} submissions${partial}` : 'No lead-campaign spend in this period') : why),
      info: `Spend of lead campaigns only ÷ total lead submissions, for the same platform(s) and months: what a lead costs on the campaigns meant to bring leads. Lower is better. ${LEAD_NOTE}` },
    { icon: PieChart, label: 'ROAS · all campaigns', value: roas !== null ? `${roas.toFixed(2)}×` : '—', rag: 'none', delta: noSales ? pendingSales : <Delta cur={roas} prev={roasP} />,
      sub: say('Lead-attributed revenue ÷ all ad spend', noSales ? `Pending: sales data runs to ${salesTo}` : roas !== null ? `${inr(tot!)} ÷ ${inr(ad.total)}` : why || 'Needs ad spend and revenue'),
      info: `Total lead-attributed revenue (new + reactivated retailers) ÷ total ad spend, same platform(s) and period. Spend covers every campaign, and revenue includes retailers won earlier, so read it as a trend. ${SPEND_NOTE}` },
    { icon: PieChart, label: 'ROAS · lead campaigns', value: roasLead !== null ? `${roasLead.toFixed(2)}×` : '—', rag: 'none', delta: noSales ? pendingSales : <Delta cur={roasLead} prev={roasLeadP} />,
      sub: say('Lead-attributed revenue ÷ lead-campaign spend', noSales ? `Pending: sales data runs to ${salesTo}` : roasLead !== null ? `${inr(tot!)} ÷ ${inr(ad.leadObjective)}` : why || 'No lead-campaign spend in this period'),
      info: `Total lead-attributed revenue (new + reactivated retailers) ÷ the spend of lead campaigns only, same platform(s) and period. ${LEAD_NOTE}` },
    { icon: UserCheck, label: 'Cost per unique lead', value: cpu !== null ? inr(cpu) : '—', rag: 'none', delta: <Delta cur={cpu} prev={cpuP} lowerIsBetter />,
      sub: say('All ad spend ÷ unique leads', costOk ? `${inr(ad.total)} ÷ ${num(cov!.cur.unique)} unique leads${partial}${cpuLead !== null ? ` · lead campaigns ${inr(cpuLead)}` : ''}` : why),
      info: `Total ad spend ÷ unique leads (one per mobile number), for the same platform(s) and months; the lead-campaign figure uses lead-campaign spend only. Lower is better. ${SPEND_NOTE}` },
    revCard(Sparkles, 'New retailer revenue', rev && rev.nw, rev ? rev.nwP : null, 'BO sales from completely new retailers',
      `BO billing in the period from retailers whose first-ever bill came after a lead (within the Window), including retailers won earlier. ${REV_NOTE}`),
    revCard(RotateCcw, 'Reactivated retailer revenue', rev && rev.re, rev ? rev.reP : null, 'BO sales from retailers a lead brought back',
      `BO billing from retailers that had gone quiet for 3 months and bought again after a lead, counted from the month of that lead. ${REV_NOTE}`),
    revCard(IndianRupee, 'Total lead-attributed revenue', tot, totP, 'New + reactivated retailer revenue',
      `New retailer revenue + reactivated retailer revenue. Used for both ROAS figures. ${REV_NOTE}`),
  ];
  const sec = (id: string) => ({ def: SECTIONS.find((x) => x.id === id)!, n: SECTIONS.findIndex((x) => x.id === id) + 1 });

  // ---- Overview, BO business impact panel: retailers the leads won, the sales they bring and the return on ad spend
  const lr = lc?.r;
  const lrp = lc?.rp ?? null;
  const pend = <span className="ld-hc-d none">pending: BO sales data not in yet</span>;
  const acquisition = useAcquisitionCards(budget);
  const impactCards: HeroCard[] = [
    { icon: BadgeCheck, tone: 'green', label: 'Converted retailers', value: noSales || !lr ? '—' : num(lr.converted),
      sub: lr ? `${num(lr.fresh)} completely new + ${num(lr.reactivated)} reactivated` : 'Needs leads',
      change: noSales ? pend : <Change cur={lr?.converted ?? null} prev={lrp?.converted ?? null} better="up" />,
      info: 'Distinct BO retailers that a lead brought in: a completely new retailer or a reactivated one. Each retailer is counted once, even if several leads point to it.' },
    { icon: Sparkles, tone: 'pink', label: 'Completely new retailers', value: noSales || !lr ? '—' : num(lr.fresh),
      sub: lr && lr.converted ? `${((100 * lr.fresh) / lr.converted).toFixed(0)}% of converted` : 'first-ever BO bill after a lead',
      change: noSales ? pend : <Change cur={lr?.fresh ?? null} prev={lrp?.fresh ?? null} better="up" />,
      info: 'Shops whose first-ever BO bill came after a lead (within the Window).' },
    { icon: RotateCcw, tone: 'teal', label: 'Reactivated retailers', value: noSales || !lr ? '—' : num(lr.reactivated),
      sub: lr && lr.converted ? `${((100 * lr.reactivated) / lr.converted).toFixed(0)}% of converted` : 'bought again after 3 quiet months',
      change: noSales ? pend : <Change cur={lr?.reactivated ?? null} prev={lrp?.reactivated ?? null} better="up" />,
      info: 'Old BO retailers that had not bought for 3 months and ordered again after a lead.' },
    { icon: IndianRupee, tone: 'violet', label: 'Lead-generated sales', value: noSales ? '—' : inr(leadRev),
      sub: noSales ? `Pending: sales data runs to ${salesTo}` : `new ${inr(S.revenueMkt)} + reactivated ${inr(reAll)}`,
      change: noSales ? pend : <Change cur={leadRev} prev={leadRevP} better="up" />,
      info: `BO billing from retailers the leads brought in, new and reactivated, from every lead source. ${REV_NOTE}` },
    { icon: PieChart, tone: 'blue', label: 'Share of all BO sales', value: !noSales && leadShare !== null ? `${leadShare.toFixed(1)}%` : '—',
      sub: noSales ? `Pending: sales data runs to ${salesTo}` : `${inr(leadRev)} of ${inr(Sbo.revenue)} total BO sales`,
      change: noSales ? pend : <Change cur={leadShare} prev={leadShareP} better="up" points />,
      info: 'Lead-generated sales (new + reactivated retailers) as a share of all BO sales in the period.' },
    { icon: TrendingUp, tone: 'amber', label: 'Return on ad spend (ROAS)', value: roas !== null ? `${roas.toFixed(2)}×` : '—',
      sub: noSales ? `Pending: sales data runs to ${salesTo}` : roas !== null ? `${inr(tot!)} sales ÷ ${inr(ad.total)} ad spend` : why || 'Needs ad spend and sales',
      change: noSales ? pend : <Change cur={roas} prev={roasP} better="up" />,
      info: `Sales from retailers the ad platforms' leads brought in (new + reactivated) ÷ total ad spend, same platform(s) and period: sales for each ₹1 spent. Revenue includes retailers won earlier, so read it as a trend. ${SPEND_NOTE}` },
  ];

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

  const nothing = <NeedsData what="leads" />;
  if (view === 'performance') {
    const { def, n } = sec('performance');
    return (
      <Section def={def} n={n} actions={
        <button type="button" className="ld-btn" onClick={() => go('/leads/attribution')} title="Which campaign each lead came from, and what every campaign cost and brought in">
          <Target size={15} strokeWidth={STROKE} />Campaign attribution<ArrowRight size={14} strokeWidth={STROKE} aria-hidden />
        </button>}>
        {!M.p.hasLeads ? nothing : (
          <>
            <div className="ld-kpis ld-kpis-hero ld-kpis-4">{adCards.map((k) => <Kpi key={k.label} {...k} />)}</div>
            <div className="ld-kpis ld-kpis-4">
              <LeadKpis lc={lc} show={['prospects']} />
              {tiles.slice(6).map((k) => <Kpi key={k.label} {...k} />)}
            </div>
            <JumpBar items={[['cp-campaigns', 'Campaign comparison'], ['cp-trends', 'Performance trends'], ['cp-meta', 'Meta analytics'], ['cp-google', 'Google analytics'], ['cp-detail', 'Spend & lead detail']]} />
            <div id="cp-campaigns" className="ld-anchor">
              <GtCampaigns budget={budget} title="Campaign comparison" />
              <PeriodComparison budget={budget} />
              <CampaignMonthly budget={budget} />
            </div>
            <div id="cp-trends" className="ld-anchor">
              <h3 className="ld-subhead">Performance trends <span>spend, leads, CPL, reach and revenue, by day, week or month</span></h3>
              <PlatformTrends budget={budget} />
            </div>
            <div id="cp-meta" className="ld-anchor">
              <h3 className="ld-subhead">Meta detailed analytics <span>ad sets, ads, placements, audience, regions and conversion events</span></h3>
              <MetaAnalytics budget={budget} detail={detail} />
            </div>
            <div id="cp-google" className="ld-anchor">
              <h3 className="ld-subhead">Google detailed analytics <span>keywords, search terms, devices, geography and conversion actions</span></h3>
              <GoogleAnalytics detail={detail} />
            </div>
            <div id="cp-detail" className="ld-anchor">
              <h3 className="ld-subhead">Spend and lead detail <span>budgets, spend and returns of the ad accounts, and the leads month by month</span></h3>
              <CampaignDetail budget={budget} />
            </div>
        <div className="ld-grid">
          <Card title="Leads each month" wide uses={['source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'New leads (one per mobile number) per month, split by where they came from. Shows every month, whatever period is picked above.', source: 'Lead sheets' }}
            csv={{ name: 'leads_per_month', rows: () => monthly.map((r) => ({ Month: r.month, ...Object.fromEntries(srcIdx.map((j) => [M.p.dims.source[j], r[`s${j}`]])) })) }}
            soWhat={months.length ? <>{monthName(M, months.reduce((a, m) => (ser.leads[m] > ser.leads[a] ? m : a), months[0]))} brought the most leads ({num(Math.max(...months.map((m) => ser.leads[m])))}).</> : undefined}>
            <StackedBars data={monthly} x="month" fmt={num} height={230}
              series={srcIdx.map((j) => ({ key: `s${j}`, label: M.p.dims.source[j], color: SOURCE_COLORS[j] }))} />
          </Card>
          <Card title="Where the leads came from" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
            info={{ what: 'Leads in the period by source (Meta, Google, Print …), one per mobile number.', source: 'Lead sheets (the tab name tells the source)' }}>
            <Donut data={views.sources.map((e) => ({ label: M.p.dims.source[e.j], value: e.n, color: SOURCE_COLORS[e.j] }))} fmt={num}
              center={<><b>{num(L.unique)}</b><span>leads</span></>} />
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
        </div>
            <RelatedPages items={[['attribution', 'Campaign attribution'], ['funnel', 'Lead journey'], ['campaigns', 'Campaigns'], ['ageing', 'Follow-ups & call lists'], ['geography', 'States & cities'], ['field', 'Distributors & ASMs']]} />
          </>
        )}
      </Section>
    );
  }
  if (view === 'impact') {
    const { def, n } = sec('impact');
    return (
      <Section def={def} n={n}>
        {!M.p.hasLeads ? nothing : (
          <>
            <div className="ld-kpis ld-kpis-hero">
              <LeadKpis lc={lc} show={['converted', 'new', 'reactivated']} />
              <Kpi {...convTile} />
              <Kpi {...salesTile} />
              <Kpi {...contribTile} />
            </div>
            <div className="ld-kpis">{tiles.slice(2, 6).map((k) => <Kpi key={k.label} {...k} />)}</div>
            <LeadFunnel lc={lc} />
        <div className="ld-grid">
          <Card title="Which source brings retailers" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
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
            <RelatedPages items={[['mix', 'Where retailers come from'], ['retention', 'Repeat buying & tiers'], ['forecast', 'Forecast'], ['retailers', 'Retailers & actions']]} />
          </>
        )}
      </Section>
    );
  }
  return (
    <Section def={SECTIONS[0]} n={1} actions={
      <>
        <button type="button" className="ld-btn" onClick={exportPdf} title="Export the cover to PDF"><FileText size={15} strokeWidth={STROKE} />PDF</button>
        <button type="button" className="ld-btn" onClick={() => void exportPpt()} title="Export the cover to PowerPoint"><Presentation size={15} strokeWidth={STROKE} />PPT</button>
      </>
    }>
      {!M.p.hasLeads ? nothing : (
        <>
          <CampaignOverview budget={budget} />
          <HeroPanel title="BO" accent="business impact" to="impact" cols={4} cards={[...impactCards, ...acquisition]}
            subtitle={`What the leads delivered for BO: retailers won and the sales they bring${noSales ? ` · pending: BO sales data runs to ${salesTo}` : rg[1] > M.p.salesEnd ? ` · BO sales data runs to ${salesTo}` : ''}`} />
          <div className="ld-grid">
            <PlatformVs budget={budget} />
          </div>
          <CampaignInsights budget={budget} />
        </>
      )}
    </Section>
  );
}

/** Links from a summary section to the detailed pages that already exist. */
function RelatedPages({ items }: { items: [string, string][] }) {
  const go = useNavigate();
  return (
    <div className="ld-related">
      <span className="ld-note">More detail:</span>
      {items.map(([to, label]) => <button key={to} type="button" className="ld-btn" onClick={() => go(`/leads/${to}`)}>{label}</button>)}
    </div>
  );
}
