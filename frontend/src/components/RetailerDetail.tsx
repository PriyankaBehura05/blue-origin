import { useMemo } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { Card, Drawer, ErrorBox, Loading, StatusBadge, TierBadge } from '@/components/ui';
import { TrendChart } from '@/components/charts';
import { formatDate, formatINR, formatMonthYear, quarterLong } from '@/utils/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-05' -> 'May 26' (same style as the dashboard chart)
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;

// Retailer profile drawer: details, monthly trend, every sales record and benefits.
export function RetailerDetail({ id, quarter, onClose }: { id: string; quarter: string; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => api.getRetailer(id), [id]);
  const monthly = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, number>();
    for (const s of data.sales) m.set(s.month, (m.get(s.month) ?? 0) + s.netAmount);
    return [...m.entries()].sort().map(([k, v]) => ({ label: monthLabel(k), value: Math.round(v) }));
  }, [data]);
  const salesTotal = data ? data.sales.reduce((t, s) => t + s.netAmount, 0) : 0;

  if (error) return <Drawer title="Retailer" onClose={onClose}><ErrorBox message={error} /></Drawer>;
  if (loading || data === undefined) return <Drawer title="Retailer" onClose={onClose}><Loading /></Drawer>;
  if (data === null) return <Drawer title="Retailer" onClose={onClose}><div className="empty">Retailer not found.</div></Drawer>;

  const r = data.retailer;
  return (
    <Drawer title={r.name} subtitle={<span style={{ display: 'flex', gap: 8 }}><TierBadge tier={r.currentTier} /><StatusBadge status={r.status} /></span>} onClose={onClose}>
      {!r.inMaster && <div className="alert warn-alert">This retailer appears in sales data but not in the retailer master file.</div>}
      {r.tierStatus === 'needs_review' && <div className="alert warn-alert">Quarter sales sit exactly on a tier boundary; the boundary rule is not confirmed, so the tier needs review.</div>}
      <dl className="kv">
        <div><dt>Retailer code</dt><dd>{r.code ?? '—'}</dd></div>
        <div><dt>Distributor</dt><dd>{r.distributorName ?? '—'}</dd></div>
        <div><dt>Location</dt><dd>{[r.city, r.state].filter(Boolean).join(', ') || '—'}{r.pincode ? ` – ${r.pincode}` : ''}</dd></div>
        <div><dt>Region</dt><dd>{r.region ?? '—'}</dd></div>
        <div><dt>ASM / RSM</dt><dd>{r.asm ?? '—'} / {r.rsm ?? '—'}</dd></div>
        <div><dt>Previous tier</dt><dd>{r.previousTier}</dd></div>
        <div><dt>{quarter} net sales</dt><dd>{formatINR(r.currentQuarterSales)}</dd></div>
        <div><dt>FY net sales</dt><dd>{formatINR(r.fySales)}</dd></div>
        <div><dt>Onboarded</dt><dd>{formatDate(r.onboardedOn)}</dd></div>
      </dl>
      <Card title="Monthly net sales">{monthly.length ? <TrendChart data={monthly} /> : <div className="empty">No sales recorded</div>}</Card>
      <Card title={`Sales records (${data.sales.length}) — total ${formatINR(salesTotal)}`} pad={false}>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>Month</th><th>Quarter</th><th>Distributor</th><th className="right">Net amount</th></tr></thead>
            <tbody>
              {data.sales.length === 0 && <tr><td colSpan={4} className="empty">No sales records</td></tr>}
              {data.sales.map((s) => (
                <tr key={s.id}>
                  <td>{formatMonthYear(s.date)}</td><td>{quarterLong(s.quarter)}</td><td>{s.distributorName}</td>
                  <td className="right">{formatINR(s.netAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={`Benefits (${data.fulfillments.length})`} pad={false}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Benefit</th><th>Quarter</th><th>Planned</th><th>Actual</th><th>Status</th></tr></thead>
            <tbody>
              {data.fulfillments.length === 0 && <tr><td colSpan={5} className="empty">No benefits assigned</td></tr>}
              {data.fulfillments.map((f) => (
                <tr key={f.id}><td>{f.benefitName}</td><td>{quarterLong(f.quarter)}</td><td>{formatDate(f.plannedDate)}</td><td>{formatDate(f.actualDate)}</td><td><StatusBadge status={f.status} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Drawer>
  );
}
