import { useState, type FormEvent } from 'react';
import { Drawer } from '@/components/ui';

interface Opt { value: string; label: string }

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'email' | 'password';
  options?: (string | Opt)[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

export type FormValues = Record<string, string>;

interface Props {
  title: string;
  fields: FieldDef[];
  initial: FormValues;
  onSubmit: (values: FormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}

// Generic create / edit drawer. Values are kept as strings; callers convert on submit.
export function RecordForm({ title, fields, initial, onSubmit, onDelete, onClose }: Props) {
  const [values, setValues] = useState<FormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => onSubmit(values));
  };

  return (
    <Drawer title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          {fields.map((f) => (
            <label key={f.name} className={`field ${f.type === 'textarea' ? 'wide' : ''}`}>
              <span>{f.label}{f.required && <em> *</em>}</span>
              {f.type === 'select' ? (
                <select className="select" value={values[f.name] ?? ''} required={f.required} onChange={(e) => set(f.name, e.target.value)}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => {
                    const opt = typeof o === 'string' ? { value: o, label: o } : o;
                    return <option key={opt.value} value={opt.value}>{opt.label}</option>;
                  })}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea className="input" rows={3} value={values[f.name] ?? ''} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <input
                  className="input"
                  type={f.type ?? 'text'}
                  step={f.type === 'number' ? 'any' : undefined}
                  min={f.type === 'number' ? 0 : undefined}
                  value={values[f.name] ?? ''}
                  required={f.required}
                  placeholder={f.placeholder}
                  autoComplete={f.type === 'password' ? 'new-password' : undefined}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              )}
              {f.hint && <small className="note">{f.hint}</small>}
            </label>
          ))}
        </div>
        {error && <div className="alert error-alert">{error}</div>}
        <div className="form-actions">
          {onDelete && (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => window.confirm('Delete this record? This cannot be undone.') && void run(onDelete)}
            >
              Delete
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Drawer>
  );
}

// Helpers for converting form strings to API values
export const num = (v: string | undefined, fallback = 0) => (v === undefined || v.trim() === '' ? fallback : Number(v));
export const optNum = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : Number(v));
export const optStr = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : v.trim());
export const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
