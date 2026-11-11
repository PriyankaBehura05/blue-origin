// Chart wrappers for the lead dashboard (recharts): thin marks, recessive grid, HTML legend above, hover tooltip.
import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface Series {
  key: string;
  label: string;
  color: string;
}

const AXIS = { fontSize: 11, fill: 'var(--muted)' };
// axis ticks drop the decimals of compact amounts: ₹180.00 Cr -> ₹180 Cr
const axis = (fmt: (v: number) => string, v: number) => fmt(v).replace(/\.\d+(?= ?(Cr|L|K))/, '');

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="ld-legend">
      {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
    </div>
  );
}

function Tip({ active, payload, label, fmt, series, title }: {
  active?: boolean;
  payload?: { dataKey: string; value: number }[];
  label?: string;
  fmt: (v: number) => string;
  series: Series[];
  title?: (label: string) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return (
    <div className="ld-chart-tip">
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{title ? title(String(label)) : label}</div>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.key);
        if (!p) return null;
        return <div className="r" key={s.key}><span><i style={{ background: s.color }} />{s.label}</span><b>{fmt(Number(p.value) || 0)}</b></div>;
      })}
      {series.length > 1 && <div className="r" style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>Total</span><b>{fmt(total)}</b></div>}
    </div>
  );
}

export function StackedBars({ data, x, series, fmt, height = 240, stacked = true }: {
  data: Record<string, number | string>[];
  x: string;
  series: Series[];
  fmt: (v: number) => string;
  height?: number;
  stacked?: boolean;
}) {
  return (
    <>
      <Legend series={series} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="var(--line-soft)" />
          <XAxis dataKey={x} tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval={data.length <= 6 ? 0 : 'preserveStartEnd'} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={58} tickFormatter={(v) => axis(fmt, Number(v))} />
          <Tooltip cursor={{ fill: 'var(--hover)' }} content={<Tip fmt={fmt} series={series} />} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} stackId={stacked ? 'a' : undefined} fill={s.color} stroke="var(--surface)" strokeWidth={stacked ? 1 : 0}
              radius={!stacked || i === series.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={44} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

export function Lines({ data, x, series, fmt, height = 240, xLabel }: {
  data: Record<string, number | string | null>[];
  x: string;
  series: Series[];
  fmt: (v: number) => string;
  height?: number;
  xLabel?: (v: string) => string;
}) {
  return (
    <>
      <Legend series={series} />
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--line-soft)" />
          <XAxis dataKey={x} tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }} tickFormatter={xLabel} interval="preserveStartEnd" />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={58} tickFormatter={(v) => axis(fmt, Number(v))} />
          <Tooltip cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }}
            content={<Tip fmt={fmt} series={series} title={xLabel ? (l) => xLabel(l) : undefined} />} />
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: s.color }}
              activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

