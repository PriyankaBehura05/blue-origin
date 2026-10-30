// BO Retailer Network dashboard: nine pages sharing one set of filters (see src/network/).
import { useMemo, useState } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { NetworkProvider, useNetwork } from '@/network/NetworkContext';
import { ChartCard, KpiGrid, NetTable, RetailerPanel } from '@/network/components';
import { exportCsv, exportXlsx } from '@/network/export';
import { applyFilters, filterText, fmtN, MOVES, qLabel, qLong } from '@/network/model';
import { QUARTER_RULE } from '@/utils/format';
import { lookup, VIEWS, type ViewKey } from '@/network/reports';
import type { Model, Table, View } from '@/network/types';

// 'construction' pages are in the menu but have no content yet
type PageKey = ViewKey | 'lookup' | 'construction';
export const NETWORK_PAGES: { slug: string; key: PageKey; label: string; icon: string; badge?: string }[] = [
  { slug: 'overview', key: 'overview', label: 'Overview', icon: '▦' },
  { slug: 'new-retailers', key: 'new', label: 'New retailers', icon: '＋' },
  { slug: 'tier-movement', key: 'tier', label: 'Tier movement', icon: '⇅' },
  { slug: 'retention', key: 'retention', label: 'Retention', icon: '↺' },
  { slug: 'upgrade-pipeline', key: 'pipeline', label: 'Upgrade pipeline', icon: '↗' },
  { slug: 'deliverables', key: 'construction', label: 'Deliverables tracker', icon: '✓' },
  { slug: 'benefits-history', key: 'construction', label: 'Benefits history', icon: '🎁' },
  { slug: 'retailer-lookup', key: 'lookup', label: 'Retailer lookup', icon: '⌕' },
];

// Route element for /dashboard/*: shared state, the retailer panel and the toast.
export function NetworkLayout() {
  return (
    <NetworkProvider>
      <Outlet />
      <NetworkOverlays />
    </NetworkProvider>
  );
}

function NetworkOverlays() {
  const { model, selected, select, toast } = useNetwork();
  return (
    <>
      {model && selected && <RetailerPanel m={model} id={selected} onClose={() => select(null)} />}
      {toast && <div className="net-toast" role="status">{toast}</div>}
    </>
  );
}

export default function NetworkPage() {
  const { tab } = useParams();
  const page = NETWORK_PAGES.find((p) => p.slug === tab);
  const net = useNetwork();
  if (!page) return <Navigate to="/dashboard/overview" replace />;
  if (page.key === 'construction') return <UnderConstruction title={page.label} />;
  if (net.error && !net.model) {
    return (
      <div className="card card-pad setup">
        <h2>The dashboard data could not be loaded</h2>
        <p className="note">{net.error}</p>
        <div><button className="btn primary" onClick={net.reload}>Try again</button></div>
      </div>
    );
  }
  if (!net.model) return <div className="empty">Loading {fmtN(30000)}+ retailers…</div>;
  return <Page m={net.model} page={{ key: page.key, label: page.label }} />;
}

function UnderConstruction({ title }: { title: string }) {
  return (
    <div className="net">
      <div className="page-header"><div><h1>{title}</h1></div></div>
      <div className="card card-pad empty-state">
        <div style={{ fontSize: 34 }} aria-hidden>🚧</div>
        <h3>Under construction</h3>
        <div className="note">This page is being built and will be available soon.</div>
      </div>
    </div>
  );
}

