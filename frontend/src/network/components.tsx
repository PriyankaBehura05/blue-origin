// Building blocks of the dashboard pages: pills, KPI cards, charts, tables and the retailer detail panel.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Drawer } from '@/components/ui';
import { useTheme } from '@/hooks/useTheme';
import { fmtINR, fmtN, fmtPct, mLabel, qLabel, qLong } from './model';
import type { Chart, Col, Kpi, Model, Row, Table } from './types';

const TIERS = ['Untiered', 'Yellow', 'Green', 'Silver', 'Gold', 'Platinum'];

export function TierPill({ t }: { t: number | undefined }) {
  if (t == null || t < 0) return <span className="pill muted">Not listed</span>;
  return (
    <span className="pill">
      <i style={{ background: `var(--t${t})` }} />
      {TIERS[t]}
    </span>
  );
}

export function KpiGrid({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="net-kpis">
      {kpis.map((k) => (
        <div className="card net-kpi" key={k.label}>
          <div className="kpi-label">{k.label}</div>
          <div className={`net-kpi-value ${k.tone ?? ''}`}>{k.value}</div>
          <div className="net-kpi-sub">
            {k.delta != null && <span className={`net-delta ${k.delta > 0.05 ? 'up' : k.delta < -0.05 ? 'down' : 'flat'}`}>{k.delta >= 0 ? '▲' : '▼'} {Math.abs(k.delta).toFixed(1)}%</span>}
            {k.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ charts */
const cssVar = (c: string) => (c.startsWith('var(') ? getComputedStyle(document.documentElement).getPropertyValue(c.slice(4, -1)).trim() || c : c);
const axisINR = (v: unknown) => {
  const n = Number(v) || 0;
  return n >= 1e7 ? `₹${+(n / 1e7).toFixed(1)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(1)} L` : n >= 1e3 ? `₹${+(n / 1e3).toFixed(0)} K` : `₹${n}`;
};

export function ChartCard({ c, onPick }: { c: Chart; onPick?: (i: number) => void }) {
  const theme = useTheme();
  const axisFmt = c.fmt === 'inr' ? axisINR : c.fmt === 'pct' ? (v: unknown) => `${Number(v).toFixed(0)}%` : fmtN;
  const tipFmt = c.fmt === 'inr' ? fmtINR : c.fmt === 'pct' ? (v: unknown) => `${Number(v).toFixed(1)}%` : fmtN;
  const data = c.labels.map((l, i) => Object.fromEntries([['label', l], ...c.series.map((s) => [s.name, s.values[i]])]));
  const colors = c.series.map((s) => cssVar(s.color));
  const grid = cssVar('var(--border)');
  const ink = cssVar('var(--muted)');
  const hl = c.highlight ? new Set(c.highlight) : null;
  const axis = { tick: { fill: ink, fontSize: 11 }, axisLine: false, tickLine: false } as const;
  const many = c.labels.length > 12;
  const xAxis = <XAxis dataKey="label" {...axis} interval={many ? 'preserveStartEnd' : 0} minTickGap={6} angle={c.labels.length > 8 ? -35 : 0} textAnchor={c.labels.length > 8 ? 'end' : 'middle'} height={c.labels.length > 8 ? 56 : 28} />;
  const tip = (
    <Tooltip
      cursor={{ fill: cssVar('var(--hover)'), opacity: 0.7 }}
      content={({ active, payload, label }) =>
        active && payload?.length ? (
          <div className="net-tip">
            <div className="net-tip-h">{label}</div>
            {payload.map((p) => (
              <div key={String(p.dataKey)}>
                <span style={{ color: p.color }}>■</span> {c.series.length > 1 || c.tipExtra ? `${p.dataKey}: ` : ''}
                <b>{tipFmt(p.value)}</b>
              </div>
            ))}
            {c.kind === 'stack' && <div className="net-tip-total">Total: <b>{tipFmt(payload.reduce((s, p) => s + Number(p.value || 0), 0))}</b></div>}
            {c.tipExtra?.map((x) => {
              const i = c.labels.indexOf(String(label));
              return i < 0 ? null : (
                <div key={x.name}>{x.name}: <b>{x.fmt === 'inr' ? fmtINR(x.values[i]) : fmtN(x.values[i])}</b></div>
              );
            })}
          </div>
        ) : null
      }
    />
  );
  return (
    <div className={`card net-card${c.wide ? ' wide' : ''}`} key={theme}>
      <div className="net-card-h">
        <div>
          <h3>{c.title}</h3>
          {c.caption && <div className="net-cap">{c.caption}</div>}
        </div>
      </div>
      <div className="net-chart">
        <ResponsiveContainer width="100%" height="100%">
          {c.kind === 'line' ? (
            <LineChart data={data} margin={{ top: 8, right: 14, left: 4, bottom: 0 }}>
              <CartesianGrid stroke={grid} vertical={false} />
              {xAxis}
              <YAxis {...axis} tickFormatter={(v) => axisFmt(v)} width={64} />
              {tip}
              {c.series.map((s, i) => <Line key={s.name} type="monotone" dataKey={s.name} stroke={colors[i]} strokeWidth={2.2} dot={{ r: 2.5 }} activeDot={{ r: 5 }} isAnimationActive={false} connectNulls />)}
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barCategoryGap={c.kind === 'group' ? '22%' : '16%'}
              onClick={onPick ? (e) => { if (e?.activeTooltipIndex != null) onPick(Number(e.activeTooltipIndex)); } : undefined}>
              <CartesianGrid stroke={grid} vertical={false} />
              {xAxis}
              <YAxis {...axis} tickFormatter={(v) => axisFmt(v)} width={64} />
              {tip}
              {c.series.map((s, si) => (
                <Bar key={s.name} dataKey={s.name} stackId={c.kind === 'stack' ? 'a' : undefined} fill={colors[si]} isAnimationActive={false}
                  radius={c.kind === 'stack' ? (si === c.series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]) : [4, 4, 0, 0]} cursor={onPick ? 'pointer' : undefined}>
                  {(hl || c.colors) && data.map((_, i) => (
                    <Cell key={i} {...(c.colors ? { fill: cssVar(c.colors[i]) } : {})} fillOpacity={hl && !hl.has(i) ? 0.35 : 1} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {c.series.length > 1 && (
        <div className="net-legend">
          {c.series.map((s, i) => <span key={s.name}><i style={{ background: colors[i] }} />{s.name}</span>)}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ tables */
const isNum = (c: Col) => c.type === 'inr' || c.type === 'num' || c.type === 'pct';

function CellValue({ c, r, onOpen }: { c: Col; r: Row; onOpen: (id: string) => void }) {
  const v = r[c.k];
  switch (c.type) {
    case 'inr': return <>{v == null || v === '' ? '–' : fmtINR(v)}</>;
    case 'num': return <>{v == null || v === '' ? '–' : fmtN(v)}</>;
    case 'pct': {
      const p = v as number | null;
      return <span className={p == null ? 'flat' : p > 0.05 ? 'up' : p < -0.05 ? 'down' : 'flat'}>{fmtPct(p)}</span>;
    }
    case 'tier': return <TierPill t={v as number} />;
    case 'link':
      return r.ID ? (
        <a href="#" onClick={(e) => { e.preventDefault(); onOpen(String(r.ID)); }}>{String(v)}</a>
      ) : <>{String(v ?? '')}</>;
    default: return <>{String(v ?? '')}</>;
  }
}

export function NetTable({ t, onOpen, onExport, extra, compact }: {
  t: Table; onOpen: (id: string) => void; onExport: (t: Table, kind: 'xlsx' | 'csv') => void; extra?: ReactNode; compact?: boolean;
}) {
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 } | null>(null);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    let rs = t.rows;
    if (q.trim()) {
      const s = q.toLowerCase();
      rs = rs.filter((r) => t.cols.some((c) => String(c.type === 'tier' && typeof r[c.k] === 'number' ? TIERS[r[c.k] as number] ?? '' : r[c.k] ?? '').toLowerCase().includes(s)));
    }
    if (sort) {
      rs = rs.slice().sort((a, b) => {
        const x = a[sort.k];
        const y = b[sort.k];
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
      });
    }
    return rs;
  }, [t, q, sort]);
  const ref = useRef<HTMLDivElement>(null);
  const virtual = rows.length > 80;
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: () => 37, overscan: 12 });
  const items = virtual ? v.getVirtualItems() : rows.map((_, i) => ({ index: i, start: 0, end: 0, key: i }));
  const padTop = virtual && items.length ? items[0].start : 0;
  const padBot = virtual && items.length ? v.getTotalSize() - items[items.length - 1].end : 0;
  const shown: Table = { ...t, rows };
  const matrixMax = t.matrix ? Math.max(1, ...t.rows.flatMap((r, i) => t.cols.slice(1, -1).map((c, j) => (i === 0 && j === 0 ? 0 : Number(r[c.k]))))) : 1;
  const mBg = (i: number, j: number, val: number) => {
    if (!t.matrix || !val || (i === 0 && j === 0)) return undefined;
    const c = j > i ? 'var(--good)' : j < i ? 'var(--bad)' : 'var(--brand)';
    return { background: `color-mix(in srgb, ${c} ${Math.round(8 + 42 * (val / matrixMax))}%, transparent)` };
  };
  return (
    <div className="card net-card">
      <div className="net-card-h">
        <div>
          <h3>{t.title}</h3>
          {t.caption && <div className="net-cap">{t.caption}</div>}
        </div>
        <div className="toolbar">
          <button className="btn sm" onClick={() => onExport(shown, 'xlsx')}>⤓ Excel</button>
          <button className="btn sm" onClick={() => onExport(shown, 'csv')}>⤓ CSV</button>
        </div>
      </div>
      {extra}
      {!t.matrix && !compact && t.rows.length > 8 && (
        <div className="net-tbar">
          <input className="input" placeholder="Quick search in this table…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${t.title}`} />
          <span className="net-count">{fmtN(rows.length)}{rows.length !== t.rows.length ? ` of ${fmtN(t.rows.length)}` : ''} rows</span>
        </div>
      )}
      <div className={`net-scroll${t.matrix || rows.length <= 12 ? ' short' : ''}`} ref={ref}>
        <table className={`net-table${t.matrix ? ' matrix' : ''}`}>
          <thead>
            <tr>
              {t.cols.map((c, i) => (
                <th key={c.k} className={`${isNum(c) ? 'r' : ''} ${i === 0 ? 'first' : ''}`}
                  onClick={() => !t.matrix && setSort((s) => ({ k: c.k, dir: s?.k === c.k ? (-s.dir as 1 | -1) : isNum(c) || c.type === 'tier' ? -1 : 1 }))}
                  aria-sort={sort?.k === c.k ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}>
                  {c.label}{sort?.k === c.k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && <tr style={{ height: padTop }}><td colSpan={t.cols.length} className="pad" /></tr>}
            {items.map((it) => {
              const r = rows[it.index];
              return (
                <tr key={it.key}>
                  {t.cols.map((c, j) => (
                    <td key={c.k} className={`${isNum(c) ? 'r' : ''} ${c.type === 'wrap' ? 'wrap' : ''} ${j === 0 ? 'first' : ''}`}
                      style={j > 0 && j < t.cols.length - 1 ? mBg(Number(r.FromIdx), j - 1, Number(r[c.k])) : undefined}>
                      {t.matrix && j === 0 ? <TierPill t={Number(r.FromIdx)} /> : <CellValue c={c} r={r} onOpen={onOpen} />}
                    </td>
                  ))}
                </tr>
              );
            })}
            {padBot > 0 && <tr style={{ height: padBot }}><td colSpan={t.cols.length} className="pad" /></tr>}
          </tbody>
        </table>
        {!rows.length && <div className="empty">No retailers match these filters.</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ retailer detail panel */
export function RetailerPanel({ m, id, onClose }: { m: Model; id: string; onClose: () => void }) {
  const r = m.byId.get(id);
  if (!r) return null;
  const chart: Chart = { id: 'one', title: 'Monthly purchases', kind: 'bar', labels: m.M.map(mLabel), series: [{ name: 'Purchase', color: 'var(--brand)', values: r.m }], fmt: 'inr' };
  return (
    <Drawer title={r.n} subtitle={<span className="note">{r.id} · {r.dist} · {r.state} · {r.region}</span>} onClose={onClose}>
      <dl className="net-kv">
        <dt>Current tier ({qLabel(m.Q[m.LQ])})</dt><dd><TierPill t={r.t[m.LQ]} /></dd>
        <dt>Best tier</dt><dd><TierPill t={r.best} /></dd>
        <dt>District</dt><dd>{r.ds || '–'}</dd>
        <dt>City / area</dt><dd>{r.ct || '–'}</dd>
        <dt>Pincode</dt><dd>{r.pin || '–'}</dd>
        <dt>Phone(s)</dt><dd>{r.phones.length ? r.phones.join(', ') : '–'}</dd>
        <dt>Lifetime revenue</dt><dd>{fmtINR(r.life)}</dd>
        <dt>First purchase</dt><dd>{r.first >= 0 ? mLabel(m.M[r.first]) : '–'}</dd>
      </dl>
      <ChartCard c={chart} />
      <div className="card net-card">
        <div className="net-card-h"><h3>Purchase and tier by quarter</h3></div>
        <div className="net-scroll short">
          <table className="net-table">
            <thead><tr><th>Quarter</th><th className="r">Purchase</th><th>Tier</th><th>Tier in distributor sheet</th></tr></thead>
            <tbody>
              {m.Q.map((q, i) => (
                <tr key={q}>
                  <td>{qLong(q)}</td>
                  <td className="r">{fmtINR(r.basis[i])}</td>
                  <td><TierPill t={r.t[i]} /></td>
                  <td><TierPill t={(r.rt ?? r.t)[i]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Drawer>
  );
}
