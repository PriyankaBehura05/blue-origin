// Detailed ad analytics on the Campaign performance page: Meta (ad sets, ads, placements, audience, regions, devices, conversion
// events) and Google (keywords, search terms, devices, geography, conversion actions). The campaign totals, budgets and trends are
// the cards above them (GtCampaigns, PlatformTrends). Data is what the platforms report, saved by the Ad budget page's refresh
// (adDetail.ts): a figure the platform does not give is shown as "—" or "not available", never as 0.
import { useMemo, useState, type ReactNode } from 'react';
import { HelpTip } from '@/components/HelpTip';
import { cpc, cpl, cpm, ctr, eventName, freq, groupBy, perfOf, rate, titleCase, type Perf } from '../adDetail';
import type { AdDetail, BudgetPayload, GoogleTab, MetaAd, MetaAdset } from '../types';
import { Card, MiniSelect, Table, csvRows, inr, num, useLeads, type Col } from '../ui';

const USES = ['period', 'source', 'campaign'] as const;
const money = (v: number | null) => (v === null ? '—' : inr(v));
const pc = (v: number | null, d = 2) => (v === null ? '—' : `${v.toFixed(d)}%`);
const dec = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
const reachText = (p: Perf) => (p.reach === null ? '—' : `${p.reachApprox ? '≈ ' : ''}${num(Math.round(p.reach))}`);
const clip = (s: string | null | undefined, n = 60) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The creative's readable text: the headline, else the body; Meta's dynamic templates ({{product.name}}) are not text people see. */
const creativeText = (a: { headline: string | null; body: string | null; format: string | null }) => {
  const ok = (t: string | null) => (t && !t.includes('{{') ? t : null);
  return ok(a.headline) ?? ok(a.body) ?? 'Dynamic creative (text and images filled in by Meta)';
};

/** A tab the platform's data does not have: why, without ever showing it as zero. */
function Unavailable({ what, fix }: { what: string; fix: string }) {
  return <div className="ld-needs"><b>{what}</b> is not available yet. {fix}</div>;
}
const FETCH = 'An admin can fetch it with the Fetch button on the Ad budget page; it is saved with the budget.';
const SCRIPT = 'Paste the updated Google Ads script (backend/docs/google_ads_to_sheet.js) into Google Ads and run it once.';

interface Agg { key: string; label: string; sub?: string; spend: number; impressions: number; clicks: number; leads: number }

function BreakdownTable({ rows, head, limit = 10, leadsLabel = 'Leads', cplLabel = 'CPL', empty }: {
  rows: Agg[]; head: string; limit?: number; leadsLabel?: string; cplLabel?: string; empty?: ReactNode;
}) {
  const total = rows.reduce((s, r) => s + r.spend, 0);
  const cols: Col<Agg>[] = [
    { key: 'l', label: head, render: (r) => <>{r.label}{r.sub ? <div className="ld-muted">{r.sub}</div> : null}</>, sort: (r) => r.label, csv: (r) => `${r.label}${r.sub ? ` (${r.sub})` : ''}` },
    { key: 's', label: 'Spend', num: true, render: (r) => inr(r.spend), sort: (r) => r.spend },
    { key: 'sh', label: 'Share of spend', num: true, render: (r) => pc(rate(r.spend, total), 1), sort: (r) => r.spend, csv: (r) => rate(r.spend, total)?.toFixed(1) ?? '' },
    { key: 'i', label: 'Impressions', num: true, render: (r) => num(Math.round(r.impressions)), sort: (r) => r.impressions },
    { key: 'c', label: 'Clicks', num: true, render: (r) => num(Math.round(r.clicks)), sort: (r) => r.clicks },
    { key: 'ctr', label: 'CTR', num: true, render: (r) => pc(ctr(r)), sort: (r) => ctr(r) ?? -1, csv: (r) => ctr(r)?.toFixed(2) ?? '' },
    { key: 'cpc', label: 'CPC', num: true, render: (r) => money(cpc(r)), sort: (r) => cpc(r) ?? Infinity, csv: (r) => cpc(r)?.toFixed(2) ?? '' },
    { key: 'ld', label: leadsLabel, num: true, render: (r) => num(Math.round(r.leads)), sort: (r) => r.leads },
    { key: 'cpl', label: cplLabel, num: true, render: (r) => (r.leads ? money(cpl(r)) : 'N/A'), sort: (r) => cpl(r) ?? Infinity, csv: (r) => cpl(r)?.toFixed(2) ?? 'N/A' },
  ];
  return rows.length ? <Table rows={rows} cols={cols} limit={limit} initialSort={{ key: 's', dir: 'desc' }} /> : <div className="ld-empty-s">{empty ?? 'No rows in this period.'}</div>;
}
const csvOf = (rows: Agg[], head: string) => rows.map((r) => ({ [head]: r.label, Detail: r.sub ?? '', Spend: Math.round(r.spend), Impressions: Math.round(r.impressions), Clicks: Math.round(r.clicks), CTR: ctr(r)?.toFixed(2) ?? '', Leads: Math.round(r.leads), CPL: cpl(r)?.toFixed(2) ?? 'N/A' }));

