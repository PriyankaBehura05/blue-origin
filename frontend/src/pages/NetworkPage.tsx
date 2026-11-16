// BO Retailer Network dashboard: nine pages sharing one set of filters (see src/network/).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Outlet, useNavigate, useParams } from 'react-router-dom';
import { NetworkProvider, useNetwork } from '@/network/NetworkContext';
import { ChartCard, KpiGrid, NetTable, RetailerPanel } from '@/network/components';
import { HelpTip } from '@/components/HelpTip';
import { filterHelp, PAGE_HELP, withHelp } from '@/network/help';
import { exportCsv, exportXlsx } from '@/network/export';
import { applyFilters, filterText, fmtN, MOVES, multiQ, qLabel, qLong } from '@/network/model';
import { QUARTER_RULE } from '@/utils/format';
import { kpiList, LIST_KEYS, lookup, VIEWS, type ListKey, type ViewKey } from '@/network/reports';
import type { Chart, Filters, Kpi, Model, Table, View } from '@/network/types';

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
  const { tab, list } = useParams();
  const page = NETWORK_PAGES.find((p) => p.slug === tab);
  const net = useNetwork();
  if (!page) return <Navigate to="/dashboard/overview" replace />;
  // /dashboard/overview/<list>: the retailers behind one Overview card
  if (list !== undefined && (page.key !== 'overview' || !(LIST_KEYS as readonly string[]).includes(list))) return <Navigate to={`/dashboard/${page.slug}`} replace />;
  if (page.key === 'construction') return <UnderConstruction title={page.label} help={PAGE_HELP[page.slug]} />;
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
  return <Page m={net.model} page={{ key: page.key, label: page.label, slug: page.slug }} list={list as ListKey | undefined} />;
}

// Pages that look at one quarter: with several selected they use the latest of them
const ONE_QUARTER: ViewKey[] = ['new', 'tier', 'retention', 'pipeline'];
const oneQuarter = (f: Filters): Filters => (multiQ(f) ? { ...f, qs: [f.q] } : f);

// Quarter filter: one quarter (click its name) or several (tick the boxes)
function QuarterPicker({ m, f, setF, help }: { m: Model; f: Filters; setF: (p: Partial<Filters>) => void; help?: string }) {
  const label = !f.qs.length ? 'All quarters' : f.qs.length === 1 ? qLong(m.Q[f.qs[0]])
    : f.qs.length <= 3 ? f.qs.map((i) => qLabel(m.Q[i])).join(' + ') : `${f.qs.length} quarters selected`;
  return (
    <MultiPick label="Quarter" help={help} allLabel="All quarters" text={label} value={f.qs}
      options={m.Q.map((q, i) => ({ v: i, label: qLong(q) })).reverse()}
      onChange={(qs) => setF({ qs: [...qs].sort((a, b) => a - b) })} />
  );
}