function Page({ m, page }: { m: Model; page: { key: Exclude<PageKey, 'construction'>; label: string } }) {
  const { f, setF, clearFilters, search, setSearch, select, flash, reload, loading } = useNetwork();
  const [packing, setPacking] = useState(false);
  const rs = useMemo(() => applyFilters(m, f), [m, f]);
  const view: View | null = useMemo(() => {
    if (page.key === 'lookup') return lookup(m, rs, search);
    return VIEWS[page.key](m, f, rs);
  }, [m, f, rs, page.key, search]);

  const D = m.p.distributors;
  const states = [...new Set(D.filter((d) => !f.region || d.r === f.region).map((d) => d.s))].filter(Boolean).sort();
  const dists = D.filter((d) => (!f.region || d.r === f.region) && (!f.state || d.s === f.state)).map((d) => d.n).sort((a, b) => a.localeCompare(b));
  const filters = filterText(m, f);
  const stamp = `${f.q < 0 ? 'AllQuarters' : m.Q[f.q]}_${f.dist || f.state || f.region || 'All'}${f.tier ? `_${f.tier}` : ''}`;
  const onExport = (t: Table, kind: 'xlsx' | 'csv') => {
    if (kind === 'csv') exportCsv(t, stamp);
    else exportXlsx([t], stamp, filters).catch((e) => flash(`Excel export failed: ${e instanceof Error ? e.message : e}`));
  };
  const reportPack = async () => {
    setPacking(true);
    flash('Building the report pack…');
    try {
      const keys: ViewKey[] = ['overview', 'new', 'tier', 'retention', 'pipeline'];
      const tables = keys.flatMap((k) => VIEWS[k](m, f, rs).tables);
      await exportXlsx(tables, stamp, filters);
    } catch (e) {
      flash(`Report pack failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setPacking(false);
    }
  };
  const onPick = (key?: 'month' | 'quarter') =>
    key === 'month' ? (i: number) => setF({ m: i + 1 }) : key === 'quarter' ? (i: number) => setF({ q: i + 1 }) : undefined;
  const active = Boolean(f.region || f.state || f.dist || f.tier || f.q >= 0 || (page.key === 'tier' && f.mv));
  const sel = (label: string, value: string | number, opts: [string | number, string][], on: (v: string) => void) => (
    <label className={`net-f${value !== '' && value !== -1 ? ' on' : ''}`}>
      <span>{label}</span>
      <select value={value} onChange={(e) => on(e.target.value)} aria-label={label}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );

  return (
    <div className="net">
      <div className="net-head">
        <div className="net-titlerow">
          <div>
            <h1>{page.label}</h1>
            <div className="net-scope" title="Active filters">{filters}</div>
          </div>
          <div className="toolbar">
            <button className="btn" onClick={reload} disabled={loading} title={`Data generated ${m.p.generated}`}>{loading ? 'Loading…' : '↻ Reload data'}</button>
            <button className="btn primary" onClick={reportPack} disabled={packing}>{packing ? 'Building…' : '⤓ Download report pack'}</button>
          </div>
        </div>
        <div className="net-filters" role="group" aria-label="Filters">
          {sel('Region', f.region, [['', 'All'], ...m.p.regions.map((r) => [r, r] as [string, string])], (v) => setF({ region: v, state: '', dist: '' }))}
          {sel('State', f.state, [['', 'All'], ...states.map((s) => [s, s] as [string, string])], (v) => setF({ state: v, dist: '' }))}
          {sel('Distributor', f.dist, [['', 'All'], ...dists.map((d) => [d, d] as [string, string])], (v) => setF({ dist: v }))}
          {sel('Quarter', f.q, [[-1, 'All quarters'], ...m.Q.map((q, i) => [i, qLong(q)] as [number, string]).reverse()], (v) => setF({ q: Number(v) }))}
          {sel(f.q < 0 ? `Tier (${qLabel(m.Q[m.LQ])})` : `Tier (${qLabel(m.Q[f.q])})`, f.tier,
            [['', 'All'], ['tiered', 'Any tier'], ...[...m.TIERS].reverse().map((t) => [t, t] as [string, string])], (v) => setF({ tier: v }))}
          {page.key === 'tier' && sel('Movement', f.mv, [['', 'All'], ...MOVES.map((k) => [k, k] as [string, string])], (v) => setF({ mv: v }))}
          {page.key === 'pipeline' && (
            <label className="net-f on">
              <span>Within % of next slab</span>
              <input type="number" min={1} max={60} step={5} value={f.near} onChange={(e) => setF({ near: Math.max(1, Math.min(60, Number(e.target.value) || 20)) })} />
            </label>
          )}
          {active && <button className="btn sm" onClick={clearFilters}>✕ Clear filters</button>}
        </div>
      </div>

      {view && (
        <>
          {view.note && <div className="alert warn-alert">{view.note}</div>}
          {view.lead && <p className="net-lead">{view.lead}</p>}
          {page.key === 'lookup' && (
            <input className="input net-search" autoFocus placeholder="Search by name, retailer ID, district, phone or old spelling" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search retailers" />
          )}
          {view.kpis && view.kpis.length > 0 && <KpiGrid kpis={view.kpis} />}
          {view.charts && (
            <>
              <div className="net-grid2">{view.charts.filter((c) => !c.wide).map((c) => <ChartCard key={c.id} c={c} onPick={onPick(c.onClickKey)} />)}</div>
              {view.charts.filter((c) => c.wide).map((c) => <ChartCard key={c.id} c={c} onPick={onPick(c.onClickKey)} />)}
            </>
          )}
          {view.tables.map((t) => <NetTable key={`${t.id}|${filters}`} t={t} onOpen={select} onExport={onExport} />)}
        </>
      )}
      <p className="note">
        Data generated {m.p.generated} · {fmtN(m.p.stats.retailers)} retailers · {D.length} distributors · {qLong(m.Q[0])} to {qLong(m.Q[m.LQ])}.
        <br />{QUARTER_RULE} Platinum applies from Q1 FY 27 (April 2026); before that Gold is the top tier.
      </p>
    </div>
  );
}
