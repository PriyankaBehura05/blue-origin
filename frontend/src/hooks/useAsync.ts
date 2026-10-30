import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

// Runs `fn` whenever `deps` change (and on reload()). While `enabled` is false nothing is fetched.
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], enabled = true): AsyncState<T> {
  const [state, setState] = useState<Omit<AsyncState<T>, 'reload'>>({ data: undefined, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => id === seq.current && setState({ data, loading: false, error: null }))
      .catch((e: unknown) => id === seq.current && setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
