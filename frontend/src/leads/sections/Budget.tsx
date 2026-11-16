// Ad budget: for each ad platform (Meta, Google) the account, every campaign with its status, daily budget, spend, how much
// of the budget is used and what is left, and spend by month and by financial quarter.
// Opening this page never calls Meta or Google: it shows what the last fetch saved (GET /api/ads/budget). Only an admin can
// press "Fetch latest", which collects fresh numbers in the background.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, Gauge, Megaphone, PiggyBank, RefreshCw, Search, Wallet } from 'lucide-react';
import { ErrorBox, Loading } from '@/components/ui';
import { useSession } from '@/services/session';
import { formatINR, formatNumber, quarterLong } from '@/utils/format';
import { adsApi } from '../api';
import { StackedBars } from '../charts';
import { SECTIONS } from '../sections';
import type { BudgetAccount, BudgetCampaign, BudgetPayload, BudgetPlatform } from '../types';
import { ExportBtn, IconToggle, Kpi, MiniSelect, Section, STROKE, Table, downloadCsv, type Col } from '../ui';
import { HelpTip } from '@/components/HelpTip';

type Platform = 'meta' | 'google';
type Group = 'active' | 'paused' | 'ended' | 'all';
const NAMES: Record<Platform, string> = { meta: 'Meta Ads', google: 'Google Ads' };
const MISSING_HELP: Record<string, string> = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'developer token', GOOGLE_ADS_CLIENT_ID: 'OAuth client ID', GOOGLE_ADS_CLIENT_SECRET: 'OAuth client secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh token', META_ACCESS_TOKEN: 'access token',
};

const money = (cur: string | null | undefined) => (n: number) => (!cur || cur === 'INR' ? formatINR(n) : `${cur} ${formatNumber(n)}`);
const moneyC = (cur: string | null | undefined) => (n: number) => (!cur || cur === 'INR' ? formatINR(n, true) : `${cur} ${formatNumber(n)}`);
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((s, v) => s + (v ?? 0), 0);

