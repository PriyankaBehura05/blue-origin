// The lead dashboard's shared state: the model and the global filters. Kept in its own small file so that live reload while
// editing the UI building blocks (ui.tsx) never creates a second, empty context ("useLeads outside the lead dashboard").
import { createContext, useContext } from 'react';
import { prevPeriod, rangeOf, type Filters, type Model, type Range } from './model';

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
