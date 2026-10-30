import type { ReactNode } from 'react';
import type { KpiCard, TierName } from '@/types';
import { formatINR, formatNumber, formatPercent } from '@/utils/format';
import { tierColor } from '@/utils/tiers';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({ title, extra, children, pad = true }: { title?: string; extra?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className={`card ${pad ? 'card-pad' : ''}`}>
      {title && (
        <div className="card-title" style={pad ? undefined : { padding: '16px 16px 0' }}>
          <span>{title}</span>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function KpiTile({ kpi, showDelta = true }: { kpi: KpiCard; showDelta?: boolean }) {
  const value = kpi.format === 'currency' ? formatINR(kpi.value, true) : kpi.format === 'percent' ? formatPercent(kpi.value) : formatNumber(kpi.value);
  const delta = kpi.deltaPct;
  const up = (delta ?? 0) >= 0;
  // For return rate, an increase is bad
  const good = kpi.key === 'returns' ? !up : up;
  return (
    <div className="card kpi">
      <div className="kpi-label">{kpi.label}</div>
      <div className="kpi-value">{value}</div>
      {showDelta && delta !== null && (
        <div className={`delta ${good ? 'up' : 'down'}`}>
          {up ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%<span className="delta-note">vs prev. period</span>
        </div>
      )}
      {showDelta && delta === null && <div className="delta-note">No comparable previous period</div>}
    </div>
  );
}

export function TierBadge({ tier }: { tier: TierName }) {
  const c = tierColor(tier);
  return (
    <span className="badge" style={{ background: `${c}22`, color: 'var(--text)', borderColor: `${c}66` }}>
      <span className="dot" style={{ background: c }} />
      {tier}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  Active: 'green', Fulfilled: 'green', Completed: 'blue', Upgrade: 'green',
  'In Progress': 'blue', Planned: 'gray', Draft: 'gray', Retained: 'gray',
  Inactive: 'red', Overdue: 'red', Downgrade: 'red',
  'On Hold': 'amber', Unknown: 'gray',
  // tier movement
  Upgraded: 'green', Downgraded: 'red', 'Stayed in same tier': 'blue', 'Dropped from the tier': 'amber', New: 'blue',
  'Never been on tier but some sales': 'gray', 'No sales': 'gray',
  updated: 'green', partial: 'amber', unchanged: 'gray', failed: 'red',
  // dashboard pipeline (Data page)
  'In dashboard': 'green', Changed: 'amber', Removed: 'gray', 'In sync': 'green', Missing: 'red', Unreadable: 'red',
  Saved: 'green', 'No change': 'gray', 'Not saved': 'red', 'No tab yet': 'amber',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? 'gray'}`}>{status}</span>;
}

export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="progress" style={{ flex: 1 }}><div style={{ width: `${pct}%` }} /></div>
      <span className="note" style={{ minWidth: 38, textAlign: 'right' }}>{max > 0 ? `${pct.toFixed(0)}%` : '—'}</span>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div style={{ marginTop: 6 }}>{subtitle}</div>}
          </div>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="error">Something went wrong: {message}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card card-pad empty-state">
      <h3>{title}</h3>
      {children && <div className="note">{children}</div>}
    </div>
  );
}
