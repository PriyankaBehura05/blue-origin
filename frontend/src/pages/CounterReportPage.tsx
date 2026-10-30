// Distribution Counter Report, opened from the Reports page: the Summary Dashboard on screen; the download is the full
// six-sheet workbook of Distributor_Counter_Report.xlsx (state / distributor sheets and one row per counter), built
// by the backend from the current data.
import { useState } from 'react';
import { api } from '@/services';
import type { CounterReport } from '@/services/api';
import { useAsync } from '@/hooks/useAsync';
import { Card, ErrorBox, Loading } from '@/components/ui';

const n0 = (v: number | null | undefined) => (v == null || v === 0 ? '–' : Math.round(v).toLocaleString('en-IN'));
const cnt = (v: number | null | undefined) => (v == null ? '' : v.toLocaleString('en-IN'));
const sum = (a: (number | null)[]) => a.reduce<number>((s, v) => s + (v ?? 0), 0);
const growth = (cur: number, prev: number) => (prev ? (cur - prev) / prev : null);

function Trend({ cur, prev }: { cur: number; prev: number }) {
  if (cur > prev) return <span className="cr-up">▲ Growth</span>;
  if (cur < prev) return <span className="cr-down">▼ Degrowth</span>;
  return <span>► Flat</span>;
}
function Pct({ v }: { v: number | null }) {
  if (v == null) return <>–</>;
  return <span className={v > 0 ? 'up' : v < 0 ? 'down' : ''}>{v < 0 ? '-' : ''}{Math.abs(v * 100).toFixed(1)}%</span>;
}

function Summary({ d }: { d: CounterReport }) {
  const s = d.summary;
  let cum = 0;
  const cumulative = s.newCount.map((v) => (cum += v));
  return (
    <div className="table-wrap cr">
      <table>
        <thead><tr><th>Metric</th>{d.months.map((m) => <th key={m} className="center">{m}</th>)}<th className="center cr-total">FY Total</th></tr></thead>
        <tbody>
          <tr><th className="cr-label">Active Counters (MoM)</th>{s.active.map((v, k) => <td key={k} className="center"><b>{cnt(v)}</b></td>)}<td className="center cr-total">{cnt(Math.max(...s.active))}</td></tr>
          <tr><th className="cr-label">Active Counters Revenue (₹)</th>{s.activeRevenue.map((v, k) => <td key={k} className="right">{n0(v)}</td>)}<td className="right cr-total">{n0(sum(s.activeRevenue))}</td></tr>
          <tr><th className="cr-label">New Counters Added</th>{s.newCount.map((v, k) => <td key={k} className="center cr-new"><b>{cnt(v)}</b></td>)}<td className="center cr-total">{cnt(sum(s.newCount))}</td></tr>
          <tr><th className="cr-label">New Counters Revenue (₹)</th>{s.newRevenue.map((v, k) => <td key={k} className="right cr-new">{n0(v)}</td>)}<td className="right cr-total">{n0(sum(s.newRevenue))}</td></tr>
          <tr><th className="cr-label">Cumulative New Adds</th>{cumulative.map((v, k) => <td key={k} className="center">{cnt(v)}</td>)}<td className="center cr-total">{cnt(cumulative[cumulative.length - 1])}</td></tr>
          <tr>
            <th className="cr-label">Active MoM Growth %</th>
            {s.active.map((t, k) => <td key={k} className="center">{k === 0 ? '—' : <Pct v={growth(t, s.active[k - 1])} />}</td>)}
            <td className="cr-total" />
          </tr>
          <tr>
            <th className="cr-label">Trend</th>
            {s.active.map((t, k) => <td key={k} className="center">{k === 0 ? '—' : <Trend cur={t} prev={s.active[k - 1]} />}</td>)}
            <td className="cr-total" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function CounterReportPanel() {
  const [fy, setFy] = useState('');
  const [busy, setBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const report = useAsync(() => api.getCounterReport(fy || undefined), [fy]);
  const d = report.data;
  const download = async () => {
    setBusy(true);
    setDlError(null);
    try {
      await api.downloadCounterReport(d?.fy ?? (fy || undefined));
    } catch (e) {
      setDlError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={d ? `Distribution Counter Report — ${d.label}` : 'Distribution Counter Report'}
      pad={false}
      extra={
        <span className="toolbar" style={{ margin: '0 16px' }}>
          <select className="select" value={d?.fy ?? fy} onChange={(e) => setFy(e.target.value)} aria-label="Financial year" disabled={!d}>
            {(d?.years ?? []).map((y) => <option key={y.fy} value={y.fy}>{y.label}</option>)}
          </select>
          <button className="btn primary" onClick={download} disabled={!d || busy}>{busy ? 'Building Excel…' : '⤓ Download full report'}</button>
        </span>
      }
    >
      {dlError && <div className="alert error-alert" style={{ margin: '0 16px 12px' }}>Download failed: {dlError}</div>}
      {report.error && <ErrorBox message={report.error} />}
      {!d ? (
        !report.error && <Loading />
      ) : (
        <div style={{ opacity: report.loading ? 0.6 : 1 }}>
          <p className="note" style={{ margin: '0 16px 12px' }}>
            {d.counts.counters.toLocaleString('en-IN')} counters ({d.counts.new.toLocaleString('en-IN')} new, {d.counts.existing.toLocaleString('en-IN')} existing,{' '}
            {d.counts.neverBilled.toLocaleString('en-IN')} never billed){d.generated ? ` · data as of ${d.generated}` : ''}. Active = billed (Value&gt;0) • New = first-ever
            billing within {d.fy} • Revenue in ₹.
          </p>
          <Summary d={d} />
          <div className="table-foot">
            <span>Summary only — the download has the complete details: new and active counters by state and by distributor, and every counter month by month</span>
          </div>
        </div>
      )}
    </Card>
  );
}
