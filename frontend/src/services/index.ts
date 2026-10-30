// Single entry point for data access. All data comes from the FastAPI backend (Dropbox-backed).
// Configure the backend URL with VITE_API_BASE_URL (default: /api, proxied to :8000 by Vite in dev).
import type { ApiClient } from './api';
import { httpApi } from './httpApi';

export const api: ApiClient = httpApi;
export { ApiError } from './httpApi';
export type { ApiClient } from './api';