/** Opening → +/- steps → closing. Each step: label, signed value; first and last are totals. */
export function Waterfall({ steps, fmt, height = 260 }: { steps: { label: string; value: number; total?: boolean }[]; fmt: (v: number) => string; height?: number }) {
  let run = 0;
  const data = steps.map((s) => {
    if (s.total) {
      run = s.value;
      return { label: s.label, base: 0, up: s.value, down: 0, value: s.value, kind: 'total' };
    }
    const start = run;
    run += s.value;
    return { label: s.label, base: Math.min(start, run), up: s.value >= 0 ? s.value : 0, down: s.value < 0 ? -s.value : 0, value: s.value, kind: s.value >= 0 ? 'up' : 'down' };
  });
  const color = (k: string) => (k === 'total' ? 'var(--ld-seq-5)' : k === 'up' ? 'var(--good)' : 'var(--bad)');
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line-soft)" />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval={0} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => axis(fmt, Number(v))} />
        <Tooltip cursor={{ fill: 'var(--hover)' }} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const d = payload[0].payload as (typeof data)[number];
          return <div className="ld-chart-tip"><b>{d.label}</b><div>{d.kind === 'total' ? fmt(d.value) : `${d.value >= 0 ? '+' : '−'}${fmt(Math.abs(d.value))}`}</div></div>;
        }} />
        <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="up" stackId="w" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={color(d.kind)} />)}
        </Bar>
        <Bar dataKey="down" stackId="w" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={color(d.kind)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Sequential blue cell shade for heat tables (0..1). */
export function heat(t: number): { background: string; color: string } {
  if (!isFinite(t) || t <= 0) return { background: 'transparent', color: 'var(--muted)' };
  const step = Math.min(6, Math.max(1, Math.ceil(t * 6)));
  return { background: `var(--ld-seq-${step})`, color: step >= 4 ? '#fff' : 'var(--text)' };
}

/** Donut with the total in the middle; legend with counts and shares beside it (identity never by colour alone). */
export function Donut({ data, fmt, center, height = 200 }: {
  data: { label: string; value: number; color: string }[];
  fmt: (v: number) => string;
  center?: ReactNode;
  height?: number;
}) {
  const shown = data.filter((d) => d.value > 0);
  const total = shown.reduce((s, d) => s + d.value, 0);
  if (!total) return <div className="ld-empty-s">Nothing to show for these filters.</div>;
  return (
    <div className="ld-donut">
      <div className="ld-donut-c" style={{ height }}>
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie data={shown} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="92%" paddingAngle={1.5} stroke="var(--surface)"
              strokeWidth={2} isAnimationActive={false}>
              {shown.map((d) => <Cell key={d.label} fill={d.color} />)}
            </Pie>
            <Tooltip content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as { label: string; value: number; color: string };
              return <div className="ld-chart-tip"><div className="r"><span><i style={{ background: d.color }} />{d.label}</span><b>{fmt(d.value)}</b></div><div className="ld-muted">{((100 * d.value) / total).toFixed(1)}% of {fmt(total)}</div></div>;
            }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="ld-donut-mid">{center ?? <><b>{fmt(total)}</b><span>total</span></>}</div>
      </div>
      <ul className="ld-donut-l">
        {shown.map((d) => (
          <li key={d.label}><i style={{ background: d.color }} /><span>{d.label}</span><b>{fmt(d.value)}</b><em>{((100 * d.value) / total).toFixed(0)}%</em></li>
        ))}
      </ul>
    </div>
  );
}

/** Ranked horizontal bars: label, bar, value (and an optional note), one row each. */
export function HBars({ rows, fmt, max }: {
  rows: { label: ReactNode; value: number; color?: string; note?: ReactNode; key?: string }[];
  fmt: (v: number) => string;
  max?: number;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="ld-empty-s">Nothing to show for these filters.</div>;
  return (
    <ul className="ld-hbars">
      {rows.map((r, i) => (
        <li key={r.key ?? i}>
          <span className="l">{r.label}</span>
          <span className="b"><span style={{ width: `${Math.max(1.5, (100 * r.value) / top)}%`, background: r.color ?? 'var(--ld-seq-4)' }} /></span>
          <span className="v">{fmt(r.value)}{r.note ? <em>{r.note}</em> : null}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tiny trend line for a KPI tile (no axes): the last point is marked. */
export function Sparkline({ values, color = 'var(--brand)', height = 30 }: { values: number[]; color?: string; height?: number }) {
  const v = values.filter((x) => isFinite(x));
  if (v.length < 2) return null;
  const w = 120;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const y = (x: number) => (hi === lo ? height / 2 : height - 3 - ((x - lo) / (hi - lo)) * (height - 6));
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * (w - 6) + 3).toFixed(1)},${y(x).toFixed(1)}`);
  const last = pts[pts.length - 1].split(',');
  return (
    <svg className="ld-spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={`3,${height} ${pts.join(' ')} ${w - 3},${height}`} fill={color} opacity={0.12} stroke="none" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />
    </svg>
  );
}
