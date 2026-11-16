// Ad detail for the Campaign performance page: loads the saved ad sets, ads, breakdowns, keywords ... (never calls Meta or Google)
// and adds them up for the selected period. One set of helpers for the Meta and Google cards.
import { useEffect, useState } from 'react';
import { adsApi } from './api';
import type { AdDetail } from './types';

export * from './adMath';

/** Loads the saved ad detail once while `enabled`; null until it arrives (or if it cannot be read). */
export function useAdDetail(enabled: boolean): AdDetail | null {
  const [data, setData] = useState<AdDetail | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const read = () => adsApi.detail().then((d) => { if (live) setData(d); }).catch(() => undefined);
    void read();
    const t = setInterval(() => void read(), 5 * 60 * 1000);
    return () => { live = false; clearInterval(t); };
  }, [enabled]);
  return data;
}

