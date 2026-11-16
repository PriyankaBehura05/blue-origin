// Campaign overview: the numbers management looks at first, in panels at the top of the Overview. Every number follows the
// period and the filters of the bar and is compared with the previous period of the same length. Ad figures come from the saved
// ad data (Ad budget page, campaign figures in gt.ts) and follow the Source and Campaign filters; State, City, Distributor, Tier
// and What happened cannot split them, so with one of those on they are withheld (shown as —). Lead and retailer counts use the
// same functions as the rest of the dashboard (leadAgg / retailerCounts).
import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUp, Coins, Percent, PiggyBank, Target, Users, Wallet, type LucideIcon } from 'lucide-react';
import { HelpTip } from '@/components/HelpTip';
import { activeFilters, FILTER_LABELS, leadAgg, NEW, periodName, REACTIVATED, retailerCounts } from '../model';
import { adSpendIn, platformsText } from '../adSpend';
import { cplOf, gtSummary, utilOf, type Plat } from '../gt';
import type { BudgetPayload } from '../types';
import { inr, num, useLeads } from '../ui';

type Better = 'up' | 'down' | 'none';

export function Change({ cur, prev, better, points }: { cur: number | null; prev: number | null; better: Better; points?: boolean }) {
  if (cur === null || prev === null || !isFinite(cur) || !isFinite(prev) || (!points && prev === 0)) return <span className="ld-hc-d none">no earlier period to compare</span>;
  const diff = points ? cur - prev : (100 * (cur - prev)) / Math.abs(prev);
  const Icon = diff > 0.05 ? ArrowUp : diff < -0.05 ? ArrowDown : ArrowRight;
  const tone = better === 'none' || Math.abs(diff) <= 0.05 ? 'flat' : (diff > 0) === (better === 'up') ? 'good' : 'bad';
  return (
    <span className={`ld-hc-d ${tone}`}>
      <span className="pill"><Icon size={12} strokeWidth={2.4} aria-hidden />{Math.abs(diff).toFixed(1)}{points ? ' pts' : '%'}</span>
      vs previous period
    </span>
  );
}

export interface HeroCard { icon: LucideIcon; tone: string; label: string; value: string; sub: ReactNode; change: ReactNode; info: string }

