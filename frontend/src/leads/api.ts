// Lead Generation API calls (/api/leads/...). Uses the shared sign-in token; nothing from the BO Dashboard.
import { clearSession, getToken } from '@/services/session';
import type { ActionItem, AdDetail, BudgetPayload, CampaignPerformance, LeadsPayload, LeadsStatus, MatchReview, SheetSource, SheetsStatus } from './types';

const BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api').replace(/\/$/, '');

async function call<T>(method: string, path: string, body?: unknown, prefix = '/leads'): Promise<T> {
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${prefix}${path}`, {
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
  campaignPerformance: (q: { start: string; end: string; level: string; window: number }) =>
    call<CampaignPerformance>('GET', `/campaign-performance?${new URLSearchParams({ ...q, window: String(q.window) })}`),
  saveMatchReview: (r: Pick<MatchReview, 'mobile' | 'retailer_id'> & { decision: 'approve' | 'reject' | 'clear' }) =>
    call<unknown>('PUT', '/match-reviews', r),
};

// Ad budget screen. Reading returns what the last fetch saved (it never calls Google or Meta); refreshing is admin only.
export const adsApi = {
  budget: () => call<BudgetPayload>('GET', '/budget', undefined, '/ads'),
  detail: () => call<AdDetail>('GET', '/budget/detail', undefined, '/ads'),
  refreshBudget: (platforms: string[]) => call<{ started: string[] }>('POST', '/budget/refresh', { platforms }, '/ads'),
};
