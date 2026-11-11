// Building blocks of the lead dashboard: cards, KPI tiles, percentages with their fraction and CI, tables with CSV
// export, icon toggles, breadcrumbs. Icons: lucide line icons, one stroke weight, coloured only for status.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ChevronRight, Download, FilterX, type LucideIcon } from 'lucide-react';
import { HelpTip } from '@/components/HelpTip';
import { Sparkline } from './charts';
import { formatINR, formatNumber } from '@/utils/format';
import {
  activeFilters, FILTER_LABELS, prevPeriod, rangeOf, wilson, SMALL_SAMPLE,
  type FilterKey, type Filters, type Model, type Rag, type Range,
} from './model';

export const STROKE = 1.75;

// ---- context: the model and the global filters ---------------------------------------------------------------------
export interface Ctx {
  M: Model;
  f: Filters;
  set: (patch: Partial<Filters>) => void;
  rg: Range;
  prev: Range | null;
  canEdit: boolean;
}
export const LeadsCtx = createContext<Ctx | null>(null);
export function useLeads(): Ctx {
  const c = useContext(LeadsCtx);
  if (!c) throw new Error('useLeads outside the lead dashboard');
  return c;
}
export function makeCtx(M: Model, f: Filters, set: Ctx['set'], canEdit: boolean): Ctx {
  const p = prevPeriod(M, f.period);
  return { M, f, set, rg: rangeOf(M, f.period), prev: p ? rangeOf(M, p) : null, canEdit };
}

// ---- formatting ----------------------------------------------------------------------------------------------------
export const num = (n: number) => formatNumber(n);
export const inr = (n: number) => formatINR(n, true);
export const pctTxt = (k: number, n: number, d = 1) => (n > 0 ? `${((100 * k) / n).toFixed(d)}%` : '—');

/** A percentage whose hover shows numerator ÷ denominator and the 95% CI. */
export function Pct({ k, n, digits = 1, ci = true, label }: { k: number; n: number; digits?: number; ci?: boolean; label?: string }) {
  if (n <= 0) return <span className="ld-muted">—</span>;
  const [lo, hi] = wilson(k, n);
  const tip = (
    <div>
      {label && <div className="ld-tip-h">{label}</div>}
      <div>{num(k)} ÷ {num(n)} = {((100 * k) / n).toFixed(2)}%</div>
      {ci && <div>Likely range {(100 * lo).toFixed(1)}% – {(100 * hi).toFixed(1)}%</div>}
      {n < SMALL_SAMPLE && <div className="ld-warn-t">Only {n} — too few to be sure</div>}
    </div>
  );
  return (
    <HelpTip text={tip}>
      <span className={`ld-pct${n < SMALL_SAMPLE ? ' small' : ''}`}>{((100 * k) / n).toFixed(digits)}%</span>
    </HelpTip>
  );
}

export function RagDot({ rag, title }: { rag: Rag; title?: string }) {
  const word = { green: 'On target', amber: 'Close to target', red: 'Off target', none: 'No target' }[rag];
  return <span className={`ld-rag ${rag}`} role="img" aria-label={title ?? word} title={title ?? word} />;
}

