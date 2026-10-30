// Shared state of the dashboard pages: the consolidated data (loaded once, kept between page visits),
// the filters (remembered per browser) and the retailer detail panel.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/services';
import { buildModel, MOVES } from './model';
import type { Filters, Model } from './types';

export const DEFAULT_FILTERS: Filters = { region: '', state: '', dist: '', q: -1, tier: '', m: -1, near: 20, mv: '' };
const FILTER_KEY = 'bo_network_filters';

// The quarter is remembered by its key ('Q2_FY27'), not its position, so it survives a change in the quarter list.
let savedQuarterKey: string | undefined;

function readFilters(): Filters {
  try {
    const { qKey, ...saved } = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    savedQuarterKey = typeof qKey === 'string' ? qKey : undefined;
    return { ...DEFAULT_FILTERS, ...saved, m: -1 };
  } catch {
    return DEFAULT_FILTERS;
  }
}

/** Filters that fit the loaded data: an unknown quarter, month, region, state, distributor or tier is reset.
 *  Applied before every render, so a stale remembered filter can never break a page. */
export function fitFilters(model: Model, cur: Filters, quarterKey?: string): Filters {
  const next = { ...cur };
  if (quarterKey !== undefined) next.q = quarterKey ? model.Q.indexOf(quarterKey) : -1;
  if (!Number.isInteger(next.q) || next.q < -1 || next.q >= model.Q.length) next.q = -1;
  if (!Number.isInteger(next.m) || next.m < 1 || next.m >= model.M.length) next.m = model.M.length - 1;
  const D = model.p.distributors;
  if (next.region && !model.p.regions.includes(next.region)) Object.assign(next, { region: '', state: '', dist: '' });
  if (next.state && !D.some((d) => d.s === next.state && (!next.region || d.r === next.region))) Object.assign(next, { state: '', dist: '' });
  if (next.dist && !D.some((d) => d.n === next.dist)) next.dist = '';
  if (next.tier && next.tier !== 'tiered' && !model.TIERS.includes(next.tier)) next.tier = '';
  if (!Number.isFinite(next.near) || next.near < 1 || next.near > 60) next.near = DEFAULT_FILTERS.near;
  if (typeof next.mv !== 'string' || (next.mv && !(MOVES as readonly string[]).includes(next.mv))) next.mv = '';
  const same = (Object.keys(next) as (keyof Filters)[]).every((k) => next[k] === cur[k]);
  return same ? cur : next;
}

let cachedModel: Model | null = null; // survives leaving and re-opening the dashboard

interface NetworkState {
  model: Model | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  f: Filters;
  setF: (p: Partial<Filters>) => void;
  clearFilters: () => void;
  selected: string | null;
  select: (id: string | null) => void;
  search: string;
  setSearch: (s: string) => void;
  toast: string | null;
  flash: (msg: string) => void;
}

const Ctx = createContext<NetworkState | null>(null);

export function useNetwork(): NetworkState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNetwork must be used inside <NetworkProvider>');
  return v;
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [model, setModel] = useState<Model | null>(cachedModel);
  const [loading, setLoading] = useState(!cachedModel);
  const [error, setError] = useState<string | null>(null);
  const [f, setFilters] = useState<Filters>(readFilters);
  const [selected, select] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const m = buildModel(await api.getNetworkData());
      cachedModel = m;
      setModel(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!cachedModel) load();
  }, [load]);

  // keep the stored filters valid for the loaded data (the remembered quarter is matched by its key once)
  useEffect(() => {
    if (!model) return;
    const key = savedQuarterKey;
    savedQuarterKey = undefined;
    setFilters((cur) => fitFilters(model, cur, key));
  }, [model]);
  // pages always get filters that fit the data, also on the render before the effect above has run
  const fit = useMemo(() => (model ? fitFilters(model, f, savedQuarterKey) : f), [model, f]);

  useEffect(() => {
    if (!model) return; // nothing to save before the data (and so the quarter keys) is loaded
    try {
      const qKey = fit.q >= 0 ? model.Q[fit.q] : '';
      localStorage.setItem(FILTER_KEY, JSON.stringify({ ...fit, q: undefined, m: undefined, qKey })); // the month is not kept
    } catch {
      /* filters are not remembered */
    }
  }, [fit, model]);

  const setF = useCallback((p: Partial<Filters>) => setFilters((cur) => ({ ...cur, ...p })), []);
  const clearFilters = useCallback(() => setFilters((cur) => ({ ...DEFAULT_FILTERS, m: cur.m, near: cur.near })), []);

  const value = useMemo<NetworkState>(() => ({
    model, loading, error, reload: load, f: fit, setF, clearFilters, selected, select, search, setSearch,
    toast, flash,
  }), [model, loading, error, load, fit, setF, clearFilters, selected, search, toast, flash]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
