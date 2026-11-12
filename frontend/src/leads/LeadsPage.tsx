// The Lead Generation Dashboard: 12 pages (/leads/<section>), opened from the icon menu in the sidebar, with a sticky
// global filter bar. Data: GET /api/leads/data, loaded once and kept while moving between pages, so filters and unsaved
// actions carry over; every filter is applied in the browser (model.ts).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { CalendarClock, Filter, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { ErrorBox, Loading } from '@/components/ui';
import { useSession } from '@/services/session';
import { leadsApi } from './api';
import { buildModel, dayName, defaultFilters, leadQuarters, LEVEL_HELP, LEVEL_NAMES, monthName, ORGANIC, outcomeOf, partialNote, PENDING, periodName, quarterName, quarterShort, rangeOf, type Filters, type Model } from './model';
import { LeadsCtx, STROKE, makeCtx } from './ui';
import { SECTIONS, SOURCE_NAMES } from './sections';
import type { ActionItem, LeadsPayload, LeadsStatus } from './types';
import Cover, { type Insight } from './sections/Cover';
import Funnel from './sections/Funnel';
import Mix from './sections/Mix';
import Campaigns from './sections/Campaigns';
import Field from './sections/Field';
import Ageing from './sections/Ageing';
import Retention from './sections/Retention';
import Geography from './sections/Geography';
import Untapped from './sections/Untapped';
import Forecast from './sections/Forecast';
import RetailerList from './sections/RetailerList';
import Quality from './sections/Quality';
import './leads.css';

// earlier addresses -> today's pages
const OLD_PAGES: Record<string, string> = { simulator: 'forecast', actions: 'retailers', list: 'retailers' };

export default function LeadsPage() {
  const { page } = useParams();
  const role = useSession()?.user.role;
  const canEdit = role === 'admin' || role === 'editor';
  const [payload, setPayload] = useState<LeadsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LeadsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [savedActions, setSavedActions] = useState<string>('[]');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, a] = await Promise.all([leadsApi.data(), leadsApi.actions()]);
      setPayload(p);
      setActions(a);
      setSavedActions(JSON.stringify(a));
      leadsApi.status().then(setStatus).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const slug = page && OLD_PAGES[page] ? OLD_PAGES[page] : page;
  if (!slug || !SECTIONS.some((x) => x.id === slug)) return <Navigate to={`/leads/${SECTIONS[0].id}`} replace />;
  if (slug !== page) return <Navigate to={`/leads/${slug}`} replace />;
  if (error) return <ErrorBox message={error} />;
  if (!payload) return <Loading />;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dashboard
      page={slug} payload={payload} canEdit={canEdit} status={status} busy={busy}
      actions={actions} setActions={setActions} dirty={JSON.stringify(actions) !== savedActions} saving={saving}
      saveActions={async () => {
        setSaving(true);
        try {
          const saved = await leadsApi.saveActions(actions);
          setActions(saved);
          setSavedActions(JSON.stringify(saved));
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      }}
      onUpload={(files) => void run('Uploading and rebuilding…', async () => { for (const f of Array.from(files)) await leadsApi.upload(f); await leadsApi.rebuild(); })}
      onDelete={(name) => { if (confirm(`Remove ${name} from the leads inbox? The dashboard rebuilds without it.`)) void run('Removing and rebuilding…', async () => { await leadsApi.removeFile(name); await leadsApi.rebuild(); }); }}
      onRebuild={() => void run('Rebuilding…', () => leadsApi.rebuild())}
      onSaveTargets={(t) => void run('Saving targets…', async () => { await leadsApi.saveTargets(t); await leadsApi.rebuild(); })}
      onSheets={(label, fn) => void run(label, fn)}
    />
  );
}

