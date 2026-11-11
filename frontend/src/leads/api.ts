// Lead Generation API calls (/api/leads/...). Uses the shared sign-in token; nothing from the BO Dashboard.
import { clearSession, getToken } from '@/services/session';
import type { ActionItem, LeadsPayload, LeadsStatus, SheetSource, SheetsStatus } from './types';

const BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api').replace(/\/$/, '');

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}/leads${path}`, {
      method,
      headers: {
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the Blue Origin API. Is the backend running?');
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = (await res.json())?.error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    if (res.status === 401) clearSession(msg);
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) return (await res.text()) as T;
  const json = await res.json();
  return (json && typeof json === 'object' && 'success' in json && 'data' in json ? json.data : json) as T;
}

async function download(path: string, name: string) {
  const t = getToken();
  const res = await fetch(`${BASE}/leads${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const leadsApi = {
  data: () => call<LeadsPayload>('GET', '/data'),
  status: () => call<LeadsStatus>('GET', '/status'),
  rebuild: () => call<LeadsStatus>('POST', '/rebuild'),
  upload: (file: File) => {
    const f = new FormData();
    f.append('file', file);
    return call<LeadsStatus>('POST', '/inbox', f);
  },
  removeFile: (name: string) => call<LeadsStatus>('DELETE', `/inbox/${encodeURIComponent(name)}`),
  memo: () => call<string>('GET', '/memo'),
  downloadReconciliation: () => download('/reconciliation', 'Lead_Gen_Reconciliation.xlsx'),
  downloadMemo: () => download('/memo', 'Lead_Gen_Findings_Memo.md'),
  actions: () => call<ActionItem[]>('GET', '/actions'),
  saveActions: (items: ActionItem[]) => call<ActionItem[]>('PUT', '/actions', { items }),
  saveSheets: (items: SheetSource[]) => call<SheetsStatus>('PUT', '/sheets', { items }),
  refreshSheets: () => call<SheetsStatus>('POST', '/sheets/refresh'),
  saveTargets: (t: Record<string, number>) => call<Record<string, number>>('PUT', '/targets', t),
};
