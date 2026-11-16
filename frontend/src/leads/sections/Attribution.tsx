// Campaign attribution: which campaign each lead came from (or why that cannot be said), what each campaign and platform
// cost and brought in (enquiries, retailers, BO sales), rankings with minimum volumes, and the review queue for unclear
// lead -> retailer matches. The lead mapping is in the payload (backend attribution.py); the campaign KPIs come from
// GET /api/leads/campaign-performance (backend spend_service.py) for the period, matching level and window of the filter bar.
import { useEffect, useMemo, useState } from 'react';
import { Ban, CalendarDays, CalendarRange, Check, Copy, Link2, ListFilter, Undo2, Unlink, X } from 'lucide-react';
import { leadsApi } from '../api';
import { HBars, Lines } from '../charts';
import { leadOk } from '../model';
import { SECTIONS } from '../sections';

import type { CampaignPerformance, CampaignRow, MatchReview, RankItem } from '../types';
import { Card, IconToggle, Kpi, MiniSelect, Section, Table, csvRows, inr, num, pctTxt, useLeads, type Col } from '../ui';

const PLATFORM_COLOR: Record<string, string> = { Meta: 'var(--ld-src-meta)', Google: 'var(--ld-src-google)' };
const money = (v: number | null) => (v === null ? '—' : inr(v));
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);
const times = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}×`);

type Metric = 'spend' | 'unique_leads' | 'cpl' | 'new_retailers' | 'cost_per_new_retailer' | 'revenue' | 'roas' | 'conversion_rate';
const METRICS: { value: Metric; label: string; fmt: (v: number) => string }[] = [
  { value: 'spend', label: 'Spend', fmt: inr },
  { value: 'unique_leads', label: 'Unique leads', fmt: num },
  { value: 'cpl', label: 'CPL', fmt: inr },
  { value: 'new_retailers', label: 'New retailers', fmt: num },
  { value: 'cost_per_new_retailer', label: 'Cost per new retailer', fmt: inr },
  { value: 'conversion_rate', label: 'Lead conversion rate', fmt: (v) => `${v.toFixed(1)}%` },
  { value: 'revenue', label: 'Attributed revenue', fmt: inr },
  { value: 'roas', label: 'ROAS', fmt: (v) => `${v.toFixed(2)}×` },
];

export default function Attribution() {
  const { M, f, rg, canEdit } = useLeads();
  const def = SECTIONS.find((s) => s.id === 'attribution')!;
  const n = SECTIONS.findIndex((s) => s.id === 'attribution') + 1;
  const A = M.p.attribution;
  const L = M.p.leads;

  // ---- lead -> campaign mapping, with every filter of the bar applied
  const map = useMemo(() => {
    const out = { rows: 0, unique: [0, 0, 0], subs: [0, 0, 0], method: new Map<number, number>(), list: [] as number[] };
    if (!L.att) return out;
    for (let i = 0; i < M.nL; i++) {
      if (!leadOk(M, f, i, rg)) continue;
      out.rows++;
      const st = L.att[i];
      out.subs[st]++;
      out.list.push(i);
      if (!L.uniq[i]) continue;
      out.unique[st]++;
      if (st === 0) out.method.set(L.meth![i], (out.method.get(L.meth![i]) ?? 0) + 1);
    }
    return out;
  }, [M, f, rg, L]);
  const paidUnique = map.unique[0] + map.unique[1];

  // ---- campaign KPIs from the server, for the period / level / window of the filter bar
  const q = useMemo(() => ({ start: M.p.months[rg[0]], end: M.p.months[Math.min(rg[1], M.nM - 1)], level: M.p.dims.levels[f.level], window: f.window }), [M, rg, f.level, f.window]);
  const [perf, setPerf] = useState<CampaignPerformance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setErr(null);
    leadsApi.campaignPerformance(q).then((d) => live && setPerf(d)).catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [q]);

  const [scope, setScope] = useState<'leads' | 'all'>('leads');
  const [grain, setGrain] = useState<'monthly' | 'quarterly'>('monthly');
  const [metric, setMetric] = useState<Metric>('cpl');
  const [reviewShow, setReviewShow] = useState<'open' | 'all'>('open');
  const [decided, setDecided] = useState<Record<string, MatchReview['decision']>>({});

  if (!M.p.hasLeads || !A || !L.att) {
    return (
      <Section def={def} n={n}>
        <div className="ld-needs">No attribution yet: it is worked out at the next lead build, once lead rows and ad data are saved.</div>
      </Section>
    );
  }

  const statusName = (i: number) => A.statuses[L.att![i]];
  const methodName = (i: number) => (L.meth![i] >= 0 ? A.methods[L.meth![i]] : '—');
  const exact = new Set(A.exact_methods);
  const listCols: Col<number>[] = [
    { key: 'lead', label: 'Lead', render: (i) => L.name[i] || L.mob[i] || '—', sort: (i) => L.name[i] },
    { key: 'date', label: 'Date', render: (i) => new Date(L.day[i] * 864e5).toLocaleDateString('en-IN'), sort: (i) => L.day[i], csv: (i) => new Date(L.day[i] * 864e5).toISOString().slice(0, 10) },
    { key: 'platform', label: 'Platform', render: (i) => M.p.dims.source[L.src[i]], sort: (i) => M.p.dims.source[L.src[i]] },
    { key: 'campaign', label: 'Campaign', render: (i) => (L.att![i] === 0 ? M.p.dims.campaign[L.camp[i]] : '—'), sort: (i) => M.p.dims.campaign[L.camp[i]] ?? '' },
    { key: 'status', label: 'Status', render: (i) => <span className={`ld-att s${L.att![i]}`}>{statusName(i)}</span>, sort: (i) => statusName(i) },
    { key: 'how', label: 'How matched', render: (i) => <>{methodName(i)}{L.meth![i] >= 0 && !exact.has(L.meth![i]) && <em className="ld-muted"> (fallback)</em>}</>, sort: (i) => methodName(i) },
    { key: 'dup', label: 'Duplicate', render: (i) => (L.uniq[i] ? '' : 'Yes'), sort: (i) => (L.uniq[i] ? 0 : 1), csv: (i) => (L.uniq[i] ? '' : 'Yes') },
  ];

  const rows = (perf?.campaigns ?? []).filter((r) => (scope === 'all' ? true : r.kind !== 'campaign' || r.unique_leads > 0 || r.lead_campaign));
  const campCols: Col<CampaignRow>[] = [
    { key: 'name', label: 'Campaign', render: (r) => <><i className="ld-dot" style={{ background: PLATFORM_COLOR[r.platform] ?? 'var(--ld-src-other)' }} />{r.name}</>, sort: (r) => r.name },
    { key: 'platform', label: 'Platform', render: (r) => r.platform, sort: (r) => r.platform },
    { key: 'spend', label: 'Spend', num: true, render: (r) => (r.spend ? inr(r.spend) : '—'), sort: (r) => r.spend },
    { key: 'uniq', label: 'Unique leads', num: true, render: (r) => num(r.unique_leads), sort: (r) => r.unique_leads },
    { key: 'cpl', label: 'CPL', num: true, render: (r) => money(r.cpl), sort: (r) => r.cpl ?? Infinity },
    { key: 'conv', label: 'Converted', num: true, render: (r) => num(r.converted), sort: (r) => r.converted },
    { key: 'rate', label: 'Conversion', num: true, render: (r) => pct(r.conversion_rate), sort: (r) => r.conversion_rate ?? -1 },
    { key: 'new', label: 'New retailers', num: true, render: (r) => num(r.new_retailers), sort: (r) => r.new_retailers },
    { key: 'cpnr', label: 'Cost / new retailer', num: true, render: (r) => money(r.cost_per_new_retailer), sort: (r) => r.cost_per_new_retailer ?? Infinity },
    { key: 'util', label: 'Budget used', num: true, render: (r) => <span title={r.utilisation_basis ?? ''}>{pct(r.budget_utilisation)}</span>, sort: (r) => r.budget_utilisation ?? -1 },
    { key: 'rev', label: 'Attributed revenue', num: true, render: (r) => (r.revenue ? inr(r.revenue) : '—'), sort: (r) => r.revenue },
    { key: 'roas', label: 'ROAS', num: true, render: (r) => times(r.roas), sort: (r) => r.roas ?? -1 },
    { key: 'spd', label: 'Spend / day', num: true, render: (r) => money(r.spend_per_day), sort: (r) => r.spend_per_day ?? -1 },
    { key: 'lpd', label: 'Leads / day', num: true, render: (r) => (r.leads_per_day === null ? '—' : r.leads_per_day.toFixed(1)), sort: (r) => r.leads_per_day ?? -1 },
    { key: 'score', label: 'Score', num: true, render: (r) => (r.score === null ? <span className="ld-muted" title={r.score_note}>—</span> : r.score.toFixed(0)), sort: (r) => r.score ?? -1 },
  ];

  const plats = perf ? (['Meta', 'Google'] as const).filter((p) => perf.platforms[p]) : [];
  const series = grain === 'monthly' ? perf?.monthly ?? [] : perf?.quarterly ?? [];
  const periods = [...new Set(series.map((r) => r.period))];
  const trend = periods.map((p) => ({ x: p, ...Object.fromEntries(['Meta', 'Google'].map((pl) => [pl, series.find((r) => r.period === p && r.platform === pl)?.[metric] ?? null])) }));
  const mdef = METRICS.find((m) => m.value === metric)!;

  const th = perf?.thresholds;
  const rank = (items: RankItem[] | undefined, fmt: (v: number) => string) =>
    <HBars rows={(items ?? []).map((r) => ({ key: r.key, label: r.name, value: r.value, color: PLATFORM_COLOR[r.platform] }))} fmt={fmt} />;

  const queue = (M.p.matchReview ?? []).map((r) => ({ ...r, decision: decided[`${r.mobile}|${r.retailer_id}`] ?? r.decision }));
  const shownQueue = reviewShow === 'open' ? queue.filter((r) => !r.decision) : queue;
  const decide = (r: MatchReview, decision: 'approve' | 'reject' | 'clear') => {
    const k = `${r.mobile}|${r.retailer_id}`;
    setDecided((d) => ({ ...d, [k]: decision === 'clear' ? '' : decision }));
    leadsApi.saveMatchReview({ mobile: r.mobile, retailer_id: r.retailer_id, decision }).catch(() => setDecided((d) => ({ ...d, [k]: r.decision })));
  };
  const reviewCols: Col<MatchReview>[] = [
    { key: 'lead', label: 'Lead', render: (r) => <>{r.lead_name || '—'}<div className="ld-muted">{[r.lead_city, r.lead_pin].filter(Boolean).join(' · ')} · {r.source} · {r.date}</div></>, sort: (r) => r.date, csv: (r) => r.lead_name },
    { key: 'retailer', label: 'Possible BO retailer', render: (r) => <>{r.retailer_name}<div className="ld-muted">{r.retailer_id} · {[r.retailer_city, r.retailer_pin].filter(Boolean).join(' · ')}</div></>, sort: (r) => r.retailer_name, csv: (r) => `${r.retailer_name} (${r.retailer_id})` },
    { key: 'why', label: 'Why check', render: (r) => <>{r.reason}{r.reason.startsWith('Loose') && <span className="ld-muted"> · {r.score}% similar</span>}</>, sort: (r) => r.reason, csv: (r) => r.reason },
    { key: 'decision', label: 'Decision', render: (r) => (
      r.decision ? (
        <span className="ld-review-done">{r.decision === 'approve' ? 'Same shop' : 'Different shop'}
          {canEdit && <button type="button" className="ld-iconbtn" title="Undo" onClick={() => decide(r, 'clear')}><Undo2 size={14} /></button>}</span>
      ) : canEdit ? (
        <span className="ld-review-btns">
          <button type="button" className="btn sm" onClick={() => decide(r, 'approve')}><Check size={14} /> Same shop</button>
          <button type="button" className="btn sm" onClick={() => decide(r, 'reject')}><X size={14} /> Different</button>
        </span>
      ) : <span className="ld-muted">Waiting</span>
    ), sort: (r) => r.decision, csv: (r) => r.decision },
  ];

  return (
    <Section def={def} n={n}>
      <div className="ld-kpis">
        <Kpi icon={Link2} label="Matched to a campaign" rag="none" value={num(map.unique[0])} sub={`${pctTxt(map.unique[0], paidUnique)} of possible ad leads · ${num(map.subs[0])} submissions`}
          info="Unique leads (first enquiry per mobile) linked to one ad campaign: by lead ID, campaign ID or name when the lead carries one, otherwise by the controlled name + date or date rule." />
        <Kpi icon={Unlink} label="Unmatched" rag="none" value={num(map.unique[1])} sub={`${pctTxt(map.unique[1], paidUnique)} of possible ad leads · ${num(map.subs[1])} submissions`}
          info="Meta or Google leads that could not be linked to exactly one campaign, and leads from a sheet tab that does not say which platform they came from (platform unknown). They are reported here and never spread over campaigns or guessed." />
        <Kpi icon={Ban} label="Non-paid" rag="none" value={num(map.unique[2])} sub={`${num(map.subs[2])} submissions`}
          info="Leads from a source with no ad platform (Print, JustDial), and Meta leads that Meta marks organic." />
        <Kpi icon={Copy} label="Duplicate submissions" rag="none" value={num(map.rows - map.unique[0] - map.unique[1] - map.unique[2])} sub="left out of every unique-lead count"
          info="Repeat enquiries from a mobile that already enquired. The person counts once, for the campaign of their first enquiry." />
      </div>

      <p className="ld-note">
        <b>Attribution window:</b> a lead counts as converted when its shop&apos;s first BO bill falls in the lead&apos;s month or within {f.window} days after it
        (change “Sale within” in the filter bar; leads whose window is not over yet are pending, not failed). <b>Campaign link:</b> by lead ID, campaign ID or name
        where the lead carries one; otherwise only when exactly one lead campaign of that platform collected leads that day, else Unmatched.
      </p>
      <div className="ld-grid">
        <Card title="How leads were matched" uses={['period', 'source', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window', 'campaign']}
          info={{ what: 'Matched unique leads by the rule that linked them. Lead ID, campaign ID and campaign name are exact links; campaign name + date and date are the controlled fallback: used only when exactly one lead campaign of the platform collected leads that day.',
            source: Object.entries(A.platforms).map(([p, x]) => `${p}: ${x.saved ? `campaign data saved ${x.fetched_at?.slice(0, 16).replace('T', ' ')}` : 'no campaign data saved'}${x.lead_id_lookup ? ', lead IDs looked up' : ''}`).join(' · ') }}
          soWhat={Object.values(A.platforms).flatMap((x) => x.notes).join(' ')}>
          <HBars rows={[...map.method.entries()].sort((a, b) => b[1] - a[1]).map(([m, v]) => ({ key: String(m), label: `${A.methods[m]}${exact.has(m) ? '' : ' (fallback)'}`, value: v,
            color: exact.has(m) ? 'var(--ld-o-new)' : 'var(--ld-seq-3)', note: ` ${pctTxt(v, map.unique[0], 0)}` }))} fmt={num} />
        </Card>
        <Card title="Why leads stay unmatched" uses={[]}
          info={{ what: 'Every unmatched lead with its reason, over all the lead data. “Several lead campaigns” lists the campaigns that ran that day: adding a campaign ID or UTM column to the lead sheet, or Meta lead-form access (leads_retrieval), would link these exactly.' }}
          csv={{ name: 'unmatched_reasons', rows: () => A.reasons.map((r) => ({ Platform: r.source, Reason: r.reason, 'Unique leads': r.unique, Submissions: r.submissions })) }}>
          <Table rows={A.reasons} limit={8} cols={[
            { key: 'p', label: 'Platform', render: (r) => r.source, sort: (r) => r.source },
            { key: 'r', label: 'Reason', render: (r) => r.reason, sort: (r) => r.reason },
            { key: 'u', label: 'Unique leads', num: true, render: (r) => num(r.unique), sort: (r) => r.unique },
          ]} initialSort={{ key: 'u', dir: 'desc' }} empty="Every paid lead is matched." />
        </Card>
      </div>

      <Card wide title="Lead → campaign mapping" uses={['period', 'source', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window', 'campaign']}
        info={{ what: 'Every lead submission with its platform, campaign and status. Duplicates are listed, but only the first enquiry per mobile counts as a unique lead.' }}
        csv={{ name: 'lead_campaign_mapping', rows: () => csvRows(map.list, listCols) }}>
        <Table rows={map.list} cols={listCols} initialSort={{ key: 'date', dir: 'desc' }} />
      </Card>

      {err && <div className="ld-needs">{err}</div>}
      {!perf && !err && <div className="ld-empty-s">Working out campaign performance…</div>}
      {perf && (
        <>
          <Card wide title="Campaign performance" uses={['period', 'level', 'window']}
            actions={<IconToggle label="Campaigns shown" value={scope} onChange={setScope} options={[
              { value: 'leads', icon: ListFilter, label: 'With leads' }, { value: 'all', icon: CalendarRange, label: 'Every campaign with spend' }]} />}
            info={{ what: <>CPL is what an enquiry costs; cost per new retailer is what a real buying retailer costs. They can tell very different stories. Converted = a unique lead whose BO retailer billed after the lead (completely new or came back). New retailers = first-ever BO bill after a lead of the campaign. Budget used = spend ÷ (today’s daily budget × days the campaign spent); the platforms keep no budget history. Score: see the rankings.</>,
              formula: 'CPL = spend ÷ unique leads · conversion = converted ÷ unique leads that can be judged × 100 · cost per new retailer = spend ÷ new retailers · ROAS = attributed revenue ÷ spend',
              source: `Spend: Meta / Google as saved on the Ad budget page. Sales: BO billing up to ${perf.sales_end ?? '—'}; leads after that are still too recent to judge.` }}
            csv={{ name: 'campaign_performance', rows: () => csvRows(rows, campCols) }}>
            <Table rows={rows} cols={campCols} initialSort={{ key: 'uniq', dir: 'desc' }} />
          </Card>

          <Card wide title={grain === 'monthly' ? 'Month on month' : 'Quarter on quarter'} uses={['level', 'window']}
              actions={<>
                <MiniSelect label="Metric" value={metric} onChange={setMetric} options={METRICS.map((m) => ({ value: m.value, label: m.label }))} />
                <IconToggle label="Grain" value={grain} onChange={setGrain} options={[{ value: 'monthly', icon: CalendarDays, label: 'Months' }, { value: 'quarterly', icon: CalendarRange, label: 'Quarters' }]} />
              </>}
              info={{ what: 'Meta and Google side by side, every month (or financial-year quarter) up to the end of the period. A blank point = nothing to divide by that month.' }}>
              <Lines data={trend} x="x" fmt={mdef.fmt} series={plats.map((p) => ({ key: p, label: p, color: PLATFORM_COLOR[p] }))} />
            </Card>

          <Card wide title="Campaign rankings" uses={['period', 'level', 'window']}
            info={{ what: <>Ranked on what each campaign achieved, not on lead volume alone. To be ranked a campaign needs at least {th!.min_leads} unique leads and some spend (cost per new retailer also {th!.min_new_retailers}+ new retailers), so a campaign with one lucky lead never tops a list. The overall score (0–100) compares campaigns with ≥ {th!.min_leads} leads and ≥ {inr(th!.min_spend)} spend: {Object.entries(perf.score_weights).map(([k, w]) => `${k.replace(/_/g, ' ')} ${w}%`).join(', ')}, each as a rank among them.</> }}>
            <div className="ld-ranks">
              <div><h4>Best overall</h4>{rank(perf.rankings.best_overall, (v) => v.toFixed(0))}</div>
              <div><h4>Lowest cost per new retailer</h4>{rank(perf.rankings.lowest_cost_per_new_retailer, inr)}</div>
              <div><h4>Lowest CPL</h4>{rank(perf.rankings.lowest_cpl, inr)}</div>
              <div><h4>Highest conversion rate</h4>{rank(perf.rankings.highest_conversion_rate, (v) => `${v.toFixed(1)}%`)}</div>
              <div><h4>Highest attributed revenue</h4>{rank(perf.rankings.highest_revenue, inr)}</div>
            </div>
          </Card>
        </>
      )}

      <Card wide title="Check unclear retailer matches" uses={[]}
        actions={<IconToggle label="Show" value={reviewShow} onChange={setReviewShow} options={[{ value: 'open', icon: ListFilter, label: 'Waiting' }, { value: 'all', icon: Check, label: 'All' }]} />}
        info={{ what: 'A lead is counted as a BO retailer only when it matches one, and a new retailer only after that retailer’s first BO bill. These matches are unclear: a shop name that is only similar (the Loose matching level), or a phone number several BO retailers share. Same shop = the match counts from the Normal level up; Different = the lead is treated as unmatched. Decisions apply at the next rebuild (within a few minutes).' }}
        csv={{ name: 'match_review', rows: () => csvRows(shownQueue, reviewCols) }}
        soWhat={`${num(queue.filter((r) => !r.decision).length)} waiting, ${num(queue.filter((r) => r.decision).length)} decided.`}>
        <Table rows={shownQueue} cols={reviewCols} limit={10} empty="Nothing waiting for a check." />
      </Card>
    </Section>
  );
}
