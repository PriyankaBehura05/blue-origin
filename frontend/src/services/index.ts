// Single entry point for data access. All data comes from the FastAPI backend (Dropbox-backed).
// The backend URL comes from VITE_API_BASE_URL, set per mode in .env.development / .env.remote / .env.production.
import type { ApiClient } from './api';
import { httpApi } from './httpApi';

export const api: ApiClient = httpApi;
export { ApiError } from './httpApi';
export type { ApiClient } from './api';
