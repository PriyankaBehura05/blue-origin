// The signed-in session: token + user, remembered in this browser until sign-out or expiry.
// httpApi.ts sends the token with every request and clears the session when the API answers 401.
import { useSyncExternalStore } from 'react';
import type { AuthUser } from '@/types';

export interface Session {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

const KEY = 'bo_session';
const listeners = new Set<() => void>();
let current: Session | null = read();
let notice: string | null = null; // why the user was signed out (shown on the login page)

function read(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null;
    return s && s.token && new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function emit() {
  listeners.forEach((l) => l());
}

export const getSession = () => current;
export const getToken = () => current?.token ?? null;

export function setSession(s: Session) {
  current = s;
  notice = null;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* kept for this tab only */
  }
  emit();
}

export function updateUser(user: AuthUser) {
  if (current) setSession({ ...current, user });
}

export function clearSession(reason: string | null = null) {
  if (!current && !reason) return;
  current = null;
  notice = reason;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
  emit();
}

export const takeNotice = () => notice;

export function useSession(): Session | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) {
          current = read();
          cb();
        }
      };
      window.addEventListener('storage', onStorage); // sign-in / sign-out in another tab
      return () => {
        listeners.delete(cb);
        window.removeEventListener('storage', onStorage);
      };
    },
    () => current,
  );
}
