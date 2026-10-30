import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TimeSeriesPoint } from '@/types';
import { formatINR } from '@/utils/format';
import { CHART_COLORS } from '@/utils/tiers';

const inrTick = (v: number) => formatINR(v, true).replace('₹', '');

export function TrendChart({ data, valueLabel = 'Net sales' }: { data: TimeSeriesPoint[]; valueLabel?: string }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} angle={data.length > 8 ? -35 : 0}
          textAnchor={data.length > 8 ? 'end' : 'middle'} height={data.length > 8 ? 48 : 30} />
        <YAxis tickFormatter={inrTick} tick={{ fontSize: 12 }} width={56} />
        <Tooltip formatter={(v: number) => formatINR(v)} />
        <Legend />
        <Line type="monotone" dataKey="value" name={valueLabel} stroke={CHART_COLORS[0]} strokeWidth={2.5} dot={false} />
        {data.some((d) => d.target != null) && (
          <Line type="monotone" dataKey="target" name="Target" stroke="#94a3b8" strokeDasharray="5 5" strokeWidth={2} dot={false} connectNulls />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