export function Delta({ cur, prev, lowerIsBetter = false, asPoints = false }: { cur: number | null; prev: number | null; lowerIsBetter?: boolean; asPoints?: boolean }) {
  if (cur === null || prev === null || !isFinite(cur) || !isFinite(prev)) return <span className="ld-delta none">no earlier period to compare</span>;
  const diff = asPoints ? cur - prev : prev === 0 ? (cur === 0 ? 0 : Infinity) : (100 * (cur - prev)) / Math.abs(prev);
  const up = diff > 0.05;
  const down = diff < -0.05;
  const good = lowerIsBetter ? down : up;
  const bad = lowerIsBetter ? up : down;
  const Icon = up ? ArrowUp : down ? ArrowDown : ArrowRight;
  const txt = !isFinite(diff) ? 'new' : asPoints ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)} pts` : `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%`;
  return (
    <span className={`ld-delta ${good ? 'good' : bad ? 'bad' : 'flat'}`}>
      <Icon size={13} strokeWidth={2} aria-hidden /> {txt} <span className="ld-muted">vs last period</span>
    </span>
  );
}

// ---- KPI tile ------------------------------------------------------------------------------------------------------
export interface KpiProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  rag: Rag;
  ragNote?: string;
  delta?: ReactNode;
  info: ReactNode;
  spark?: number[]; // month-by-month trend shown under the number
}
export function Kpi({ icon: Icon, label, value, sub, rag, ragNote, delta, info, spark }: KpiProps) {
  return (
    <div className={`ld-kpi rag-${rag}`}>
      <div className="ld-kpi-h">
        <span className="ld-kpi-ico"><Icon size={16} strokeWidth={STROKE} aria-hidden /></span>
        <span className="ld-kpi-l">{label}</span>
        <RagDot rag={rag} title={ragNote} />
        <span className="ld-kpi-i"><HelpTip text={info} /></span>
      </div>
      <div className="ld-kpi-v">{value}</div>
      {sub && <div className="ld-kpi-sub">{sub}</div>}
      {spark && <Sparkline values={spark} />}
      {delta && <div className="ld-kpi-d">{delta}</div>}
    </div>
  );
}

// ---- card ----------------------------------------------------------------------------------------------------------
export interface Info {
  what: ReactNode; // definition
  formula?: ReactNode; // numerator ÷ denominator
  source?: ReactNode;
}
export function InfoText({ info }: { info: Info }) {
  return (
    <div className="ld-info">
      <div>{info.what}</div>
      {info.formula && <div><b>Calculation:</b> {info.formula}</div>}
      {info.source && <div className="ld-muted"><b>Source:</b> {info.source}</div>}
    </div>
  );
}

/** A card. `uses` lists the global filters it responds to; an active filter outside it shows the "not applied" icon. */
export function Card({ title, info, uses, children, actions, csv, wide, soWhat }: {
  title: string;
  info: Info;
  uses: FilterKey[];
  children: ReactNode;
  actions?: ReactNode;
  csv?: { name: string; rows: () => Record<string, unknown>[] };
  wide?: boolean;
  soWhat?: ReactNode;
}) {
  const { f } = useLeads();
  const ignored = activeFilters(f).filter((k) => !uses.includes(k));
  return (
    <section className={`ld-card${wide ? ' wide' : ''}`}>
      <header className="ld-card-h">
        <h3>{title}</h3>
        <HelpTip text={<InfoText info={info} />} />
        {ignored.length > 0 && (
          <HelpTip text={`Filter not applied here: ${ignored.map((k) => FILTER_LABELS[k]).join(', ')}`}>
            <span className="ld-notapplied" aria-label="Filter not applied"><FilterX size={14} strokeWidth={STROKE} /></span>
          </HelpTip>
        )}
        <div className="ld-card-actions">
          {actions}
          {csv && <ExportBtn onClick={() => downloadCsv(csv.name, csv.rows())} />}
        </div>
      </header>
      <div className="ld-card-b">{children}</div>
      {soWhat && <footer className="ld-sowhat">{soWhat}</footer>}
    </section>
  );
}

export function ExportBtn({ onClick, label = 'Download CSV' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="ld-iconbtn" onClick={onClick} aria-label={label} title={label}>
      <Download size={15} strokeWidth={STROKE} />
    </button>
  );
}

export function downloadCsv(name: string, rows: Record<string, unknown>[]) {
  const cols = rows.length ? Object.keys(rows[0]) : ['(no rows)'];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.endsWith('.csv') ? name : `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- toggles, selects, breadcrumbs ---------------------------------------------------------------------------------