function Dashboard(props: {
  page: string;
  payload: LeadsPayload;
  canEdit: boolean;
  status: LeadsStatus | null;
  busy: string | null;
  actions: ActionItem[];
  setActions: (a: ActionItem[]) => void;
  dirty: boolean;
  saving: boolean;
  saveActions: () => void;
  onUpload: (f: FileList) => void;
  onDelete: (name: string) => void;
  onRebuild: () => void;
  onSaveTargets: (t: Record<string, number>) => void;
  onSheets: (label: string, fn: () => Promise<unknown>) => void;
}) {
  const M: Model = useMemo(() => buildModel(props.payload), [props.payload]);
  const [f, setF] = useState<Filters>(() => defaultFilters(M));
  useEffect(() => { setF((cur) => ({ ...defaultFilters(M), level: cur.level, window: cur.window })); }, [M]);
  const set = useCallback((patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch })), []);
  const ctx = useMemo(() => makeCtx(M, f, set, props.canEdit), [M, f, set, props.canEdit]);

  const navigate = useNavigate();
  useEffect(() => { window.scrollTo(0, 0); }, [props.page]);
  const addAction = (i: Insight) => {
    props.setActions([...props.actions, { id: `a${Date.now()}`, recommendation: `${i.insight}: ${i.action}`, owner: i.owner, due: '', status: 'Not started', expected: i.number, achieved: '' }]);
    navigate('/leads/retailers');
  };
  const view: Record<string, () => JSX.Element> = {
    cover: () => <Cover onAddAction={addAction} />,
    funnel: () => <Funnel />,
    mix: () => <Mix />,
    campaigns: () => <Campaigns />,
    field: () => <Field />,
    ageing: () => <Ageing />,
    retention: () => <Retention />,
    geography: () => <Geography />,
    untapped: () => <Untapped />,
    forecast: () => <Forecast />,
    retailers: () => <RetailerList actions={props.actions} setActions={props.setActions} save={props.saveActions} saving={props.saving} dirty={props.dirty} />,
    quality: () => <Quality status={props.status} busy={props.busy} onUpload={props.onUpload} onDelete={props.onDelete} onRebuild={props.onRebuild} onSaveTargets={props.onSaveTargets} onSheets={props.onSheets} />,
  };

  return (
    <LeadsCtx.Provider value={ctx}>
      <div className="ld">
        <FilterBar M={M} f={f} set={set} reset={() => setF({ ...defaultFilters(M), level: f.level, window: f.window })} />
        <main className="ld-main">
          <PeriodNote M={M} f={f} set={set} />
          {view[props.page]()}
        </main>
      </div>
    </LeadsCtx.Provider>
  );
}

/** Leads and sales run on their own dates: say which leads sit outside the chosen period, and which ones the sales
 *  data does not reach yet (Pending sales data, never counted as not converted). Both fill in on their own. */
function PeriodNote({ M, f, set }: { M: Model; f: Filters; set: (p: Partial<Filters>) => void }) {
  const L = M.p.leads;
  const [a, b] = rangeOf(M, f.period);
  let newer = 0;
  let pending = 0;
  let known = 0;
  for (let i = 0; i < M.nL; i++) {
    if (!L.uniq[i]) continue;
    if (L.m[i] > b) newer++;
    else if (L.m[i] >= a && L.valid[i]) {
      if (outcomeOf(M, i, f.level, f.window) === PENDING) pending++;
      else known++;
    }
  }
  if (!newer && !pending) return null;
  const sales = monthName(M, M.p.salesEnd);
  const q = M.p.monthQuarter[M.leadEnd];
  return (
    <div className="ld-banner" role="status">
      <CalendarClock size={16} strokeWidth={STROKE} aria-hidden />
      <span>
        {newer > 0 && <><b>{newer.toLocaleString('en-IN')}</b> newer leads (up to {monthName(M, M.leadEnd)}) are outside <b>{periodName(M, f.period)}</b>. </>}
        {pending > 0 && <><b>{pending.toLocaleString('en-IN')}</b> leads here are <b>Pending sales data</b>: sales only run to {sales}, so we can't tell yet if they became retailers.
          They are not counted as "No sale yet", and the conversion % uses the {known.toLocaleString('en-IN')} leads whose sales are known. </>}
        {pending > 0 && 'This fills in by itself when new sales data arrives.'}
      </span>
      {newer > 0 && <>
        <button type="button" className="ld-btn" onClick={() => set({ period: `q:${q}` })}>See {quarterShort(q)} leads</button>
        <button type="button" className="ld-btn" onClick={() => set({ period: 'all' })}>All periods</button>
      </>}
    </div>
  );
}