/** Add up rows by a key: spend, impressions, clicks and leads (reach is not additive and is left out). */
type Row = Record<string, string | number | undefined>;
function aggregate(rows: Row[], key: (r: Row) => [string, string, string?], leadsKey = 'leads'): Agg[] {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const [k, label, sub] = key(r);
    const e = m.get(k) ?? { key: k, label, sub, spend: 0, impressions: 0, clicks: 0, leads: 0 };
    e.spend += Number(r.spend) || 0; e.impressions += Number(r.impressions) || 0; e.clicks += Number(r.clicks) || 0; e.leads += Number(r[leadsKey]) || 0;
    m.set(k, e);
  }
  return [...m.values()];
}

/* ------------------------------------------------------------------------------------------------------- Meta */
export function MetaAnalytics({ budget, detail }: { budget: BudgetPayload | null; detail: AdDetail | null }) {
  const { M, f, rg } = useLeads();
  const meta = detail?.meta ?? null;
  const [split, setSplit] = useState<'age' | 'gender' | 'both'>('age');
  const months = useMemo(() => new Set(M.p.months.slice(rg[0], Math.min(rg[1], M.nM - 1) + 1)), [M, rg]);
  const camps = useMemo(() => {
    const m = new Map<string, { name: string; status: string }>();
    for (const a of budget?.meta?.snapshot?.accounts ?? []) for (const c of a.campaigns) m.set(c.campaign_id, { name: c.name, status: c.status_group });
    return m;
  }, [budget]);
  const campName = f.campaign >= 0 ? M.p.dims.campaign[f.campaign] : null;
  const keep = (cid: string) => !campName || camps.get(cid)?.name === campName;
  const hidden = f.source >= 0 && M.p.dims.source[f.source] !== 'Meta';

  const adsets = useMemo(() => {
    if (!meta) return [];
    const mon = groupBy(meta.adset_monthly, (r) => r.adset_id ?? '');
    const life = new Map(meta.adset_life.map((r) => [r.adset_id ?? '', r]));
    return meta.adsets.filter((a) => keep(a.campaign_id)).map((a) => ({ a, p: perfOf(mon.get(a.adset_id) ?? [], life.get(a.adset_id), months) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, months, campName, camps]);
  const ads = useMemo(() => {
    if (!meta) return [];
    const mon = groupBy(meta.ad_monthly, (r) => r.ad_id ?? '');
    const life = new Map(meta.ad_life.map((r) => [r.ad_id ?? '', r]));
    const setName = new Map(meta.adsets.map((a) => [a.adset_id, a.name]));
    return meta.ads.filter((a) => keep(a.campaign_id)).map((a) => ({ a, set: setName.get(a.adset_id) ?? '', p: perfOf(mon.get(a.ad_id) ?? [], life.get(a.ad_id), months) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, months, campName, camps]);
  const bd = (name: 'placement' | 'age_gender' | 'region' | 'device') => (meta?.breakdowns[name] ?? []).filter((r) => months.has(r.period) && keep(r.campaign_id));
  const placements = useMemo(() => aggregate(bd('placement'), (r) => {
    const plat = String(r.publisher_platform); const pos = String(r.platform_position).replace(new RegExp(`^${plat}_?`), '');
    return [`${plat}|${pos}`, `${titleCase(plat)} · ${titleCase(pos) || 'All'}`];
  }), [meta, months, campName, camps]); // eslint-disable-line react-hooks/exhaustive-deps
  const audience = useMemo(() => aggregate(bd('age_gender'), (r) => {
    const age = String(r.age); const g = titleCase(r.gender);
    return split === 'age' ? [age, age] : split === 'gender' ? [g, g] : [`${age}|${g}`, age, g];
  }), [meta, months, campName, camps, split]); // eslint-disable-line react-hooks/exhaustive-deps
  const regions = useMemo(() => aggregate(bd('region'), (r) => [String(r.region), String(r.region)]), [meta, months, campName, camps]); // eslint-disable-line react-hooks/exhaustive-deps
  const devices = useMemo(() => aggregate(bd('device'), (r) => [String(r.device_platform), titleCase(r.device_platform)]), [meta, months, campName, camps]); // eslint-disable-line react-hooks/exhaustive-deps
  const events = useMemo(() => {
    const ids = [...new Set((meta?.events ?? []).filter((e) => keep(e.campaign_id)).map((e) => e.campaign_id))];
    const by = groupBy((meta?.events ?? []).filter((e) => keep(e.campaign_id)), (e) => e.action_type);
    const rows = [...by.entries()].map(([t, es]) => ({ t, name: eventName(t), by: Object.fromEntries(es.map((e) => [e.campaign_id, e.value])) as Record<string, number>, total: es.reduce((s, e) => s + e.value, 0) }));
    return { ids, rows: rows.sort((a, b) => b.total - a.total) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, campName, camps]);

  if (hidden) return <div className="ld-needs">The Source filter excludes Meta, so its detail is hidden.</div>;
  if (!meta) return <Unavailable what="Meta detail (ad sets, ads, placements, audience)" fix={detail ? FETCH : 'Loading…'} />;
  const err = Object.entries(meta.errors);
  const active = adsets.filter((x) => x.p.spend > 0 || x.p.impressions > 0);
  const activeAds = ads.filter((x) => x.p.spend > 0 || x.p.impressions > 0);

  const setCols: Col<{ a: MetaAdset; p: Perf }>[] = [
    { key: 'n', label: 'Ad set', render: ({ a }) => <>{a.name}<div className="ld-muted">{a.status ? titleCase(a.status.toLowerCase()) : ''}{a.optimization_goal ? ` · ${titleCase(a.optimization_goal.toLowerCase())}` : ''}</div></>, sort: ({ a }) => a.name, csv: ({ a }) => a.name },
    { key: 'c', label: 'Campaign', render: ({ a }) => camps.get(a.campaign_id)?.name ?? a.campaign_id, sort: ({ a }) => camps.get(a.campaign_id)?.name ?? '' },
    { key: 'au', label: 'Audience', render: ({ a }) => <span title={`${a.audience.locations}${a.audience.interests.length ? ` · Interests: ${a.audience.interests.join(', ')}` : ''}`}>{a.audience.age}, {a.audience.gender}<div className="ld-muted">{clip(a.audience.locations, 42)}{a.audience.custom_audiences ? ` · ${a.audience.custom_audiences} custom` : ''}{a.audience.advantage_audience ? ' · Advantage+' : ''}</div></span>, sort: ({ a }) => a.audience.locations, csv: ({ a }) => `${a.audience.age}, ${a.audience.gender}, ${a.audience.locations}` },
    { key: 'pl', label: 'Placements', render: ({ a }) => <span title={a.placements.positions.join(', ')}>{a.placements.text}</span>, sort: ({ a }) => a.placements.text, csv: ({ a }) => a.placements.text },
    { key: 'b', label: 'Daily budget', num: true, render: ({ a }) => (a.daily_budget ? inr(a.daily_budget) : a.lifetime_budget ? `${inr(a.lifetime_budget)} total` : 'campaign budget'), sort: ({ a }) => a.daily_budget ?? 0, csv: ({ a }) => a.daily_budget ?? '' },
    { key: 's', label: 'Spend', num: true, render: ({ p }) => inr(p.spend), sort: ({ p }) => p.spend },
    { key: 'r', label: 'Reach', num: true, render: ({ p }) => reachText(p), sort: ({ p }) => p.reach ?? -1 },
    { key: 'f', label: 'Frequency', num: true, render: ({ p }) => dec(freq(p)), sort: ({ p }) => freq(p) ?? -1 },
    { key: 'i', label: 'Impressions', num: true, render: ({ p }) => num(Math.round(p.impressions)), sort: ({ p }) => p.impressions },
    { key: 'k', label: 'Clicks', num: true, render: ({ p }) => num(Math.round(p.clicks)), sort: ({ p }) => p.clicks },
    { key: 'ctr', label: 'CTR', num: true, render: ({ p }) => pc(ctr(p)), sort: ({ p }) => ctr(p) ?? -1 },
    { key: 'cpc', label: 'CPC', num: true, render: ({ p }) => money(cpc(p)), sort: ({ p }) => cpc(p) ?? Infinity },
    { key: 'cpm', label: 'CPM', num: true, render: ({ p }) => money(cpm(p)), sort: ({ p }) => cpm(p) ?? Infinity },
    { key: 'l', label: 'Leads', num: true, render: ({ p }) => num(Math.round(p.leads)), sort: ({ p }) => p.leads },
    { key: 'cpl', label: 'CPL', num: true, render: ({ p }) => (p.leads ? money(cpl(p)) : 'N/A'), sort: ({ p }) => cpl(p) ?? Infinity, csv: ({ p }) => cpl(p)?.toFixed(2) ?? 'N/A' },
  ];
  const adCols: Col<{ a: MetaAd; set: string; p: Perf }>[] = [
    { key: 'n', label: 'Ad', render: ({ a }) => <>{a.name}<div className="ld-muted">{a.status ? titleCase(a.status.toLowerCase()) : ''}</div></>, sort: ({ a }) => a.name, csv: ({ a }) => a.name },
    { key: 'set', label: 'Ad set', render: ({ set }) => set || '—', sort: ({ set }) => set },
    { key: 'fm', label: 'Format', render: ({ a }) => a.format ?? '—', sort: ({ a }) => a.format ?? '' },
    { key: 'cr', label: 'Creative', render: ({ a }) => <span title={a.body ?? ''}>{clip(creativeText(a), 54)}{a.cta ? <div className="ld-muted">Button: {a.cta}</div> : null}</span>, sort: ({ a }) => creativeText(a), csv: ({ a }) => creativeText(a) },
    { key: 's', label: 'Spend', num: true, render: ({ p }) => inr(p.spend), sort: ({ p }) => p.spend },
    { key: 'r', label: 'Reach', num: true, render: ({ p }) => reachText(p), sort: ({ p }) => p.reach ?? -1 },
    { key: 'f', label: 'Frequency', num: true, render: ({ p }) => dec(freq(p)), sort: ({ p }) => freq(p) ?? -1 },
    { key: 'i', label: 'Impressions', num: true, render: ({ p }) => num(Math.round(p.impressions)), sort: ({ p }) => p.impressions },
    { key: 'k', label: 'Clicks', num: true, render: ({ p }) => num(Math.round(p.clicks)), sort: ({ p }) => p.clicks },
    { key: 'ctr', label: 'CTR', num: true, render: ({ p }) => pc(ctr(p)), sort: ({ p }) => ctr(p) ?? -1 },
    { key: 'cpc', label: 'CPC', num: true, render: ({ p }) => money(cpc(p)), sort: ({ p }) => cpc(p) ?? Infinity },
    { key: 'l', label: 'Leads', num: true, render: ({ p }) => num(Math.round(p.leads)), sort: ({ p }) => p.leads },
    { key: 'cpl', label: 'CPL', num: true, render: ({ p }) => (p.leads ? money(cpl(p)) : 'N/A'), sort: ({ p }) => cpl(p) ?? Infinity, csv: ({ p }) => cpl(p)?.toFixed(2) ?? 'N/A' },
  ];
  const evCols: Col<(typeof events.rows)[number]>[] = [
    { key: 'e', label: 'Conversion event', render: (r) => <span title={r.t}>{r.name}</span>, sort: (r) => r.name, csv: (r) => r.name },
    ...events.ids.map((id) => ({ key: id, label: camps.get(id)?.name ?? id, num: true, render: (r: (typeof events.rows)[number]) => (r.by[id] !== undefined ? num(Math.round(r.by[id])) : '—'), sort: (r: (typeof events.rows)[number]) => r.by[id] ?? -1, csv: (r: (typeof events.rows)[number]) => r.by[id] ?? '' })),
  ];

  return (
    <>
      {err.length > 0 && <div className="ld-needs">Some Meta detail could not be read at the last fetch ({err.map(([k, v]) => `${k}: ${v}`).join('; ')}). The rest is shown; the Fetch button on the Ad budget page tries again.</div>}
      <Card wide title="Meta ad sets" uses={[...USES]}
        info={{ what: 'Every ad set of the campaigns that spent in the period, with its audience (age, gender, locations, custom audiences), placements and budget as set today, and its performance. Reach counts people: the whole campaign life is exact, one month is exact, several months are added (≈) and have no frequency.',
          formula: 'frequency = impressions ÷ reach · CTR = clicks ÷ impressions · CPM = spend ÷ impressions × 1000 · CPL = spend ÷ leads', source: 'Meta Marketing API, saved with the Ad budget page' }}
        csv={{ name: 'meta_ad_sets', rows: () => csvRows(active, setCols) }}
        soWhat={adsets.length > active.length ? `${num(adsets.length - active.length)} ad sets had no spend in this period and are not listed.` : undefined}>
        {meta.adsets.length === 0
          ? <Unavailable what="Ad sets" fix={`${meta.errors['ad sets'] ? `Meta refused the request at the last fetch (${meta.errors['ad sets']}). ` : ''}${FETCH}`} />
          : <Table rows={active} cols={setCols} limit={10} initialSort={{ key: 's', dir: 'desc' }} empty="No ad set spent in this period." />}
      </Card>
      <Card wide title="Meta ads and creatives" uses={[...USES]}
        info={{ what: 'Every ad that spent in the period with its format and creative (headline and button), and its performance. The format is the creative type Meta reports; previews of the images and videos are not loaded.', source: 'Meta Marketing API' }}
        csv={{ name: 'meta_ads', rows: () => csvRows(activeAds, adCols) }}
        soWhat={ads.length > activeAds.length ? `${num(ads.length - activeAds.length)} ads had no spend in this period and are not listed.` : undefined}>
        {meta.ads.length === 0
          ? <Unavailable what="Ads" fix={`${meta.errors['ads'] ? `Meta refused the request at the last fetch (${meta.errors['ads']}). ` : ''}${FETCH}`} />
          : <Table rows={activeAds} cols={adCols} limit={10} initialSort={{ key: 's', dir: 'desc' }} empty="No ad spent in this period." />}
      </Card>
      <div className="ld-grid">
        <Card title="Placements" uses={[...USES]} info={{ what: 'Where the ads were shown (Facebook feed, Instagram stories …) and what each placement cost and brought in.', source: 'Meta Marketing API breakdown' }} csv={{ name: 'meta_placements', rows: () => csvOf(placements, 'Placement') }}>
          <BreakdownTable rows={placements} head="Placement" empty={meta.errors['placement breakdown'] ? 'Could not be read at the last fetch.' : undefined} />
        </Card>
        <Card title="Devices" uses={[...USES]} info={{ what: 'Performance by the device the ad was shown on.', source: 'Meta Marketing API breakdown' }} csv={{ name: 'meta_devices', rows: () => csvOf(devices, 'Device') }}>
          <BreakdownTable rows={devices} head="Device" empty={meta.errors['device breakdown'] ? 'Could not be read at the last fetch.' : undefined} />
        </Card>
        <Card title="Audience: age and gender" uses={[...USES]} actions={<MiniSelect label="Split by" value={split} onChange={setSplit} options={[{ value: 'age', label: 'Age' }, { value: 'gender', label: 'Gender' }, { value: 'both', label: 'Age and gender' }]} />}
          info={{ what: 'Who the ads reached and who turned into leads, by the age and gender Meta reports. “Unknown” gender is people Meta could not classify.', source: 'Meta Marketing API breakdown' }} csv={{ name: 'meta_audience', rows: () => csvOf(audience, 'Audience') }}>
          <BreakdownTable rows={audience} head={split === 'age' ? 'Age' : split === 'gender' ? 'Gender' : 'Age'} limit={12} empty={meta.errors['age_gender breakdown'] ? 'Could not be read at the last fetch.' : undefined} />
        </Card>
        <Card title="Regions" uses={[...USES]} info={{ what: 'Spend and leads by the region (state) of the people reached, as Meta reports it. Cost per lead tells where to put more or less budget.', source: 'Meta Marketing API breakdown' }} csv={{ name: 'meta_regions', rows: () => csvOf(regions, 'Region') }}>
          <BreakdownTable rows={regions} head="Region" empty={meta.errors['region breakdown'] ? 'Could not be read at the last fetch.' : undefined} />
        </Card>
      </div>
      <Card wide title="Conversion events" uses={['source', 'campaign']}
        info={{ what: 'Every action Meta recorded for the campaigns over their whole life (not the selected period): lead form submissions, link clicks, landing page views, messaging conversations and more. “Leads” everywhere else on this page is the largest of the lead actions, never their sum. Individual lead-form records need the leads_retrieval permission, which the Meta token does not have.', source: 'Meta Marketing API (actions)' }}
        csv={{ name: 'meta_conversion_events', rows: () => csvRows(events.rows, evCols) }}>
        <Table rows={events.rows} cols={evCols} limit={12} empty="No events recorded." />
      </Card>
    </>
  );
}

/* ----------------------------------------------------------------------------------------------------- Google */
export function GoogleAnalytics({ detail }: { detail: AdDetail | null }) {
  const { M, f, rg } = useLeads();
  const g = detail?.google ?? null;
  const months = useMemo(() => new Set(M.p.months.slice(rg[0], Math.min(rg[1], M.nM - 1) + 1)), [M, rg]);
  const campName = f.campaign >= 0 ? M.p.dims.campaign[f.campaign] : null;
  const hidden = f.source >= 0 && M.p.dims.source[f.source] !== 'Google';
  const rowsOf = (tab: GoogleTab | undefined) => (tab?.rows ?? []).filter((r) => months.has(String(r.period)) && (!campName || r.campaign_name === campName));

  const keywords = useMemo(() => aggregate(rowsOf(g?.tabs?.keywords),
    (r) => [`${r.campaign_name}|${r.ad_group}|${r.keyword}|${r.match_type}`, String(r.keyword), `${titleCase(String(r.match_type).toLowerCase())} · ${r.campaign_name}`], 'conversions'), [g, months, campName]); // eslint-disable-line react-hooks/exhaustive-deps
  const terms = useMemo(() => aggregate(rowsOf(g?.tabs?.search_terms),
    (r) => [`${r.campaign_name}|${r.search_term}`, String(r.search_term), String(r.campaign_name)], 'conversions'), [g, months, campName]); // eslint-disable-line react-hooks/exhaustive-deps
  const devices = useMemo(() => aggregate(rowsOf(g?.tabs?.devices),
    (r) => [String(r.device), titleCase(String(r.device).toLowerCase())], 'conversions'), [g, months, campName]); // eslint-disable-line react-hooks/exhaustive-deps
  const geo = useMemo(() => aggregate(rowsOf(g?.tabs?.geo),
    (r) => [String(r.region), String(r.region)], 'conversions'), [g, months, campName]); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useMemo(() => {
    const m = new Map<string, { name: string; conv: number; all: number }>();
    for (const r of rowsOf(g?.tabs?.conversions)) {
      const k = String(r.conversion_action);
      const e = m.get(k) ?? { name: k, conv: 0, all: 0 };
      e.conv += Number(r.conversions) || 0; e.all += Number(r.all_conversions) || 0;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.all - a.all);
  }, [g, months, campName]); // eslint-disable-line react-hooks/exhaustive-deps

  if (hidden) return <div className="ld-needs">The Source filter excludes Google, so its detail is hidden.</div>;
  if (!detail) return <Unavailable what="Google detail" fix="Loading…" />;
  if (!g) return <Unavailable what="Google detail (keywords, search terms, devices, geography)" fix={FETCH} />;
  if (!g.tabs) return <Unavailable what="Google detail (keywords, search terms, devices, geography)" fix={g.reason ?? ''} />;
  const tabs = g.tabs;
  const state = (tab: GoogleTab, what: string, none: string, body: ReactNode) => {
    if (tab.error) return <div className="ld-needs"><b>{what}</b> could not be read by the Google Ads script: {tab.error}. The other Google figures are not affected.</div>;
    if (!tab.available) return <Unavailable what={what} fix={SCRIPT} />;
    return body ?? <div className="ld-empty-s">{none}</div>;
  };
  const PMAX = 'No rows. Performance Max campaigns have no keywords or search terms; this fills only for Search campaigns.';
  const convLabel = 'Conv.';
  return (
    <>
      <Card wide title="Google keywords and match types" uses={[...USES]} csv={{ name: 'google_keywords', rows: () => csvOf(keywords, 'Keyword') }}
        info={{ what: 'Keywords of Search campaigns with their match type, and what each cost and converted. Performance Max campaigns have no keywords.', formula: 'cost per conversion = spend ÷ conversions', source: 'Google Ads script sheet (Ads_Keywords)' }}>
        {state(tabs.keywords, 'Keywords', PMAX, keywords.length ? <BreakdownTable rows={keywords} head="Keyword" leadsLabel={convLabel} cplLabel="Cost / conv." /> : null)}
      </Card>
      <Card wide title="Google search terms" uses={[...USES]} csv={{ name: 'google_search_terms', rows: () => csvOf(terms, 'Search term') }}
        info={{ what: `What people searched before seeing the ads (the top ${tabs.search_terms.capped ?? 3000} by spend are kept), with cost and conversions. Performance Max campaigns do not report search terms here.`, source: 'Google Ads script sheet (Ads_SearchTerms)' }}>
        {state(tabs.search_terms, 'Search terms', PMAX, terms.length ? <BreakdownTable rows={terms} head="Search term" leadsLabel={convLabel} cplLabel="Cost / conv." /> : null)}
      </Card>
      <div className="ld-grid">
        <Card title="Google devices" uses={[...USES]} csv={{ name: 'google_devices', rows: () => csvOf(devices, 'Device') }} info={{ what: 'Performance by the device the ads were shown on.', source: 'Google Ads script sheet (Ads_Devices)' }}>
          {state(tabs.devices, 'Devices', 'No device rows in this period.', devices.length ? <BreakdownTable rows={devices} head="Device" leadsLabel={convLabel} cplLabel="Cost / conv." /> : null)}
        </Card>
        <Card title="Google geography" uses={[...USES]} csv={{ name: 'google_geography', rows: () => csvOf(geo, 'Region') }} info={{ what: 'Spend and conversions by the region of the people reached.', source: 'Google Ads script sheet (Ads_Geo)' }}>
          {state(tabs.geo, 'Geography', 'No geography rows in this period.', geo.length ? <BreakdownTable rows={geo} head="Region" leadsLabel={convLabel} cplLabel="Cost / conv." /> : null)}
        </Card>
      </div>
      <Card wide title="Google conversion actions" uses={[...USES]} csv={{ name: 'google_conversion_actions', rows: () => actions.map((a) => ({ Action: a.name, Conversions: a.conv, 'All conversions': a.all, 'Counted as leads': a.name.toLowerCase() === g.lead_action.toLowerCase() ? 'Yes' : 'No' })) }}
        info={{ what: <>Each conversion action Google counts for the campaigns. Only the action named “{g.lead_action}” is counted as leads everywhere in the dashboard; the others are shown so nothing is hidden. If that action is a secondary one, its All conversions count is used.</>, source: 'Google Ads script sheet (Ads_Conversions)' }}>
        {state(tabs.conversions, 'Conversion actions', 'No conversions recorded in this period.', actions.length ? (
          <Table rows={actions} limit={10} initialSort={{ key: 'all', dir: 'desc' }} cols={[
            { key: 'n', label: 'Conversion action', render: (a) => <>{a.name}{a.name.toLowerCase() === g.lead_action.toLowerCase() ? <span className="ld-call scale" style={{ marginLeft: 8 }}>Counted as leads</span> : null}</>, sort: (a) => a.name },
            { key: 'c', label: 'Conversions', num: true, render: (a) => num(Math.round(a.conv)), sort: (a) => a.conv },
            { key: 'a', label: 'All conversions', num: true, render: (a) => num(Math.round(a.all)), sort: (a) => a.all },
          ]} />
        ) : null)}
      </Card>
    </>
  );
}

/** Quick links to the parts of the Campaign performance page. */
export function JumpBar({ items }: { items: [string, string][] }) {
  return (
    <div className="ld-related">
      <span className="ld-note">Jump to:</span>
      {items.map(([id, label]) => <button key={id} type="button" className="ld-btn" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{label}</button>)}
      <HelpTip text="Every card shows the period and filters of the filter bar. Spend, budgets and ad figures follow the Source and Campaign filters only: the platforms do not report them by state, city, distributor or tier." />
    </div>
  );
}
