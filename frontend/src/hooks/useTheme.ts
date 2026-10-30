// Light / dark mode for the whole app. The choice is remembered per browser; the default follows the system.
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'bo_theme';
const EVENT = 'bo-theme';

export function initialTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage blocked: follow the system */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new Event(EVENT));
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* not remembered */
  }
  applyTheme(t);
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  );
}