function FilterBar({ M, f, set, reset }: { M: Model; f: Filters; set: (p: Partial<Filters>) => void; reset: () => void }) {
  const [more, setMore] = useState(false);
  const d = M.p.dims;
  const cities = useMemo(() => {
    if (f.state < 0) return d.city.map((c, i) => ({ c, i }));
    const keep = new Set<number>();
    M.p.retailers.s.forEach((s, r) => { if (s === f.state && M.p.retailers.c[r] >= 0) keep.add(M.p.retailers.c[r]); });
    M.p.leads.s.forEach((s, i) => { if (s === f.state && M.p.leads.c[i] >= 0) keep.add(M.p.leads.c[i]); });
    return [...keep].map((i) => ({ c: d.city[i], i }));
  }, [M, f.state, d.city]);
  const sorted = <T extends { c: string }>(a: T[]) => [...a].sort((x, y) => x.c.localeCompare(y.c));
  const idx = (a: string[]) => sorted(a.map((c, i) => ({ c, i })).filter((x) => x.c));
  const leadSources = useMemo(() => new Set(M.p.leads.src.filter((_, i) => M.p.leads.uniq[i])), [M]); // only sources that have leads
  const months = M.p.months.map((_, i) => i).filter((i) => i >= M.leadStart && i <= M.leadEnd).reverse();

  const ADV: (keyof Filters)[] = ['campaign', 'tier', 'outcome', 'level', 'window'];
  const sel = (key: keyof Filters, label: string, options: { v: number | string; l: string }[], opt = true, allLabel?: string) => (
    <select key={key} aria-label={label} title={label} className={`ld-fsel${opt ? ' opt' : ''}${ADV.includes(key) ? ' adv' : ''}${f[key] !== -1 && allLabel ? ' set' : ''}`} value={String(f[key])}
      onChange={(e) => set({ [key]: typeof f[key] === 'number' ? Number(e.target.value) : e.target.value } as Partial<Filters>)}>
      {allLabel && <option value="-1">{allLabel}</option>}
      {options.map((o) => <option key={o.v} value={String(o.v)}>{o.l}</option>)}
    </select>
  );

  const periodOpts = [
    { v: 'all', l: periodName(M, 'all') },
    ...[...leadQuarters(M)].reverse().map((q) => ({ v: `q:${q}`, l: quarterName(q) + partialNote(M, `q:${q}`) })),
    ...months.map((m) => ({ v: `m:${m}`, l: `Month: ${monthName(M, m)}` })),
  ];
  return (
    <div className={`ld-filters${more ? ' expanded' : ''}`} role="search" aria-label="Global filters">
      <span className="ld-fi"><Filter size={15} strokeWidth={STROKE} aria-hidden />Filters</span>
      {sel('period', 'Quarter or month', periodOpts, false)}
      {sel('source', 'Source', SOURCE_NAMES.map((s, i) => ({ v: i, l: s })).filter((o) => o.v !== ORGANIC && leadSources.has(o.v)), true, 'All sources')}
      {sel('state', 'State', idx(d.state).map((x) => ({ v: x.i, l: x.c })), true, 'All states')}
      {sel('city', 'City', sorted(cities).map((x) => ({ v: x.i, l: x.c })), true, 'All cities')}
      {sel('dist', 'Distributor', idx(d.dist).map((x) => ({ v: x.i, l: x.c })), true, 'All distributors')}
      {d.campaign.length > 0 && sel('campaign', 'Campaign', idx(d.campaign).map((x) => ({ v: x.i, l: x.c })), true, 'All campaigns')}
      {sel('tier', 'Tier', d.tiers.map((t, i) => ({ v: i, l: t })).reverse(), true, 'All tiers')}
      {M.p.hasLeads && sel('outcome', 'What happened to the lead', d.outcomes.map((o, i) => ({ v: i, l: o })), true, 'Every result')}
      {sel('level', 'How sure a lead-to-retailer match must be', d.levels.map((_, i) => ({ v: i, l: `Matching: ${LEVEL_NAMES[i] ?? d.levels[i]}` })), true)}
      {sel('window', 'Count a first order within', d.windows.map((w) => ({ v: w, l: `Sale within ${w} days` })), true)}
      <button type="button" className="ld-reset ld-filter-more" onClick={() => setMore((x) => !x)} aria-expanded={more}
        title={LEVEL_HELP.join(' · ')}><SlidersHorizontal size={13} strokeWidth={STROKE} />{more ? 'Fewer filters' : 'More filters'}</button>
      <button type="button" className="ld-reset" onClick={reset} title="Clear filters"><RotateCcw size={13} strokeWidth={STROKE} />Reset</button>
      <span className="ld-window">Showing: <b>{periodName(M, f.period)}</b>
        <span className="ld-cover" title="Leads and sales update on their own; each new sales month fills in the pending results.">
          Leads up to {M.leadLastDay >= 0 ? dayName(M.leadLastDay) : '—'} · Sales up to {monthName(M, M.p.salesEnd)}</span></span>
    </div>
  );
}
