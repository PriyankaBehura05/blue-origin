import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Card, Section, STROKE, inr, num, useLeads } from '../ui';
import { StackedBars } from '../charts';
import { SECTIONS, SOURCE_COLORS } from '../sections';
import { leadAgg, monthName, NEW, quarterName, retailerOk, spendIn } from '../model';
import { earlyQuality, newPerMonth, runRate } from '../calc';

interface Knobs { budget: number; cpl: number; conv: number; aov: number; ret: number; margin: number }

function Slider({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt: (v: number) => string }) {
  return (
    <label className="ld-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(value)}</span>
    </label>
  );
}

export default function Forecast() {
  const { M, f } = useLeads();
  const rr = useMemo(() => runRate(M, f), [M, f]);
  const t = M.p.targets;

  const monthly = useMemo(() => {
    const { all, mkt } = newPerMonth(M, f);
    const from = Math.max(0, M.p.salesEnd - 11);
    return Array.from({ length: M.p.salesEnd - from + 1 }, (_, j) => {
      const m = from + j;
      return { month: monthName(M, m), organic: all[m] - mkt[m], marketing: mkt[m] };
    });
  }, [M, f]);

  // defaults observed in the data (last quarter with sales), placeholders when there is nothing to observe
  const observed = useMemo(() => {
    const ms = M.qMonths[M.latestQuarter];
    const rg: [number, number] = [ms[0], ms[ms.length - 1]];
    const spend = spendIn(M, rg);
    const la = leadAgg(M, { ...f, period: 'all' }, null);
    let rev = 0, months = 0, n = 0, m1 = 0;
    for (let r = 0; r < M.nR; r++) {
      const first = M.p.retailers.first[r];
      if (first < M.p.salesEnd - 9 || !retailerOk(M, f, r, M.p.salesEnd)) continue;
      const q = earlyQuality(M, r);
      if (!q) continue;
      rev += q.rev90;
      months += q.months90;
      n++;
      if (q.m1) m1++;
    }
    const leadsQ = leadAgg(M, f, rg).rows;
    return {
      budget: spend || 500000, budgetObserved: spend > 0,
      cpl: spend && leadsQ ? spend / leadsQ : 250, cplObserved: !!(spend && leadsQ),
      conv: la.judged ? (100 * la.out[NEW]) / la.judged : t.conversion_pct, convObserved: la.judged > 0,
      aov: months ? rev / months : 20000, aovObserved: months > 0,
      ret: n ? (100 * m1) / n : t.retention_pct, retObserved: n > 0,
    };
  }, [M, f, t]);

  const init: Knobs = { budget: Math.round(observed.budget), cpl: Math.round(observed.cpl), conv: +observed.conv.toFixed(1), aov: Math.round(observed.aov), ret: +observed.ret.toFixed(0), margin: t.gross_margin_pct ?? 30 };
  const [k, setK] = useState<Knobs | null>(null);
  const v = k ?? init;
  const set = (patch: Partial<Knobs>) => setK({ ...v, ...patch });

  const leads = v.cpl ? v.budget / v.cpl : 0;
  const fresh = (leads * v.conv) / 100;
  const r = v.ret / 100;
  const revQ = fresh * v.aov * (1 + r);
  const rev6 = fresh * v.aov * (1 + 5 * r);
  const roi = v.budget ? (rev6 * (v.margin / 100) - v.budget) / v.budget : 0;
  const nq = quarterName(rr.quarter);

  return (
    <Section def={SECTIONS[9]} n={10}>
      <div className="ld-grid">
        <Card title="Run-rate and next quarter" uses={['source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          info={{ what: 'New retailers per month (first-ever bill) for the last 12 months with sales, split by source. Projection = average of the last 3 months × 3.', formula: 'Σ new retailers (last 3 months) ÷ 3 × 3', source: 'retailer_month.csv' }}
          csv={{ name: 'new_retailers_per_month', rows: () => monthly.map((m) => ({ Month: m.month, Organic: m.organic, Marketing: m.marketing })) }}
          soWhat={<>At current pace {nq} adds <b>{num(rr.projected)}</b> retailers vs target <b>{num(t.new_retailers_quarter)}</b> ({rr.projected >= t.new_retailers_quarter ? 'on track' : `${num(t.new_retailers_quarter - rr.projected)} short`}).</>}>
          <StackedBars data={monthly} x="month" fmt={num} series={[{ key: 'organic', label: 'Organic', color: SOURCE_COLORS[5] }, { key: 'marketing', label: 'Marketing', color: SOURCE_COLORS[0] }].filter((s) => monthly.some((m) => (m as Record<string, number | string>)[s.key] as number > 0))} />
        </Card>
        <Card title={`What-if: paid lead gen in ${nq}`} uses={['source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          actions={<button type="button" className="ld-btn" onClick={() => setK(null)} title="Back to the observed values"><RotateCcw size={14} strokeWidth={STROKE} />Reset</button>}
          info={{ what: 'Move the sliders to see next quarter\'s outcome. Starting values come from the data where it exists (marked "observed"), else from targets / placeholders.',
            formula: 'leads = budget ÷ CPL; new retailers = leads × conversion; quarter revenue = new × AOV × (1 + retention); 6-month revenue = new × AOV × (1 + 5 × retention); 6-month ROI = (6-month revenue × margin − budget) ÷ budget',
            source: 'Spend sheet, lead outcomes, retailer_month.csv' }}>
          <Slider label={`Budget${observed.budgetObserved ? ' (observed)' : ''}`} value={v.budget} min={0} max={Math.max(5000000, v.budget * 2)} step={10000} onChange={(x) => set({ budget: x })} fmt={inr} />
          <Slider label={`Cost per lead${observed.cplObserved ? ' (observed)' : ''}`} value={v.cpl} min={10} max={Math.max(2000, v.cpl * 2)} step={10} onChange={(x) => set({ cpl: x })} fmt={inr} />
          <Slider label={`Conversion %${observed.convObserved ? ' (observed)' : ' (target)'}`} value={v.conv} min={0} max={30} step={0.1} onChange={(x) => set({ conv: x })} fmt={(x) => `${x.toFixed(1)}%`} />
          <Slider label={`AOV / billing month${observed.aovObserved ? ' (observed)' : ''}`} value={v.aov} min={1000} max={Math.max(200000, v.aov * 2)} step={500} onChange={(x) => set({ aov: x })} fmt={inr} />
          <Slider label={`Monthly retention %${observed.retObserved ? ' (observed M1)' : ' (target)'}`} value={v.ret} min={0} max={100} step={1} onChange={(x) => set({ ret: x })} fmt={(x) => `${x.toFixed(0)}%`} />
          <Slider label="Gross margin %" value={v.margin} min={5} max={60} step={1} onChange={(x) => set({ margin: x })} fmt={(x) => `${x.toFixed(0)}%`} />
          <div className="ld-out">
            <div><div className="v">{num(leads)}</div><div className="l">Leads</div></div>
            <div><div className="v">{num(fresh)}</div><div className="l">New retailers</div></div>
            <div><div className="v">{fresh ? inr(v.budget / fresh) : '—'}</div><div className="l">Cost per new retailer</div></div>
            <div><div className="v">{inr(revQ)}</div><div className="l">Revenue in {nq.split(' (')[0]}</div></div>
            <div><div className="v">{inr(rev6)}</div><div className="l">6-month revenue</div></div>
            <div><div className="v" style={{ color: roi >= 0 ? 'var(--good-ink)' : 'var(--bad-ink)' }}>{(100 * roi).toFixed(0)}%</div><div className="l">6-month ROI (on margin)</div></div>
          </div>
          {!M.p.hasLeads && <div className="ld-note">No leads loaded: conversion and cost per lead are placeholders, so treat the outputs as illustration only.</div>}
        </Card>
      </div>
    </Section>
  );
}
