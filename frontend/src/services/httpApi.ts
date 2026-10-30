// HTTP implementation of ApiClient for the FastAPI backend (data stored in Dropbox).
// Every JSON response is an envelope: { success, data, meta } or { success: false, error }.
import type { ApiClient } from './api';
import type { ListQuery, ReportFilters } from '@/types';
import { clearSession, getToken } from './session';

const BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public details?: unknown) {
    super(message);
  }
}

function qs(q: ListQuery): string {
  const p = new URLSearchParams();
  if (q.search) p.set('search', q.search);
  if (q.sortBy) p.set('sort_by', q.sortBy);
  if (q.sortDir) p.set('sort_dir', q.sortDir);
  if (q.page) p.set('page', String(q.page));
  if (q.pageSize) p.set('page_size', String(q.pageSize));
  for (const [k, v] of Object.entries(q.filters ?? {})) if (v) p.set(k, v);
  return p.toString();
}

async function errorFrom(res: Response, path: string): Promise<ApiError> {
  try {
    const body = await res.json();
    const err = body?.error;
    if (err?.message) {
      const extra = Array.isArray(err.details)
        ? ` (${err.details.map((d: { field?: string; message?: string }) => [d.field, d.message].filter(Boolean).join(': ')).join('; ')})`
        : '';
      return new ApiError(`${err.message}${extra}`, res.status, err.code, err.details);
    }
  } catch {
    /* not JSON */
  }
  return new ApiError(`Request failed (${res.status}) for ${path}`, res.status);
}

function authHeader(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// A 401 means the sign-in is missing, expired or revoked: back to the login page with the reason.
async function checked(res: Response, path: string): Promise<Response> {
  if (res.ok) return res;
  const err = await errorFrom(res, path);
  if (res.status === 401 && path !== '/auth/login') clearSession(err.message);
  throw err;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...authHeader(),
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Blue Origin API. Is the backend running?', 0, 'NETWORK');
  }
  await checked(res, path);
  if (res.status === 204) return undefined as T;
  const json = await res.json();
  return (json && typeof json === 'object' && 'success' in json && 'data' in json ? json.data : json) as T;
}

const get = <T,>(path: string) => request<T>('GET', path);

// Same search / filters / sort as the table, without paging, for file exports
function exportQs(q: ListQuery, format: string): string {
  return `${qs({ ...q, page: undefined, pageSize: undefined })}&format=${format}`;
}

async function download(path: string, fallbackName: string): Promise<void> {
  const res = await checked(await fetch(`${BASE}${path}`, { headers: authHeader() }), path);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function uploadForm(file: File, dataset: string, sheetName?: string): FormData {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('dataset', dataset);
  if (sheetName) fd.append('sheet_name', sheetName);
  return fd;
}

const enc = encodeURIComponent;
// '&month=2026-09&region=South' for the filters that are set
const reportQs = (f?: ReportFilters) =>
  Object.entries(f ?? {}).filter(([, v]) => v).map(([k, v]) => `&${k}=${enc(String(v))}`).join('');

export const httpApi: ApiClient = {
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  getMe: () => get('/auth/me'),
  changePassword: (currentPassword, newPassword) => request('POST', '/auth/change-password', { currentPassword, newPassword }),
  getUsers: () => get('/users'),
  createUser: (input) => request('POST', '/users', input),
  updateUser: (id, input) => request('PUT', `/users/${enc(id)}`, input),
  deleteUser: (id) => request('DELETE', `/users/${enc(id)}`),
  getHealth: () => get('/health'),
  getFilterOptions: () => get('/meta/filters'),
  getNetworkData: () => get('/network/data'),
  getCounterReport: (fy) => get(`/counter-report${fy ? `?fy=${enc(fy)}` : ''}`),
  downloadCounterReport: (fy) => download(`/counter-report/download${fy ? `?fy=${enc(fy)}` : ''}`, `Distributor_Counter_Report_${fy ?? ''}.xlsx`),
  getNetworkStatus: () => get('/network/status'),
  rebuildNetwork: () => request('POST', '/network/rebuild'),
  downloadConsolidated: (quarter) => download(`/network/download${quarter ? `?quarter=${enc(quarter)}` : ''}`, `BO_Consolidated_Data${quarter ? `_${quarter}` : ''}.xlsx`),
  downloadUserRegister: () => download('/users/register', 'BO_User_Register.xlsx'),
  getSales: (q) => get(`/sales?${qs(q)}`),
  getRetailers: (q) => get(`/retailers?${qs(q)}`),
  getRetailer: async (id) => {
    try {
      return await get(`/retailers/${enc(id)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  exportRetailers: (q, format) => download(`/retailers/export?${exportQs(q, format)}`, `Retailers.${format}`),
  getDistributors: (q) => get(`/distributors?${qs(q)}`),
  exportDistributors: (q, format) => download(`/distributors/export?${exportQs(q, format)}`, `Distributors.${format}`),
  getTierDefinitions: (quarter) => get(`/tiers/definitions${quarter ? `?quarter=${enc(quarter)}` : ''}`),
  getTierMix: (fy) => get(`/tiers/by-quarter${fy ? `?fy=${enc(fy)}` : ''}`),
  getTierMovements: (q) => get(`/tiers/movements?${qs(q)}`),

  getBenefits: (q) => get(`/benefits?${qs(q)}`),
  createBenefit: (input) => request('POST', '/benefits', input),
  updateBenefit: (id, input) => request('PUT', `/benefits/${enc(id)}`, input),
  deleteBenefit: (id) => request('DELETE', `/benefits/${enc(id)}`),

  getFulfillments: (q) => get(`/benefits/fulfillments?${qs(q)}`),
  createFulfillment: (input) => request('POST', '/benefits/fulfillments', input),
  updateFulfillment: (id, input) => request('PUT', `/benefits/fulfillments/${enc(id)}`, input),
  deleteFulfillment: (id) => request('DELETE', `/benefits/fulfillments/${enc(id)}`),

  getReports: () => get('/reports'),
  getReportPreview: (id, filters) => get(`/reports/${enc(id)}/preview?limit=25${reportQs(filters)}`),
  getBoDataSummary: (filters) => get(`/reports/bo-data/summary?x=1${reportQs(filters)}`),
  downloadBoData: (filters) => download(`/reports/bo-data/download?x=1${reportQs(filters)}`, 'BO_Data.xlsx'),
  downloadReport: (id, format, filters) => download(`/reports/${enc(id)}/download?format=${format}${reportQs(filters)}`, `${id}.${format}`),

  getDatasets: () => get('/datasets'),
  reloadDatasets: () => request('POST', '/datasets/reload'),
  downloadDatasetTemplate: (dataset) => download(`/datasets/${dataset}/template`, `${dataset}_template.csv`),
  downloadDataset: (dataset) => download(`/datasets/${dataset}/download`, `${dataset}.csv`),
  validateUpload: (file, dataset, sheetName) => request('POST', '/uploads/validate', uploadForm(file, dataset, sheetName)),
  upload: (file, dataset, sheetName, allowDuplicate = false) =>
    request('POST', `/uploads${allowDuplicate ? '?allow_duplicate=true' : ''}`, uploadForm(file, dataset, sheetName)),
  activateUpload: (uploadId, mode) => request('POST', `/uploads/${enc(uploadId)}/activate?mode=${mode}`),
  getUploads: () => get('/uploads'),

  getSyncStatus: () => get('/sync'),
  runSync: (force = false) => request('POST', `/sync${force ? '?force=true' : ''}`),
};
