import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListQuery } from '@/types';

interface Options extends Partial<ListQuery> {
  // When true, `ready` stays false until applyDefaults() is called (e.g. once the current quarter is known),
  // so the first request already carries the default filters.
  waitForDefaults?: boolean;
}

export function useListQuery(initial: Options = {}) {
  const [searchInput, setSearchInput] = useState(initial.search ?? '');
  const [search, setSearch] = useState(initial.search ?? '');
  const [filters, setFilters] = useState<Record<string, string>>(initial.filters ?? {});
  const [sortBy, setSortBy] = useState<string | undefined>(initial.sortBy);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initial.sortDir ?? 'desc');
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(!initial.waitForDefaults);
  const defaults = useRef<Record<string, string>>(initial.filters ?? {});
  const pageSize = initial.pageSize ?? 15;

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const setFilter = useCallback((key: string, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }, []);

  const applyDefaults = useCallback((d: Record<string, string>) => {
    defaults.current = { ...defaults.current, ...d };
    setFilters((f) => ({ ...f, ...d }));
    setReady(true);
  }, []);

  const toggleSort = useCallback(
    (key: string) => {
      if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortBy(key);
        setSortDir('asc');
      }
      setPage(1);
    },
    [sortBy],
  );

  const reset = useCallback(() => {
    setSearchInput('');
    setSearch('');
    setFilters(defaults.current);
    setPage(1);
  }, []);

  const query: ListQuery = useMemo(
    () => ({ search, filters, sortBy, sortDir, page, pageSize }),
    [search, filters, sortBy, sortDir, page, pageSize],
  );

  return { query, ready, searchInput, setSearchInput, setFilter, applyDefaults, toggleSort, setPage, reset };
}