// A filter that takes one value (click it) or several (tick "Select multiple", then the boxes). [] = all.
function MultiPick<T extends string | number>({ label, help, allLabel, text, value, options, onChange }: {
  label: string; help?: string; allLabel: string; text?: string; value: T[]; options: { v: T; label: string }[]; onChange: (v: T[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [multi, setMulti] = useState(value.length > 1);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const nameOf = (v: T) => options.find((o) => o.v === v)?.label ?? String(v);
  const shown = text ?? (!value.length ? allLabel : value.length <= 2 ? value.map(nameOf).join(' + ') : `${value.length} selected`);
  const toggle = (v: T) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className={`net-f net-qp${value.length ? ' on' : ''}`} ref={box}>
      <span>{label}<HelpTip text={help} /></span>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)} title={value.map(nameOf).join(', ') || allLabel}>
        {shown} ▾
      </button>
      {open && (
        <div className="net-qp-pop" role="listbox" aria-multiselectable={multi}>
          <div className="net-qp-h">
            <label><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Select multiple</label>
          </div>
          <button type="button" className={`net-qp-opt${!value.length ? ' on' : ''}`} onClick={() => { onChange([]); if (!multi) setOpen(false); }}>
            {multi ? <input type="checkbox" readOnly checked={!value.length} tabIndex={-1} /> : null}{allLabel}
          </button>
          {options.map((o) => (
            <button key={String(o.v)} type="button" role="option" aria-selected={value.includes(o.v)} className={`net-qp-opt${value.includes(o.v) ? ' on' : ''}`}
              onClick={() => { if (multi) toggle(o.v); else { onChange([o.v]); setOpen(false); } }}>
              {multi ? <input type="checkbox" readOnly checked={value.includes(o.v)} tabIndex={-1} /> : null}{o.label}
            </button>
          ))}
          {multi && (
            <div className="net-qp-foot">
              <button type="button" className="btn sm" onClick={() => onChange([])}>Clear</button>
              <button type="button" className="btn sm primary" onClick={() => setOpen(false)}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UnderConstruction({ title, help }: { title: string; help?: string }) {
  return (
    <div className="net">
      <div className="page-header"><div><h1>{title}<HelpTip text={help} /></h1></div></div>
      <div className="card card-pad empty-state">
        <div style={{ fontSize: 34 }} aria-hidden>🚧</div>
        <h3>Under construction</h3>
        <div className="note">This page is being built and will be available soon.</div>
      </div>
    </div>
  );
}

function Page({ m, page, list }: { m: Model; page: { key: Exclude<PageKey, 'construction'>; label: string; slug: string }; list?: ListKey }) {
  const { f: fAll, setF, clearFilters, search, setSearch, select, flash, reload, loading } = useNetwork();
  const go = useNavigate();
  const [packing, setPacking] = useState(false);
  const single = page.key !== 'lookup' && ONE_QUARTER.includes(page.key);
  const f = useMemo(() => (single ? oneQuarter(fAll) : fAll), [single, fAll]);   // the filters this page works with
  const rs = useMemo(() => applyFilters(m, f), [m, f]);
  const listView = useMemo(() => (list ? kpiList(m, f, rs, list) : null), [m, f, rs, list]);
  const view: View | null = useMemo(() => {
    if (listView) return listView;
    const v = page.key === 'lookup' ? lookup(m, rs, search, f) : VIEWS[page.key](m, f, rs);
    const w = withHelp(page.key, v, m, f);
    return single && multiQ(fAll)
      ? { ...w, note: [`Several quarters are selected. This page looks at one quarter at a time, so it uses the latest of them, ${qLong(m.Q[fAll.q])}. The Overview and Retailer lookup use all the selected quarters.`, w.note].filter(Boolean).join(' ') }
      : w;
  }, [m, f, fAll, rs, page.key, search, single, listView]);
  const fHelp = filterHelp(m, f);

  const D = m.p.distributors;
  const states = [...new Set(D.filter((d) => !f.region || d.r === f.region).map((d) => d.s))].filter(Boolean).sort();
  const dists = D.filter((d) => (!f.region || d.r === f.region) && (!f.state || d.s === f.state)).map((d) => d.n).sort((a, b) => a.localeCompare(b));
  // Every filter a page's tables depend on, as written in the Excel header: the shared filters plus the page's own
  // (Movement on Tier movement, the % band on Upgrade pipeline, the search on Retailer lookup)
  const scopeOf = (k: PageKey, fk: Filters) => [
    filterText(m, fk),
    k === 'tier' && fk.mv.length ? `Movement: ${fk.mv.join(' + ')}` : '',
    k === 'pipeline' ? `Within ${fk.near}% of the next slab` : '',
    k === 'lookup' && search.trim() ? `Search “${search.trim()}”` : '',
  ].filter(Boolean).join(' · ');
  const filters = filterText(m, f);
  const scope = scopeOf(page.key, f);
  const stamp = `${list ? `${list}_` : ''}${f.qs.length ? f.qs.map((i) => m.Q[i]).join('+') : 'AllQuarters'}_${f.dist || f.state || f.region || 'All'}${f.tier.length ? `_${f.tier.join('+')}` : ''}${page.key === 'tier' && f.mv.length ? `_${f.mv.join('+')}` : ''}`;
  const onExport = (t: Table, kind: 'xlsx' | 'csv') => {
    if (kind === 'csv') exportCsv(t, stamp);
    else exportXlsx([t], stamp, scope).catch((e) => flash(`Excel export failed: ${e instanceof Error ? e.message : e}`));
  };
  const reportPack = async () => {
    setPacking(true);
    flash('Building the report pack…');
    try {
      const keys: ViewKey[] = ['overview', 'new', 'tier', 'retention', 'pipeline'];
      const tables = keys.flatMap((k) => {
        // each sheet is built with, and labelled with, the filters that page itself would use; the Movement filter
        // only applies when the pack is downloaded from the Tier movement page, where it is shown
        const one = ONE_QUARTER.includes(k) ? oneQuarter(fAll) : fAll;
        const fk = k === 'tier' && page.key === 'tier' ? one : { ...one, mv: [] };
        const v = VIEWS[k](m, fk, applyFilters(m, fk));
        const s = scopeOf(k, fk) + (ONE_QUARTER.includes(k) && multiQ(fAll) ? ' (this page looks at one quarter: the latest selected)' : '');
        return [...v.tables, ...(v.sections?.flatMap((x) => x.tables) ?? [])].map((t) => ({ ...t, scope: s }));
      });
      await exportXlsx(tables, stamp, filters);
    } catch (e) {
      flash(`Report pack failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setPacking(false);
    }
  };
  const onPick = (key?: 'month' | 'quarter') =>
    key === 'month' ? (i: number) => setF({ m: i + 1 }) : key === 'quarter' ? (i: number) => setF({ q: i + 1 }) : undefined;
  const active = Boolean(f.region || f.state || f.dist || f.tier.length || fAll.qs.length || (page.key === 'tier' && f.mv.length));
  const downloadList = () => {
    if (!listView) return;
    exportXlsx(listView.tables, stamp, scope).catch((e) => flash(`Excel export failed: ${e instanceof Error ? e.message : e}`));
  };
  const sel = (label: string, value: string | number, opts: [string | number, string][], on: (v: string) => void, help?: string) => (
    <label className={`net-f${value !== '' && value !== -1 ? ' on' : ''}`}>
      <span>{label}<HelpTip text={help ?? fHelp[label]} /></span>
      <select value={value} onChange={(e) => on(e.target.value)} aria-label={label}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );

  // the cards, charts and tables of the page itself or of one of its sections
  const body = (b: { kpis?: Kpi[]; charts?: Chart[]; tables: Table[] }) => (
    <>
      {b.kpis && b.kpis.length > 0 && <KpiGrid kpis={b.kpis} onList={page.key === 'overview' ? (k) => go(`/dashboard/overview/${k}`) : undefined} />}
      {b.charts && (
        <>
          <div className="net-grid2">{b.charts.filter((c) => !c.wide).map((c) => <ChartCard key={c.id} c={c} onPick={onPick(c.onClickKey)} />)}</div>
          {b.charts.filter((c) => c.wide).map((c) => <ChartCard key={c.id} c={c} onPick={onPick(c.onClickKey)} />)}
        </>
      )}
      {b.tables.map((t) => <NetTable key={`${t.id}|${filters}`} t={t} onOpen={select} onExport={onExport} />)}
    </>
  );

  return (
    <div className="net">
      <div className="net-head">
        <div className="net-titlerow">
          <div>
            {listView && <nav className="net-crumbs" aria-label="Breadcrumb"><Link to="/dashboard/overview">Overview</Link><span>›</span><span>{listView.title}</span></nav>}
            <h1>{listView ? listView.title : page.label}<HelpTip text={listView ? 'The retailers counted in this Overview card, and the same retailers per distributor. Change the Quarter, Region, State, Distributor or Tier filters to change the list.' : PAGE_HELP[page.slug]} /></h1>
            <div className="net-scope" title="Active filters">{filters}</div>
          </div>
          <div className="toolbar">
            {listView ? (
              <>
                <button className="btn" onClick={() => go('/dashboard/overview')}>‹ Back to Overview</button>
                <button className="btn primary" onClick={downloadList} disabled={!listView.tables[0].rows.length}>⤓ Download Excel (retailers + distributors)</button>
              </>
            ) : (
              <>
                <button className="btn" onClick={reload} disabled={loading} title={`Data generated ${m.p.generated}`}>{loading ? 'Loading…' : '↻ Reload data'}</button>
                <button className="btn primary" onClick={reportPack} disabled={packing}>{packing ? 'Building…' : '⤓ Download report pack'}</button>
              </>
            )}
          </div>
        </div>
        <div className="net-filters" role="group" aria-label="Filters">
          {sel('Region', f.region, [['', 'All'], ...m.p.regions.map((r) => [r, r] as [string, string])], (v) => setF({ region: v, state: '', dist: '' }))}
          {sel('State', f.state, [['', 'All'], ...states.map((s) => [s, s] as [string, string])], (v) => setF({ state: v, dist: '' }))}
          {sel('Distributor', f.dist, [['', 'All'], ...dists.map((d) => [d, d] as [string, string])], (v) => setF({ dist: v }))}
          <QuarterPicker m={m} f={fAll} setF={setF} help={fHelp.Quarter} />
          <MultiPick label={multiQ(f) ? 'Tier (every selected qtr)' : f.q < 0 ? `Tier (${qLabel(m.Q[m.LQ])})` : `Tier (${qLabel(m.Q[f.q])})`} help={fHelp.Tier}
            allLabel="All" value={f.tier} options={[{ v: 'tiered', label: 'Any tier' }, ...[...m.TIERS].reverse().map((t) => ({ v: t, label: t }))]}
            onChange={(tier) => setF({ tier })} />
          {page.key === 'tier' && (
            <MultiPick label="Movement" help={fHelp.Movement} allLabel="All" value={f.mv} options={MOVES.map((k) => ({ v: k as string, label: k }))}
              onChange={(mv) => setF({ mv: MOVES.filter((k) => mv.includes(k)) })} />
          )}
          {page.key === 'pipeline' && (
            <label className="net-f on">
              <span>Within % of next slab<HelpTip text={fHelp.Near} /></span>
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
          {body(view)}
          {view.sections?.map((s) => (
            <section key={s.id} className="net-section">
              <h2>{s.title}<HelpTip text={s.help} /></h2>
              {s.lead && <p className="net-lead">{s.lead}</p>}
              {body(s)}
            </section>
          ))}
        </>
      )}
      <p className="note">
        Data generated {m.p.generated} · {fmtN(m.p.stats.retailers)} retailers · {D.length} distributors · {qLong(m.Q[0])} to {qLong(m.Q[m.LQ])}.
        <br />{QUARTER_RULE} Platinum applies from Q1 FY 27 (April 2026); before that Gold is the top tier.
      </p>
    </div>
  );
}
