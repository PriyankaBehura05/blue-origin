// Shared state of the dashboard pages: the consolidated data (loaded once, kept between page visits),
// the filters (remembered per browser) and the retailer detail panel.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/services';
import { buildModel, MOVES } from './model';
import type { Filters, Model } from './types';

export const DEFAULT_FILTERS: Filters = { region: '', state: '', dist: '', q: -1, qs: [], tier: [], m: -1, near: 20, mv: [] };
const FILTER_KEY = 'bo_network_filters';

// The quarters are remembered by their keys ('Q2_FY27'), not their positions, so they survive a change in the quarter list.
// (Older saves hold one quarter as `qKey`.)
let savedQuarterKeys: string[] | undefined;

function readFilters(): Filters {
  try {
    const { qKey, qKeys, ...saved } = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    savedQuarterKeys = Array.isArray(qKeys) ? qKeys.filter((k: unknown) => typeof k === 'string') : typeof qKey === 'string' ? (qKey ? [qKey] : []) : undefined;
    return { ...DEFAULT_FILTERS, ...saved, q: -1, qs: [], m: -1 };
  } catch {
    return DEFAULT_FILTERS;
  }
}

/** Filters that fit the loaded data: an unknown quarter, month, region, state, distributor or tier is reset.
 *  Applied before every render, so a stale remembered filter can never break a page. */
export function fitFilters(model: Model, cur: Filters, quarterKeys?: string[]): Filters {
  const next = { ...cur };
  // the selected quarters: valid, unique, oldest first; every quarter selected = all quarters. q follows: the latest selected, or -1
  let qs = quarterKeys !== undefined ? quarterKeys.map((k) => model.Q.indexOf(k)) : Array.isArray(cur.qs) ? cur.qs : cur.q >= 0 ? [cur.q] : [];
  qs = [...new Set(qs.filter((i) => Number.isInteger(i) && i >= 0 && i < model.Q.length))].sort((a, b) => a - b);
  if (qs.length === model.Q.length && qs.length > 1) qs = [];
  next.qs = Array.isArray(cur.qs) && cur.qs.join() === qs.join() ? cur.qs : qs;
  next.q = qs.length ? qs[qs.length - 1] : -1;
  if (!Number.isInteger(next.m) || next.m < 1 || next.m >= model.M.length) next.m = model.M.length - 1;
  const D = model.p.distributors;
  if (next.region && !model.p.regions.includes(next.region)) Object.assign(next, { region: '', state: '', dist: '' });
  if (next.state && !D.some((d) => d.s === next.state && (!next.region || d.r === next.region))) Object.assign(next, { state: '', dist: '' });
  if (next.dist && !D.some((d) => d.n === next.dist)) next.dist = '';
  // tiers: known ones only, 'Any tier' first then highest tier first (an older save holds one tier as a string)
  const tierIn: unknown[] = Array.isArray(cur.tier) ? cur.tier : typeof cur.tier === 'string' && cur.tier ? [cur.tier] : [];
  const tiers = ['tiered', ...[...model.TIERS].reverse()].filter((t) => tierIn.includes(t));
  next.tier = Array.isArray(cur.tier) && cur.tier.join('|') === tiers.join('|') ? cur.tier : tiers;
  if (!Number.isFinite(next.near) || next.near < 1 || next.near > 60) next.near = DEFAULT_FILTERS.near;
  // movement categories: known ones only, in the MOVES order (an older save holds one category as a string)
  const mvIn: unknown[] = Array.isArray(cur.mv) ? cur.mv : typeof cur.mv === 'string' && cur.mv ? [cur.mv] : [];
  const mv = MOVES.filter((k) => mvIn.includes(k));
  next.mv = Array.isArray(cur.mv) && cur.mv.join('|') === mv.join('|') ? cur.mv : mv.length === MOVES.length ? [] : mv;
  const same = (Object.keys(next) as (keyof Filters)[]).every((k) => next[k] === cur[k]) && 'qs' in cur;
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
    const keys = savedQuarterKeys;
    savedQuarterKeys = undefined;
    setFilters((cur) => fitFilters(model, cur, keys));
  }, [model]);
  // pages always get filters that fit the data, also on the render before the effect above has run
  const fit = useMemo(() => (model ? fitFilters(model, f, savedQuarterKeys) : f), [model, f]);

  useEffect(() => {
    if (!model) return; // nothing to save before the data (and so the quarter keys) is loaded
    try {
      const qKeys = fit.qs.map((i) => model.Q[i]);
      localStorage.setItem(FILTER_KEY, JSON.stringify({ ...fit, q: undefined, qs: undefined, m: undefined, qKeys })); // the month is not kept
    } catch {
      /* filters are not remembered */
    }
  }, [fit, model]);

  // setting `q` alone picks just that quarter (-1 = all); `qs` sets several (q then follows in fitFilters)
  const setF = useCallback((p: Partial<Filters>) => setFilters((cur) => {
    const next = { ...cur, ...p };
    if (p.q !== undefined && p.qs === undefined) next.qs = p.q >= 0 ? [p.q] : [];
    if (p.qs !== undefined && p.q === undefined) next.q = p.qs.length ? Math.max(...p.qs) : -1;
    return next;
  }), []);
  const clearFilters = useCallback(() => setFilters((cur) => ({ ...DEFAULT_FILTERS, m: cur.m, near: cur.near })), []);

  const value = useMemo<NetworkState>(() => ({
    model, loading, error, reload: load, f: fit, setF, clearFilters, selected, select, search, setSearch,
    toast, flash,
  }), [model, loading, error, load, fit, setF, clearFilters, selected, search, toast, flash]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
