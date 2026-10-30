import { useEffect, useRef, useState } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from '@/components/ui';
import { formatNumber, quarterLong } from '@/utils/format';
import type { DatasetName, DatasetStatus, SyncRun, UploadRecord, ValidationReport } from '@/types';
import type { SheetsStatus } from '@/services/api';

const DATASET_HELP: Record<DatasetName, string> = {
  sales: 'Invoice-level sales (net amount, returns, channel, category)',
  retailers: 'Retailer master: codes, distributor, geography, status',
  distributors: 'Distributor master: codes, geography, ASM / RSM',
  benefits: 'Benefit catalogue per tier (or manage it on the Benefits page)',
  fulfillments: 'Benefit fulfilment plan / actuals (or manage on the Benefits page)',
  targets: 'Monthly sales targets (month, target_amount, optional region / channel)',
};

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

function DatasetTable({ datasets }: { datasets: DatasetStatus[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Dataset</th><th>Contents</th><th className="right">Rows</th><th className="right">Valid</th><th>Last updated</th><th>Columns</th><th /></tr>
        </thead>
        <tbody>
          {datasets.map((d) => (
            <tr key={d.dataset}>
              <td><strong>{d.dataset}</strong></td>
              <td className="note" style={{ whiteSpace: 'normal', minWidth: 220 }}>{DATASET_HELP[d.dataset]}</td>
              <td className="right">{d.stored ? formatNumber(d.rows) : '—'}</td>
              <td className="right">{d.stored ? formatNumber(d.validRows) : '—'}</td>
              <td>{d.stored ? fmtTime(d.modified) : <StatusBadge status="Empty" />}</td>
              <td style={{ whiteSpace: 'normal', minWidth: 260 }}>
                <div className="chips">
                  {d.requiredColumns.map((c) => <span key={c} className="chip req" title="required">{c}</span>)}
                  {d.optionalColumns.map((c) => <span key={c} className="chip">{c}</span>)}
                </div>
              </td>
              <td>
                <span className="toolbar">
                  <button className="btn" onClick={() => void api.downloadDatasetTemplate(d.dataset)}>Template</button>
                  {d.stored && <button className="btn" onClick={() => void api.downloadDataset(d.dataset)}>Download</button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportView({ report }: { report: ValidationReport }) {
  const counts = report.status_counts;
  const previewCols = report.preview.length ? Object.keys(report.preview[0]).filter((c) => !c.startsWith('_') || c === '_row_status') : [];
  return (
    <div className="form">
      <div className={`alert ${report.can_process ? 'success-alert' : 'error-alert'}`}>
        {report.can_process
          ? `${report.filename}: ${formatNumber(report.total_rows)} rows read — ${counts.valid ?? 0} valid, ${counts.needs_review ?? 0} need review, ${(counts.invalid ?? 0) + (counts.missing ?? 0)} invalid/missing, ${counts.duplicate ?? 0} duplicate. Only valid sales rows are counted in figures; flagged rows are kept.`
          : `${report.filename} cannot be used: ${report.file_errors.map((e) => e.message).join(' ')}`}
      </div>
      {report.file_warnings.length > 0 && (
        <div className="alert warn-alert">{report.file_warnings.map((w) => w.message).join(' ')}</div>
      )}
      {report.issues.length > 0 && (
        <details>
          <summary>{report.issues_total} row issue(s){report.issues_truncated ? ' (first ones shown)' : ''}</summary>
          <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Row</th><th>Column</th><th>Status</th><th>Message</th></tr></thead>
              <tbody>
                {report.issues.slice(0, 200).map((i, n) => (
                  <tr key={n}><td>{i.row ?? '—'}</td><td>{i.column ?? '—'}</td><td>{i.status}</td><td style={{ whiteSpace: 'normal' }}>{i.message}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {previewCols.length > 0 && (
        <details>
          <summary>Preview of cleaned rows</summary>
          <div className="table-wrap">
            <table>
              <thead><tr>{previewCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {report.preview.slice(0, 10).map((row, n) => (
                  <tr key={n}>{previewCols.map((c) => <td key={c}>{row[c] === null || row[c] === undefined ? '—' : String(row[c])}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function UploadPanel({ datasets, onActivated }: { datasets: DatasetName[]; onActivated: () => void }) {
  const [dataset, setDataset] = useState<DatasetName>('sales');
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState('');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState<'validate' | 'upload' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setReport(null);
    setMessage(null);
  };

  const validate = async () => {
    if (!file) return;
    setBusy('validate');
    reset();
    try {
      setReport(await api.validateUpload(file, dataset, sheet || undefined));
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const uploadAndActivate = async () => {
    if (!file) return;
    setBusy('upload');
    setMessage(null);
    try {
      const res = await api.upload(file, dataset, sheet || undefined, allowDuplicate);
      setReport(res.report);
      if (!res.report.can_process) {
        setMessage({ kind: 'err', text: 'The file was stored for reference but cannot be activated. Fix the errors below and upload again.' });
        return;
      }
      const act = await api.activateUpload(res.upload.upload_id, mode);
      setMessage({ kind: 'ok', text: `${act.dataset} updated in the data store (${act.mode}): ${formatNumber(act.rows_stored)} rows now stored at ${act.path}.` });
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onActivated();
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Upload a BO file">
      <div className="form">
        <div className="form-grid">
          <label className="field">
            <span>Dataset</span>
            <select className="select" value={dataset} onChange={(e) => { setDataset(e.target.value as DatasetName); reset(); }}>
              {datasets.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <small className="note">{DATASET_HELP[dataset]}</small>
          </label>
          <label className="field">
            <span>File (.xlsx, .xls, .csv)</span>
            <input ref={fileInput} className="input" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }} />
          </label>
          <label className="field">
            <span>Excel sheet</span>
            <input className="input" value={sheet} placeholder="First sheet" onChange={(e) => setSheet(e.target.value)} />
          </label>
          <label className="field">
            <span>When activating</span>
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'replace' | 'append')}>
              <option value="replace">Replace the stored {dataset}</option>
              <option value="append">Append rows to the stored {dataset}</option>
            </select>
          </label>
        </div>
        <label className="note" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />
          Allow uploading a file identical to an earlier upload
        </label>
        <div className="form-actions">
          <button className="btn" disabled={!file || busy !== null} onClick={validate}>{busy === 'validate' ? 'Checking…' : 'Validate only'}</button>
          <button className="btn primary" disabled={!file || busy !== null} onClick={uploadAndActivate}>{busy === 'upload' ? 'Uploading…' : 'Upload & activate'}</button>
        </div>
        {message && <div className={`alert ${message.kind === 'ok' ? 'success-alert' : 'error-alert'}`}>{message.text}</div>}
        {report && <ReportView report={report} />}
      </div>
    </Card>
  );
}

function HistoryTable({ uploads, onActivated }: { uploads: UploadRecord[]; onActivated: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activate = async (u: UploadRecord, mode: 'replace' | 'append') => {
    if (!window.confirm(`${mode === 'replace' ? 'Replace' : 'Append to'} the stored ${u.dataset} with ${u.original_filename}?`)) return;
    setBusy(u.upload_id);
    setError(null);
    try {
      await api.activateUpload(u.upload_id, mode);
      onActivated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {error && <div className="alert error-alert" style={{ margin: '0 16px 12px' }}>{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Uploaded</th><th>File</th><th>Dataset</th><th className="right">Rows</th><th>Validation</th><th>Activated</th><th /></tr></thead>
          <tbody>
            {uploads.length === 0 && <tr><td colSpan={7} className="empty">No uploads yet</td></tr>}
            {uploads.map((u) => (
              <tr key={u.upload_id}>
                <td>{fmtTime(u.uploaded_at)}</td>
                <td>{u.original_filename}</td>
                <td>{u.dataset}</td>
                <td className="right">{formatNumber(u.total_rows)}</td>
                <td>{u.can_process ? <span className="note">{u.status_counts.valid ?? 0} valid / {u.total_rows}</span> : <StatusBadge status="Rejected" />}</td>
                <td>{u.processed ? `${fmtTime(u.activated_at)} (${u.activation_mode})` : '—'}</td>
                <td>
                  {u.can_process && (
                    <span className="toolbar">
                      <button className="btn" disabled={busy !== null} onClick={() => activate(u, 'replace')}>Activate</button>
                      <button className="btn" disabled={busy !== null} onClick={() => activate(u, 'append')}>Append</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SyncPanel({ onSynced }: { onSynced: () => void }) {
  const status = useAsync(() => api.getSyncStatus(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<SyncRun | null>(null);
  const s = status.data;
  const shown = run ?? s?.last_run ?? null;

  const sync = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.runSync(force);
      setRun(r);
      status.reload();
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Dropbox inbox — other datasets"
      extra={(
        <span className="toolbar">
          <button className="btn" disabled={busy} onClick={() => sync(true)} title="Rebuild every dataset from its inbox files">Rebuild all</button>
          <button className="btn primary" disabled={busy} onClick={() => sync(false)}>{busy ? 'Syncing…' : 'Sync now'}</button>
        </span>
      )}
    >
      <div className="form">
        {status.error && <ErrorBox message={status.error} />}
        {s && (
          <div className="sync-meta">
            <span>Inbox: <code>{s.inbox}</code></span>
            <span>Schedule: <b>{s.interval_minutes <= 0 ? 'manual only' : s.interval_minutes % 60 === 0 ? `every ${s.interval_minutes / 60} h` : `every ${s.interval_minutes} min`}</b></span>
            {s.next_run_at && <span>Next check: <b>{fmtTime(s.next_run_at)}</b></span>}
            <span>Last run: <b>{shown ? `${fmtTime(shown.finished_at)} (${shown.trigger})` : 'never'}</b></span>
          </div>
        )}
        <div className="note">
          Put Excel/CSV files in <code>inbox/&lt;dataset&gt;/</code> (e.g. <code>inbox/sales/Sales_Apr26.xlsx</code>) — every file in a folder is combined —
          or put one workbook in <code>inbox/</code> with a sheet per dataset named “Sales”, “Retailers”, “Distributors”… Changed folders are re-imported
          automatically; a dataset fed from the inbox is rebuilt from its files whenever they change.
        </div>
        {error && <div className="alert error-alert">{error}</div>}
        {shown && !shown.ok && <div className="alert error-alert">Last run failed: {shown.error}</div>}
        {shown?.warnings.map((w) => <div key={w} className="alert warn-alert">{w}</div>)}
        {shown && shown.ok && shown.results.length === 0 && (
          <div className="alert warn-alert">No files found in the inbox yet.</div>
        )}
        {shown && shown.results.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Dataset</th><th>Result</th><th className="right">Rows stored</th><th>Source files</th></tr></thead>
              <tbody>
                {shown.results.map((r) => (
                  <tr key={r.dataset}>
                    <td><strong>{r.dataset}</strong></td>
                    <td><StatusBadge status={r.status} />{r.message && <div className="note">{r.message}</div>}</td>
                    <td className="right">{formatNumber(r.rows)}</td>
                    <td style={{ whiteSpace: 'normal' }}>
                      {r.files.map((f) => (
                        <div key={`${f.path}|${f.sheet}`} className={f.error ? 'error-text' : 'note'}>
                          {f.path.split('/').pop()}{f.sheet ? ` › ${f.sheet}` : ''} — {f.error ?? `${formatNumber(f.valid_rows)} valid of ${formatNumber(f.rows)} rows${f.issues ? `, ${f.issues} issue(s)` : ''}`}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// The dashboard pipeline: the automated pipeline in Dropbox /Power BI/BO_Dashboard refreshes the consolidated sheets;
// the platform sums them per retailer (one per Code name, no duplicate merging), recalculates tiers (bo_pipeline.py) and serves the result.
type LastBuild = {
  status?: string; built_at?: string; finished_at?: string; last_success_at?: string; quarters?: string[]; retailers?: number;
  message?: string; seconds?: number; revenue_check?: string;
  enrichment?: { source?: string; city?: number; pincode?: number; phone?: number; error?: string } | null;
};

const fmtSize = (n: number | null) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function revenueOk(check: string | undefined) {
  const m = check?.match(/source:\s*(\d+)\s+consolidated:\s*(\d+)/);
  return m ? m[1] === m[2] : null;
}

// Google Sheets -> Consolidated: what the next sync downloads and what the last one did
function SheetsBox({ sh }: { sh: SheetsStatus }) {
  const last = sh.last;
  const outcomeText: Record<string, string> = { saved: 'Saved', unchanged: 'No change', kept: 'Not saved', no_tab: 'No tab yet' };
  return (
    <div className="form">
      {!sh.key_found && (
        <div className="alert warn-alert">
          The Google key is not installed, so “Sync now” cannot download the sheets yet. Copy <code>bo-data-service-account.json</code> (the key BO_data.ipynb
          uses) to <code>{sh.key_path}</code>; the dashboard uses only the real Google Sheets listed in <code>{sh.distributor_list}</code>.
        </div>
      )}
      {sh.list_error && <div className="alert error-alert">Distributor list {sh.distributor_list}: {sh.list_error}</div>}
      <div className="sync-meta">
        <span>Google Sheets: <b>{sh.distributors} distributors</b> ({sh.distributor_list})</span>
        <span>Next sync downloads: <b>{sh.quarters.map((q) => q.label).join(' and ')}</b> → {sh.target}</span>
        <span>Last download: <b>{last ? `${fmtTime(last.finished_at)} (${last.trigger})` : 'never'}</b></span>
      </div>
      {last?.error && <div className="alert error-alert">Last download failed: {last.error}</div>}
      {last && last.quarters.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Quarter file</th><th>Result</th><th className="right">Sheets read</th><th className="right">No tab yet</th><th>Could not be read</th></tr></thead>
            <tbody>
              {last.quarters.map((q) => (
                <tr key={q.file}>
                  <td>{q.file} <span className="note">{q.label}</span></td>
                  <td><StatusBadge status={outcomeText[q.outcome] ?? q.outcome} /> <span className="note">{q.message}</span></td>
                  <td className="right">{q.loaded.length}</td>
                  <td className="right" title={q.no_tab.join(', ')}>{q.no_tab.length}</td>
                  <td style={{ whiteSpace: 'normal' }}>{q.failed.length ? <span className="error-text">{q.failed.join('; ')}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PipelinePanel() {
  const status = useAsync(() => api.getNetworkStatus(), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlQuarter, setDlQuarter] = useState('');   // '' = all quarters
  const [syncing, setSyncing] = useState(false);
  const { reload } = status;
  const s = status.data;
  const building = s?.building ?? false;
  useEffect(() => {
    if (!building) return;
    const t = setTimeout(reload, 10000);
    return () => clearTimeout(t);
  }, [building, reload]);
  const b = (s?.lastBuild ?? {}) as LastBuild;
  const rebuild = async () => {
    setMsg(null);
    try {
      await api.rebuildNetwork();
      setMsg('Rebuilding in the background (about 5 minutes). Every page picks up the new data when it is done.');
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  // download the Google Sheets of the current + previous quarter into Consolidated, then rebuild when they changed
  const syncNow = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      const run = await api.runSync(false);
      setMsg(run.ok ? 'Sync finished: the Google Sheets were downloaded and the dashboard was updated where the data changed.' : `Sync failed: ${run.error}`);
    } catch (e) {
      setMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      reload();
    }
  };
  const downloadData = async () => {
    setDownloading(true);
    setMsg(null);
    try {
      await api.downloadConsolidated(dlQuarter || undefined);
    } catch (e) {
      setMsg(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  };
  const files = s?.files ?? [];
  const waiting = files.filter((f) => f.status !== 'In dashboard');
  const codeChanged = (s?.code ?? []).filter((c) => c.status !== 'In sync');
  const revOk = revenueOk(b.revenue_check);
  const sourceFolder = s?.code[0]?.file.replace(/\/[^/]+$/, '') ?? '/Power BI/BO_Dashboard';
  const steps: [string, string][] = [
    ['Google Sheets', s?.sheets ? `${s.sheets.distributors} distributor sheets` : 'distributor sheets'],
    ['Download (built in)', s?.sheets?.configured ? 'current + previous quarter, found by date' : `${sourceFolder} · BO_data.ipynb`],
    ['Consolidated', `${s?.pipelineInput ?? '/Power BI/Consolidated'} · one file per quarter`],
    ['Platform build', 'one retailer per Code name · recalculate tiers'],
    ['Dashboard & reports', b.retailers != null ? `${formatNumber(b.retailers)} retailers` : 'every page'],
  ];

  return (
    <Card
      title="Dashboard pipeline"
      extra={(
        <span className="toolbar">
          <button className="btn primary" onClick={syncNow} disabled={syncing || building}
            title="Download the distributors' Google Sheets (current and previous quarter) into Consolidated, then update the dashboard">
            {syncing ? 'Syncing… (a few minutes)' : '⟳ Sync now'}
          </button>
          <select value={dlQuarter} onChange={(e) => setDlQuarter(e.target.value)} aria-label="Quarter to download"
            title="Which quarter to download: its retailers, tiers and monthly sales (Jul, Aug, Sep for Q2)">
            <option value="">All quarters</option>
            {[...(b.quarters ?? [])].reverse().map((q) => <option key={q} value={q}>{quarterLong(q)}</option>)}
          </select>
          <button className="btn" onClick={downloadData} disabled={downloading || s?.source !== 'pipeline'}
            title="The current consolidated retailer data (one retailer per Code name) as an Excel workbook">
            {downloading ? 'Preparing Excel…' : '⤓ Download consolidated data (Excel)'}
          </button>
          <button className="btn" onClick={rebuild} disabled={building || syncing || !s?.pipelineInput}
            title="Rebuild from the files already in Consolidated (no download)">{building ? 'Rebuilding…' : 'Rebuild now'}</button>
        </span>
      )}
    >
      <div className="form">
        {status.error && <ErrorBox message={status.error} />}
        {!s ? (!status.error && <Loading />) : (
          <>
            <ol className="pipe-flow">
              {steps.map(([t, d]) => <li key={t}><b>{t}</b><span>{d}</span></li>)}
            </ol>
            <div className="sync-meta">
              <span>State: <b>{building ? 'rebuilding…' : b.status === 'failed' ? 'last build failed' : waiting.length ? `${waiting.length} change(s) waiting` : 'up to date'}</b></span>
              {b.built_at && <span>Last built: <b>{fmtTime(b.built_at)}</b>{b.seconds ? ` (${Math.round(b.seconds / 60)} min)` : ''}</span>}
              <span>Next automatic check: <b>{s.nextCheckAt ? fmtTime(s.nextCheckAt) : 'not scheduled (manual only)'}</b></span>
              {b.quarters && <span>Quarters: <b>{quarterLong(b.quarters[0])} – {quarterLong(b.quarters[b.quarters.length - 1])}</b></span>}
              {revOk != null && <span>Revenue check: <b className={revOk ? 'up' : 'down'}>{revOk ? '✓ totals match the sheets' : '✗ totals differ from the sheets'}</b></span>}
            </div>
            {s.sheets?.configured && <SheetsBox sh={s.sheets} />}
            {b.status === 'failed' && (
              <div className="alert error-alert">
                Last build failed{b.finished_at ? ` (${fmtTime(b.finished_at)})` : ''}: {b.message}. The dashboard keeps showing the build of {fmtTime(b.last_success_at ?? b.built_at ?? null)}.
              </div>
            )}
            {waiting.length > 0 && !building && (
              <div className="alert warn-alert">
                {waiting.map((f) => f.file.split('/').pop()).join(', ')} {waiting.length === 1 ? 'has' : 'have'} changed since the last build.
                The dashboard is updated at the next automatic check{s.nextCheckAt ? ` (${fmtTime(s.nextCheckAt)})` : ''}, or now with “Rebuild now”.
              </div>
            )}
            {codeChanged.map((c) => (
              <div key={c.file} className="alert warn-alert">
                {c.status === 'Changed'
                  ? <>The pipeline code <code>{c.file}</code> was changed{c.modified ? ` on ${fmtTime(c.modified)}` : ''}. The platform still runs its copy from {c.copied} ({c.copy}), so the change is not in the dashboard until that copy is updated.</>
                  : <><code>{c.file}</code>: {c.status.toLowerCase()}{c.error ? ` — ${c.error}` : ''}. The platform keeps running its copy ({c.copy}).</>}
              </div>
            ))}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Input file</th><th>Used for</th><th>Updated in Dropbox</th><th className="right">Size</th><th>Status</th></tr></thead>
                <tbody>
                  {files.length === 0 && <tr><td colSpan={5} className="empty">No input files found</td></tr>}
                  {files.map((f) => (
                    <tr key={f.file}>
                      <td>{f.file}</td>
                      <td>{f.quarter ? quarterLong(f.quarter) : f.kind || '—'}</td>
                      <td>{fmtTime(f.modified)}</td>
                      <td className="right">{fmtSize(f.size)}</td>
                      <td><StatusBadge status={f.status} />{f.error && <div className="note">{f.error}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details>
              <summary>Pipeline code ({(s.code.length - codeChanged.length)} of {s.code.length} in sync) and build details</summary>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Code in Dropbox</th><th>Platform copy</th><th>Changed in Dropbox</th><th>Status</th></tr></thead>
                  <tbody>
                    {s.code.map((c) => (
                      <tr key={c.file}><td>{c.file}</td><td>{c.copy} <span className="note">(from {c.copied})</span></td><td>{fmtTime(c.modified)}</td><td><StatusBadge status={c.status} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="note">
                {b.revenue_check && <>{b.revenue_check}. </>}
                {b.enrichment && !b.enrichment.error && <>Blank contact details filled from {b.enrichment.source}: {formatNumber(b.enrichment.city ?? 0)} cities, {formatNumber(b.enrichment.pincode ?? 0)} pincodes, {formatNumber(b.enrichment.phone ?? 0)} phone numbers. </>}
                {b.enrichment?.error && <>Contact details were not filled: {b.enrichment.error}. </>}
                The build only runs when an input file changed; re-running the notebook without new data does not rebuild. A failed build never replaces the last good data.
              </p>
            </details>
          </>
        )}
        {msg && <p className="note">{msg}</p>}
      </div>
    </Card>
  );
}

export default function DataPage() {
  const health = useAsync(() => api.getHealth(), []);
  const ds = useAsync(() => api.getDatasets(), []);
  const uploads = useAsync(() => api.getUploads(), []);
  const [reloading, setReloading] = useState(false);

  const refresh = () => {
    ds.reload();
    uploads.reload();
  };
  const reloadFromStore = async () => {
    setReloading(true);
    try {
      await api.reloadDatasets();
      refresh();
    } finally {
      setReloading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Data"
        subtitle={health.data?.store ? `Data store: ${health.data.store}` : 'Upload BO files into the data store'}
        actions={<button className="btn" onClick={reloadFromStore} disabled={reloading}>{reloading ? 'Reloading…' : 'Reload from store'}</button>}
      />
      {health.data && !health.data.store_ok && <ErrorBox message={health.data.store_error ?? 'The data store is not reachable.'} />}
      <PipelinePanel />
      <SyncPanel onSynced={refresh} />
      <UploadPanel datasets={(ds.data ?? []).map((d) => d.dataset)} onActivated={refresh} />
      <Card title="Stored datasets" pad={false}>
        {ds.error ? <ErrorBox message={ds.error} /> : !ds.data ? <Loading /> : <DatasetTable datasets={ds.data} />}
      </Card>
      <Card title="Upload history" pad={false}>
        {uploads.error ? <ErrorBox message={uploads.error} /> : !uploads.data ? <Loading /> : <HistoryTable uploads={uploads.data} onActivated={refresh} />}
      </Card>
      <p className="note">
        Files are stored unchanged under <code>uploads/</code> in the data store; activating one writes it to <code>datasets/&lt;name&gt;.csv</code>,
        which every page reads. Headers are matched loosely (e.g. “Net Sales (₹)” → net_sales_amount). Use “Reload from store” after editing files directly in Dropbox.
      </p>
    </>
  );
}