export function IconToggle<T extends string | number>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; icon: LucideIcon; label: string }[];
  label: string;
}) {
  return (
    <div className="ld-toggle" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} title={o.label}
          className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          <o.icon size={15} strokeWidth={STROKE} aria-hidden />
          <span className="ld-toggle-t">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function MiniSelect<T extends string | number>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <select className="ld-mini" aria-label={label} value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

export function Crumbs({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <nav className="ld-crumbs" aria-label="Drill-down">
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 && <ChevronRight size={13} strokeWidth={STROKE} aria-hidden />}
          {it.onClick && i < items.length - 1 ? <button type="button" onClick={it.onClick}>{it.label}</button> : <b>{it.label}</b>}
        </span>
      ))}
    </nav>
  );
}

// ---- table ---------------------------------------------------------------------------------------------------------
export interface Col<R> {
  key: string;
  label: ReactNode;
  render: (r: R) => ReactNode;
  sort?: (r: R) => number | string;
  num?: boolean;
  csv?: (r: R) => unknown;
}
export function Table<R>({ rows, cols, onRow, limit = 15, initialSort, empty = 'Nothing to show for these filters.' }: {
  rows: R[];
  cols: Col<R>[];
  onRow?: (r: R) => void;
  limit?: number;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  empty?: ReactNode;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [shown, setShown] = useState(limit);
  const sorted = useMemo(() => {
    const c = sort && cols.find((x) => x.key === sort.key);
    if (!c?.sort) return rows;
    const k = c.sort;
    return [...rows].sort((a, b) => {
      const x = k(a);
      const y = k(b);
      const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort!.dir === 'asc' ? d : -d;
    });
  }, [rows, cols, sort]);
  if (!rows.length) return <div className="ld-empty-s">{empty}</div>;
  return (
    <div className="ld-table-wrap">
      <table className="ld-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={c.num ? 'num' : ''} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                {c.sort ? (
                  <button type="button" onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
                    {c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, shown).map((r, i) => (
            <tr key={i} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(r) : undefined}>
              {cols.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > shown && (
        <button type="button" className="ld-more" onClick={() => setShown((s) => s + 50)}>
          Show more ({num(sorted.length - shown)} more)
        </button>
      )}
    </div>
  );
}

export const csvRows = <R,>(rows: R[], cols: Col<R>[]) =>
  rows.map((r) => Object.fromEntries(cols.map((c) => [typeof c.label === 'string' ? c.label : c.key, c.csv ? c.csv(r) : c.sort ? c.sort(r) : ''])));

/** Shown in place of a lead-driven card while no lead files are loaded. */
export function NeedsData({ what }: { what: 'leads' | 'spend' | 'followup' }) {
  const text = {
    leads: 'No leads yet. Link the lead Google Sheet on the Data & settings page.',
    spend: 'No ad spend yet. Add a sheet with campaign, month and amount to see cost per lead and cost per new retailer.',
    followup: 'No ASM follow-up yet. Add ASM NAME, Calling Done, Visit Done and Order Placed columns to the lead sheet.',
  }[what];
  return <div className="ld-needs">{text}</div>;
}

export function Bar({ value, max, tone = 'brand' }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0;
  return <span className="ld-inbar"><span className={`ld-inbar-f ${tone}`} style={{ width: `${w}%` }} /></span>;
}

// ---- section frame -------------------------------------------------------------------------------------------------
export function Section({ def, n, actions, children }: { def: { id: string; icon: LucideIcon; title: string; soWhat: string }; n: number; actions?: ReactNode; children: ReactNode }) {
  const Icon = def.icon;
  return (
    <section id={def.id} className="ld-sec" aria-labelledby={`${def.id}-h`}>
      <header className="ld-sec-h">
        <span className="ld-sec-ico"><Icon size={20} strokeWidth={STROKE} aria-hidden /></span>
        <div>
          <h2 id={`${def.id}-h`} data-n={n}>{def.title}</h2>
          <p>{def.soWhat}</p>
        </div>
        {actions && <div className="ld-sec-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
