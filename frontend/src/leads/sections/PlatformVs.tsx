// Meta vs Google: budget against actual spend, leads, CPL, CTR, CPC and ROAS of the two platforms side by side, as paired bars
// (each metric scaled on its own). The figures are the combined platform rows of gt.ts, so they match the Overview cards and
// the campaign table exactly.
import { useMemo } from 'react';
import { HelpTip } from '@/components/HelpTip';
import { cpcOf, cplOf, ctrOf, gtSummary, roasOf, type GtLine, type Plat } from '../gt';
import type { BudgetPayload } from '../types';
import { Card, inr, num, useLeads } from '../ui';

interface Metric { label: string; get: (l: GtLine) => number | null; fmt: (v: number) => string; better?: 'up' | 'down'; info: string }
const METRICS: Metric[] = [
  { label: 'Leads', get: (l) => l.leads, fmt: (v) => num(Math.round(v)), better: 'up', info: 'Leads each platform reports for the campaigns.' },
  { label: 'CPL', get: (l) => cplOf(l), fmt: (v) => `₹${v.toFixed(0)}`, better: 'down', info: 'Spend ÷ leads (N/A when there are no leads).' },
  { label: 'CTR', get: (l) => ctrOf(l), fmt: (v) => `${v.toFixed(2)}%`, better: 'up', info: 'Clicks ÷ impressions × 100.' },
  { label: 'CPC', get: (l) => cpcOf(l), fmt: (v) => `₹${v.toFixed(2)}`, better: 'down', info: 'Spend ÷ clicks.' },
  { label: 'ROAS', get: (l) => roasOf(l), fmt: (v) => `${v.toFixed(2)}×`, better: 'up', info: 'BO sales from the retailers the platform’s leads brought in or back ÷ spend. Blank when the period has no BO sales data yet.' },
];
const COLOR: Record<Plat, string> = { Meta: 'var(--ld-src-meta)', Google: 'var(--ld-src-google)' };

export default function PlatformVs({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg } = useLeads();
  const s = useMemo(() => gtSummary(budget, M, f, rg), [budget, M, f, rg]);
  const plats = (['Meta', 'Google'] as const).filter((p) => s.platforms[p]);
  const maxMoney = Math.max(1, ...plats.flatMap((p) => [s.platforms[p]!.budget ?? 0, s.platforms[p]!.spend]));
  const bar = (v: number, max: number, color: string, faded = false) => (
    <span className="ld-vs-track"><span className={`ld-vs-bar${faded ? ' faded' : ''}`} style={{ width: `${Math.max(2, (100 * v) / Math.max(max, 1e-9))}%`, background: color }} /></span>
  );
  return (
    <Card title="Meta vs Google" uses={['period', 'source', 'campaign']}
      info={{ what: 'The two platforms side by side for the period: budget against what was actually spent, the leads each generated, and what they cost. Each metric has its own scale; the better platform of each metric is in bold.',
        formula: 'CPL = spend ÷ leads · CTR = clicks ÷ impressions × 100 · CPC = spend ÷ clicks · ROAS = attributed BO sales ÷ spend' }}
      csv={{ name: 'meta_vs_google', rows: () => [{ Metric: 'Budget', ...Object.fromEntries(plats.map((p) => [p, s.platforms[p]!.budget ?? ''])) },
        { Metric: 'Spend', ...Object.fromEntries(plats.map((p) => [p, Math.round(s.platforms[p]!.spend)])) },
        ...METRICS.map((m) => ({ Metric: m.label, ...Object.fromEntries(plats.map((p) => [p, m.get(s.platforms[p]!)?.toFixed(2) ?? ''])) }))] }}>
      {!plats.length ? <div className="ld-empty-s">No campaign data saved yet for these filters.</div> : (
        <div className="ld-vs">
          <div className="ld-vs-h">Budget vs actual spend <HelpTip text="Light bar = budget for the period; solid bar = actual spend. Budget = daily budget × the days the campaigns actually spent in the period." /></div>
          {plats.map((p) => {
            const l = s.platforms[p]!;
            return (
              <div key={`b${p}`} className="ld-vs-row">
                <span className="ld-vs-l"><i className="ld-dot" style={{ background: COLOR[p] }} />{p}</span>
                <span className="ld-vs-pair">{bar(l.budget ?? 0, maxMoney, COLOR[p], true)}{bar(l.spend, maxMoney, COLOR[p])}</span>
                <span className="ld-vs-v">{inr(l.spend)}<em> of {l.budget ? inr(l.budget) : '—'}{l.budget ? ` · ${((100 * l.spend) / l.budget).toFixed(0)}%` : ''}</em></span>
              </div>
            );
          })}
          {METRICS.map((m) => {
            const vals = plats.map((p) => m.get(s.platforms[p]!));
            const ok = vals.filter((v): v is number => v !== null);
            const max = Math.max(...ok, 0);
            const top = ok.length > 1 && m.better ? (m.better === 'up' ? Math.max(...ok) : Math.min(...ok)) : null;
            return (
              <div key={m.label}>
                <div className="ld-vs-h">{m.label} <HelpTip text={m.info} /></div>
                {plats.map((p, j) => (
                  <div key={p} className="ld-vs-row">
                    <span className="ld-vs-l"><i className="ld-dot" style={{ background: COLOR[p] }} />{p}</span>
                    {vals[j] === null ? <span className="ld-vs-track" /> : bar(vals[j]!, max, COLOR[p])}
                    <span className="ld-vs-v">{vals[j] === null ? (m.label === 'CPL' ? 'N/A' : '—') : top !== null && vals[j] === top ? <b>{m.fmt(vals[j]!)}</b> : m.fmt(vals[j]!)}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
