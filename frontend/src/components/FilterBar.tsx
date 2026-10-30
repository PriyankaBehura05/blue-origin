import type { ReactNode } from 'react';

interface Opt { value: string; label: string }

export function SelectFilter({ label, value, options, onChange, emptyLabel = 'All' }: { label: string; value: string; options: (string | Opt)[]; onChange: (v: string) => void; emptyLabel?: string }) {
  return (
    <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}: {emptyLabel}</option>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return <option key={opt.value} value={opt.value}>{opt.label}</option>;
      })}
    </select>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="input search" type="search" value={value} placeholder={placeholder ?? 'Search…'} onChange={(e) => onChange(e.target.value)} />;
}

export function FilterBar({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return (
    <div className="card filter-bar">
      {children}
      {onReset && <button className="btn" onClick={onReset}>Reset</button>}
    </div>
  );
}