export default function Budget() {
  const def = SECTIONS.find((s) => s.id === 'budget')!;
  const isAdmin = useSession()?.user.role === 'admin';
  const [data, setData] = useState<BudgetPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>('meta');
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adsApi.budget());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // while a fetch runs in the background, look again every few seconds (this only reads what is saved)
  const running = !!data && (data.meta.refreshing || data.google.refreshing);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const fetchNow = async (p: Platform) => {
    setAsking(true);
    try {
      await adsApi.refreshBudget([p]);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  return (
    <Section def={def} n={SECTIONS.findIndex((s) => s.id === 'budget') + 1}
      actions={<IconToggle label="Platform" value={platform} onChange={setPlatform}
        options={[{ value: 'meta', icon: Megaphone, label: 'Meta Ads' }, { value: 'google', icon: Search, label: 'Google Ads' }]} />}>
      <PlatformView key={platform} platform={platform} p={data[platform]} isAdmin={isAdmin} busy={asking} onFetch={() => void fetchNow(platform)} />
    </Section>
  );
}

function PlatformView({ platform, p, isAdmin, busy, onFetch }: { platform: Platform; p: BudgetPlatform; isAdmin: boolean; busy: boolean; onFetch: () => void }) {
  const [acctIx, setAcctIx] = useState(0);
  const snap = p.snapshot;
  const name = NAMES[platform];

  const sample = !!snap?.sample;
  const canFetch = p.mode !== 'off' && p.mode !== 'sample';
  const status = (
    <div className={`ld-banner${sample ? ' ld-sample' : ''}`} role="status">
      <RefreshCw size={16} strokeWidth={STROKE} aria-hidden className={p.refreshing ? 'ld-spin' : undefined} />
      <span>
        {sample ? <><b>SAMPLE DATA — not real {name} figures.</b> Made up to preview this page (GOOGLE_ADS_MODE=sample). Never saved, and never used in the dashboard's totals, cost per lead or ROAS.</>
          : p.mode === 'off' ? <><b>{name}</b> is switched off (GOOGLE_ADS_MODE=off): not connected.</>
          : p.refreshing ? <>Fetching from <b>{name}</b>… this can take a minute or two. The page updates by itself.</>
          : snap ? <>Last fetched from <b>{name}</b>: <b>{when(snap.fetched_at)}</b>. This page shows saved numbers; it does not call {name} when opened.{p.configured && p.auto_minutes > 0 ? <> They are refreshed automatically about every {p.auto_minutes} minutes.</> : null}</>
          : p.configured ? <>Nothing has been fetched from <b>{name}</b> yet.</>
          : <><b>{name}</b> is not connected yet.</>}
        {isAdmin || !canFetch ? '' : ' Only an admin can fetch fresh numbers.'}
      </span>
      {isAdmin && canFetch && <button type="button" className="ld-btn primary" disabled={busy || p.refreshing || !p.configured} onClick={onFetch}
        title={p.configured ? `Fetch the latest from ${name}` : `${name} is not connected`}>
        <RefreshCw size={14} strokeWidth={STROKE} aria-hidden />{p.refreshing ? 'Fetching…' : 'Fetch latest'}
      </button>}
    </div>
  );

  const notConnected = !p.configured && (
    <div className="ld-needs">
      {p.mode === 'off'
        ? <>{name} is not connected, so there is nothing to show. In backend/.env, GOOGLE_ADS_MODE=live uses the Google Ads API (once its credentials are added),
            and GOOGLE_ADS_MODE=sample previews this page with clearly marked made-up figures.</>
        : <>{name} is not connected, so there is nothing to show. It still needs: {p.missing.map((m) => MISSING_HELP[m] ?? m).join(', ')}.
            These are set by whoever manages the server (in backend/.env); no figures are shown or invented until then.</>}
    </div>
  );
  const failed = p.error && (
    <div className="ld-needs" role="alert"><CircleAlert size={14} strokeWidth={STROKE} aria-hidden /> The last fetch failed: {p.error}</div>
  );

  if (!snap) return <>{status}{notConnected}{failed}{p.configured && canFetch && !p.error && !p.refreshing && <div className="ld-needs">No data saved yet.{isAdmin ? ' Press "Fetch latest".' : ' Ask an admin to fetch it.'}</div>}</>;
  const A = snap.accounts[Math.min(acctIx, snap.accounts.length - 1)];
  return (
    <>
      {status}
      {failed}
      {snap.unreachable.length > 0 && <div className="ld-note">{snap.unreachable.length} account(s) could not be read: {snap.unreachable.map((u) => u.error).filter(Boolean).join('; ')}</div>}
      {!A ? <div className="ld-needs">The connection works but no ad account was returned.</div> : (
        <>
          {snap.accounts.length > 1 && (
            <MiniSelect label="Ad account" value={acctIx} onChange={setAcctIx}
              options={snap.accounts.map((a, i) => ({ value: i, label: a.account.name || a.account.account_id }))} />
          )}
          <AccountView A={A} platform={platform} sample={sample} />
        </>
      )}
    </>
  );
}

function AccountView({ A, platform, sample = false }: { A: BudgetAccount; platform: Platform; sample?: boolean }) {
  const [group, setGroup] = useState<Group>('active');
  const [q, setQ] = useState('');
  const cur = A.account.currency;
  const fmt = money(cur);
  const fmtC = moneyC(cur);
  const C = A.campaigns;
  const active = C.filter((c) => c.status_group === 'active');

  const k = useMemo(() => {
    const withDaily = active.filter((c) => c.daily_budget);
    const judged = active.filter((c) => c.utilization_pct !== null && c.daily_budget);
    const allowed = sum(judged.map((c) => (c.daily_budget ?? 0) * A.days_elapsed));
    const used = sum(judged.map((c) => c.spend_mtd));
    const life = active.filter((c) => c.lifetime_budget && c.remaining_budget !== null);
    return {
      withDaily, dailyTotal: sum(withDaily.map((c) => c.daily_budget)), mtd: sum(C.map((c) => c.spend_mtd)), today: sum(C.map((c) => c.spend_today)),
      pct: allowed > 0 ? (100 * used) / allowed : null, judged: judged.length, life, lifeLeft: sum(life.map((c) => c.remaining_budget)),
    };
  }, [active, C, A.days_elapsed]);

  const rows = useMemo(() => C.filter((c) => (group === 'all' || c.status_group === group)
    && (!q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()) || c.campaign_id.includes(q.trim()))), [C, group, q]);
  const count = (g: Group) => (g === 'all' ? C.length : C.filter((c) => c.status_group === g).length);

  const pctRag = k.pct === null ? 'none' : k.pct > 105 ? 'red' : k.pct < 50 ? 'amber' : 'green';
  const mAll = A.monthly.map((m) => ({ month: monthLabel(m.period), spend: m.spend }));
  const months = mAll.slice(-18);
  const quarters = [...A.quarterly].reverse();

  const cols: Col<BudgetCampaign>[] = [
    { key: 'name', label: 'Campaign', render: (c) => <><b>{c.name}</b><div className="ld-note">{c.objective ?? '—'} · ID {c.campaign_id}</div></>, sort: (c) => c.name.toLowerCase(), csv: (c) => c.name },
    { key: 'status', label: 'Status', render: (c) => <span className={`ld-tag ${c.status_group === 'active' ? 'scale' : c.status_group === 'paused' ? 'early' : 'kill'}`} title={c.status}>{c.status_group === 'other' ? c.status : c.status_group}</span>, sort: (c) => c.status_group, csv: (c) => c.status },
    { key: 'daily', label: 'Daily budget', num: true, render: (c) => c.daily_budget ? <>{fmt(c.daily_budget)}{c.daily_budget_source === 'ad sets' && <div className="ld-note">from ad sets</div>}{c.shared_budget && <div className="ld-note">shared budget</div>}</> : '—', sort: (c) => c.daily_budget ?? -1, csv: (c) => c.daily_budget },
    { key: 'mtd', label: 'Spent this month', num: true, render: (c) => fmt(c.spend_mtd), sort: (c) => c.spend_mtd, csv: (c) => c.spend_mtd },
    { key: 'used', label: 'Budget used', num: true, render: (c) => <Used c={c} />, sort: (c) => c.utilization_pct ?? c.lifetime_utilization_pct ?? -1, csv: (c) => c.utilization_pct ?? c.lifetime_utilization_pct },
    { key: 'life', label: 'Lifetime budget', num: true, render: (c) => c.lifetime_budget ? <>{fmt(c.lifetime_budget)}{c.lifetime_budget_source === 'ad sets' && <div className="ld-note">from ad sets</div>}</> : '—', sort: (c) => c.lifetime_budget ?? -1, csv: (c) => c.lifetime_budget },
    { key: 'left', label: 'Left', num: true, render: (c) => c.remaining_budget === null ? '—' : <>{fmt(c.remaining_budget)}<div className="ld-note">{c.remaining_basis}</div></>, sort: (c) => c.remaining_budget ?? -1, csv: (c) => c.remaining_budget },
    { key: 'lm', label: 'Last month', num: true, render: (c) => fmt(c.spend_last_month), sort: (c) => c.spend_last_month, csv: (c) => c.spend_last_month },
    { key: 'tq', label: 'This quarter', num: true, render: (c) => fmt(c.spend_this_quarter), sort: (c) => c.spend_this_quarter, csv: (c) => c.spend_this_quarter },
    { key: 'all', label: 'All-time spend', num: true, render: (c) => fmt(c.spend_lifetime), sort: (c) => c.spend_lifetime, csv: (c) => c.spend_lifetime },
  ];
  const csvOf = () => rows.map((c) => ({
    Platform: platform, Account: A.account.name, 'Campaign ID': c.campaign_id, Campaign: c.name, Status: c.status, 'Daily budget': c.daily_budget, 'Daily budget from': c.daily_budget_source,
    'Lifetime budget': c.lifetime_budget, 'Remaining budget': c.remaining_budget, 'Remaining means': c.remaining_basis, 'Spent today': c.spend_today, 'Spent this month': c.spend_mtd,
    'Budget used this month %': c.utilization_pct, 'Lifetime budget used %': c.lifetime_utilization_pct, 'Spent last month': c.spend_last_month, 'Spent this quarter': c.spend_this_quarter,
    'All-time spend': c.spend_lifetime,
  }));

  return (
    <>
      <section className="ld-card wide">
        <header className="ld-card-h"><h3>Ad account</h3></header>
        <div className="ld-card-b ld-acct">
          <div><span className="ld-note">Name</span><b>{A.account.name || '—'}</b></div>
          <div><span className="ld-note">Account ID</span><b>{A.account.account_id}</b></div>
          <div><span className="ld-note">Status</span><b>{A.account.status ?? '—'}</b></div>
          <div><span className="ld-note">Currency</span><b>{cur ?? '—'}</b></div>
          <div><span className="ld-note">Time zone</span><b>{A.account.timezone ?? '—'}</b></div>
          {A.account.business_name && <div><span className="ld-note">Business</span><b>{A.account.business_name}</b></div>}
          <div><span className="ld-note">Figures as of</span><b>{A.today}</b></div>
        </div>
      </section>

      <div className="ld-kpis">
        <Kpi icon={Megaphone} label="Active campaigns" value={active.length} rag="none"
          sub={`${count('paused')} paused · ${count('ended')} ended · ${C.length} in all`}
          info="Campaigns that are switched on and allowed to deliver. Paused and ended (archived or removed) campaigns are counted below it." />
        <Kpi icon={Wallet} label="Daily budget, active" value={fmtC(k.dailyTotal)} rag="none"
          sub={`${k.withDaily.length} of ${active.length} active campaigns have a daily budget`}
          info="The total of the daily budgets of active campaigns. Where the budget is set on ad sets, the live ad sets are added up. Campaigns on a lifetime budget have no daily figure." />
        <Kpi icon={Gauge} label="Spent this month" value={fmtC(k.mtd)} rag="none"
          sub={`${fmtC(k.today)} today · all campaigns`}
          info="What the platform reports as spent from the 1st of this month to the date shown above, across all campaigns." />
        <Kpi icon={Gauge} label="Daily budget used, this month" value={k.pct === null ? '—' : `${k.pct.toFixed(0)}%`} rag={pctRag}
          ragNote="Under 50% is amber (budget not being used), over 105% is red (overspending), otherwise green"
          sub={k.pct === null ? 'No active campaign on a daily budget' : `${k.judged} active campaigns on daily budgets`}
          info={`Spent so far this month divided by what the daily budgets allow over ${A.days_elapsed} days. A budget changed in the middle of the month makes this approximate. Campaigns that also have lifetime-budget ad sets are left out.`} />
        <Kpi icon={PiggyBank} label="Lifetime budgets left" value={fmtC(k.lifeLeft)} rag="none"
          sub={`${k.life.length} active campaigns with a lifetime budget`}
          info="For active campaigns on a lifetime (total) budget: what the platform says is still unspent." />
      </div>

      <section className="ld-card wide">
        <header className="ld-card-h">
          <h3>Campaigns</h3>
          <HelpTip text="Budgets and spend are as reported by the platform. 'Budget used' = spent this month ÷ daily budget × days so far for daily budgets, and the share already spent for lifetime budgets. 'Left' means the lifetime budget left, or what is left of today's daily budget." />
          <div className="ld-card-actions">
            <MiniSelect label="Show" value={group} onChange={setGroup}
              options={(['active', 'paused', 'ended', 'all'] as Group[]).map((g) => ({ value: g, label: `${g[0].toUpperCase()}${g.slice(1)} (${count(g)})` }))} />
            <input className="ld-input" style={{ width: 170 }} placeholder="Search name or ID" aria-label="Search campaigns" value={q} onChange={(e) => setQ(e.target.value)} />
            <ExportBtn onClick={() => downloadCsv(`${platform}_budget_screen`, csvOf())} />
          </div>
        </header>
        <div className="ld-card-b ld-table-wrap">
          <Table rows={rows} cols={cols} limit={25} initialSort={{ key: 'mtd', dir: 'desc' }} empty="No campaigns match." />
        </div>
      </section>

      <div className="ld-grid">
        <section className="ld-card">
          <header className="ld-card-h">
            <h3>Spend by month</h3>
            <HelpTip text="Everything spent in each calendar month, including campaigns that no longer exist, as reported by the platform." />
            <div className="ld-card-actions"><ExportBtn onClick={() => downloadCsv(`${platform}_spend_by_month`, A.monthly.map((m) => ({ Month: m.period, Spend: m.spend })))} /></div>
          </header>
          <div className="ld-card-b">
            <StackedBars data={months} x="month" fmt={fmtC} series={[{ key: 'spend', label: 'Spend', color: 'var(--ld-seq-4)' }]} stacked={false} />
            <div className="ld-note">Last {months.length} of {mAll.length} months shown; the CSV has all of them.</div>
          </div>
        </section>
        <section className="ld-card">
          <header className="ld-card-h">
            <h3>Spend by quarter</h3>
            <HelpTip text="Financial-year quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. The latest quarter is still running." />
            <div className="ld-card-actions"><ExportBtn onClick={() => downloadCsv(`${platform}_spend_by_quarter`, A.quarterly.map((m) => ({ Quarter: m.period, Spend: m.spend })))} /></div>
          </header>
          <div className="ld-card-b ld-table-wrap">
            <Table rows={quarters} limit={12} cols={[
              { key: 'q', label: 'Quarter', render: (r) => quarterLong(r.period), sort: (r) => r.first_month },
              { key: 's', label: 'Spend', num: true, render: (r) => fmt(r.spend), sort: (r) => r.spend },
            ]} initialSort={{ key: 'q', dir: 'desc' }} />
          </div>
        </section>
      </div>
      <div className="ld-note">
        {sample ? <>Sample data: every figure on this page is made up (GOOGLE_ADS_MODE=sample) and is never saved or used elsewhere.</> : <>How it works: budgets, statuses and spend come straight from {NAMES[platform]}.</>} Calculated here: the budget-used percentage and the monthly and quarterly totals. Nothing is estimated for
        days the platform has no data for.
      </div>
    </>
  );
}

function Used({ c }: { c: BudgetCampaign }) {
  const v = c.utilization_pct ?? c.lifetime_utilization_pct;
  if (v === null) return <>—</>;
  return (
    <>
      {v.toFixed(0)}%<span className="ld-inbar"><span className={`ld-inbar-f${v > 105 ? ' warn' : ''}`} style={{ width: `${Math.min(v, 100)}%` }} /></span>
      <div className="ld-note">{c.utilization_pct !== null ? 'this month' : 'of lifetime'}</div>
    </>
  );
}
