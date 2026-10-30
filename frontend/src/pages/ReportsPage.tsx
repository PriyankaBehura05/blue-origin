import { useState } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { Card, ErrorBox, Loading, PageHeader } from '@/components/ui';
import { FilterBar, SelectFilter } from '@/components/FilterBar';
import { formatNumber, quarterOptions } from '@/utils/format';
import type { ReportDefinition, ReportFilters } from '@/types';
import { CounterReportPanel } from '@/pages/CounterReportPage';

const COUNTER = 'counter-report';
const BO_DATA = 'bo-data';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;   // '2026-09' -> 'Sep 2026'

const formatDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';

function Preview({ def, filters, onDownloaded }: { def: ReportDefinition; filters: ReportFilters; onDownloaded: () => void }) {
  const key = JSON.stringify(filters);
  const { data, loading, error } = useAsync(() => api.getReportPreview(def.id, filters), [def.id, key]);
  const [busy, setBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);

  const download = async (format: 'csv' | 'xlsx') => {
    setBusy(true);
    setDlError(null);
    try {
      await api.downloadReport(def.id, format, filters);
      onDownloaded();
    } catch (e) {
      setDlError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <Loading />;
  return (
    <Card
      title={`Preview — ${def.name}`}
      pad={false}
      extra={
        <span className="toolbar" style={{ margin: '0 16px' }}>
          <button className="btn primary" disabled={busy} onClick={() => download('xlsx')}>Download XLSX</button>
          <button className="btn" disabled={busy} onClick={() => download('csv')}>Download CSV</button>
        </span>
      }
    >
      {dlError && <div className="alert error-alert" style={{ margin: '0 16px 12px' }}>{dlError}</div>}
      <p className="note" style={{ margin: '0 16px 12px' }}>
        Filters: <b>{data.filters || 'All'}</b>
        {def.usesPeriod === false && (filters.month || filters.quarter) ? ' — the month and quarter filters do not apply to this list.' : ''}
        {def.usesPeriod !== false && !filters.month && !filters.quarter ? ' — period: the current quarter (pick a month or quarter to change it).' : ''}
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr>{data.columns.map((c, i) => <th key={c} className={typeof data.rows[0]?.[i] === 'number' ? 'right' : ''}>{c}</th>)}</tr></thead>
          <tbody>
            {data.rows.length === 0 && <tr><td colSpan={data.columns.length} className="empty">No rows for these filters.</td></tr>}
            {data.rows.map((row, ri) => (
              <tr key={ri}>{row.map((v, ci) => <td key={ci} className={typeof v === 'number' ? 'right' : ''}>{typeof v === 'number' ? formatNumber(v) : v ?? '—'}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-foot"><span>Showing {data.rows.length} of {data.totalRows.toLocaleString('en-IN')} rows — the download contains every row</span></div>
    </Card>
  );
}

// BO_Data: the six sheets of BO_Consolidate_Final.xlsx from the current data, for the chosen filters
function BoDataPanel({ filters }: { filters: ReportFilters }) {
  const key = JSON.stringify(filters);
  const { data, loading, error } = useAsync(() => api.getBoDataSummary(filters), [key]);
  const [busy, setBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setDlError(null);
    try {
      await api.downloadBoData(filters);
    } catch (e) {
      setDlError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const table = (t: { columns: string[]; rows: (string | number)[][] }) => (
    <div className="table-wrap">
      <table>
        <thead><tr>{t.columns.map((c, i) => <th key={c} className={i ? 'right' : ''}>{c.replace('_', ' ')}</th>)}</tr></thead>
        <tbody>{t.rows.map((r) => <tr key={String(r[0])}>{r.map((v, i) => <td key={i} className={i ? 'right' : ''}>{typeof v === 'number' ? formatNumber(v) : v}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
  return (
    <Card
      title={data ? `BO_Data — as at ${data.latest.replace('_', ' ')}` : 'BO_Data'}
      pad={false}
      extra={
        <span className="toolbar" style={{ margin: '0 16px' }}>
          <button className="btn primary" disabled={busy || !data} onClick={download}>{busy ? 'Building Excel… (about 20 s)' : '⤓ Download BO_Data (Excel)'}</button>
        </span>
      }
    >
      {dlError && <div className="alert error-alert" style={{ margin: '0 16px 12px' }}>{dlError}</div>}
      {error && <ErrorBox message={error} />}
      {!data ? (!error && <Loading />) : (
        <div style={{ opacity: loading ? 0.6 : 1 }}>
          <p className="note" style={{ margin: '0 16px 12px' }}>
            Same six sheets and columns as BO_Consolidate_Final.xlsx — Consolidated_Tiered, Tier_Distribution, Tier_Movement_Summary,
            Revenue_Region_x_Movement, Count_Region_x_Movement and Final_Data — built from the current data: <b>{formatNumber(data.rows)} retailers</b>,
            every quarter up to {data.latest.replace('_', ' ')}{data.partial ? ' (that quarter counted up to the chosen month)' : ''}.
            A quarter or month gives the workbook as it stood at the end of that period; distributor, region and state keep only those retailers.
          </p>
          <p className="note" style={{ margin: '0 16px 6px' }}><b>Tier_Distribution</b></p>
          {table(data.tierDistribution)}
          <p className="note" style={{ margin: '12px 16px 6px' }}><b>Tier_Movement_Summary</b></p>
          {table(data.movementSummary)}
        </div>
      )}
    </Card>
  );
}

export default function ReportsPage() {
  const { data, loading, error, reload } = useAsync(() => api.getReports(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data?.find((r) => r.id === selectedId) ?? null;
  const opts = useAsync(() => api.getFilterOptions(), []);
  const [filters, setFilters] = useState<ReportFilters>({});
  const set = (patch: ReportFilters) => setFilters((f) => ({ ...f, ...patch }));
  const o = opts.data;

  return (
    <>
      <PageHeader title="Reports" subtitle="Standard reports built from live data — select one to preview and export" />
      <FilterBar onReset={() => setFilters({})}>
        <SelectFilter label="Month" value={filters.month ?? ''} options={(o?.months ?? []).map((m) => ({ value: m, label: monthName(m) }))}
          onChange={(v) => set({ month: v, quarter: v ? '' : filters.quarter })} />
        <SelectFilter label="Quarter" value={filters.quarter ?? ''} options={quarterOptions(o?.salesQuarters ?? [])}
          onChange={(v) => set({ quarter: v, month: v ? '' : filters.month })} />
        <SelectFilter label="Region" value={filters.region ?? ''} options={o?.regions ?? []} onChange={(v) => set({ region: v })} />
        <SelectFilter label="State" value={filters.state ?? ''} options={o?.states ?? []} onChange={(v) => set({ state: v })} />
        <SelectFilter label="Distributor" value={filters.distributor ?? ''} options={(o?.distributors ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => set({ distributor: v })} />
        <span className="note">Applies to the preview and the download. The Counter Report has its own financial-year picker.</span>
      </FilterBar>
      {error && <ErrorBox message={error} />}
      {loading && !data && <Loading />}
      <div className="grid grid-3">
        <button
          className="card card-pad"
          style={{ textAlign: 'left', cursor: 'pointer', outline: selectedId === BO_DATA ? '2px solid var(--brand)' : 'none' }}
          onClick={() => setSelectedId(BO_DATA)}
        >
          <div className="note">Retailers · XLSX</div>
          <div style={{ fontWeight: 600, margin: '4px 0' }}>BO_Data</div>
          <div className="note">The BO_Consolidate_Final workbook from the current data: every retailer with revenue, tier and movement per quarter, plus the tier, movement and region summaries.</div>
        </button>
        <button
          className="card card-pad"
          style={{ textAlign: 'left', cursor: 'pointer', outline: selectedId === COUNTER ? '2px solid var(--brand)' : 'none' }}
          onClick={() => setSelectedId(COUNTER)}
        >
          <div className="note">Counters · XLSX</div>
          <div style={{ fontWeight: 600, margin: '4px 0' }}>Distribution Counter Report</div>
          <div className="note">Active and new counters per month for a financial year. Opens as a summary; the download has the complete details by state, distributor and counter.</div>
        </button>
        {data?.map((r) => (
          <button
            key={r.id}
            className="card card-pad"
            style={{ textAlign: 'left', cursor: 'pointer', outline: selectedId === r.id ? '2px solid var(--brand)' : 'none' }}
            onClick={() => setSelectedId(r.id)}
          >
            <div className="note">{r.category} · {r.format}</div>
            <div style={{ fontWeight: 600, margin: '4px 0' }}>{r.name}</div>
            <div className="note">{r.description}</div>
            <div className="note" style={{ marginTop: 8 }}>Last generated: {formatDateTime(r.lastGenerated)}</div>
          </button>
        ))}
      </div>
      {selectedId === BO_DATA && <BoDataPanel filters={filters} />}
      {selectedId === COUNTER && <CounterReportPanel />}
      {selected && <Preview def={selected} filters={filters} onDownloaded={reload} />}
    </>
  );
}