/** A dark spotlight panel of KPI cards (Overview): title with an accent part, a subtitle, an optional link to the detail page. */
export function HeroPanel({ title, accent, subtitle, stamp, to, cards, cols = 4 }: {
  title: string; accent: string; subtitle: ReactNode; stamp?: string | null; to?: string; cards: HeroCard[]; cols?: 3 | 4 | 5;
}) {
  const go = useNavigate();
  return (
    <section className="ld-hero" aria-label={`${title} ${accent}`}>
      <header className="ld-hero-h">
        <div>
          <h2>{title} <span>{accent}</span></h2>
          <p>{subtitle}</p>
        </div>
        <div className="ld-hero-side">
          {stamp && <span className="ld-hero-stamp">{stamp}</span>}
          {to && <button type="button" className="ld-hero-link" onClick={() => go(`/leads/${to}`)}>View details <ArrowRight size={14} strokeWidth={2} aria-hidden /></button>}
        </div>
      </header>
      <div className={`ld-hero-grid c${cols}`}>
        {cards.map((c) => (
          <div key={c.label} className={`ld-hc t-${c.tone}`}>
            <div className="ld-hc-top">
              <span className="ld-hc-ico"><c.icon size={18} strokeWidth={2} aria-hidden /></span>
              <span className="ld-hc-l">{c.label}</span>
              <span className="ld-hc-i"><HelpTip text={c.info} /></span>
            </div>
            <div className="ld-hc-v">{c.value}</div>
            <div className="ld-hc-sub">{c.sub}</div>
            {c.change}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Cost per new retailer and lead conversion rate: the acquisition cards of the Overview's BO business impact panel. Spend
 *  follows the Source and Campaign filters; filters that ad spend cannot follow withhold the cost (—). */
export function useAcquisitionCards(budget: BudgetPayload | null): HeroCard[] {
  const { M, f, rg, prev } = useLeads();
  const L = M.p.leads;
  const d = useMemo(() => {
    const ad = adSpendIn(budget, M, f, rg);
    const adP = prev ? adSpendIn(budget, M, f, prev) : null;
    const paid = (i: number) => ad.srcIdx.includes(L.src[i]);   // the leads the spend can be divided by: the spend's own platform(s)
    return {
      ad, adP, a: leadAgg(M, f, rg), ap: prev ? leadAgg(M, f, prev) : null,
      pr: retailerCounts(M, f, rg, paid), prp: prev ? retailerCounts(M, f, prev, paid) : null,
    };
  }, [budget, M, f, rg, prev, L]);
  const { ad, adP, a, ap, pr, prp } = d;
  const costBlock = ad.reason ?? (ad.unsplit.length ? `Ad spend cannot be split by ${ad.unsplit.join(', ')}` : null);
  const prevOk = !!adP && !adP.reason;
  const per = (s: number, n: number | undefined) => (s > 0 && n ? s / n : null);
  const conv = (x: typeof a) => x.out[NEW] + x.out[REACTIVATED];
  const rate = (x: typeof a | null) => (x && x.judged ? (100 * conv(x)) / x.judged : null);
  const pendingOnly = rg[0] > M.p.salesEnd;
  const PENDING = 'Pending: BO sales data not in yet';
  const cpn = !costBlock && !pendingOnly ? per(ad.total, pr.fresh) : null;
  const cpnP = !costBlock && prevOk ? per(adP!.total, prp?.fresh) : null;
  return [
    { icon: Coins, tone: 'cyan', label: 'Cost per new retailer', value: cpn !== null ? inr(cpn) : '—',
      sub: costBlock ?? (pendingOnly ? PENDING : cpn !== null ? `${inr(ad.total)} ÷ ${num(pr.fresh)} new retailers from ${platformsText(ad)} leads` : 'No new retailer from ad leads yet'),
      change: pendingOnly ? <span className="ld-hc-d none">{PENDING}</span> : <Change cur={cpn} prev={cpnP} better="down" />,
      info: 'Ad spend ÷ new retailers that came from the leads of the same platform(s). What a real buying retailer costs, which can tell a very different story from CPL. Lower is better.' },
    { icon: Percent, tone: 'indigo', label: 'Lead conversion rate', value: pendingOnly || rate(a) === null ? '—' : `${rate(a)!.toFixed(1)}%`,
      sub: pendingOnly ? PENDING : `${num(conv(a))} converted ÷ ${num(a.judged)} leads with sales data`,
      change: pendingOnly ? <span className="ld-hc-d none">{PENDING}</span> : <Change cur={rate(a)} prev={rate(ap)} better="up" points />,
      info: 'Converted leads (BO confirms a new retailer or one that came back) ÷ unique leads that can be judged × 100. Leads too recent for the sales data, and invalid numbers, are left out.' },
  ];
}

/** The Overview's top panel: budget, spend, leads and CPL in total and for Meta and Google, from the campaign figures the
 *  platforms report (gt.ts). Overall CPL = all spend ÷ all leads (never an average of CPLs). Compared with the previous period. */
export default function CampaignOverview({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg, prev } = useLeads();
  const s = useMemo(() => gtSummary(budget, M, f, rg, false), [budget, M, f, rg]);
  const sp = useMemo(() => (prev ? gtSummary(budget, M, f, prev, false) : null), [budget, M, f, prev]);
  const ad = useMemo(() => adSpendIn(budget, M, f, rg), [budget, M, f, rg]);
  // filters ad figures cannot follow (state, city, distributor, tier, what happened): withheld, never divided by part of the leads
  const block = ad.unsplit.length ? `Ad figures cannot be split by ${ad.unsplit.join(', ')}` : null;
  const all = (x: typeof s | null) => (x ? x.total ?? x.platforms.Meta ?? x.platforms.Google ?? null : null);
  const T = block ? null : all(s);
  const TP = block ? null : all(sp);
  const P = (x: typeof s | null, p: Plat) => (block || !x ? null : x.platforms[p] ?? null);
  const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : inr(v));
  const cplTxt = (l: { spend: number; leads: number } | null) => (l ? (cplOf(l) === null ? 'N/A' : `₹${cplOf(l)!.toFixed(0)}`) : '—');
  const none = (why: string) => <span className="ld-hc-d none">{why}</span>;
  const googleNote = s.googleAllConversions ? 'all Google conversions until the Google Ads script is updated' : 'the “Conversion” action';
  const why = block ?? 'No campaign data saved yet';

  const platCards = (p: Plat, tones: [string, string, string]): HeroCard[] => {
    const l = P(s, p);
    const lp = P(sp, p);
    const leadsWord = p === 'Meta' ? 'lead-form leads' : `leads (${googleNote})`;
    return [
      { icon: Wallet, tone: tones[0], label: `${p} Ads spend`, value: money(l?.spend), sub: l ? `${num(Math.round(l.impressions))} impressions · ${num(Math.round(l.clicks))} clicks` : why,
        change: l ? <Change cur={l.spend} prev={lp?.spend ?? null} better="none" /> : none(why), info: `What ${p} Ads reports as spent on the campaigns in the months of the period.` },
      { icon: Users, tone: tones[1], label: `${p} Ads leads`, value: l ? num(Math.round(l.leads)) : '—', sub: l ? leadsWord : why,
        change: l ? <Change cur={l.leads} prev={lp?.leads ?? null} better="up" /> : none(why),
        info: p === 'Meta' ? "Leads Meta reports for the campaigns: the lead-form results (never Meta's lead action names added together)." : 'Conversions of the Google Ads conversion action named “Conversion” (its All conversions when it is a secondary action). Other conversion actions are not leads.' },
      { icon: Target, tone: tones[2], label: `${p} Ads CPL`, value: cplTxt(l), sub: l ? `${inr(l.spend)} ÷ ${num(Math.round(l.leads))} leads` : why,
        change: l && cplOf(l) !== null ? <Change cur={cplOf(l)} prev={lp ? cplOf(lp) : null} better="down" /> : none(l ? 'no leads: CPL N/A' : why),
        info: `${p} Ads spend ÷ ${p} Ads leads for the period. N/A when there are no leads. Lower is better.` },
    ];
  };
  const cards: HeroCard[] = [
    { icon: PiggyBank, tone: 'blue', label: 'Total ad budget', value: money(T?.budget), sub: T ? (T.budget ? `${utilOf(T)!.toFixed(0)}% of it spent` : 'no budget set') : why,
      change: T ? <Change cur={T.budget} prev={TP?.budget ?? null} better="none" /> : none(why),
      info: "Budget of the campaigns for the period: daily budget × the days the campaigns actually spent in the period. Meta and Google keep no budget history, so today's budget settings are used." },
    { icon: Wallet, tone: 'violet', label: 'Total ad spend', value: money(T?.spend), sub: T ? 'Meta Ads + Google Ads' : why,
      change: T ? <Change cur={T.spend} prev={TP?.spend ?? null} better="none" /> : none(why), info: 'What Meta and Google report as spent on the campaigns in the months of the period.' },
    { icon: Users, tone: 'teal', label: 'Total leads', value: T ? num(Math.round(T.leads)) : '—', sub: T ? 'as Meta and Google report them' : why,
      change: T ? <Change cur={T.leads} prev={TP?.leads ?? null} better="up" /> : none(why),
      info: `Meta lead-form leads + Google leads (${googleNote}). The lead sheet's unique leads, after repeat enquiries are removed, are on the Lead journey page.` },
    { icon: Target, tone: 'amber', label: 'Overall CPL', value: cplTxt(T), sub: T ? `${inr(T.spend)} ÷ ${num(Math.round(T.leads))} leads` : why,
      change: T && cplOf(T) !== null ? <Change cur={cplOf(T)} prev={TP ? cplOf(TP) : null} better="down" /> : none(T ? 'no leads: CPL N/A' : why),
      info: '(Meta spend + Google spend) ÷ (Meta leads + Google leads). Never an average of the platforms\u2019 or campaigns\u2019 CPLs. Lower is better.' },
    ...platCards('Meta', ['indigo', 'blue', 'cyan']),
    ...platCards('Google', ['pink', 'green', 'amber']),
  ];

  const on = activeFilters(f).filter((k) => k !== 'period').map((k) => FILTER_LABELS[k]);
  return (
    <HeroPanel title="Paid ads &" accent="campaign overview" to="performance" cards={cards} cols={5}
      subtitle={`${periodName(M, f.period)}${on.length ? ` · filtered by ${on.join(', ')}` : ''}${prev ? ' · compared with the previous period' : ''}`}
      stamp={s.saved ? `Ad data saved ${s.saved.slice(0, 16).replace('T', ' ')}` : null} />
  );
}
