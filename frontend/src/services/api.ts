// API contract used by the UI. httpApi.ts implements it against the FastAPI backend;
// pages and components depend only on this interface.
import type {
  ActivationResult,
  AuthUser,
  LoginResult,
  UserInput,
  Benefit,
  BenefitFulfillment,
  BenefitInput,
  DatasetName,
  DatasetStatus,
  Distributor,
  FilterOptions,
  FulfillmentInput,
  FulfillmentSummary,
  HealthStatus,
  ListQuery,
  Paged,
  ReportDefinition,
  ReportFilters,
  ReportPreview,
  Retailer,
  SalesRecord,
  SalesSummary,
  SyncRun,
  SyncStatus,
  TierDefinition,
  TierMixRow,
  TierMovement,
  UploadRecord,
  UploadResult,
  ValidationReport,
} from '@/types';
import type { Payload } from '@/network/types';

// BO_Data report (layout of BO_Consolidate_Final.xlsx): what the preview shows
export interface BoDataSummary {
  rows: number;
  latest: string; // last quarter in the workbook, e.g. 'Q2_FY27'
  partial: boolean; // the last quarter is cut at the chosen month
  tierDistribution: { columns: string[]; rows: (string | number)[][] };
  movementSummary: { columns: string[]; rows: (string | number)[][] };
}

// Distribution Counter Report summary (GET /api/counter-report; the download has every sheet)
export interface CounterReport {
  fy: string;
  label: string;
  years: { fy: string; label: string; months: string[] }[];
  months: string[];
  summary: { active: number[]; activeRevenue: number[]; newCount: number[]; newRevenue: number[] };
  generated: string | null;
  counts: { counters: number; new: number; existing: number; neverBilled: number };
}

export interface NetworkStatus {
  source: 'pipeline' | 'notebook' | null;
  building: boolean;
  pipelineInput: string | null;
  lastBuild: Record<string, unknown> | null;
  files: PipelineFile[];
  pending: boolean;
  code: PipelineCode[];
  nextCheckAt: string | null;
  sheets: SheetsStatus | null;
}
// Google Sheets -> Consolidated download (run by the sync)
export interface SheetsQuarter {
  file: string;
  label: string;
  outcome: 'saved' | 'unchanged' | 'kept' | 'no_tab';
  message: string;
  rows: number;
  loaded: string[];
  no_tab: string[];
  failed: string[];
}
export interface SheetsStatus {
  configured: boolean;
  key_found: boolean;
  key_path: string;
  distributor_list: string;
  distributors: number;
  list_error: string | null;
  target: string;
  quarters: { file: string; label: string }[];
  every_minutes: number;
  last: { trigger: string; started_at: string; finished_at: string; ok: boolean; error: string | null; quarters: SheetsQuarter[] } | null;
}
export interface PipelineFile {
  file: string;
  kind: string;
  quarter: string | null;
  modified: string | null;
  size: number | null;
  status: 'In dashboard' | 'Changed' | 'New' | 'Removed' | 'Unreadable';
  error?: string;
}
export interface PipelineCode {
  file: string;
  copy: string;
  copied: string;
  modified: string | null;
  status: 'In sync' | 'Changed' | 'Missing' | 'Unreadable';
  error?: string;
}

export interface ApiClient {
  // sign-in and users (users: admins only)
  login(email: string, password: string): Promise<LoginResult>;
  getMe(): Promise<AuthUser>;
  changePassword(currentPassword: string, newPassword: string): Promise<LoginResult>;
  getUsers(): Promise<AuthUser[]>;
  createUser(input: UserInput & { email: string; password: string }): Promise<AuthUser>;
  updateUser(id: string, input: UserInput): Promise<AuthUser>;
  deleteUser(id: string): Promise<void>;

  getHealth(): Promise<HealthStatus>;
  getFilterOptions(): Promise<FilterOptions>;
  // BO Retailer Network dashboard
  getNetworkData(): Promise<Payload>;
  getNetworkStatus(): Promise<NetworkStatus>;
  rebuildNetwork(): Promise<NetworkStatus>;
  downloadConsolidated(quarter?: string): Promise<void>;   // quarter key such as 'Q2_FY27'; none = all quarters
  // Excel register of the accounts (roles, status, sign-ins, history; never passwords), admins only
  downloadUserRegister(): Promise<void>;
  getCounterReport(fy?: string): Promise<CounterReport>;
  downloadCounterReport(fy?: string): Promise<void>;
  getSales(q: ListQuery): Promise<Paged<SalesRecord> & { summary: SalesSummary }>;
  getRetailers(q: ListQuery): Promise<Paged<Retailer>>;
  getRetailer(id: string): Promise<{ retailer: Retailer; sales: SalesRecord[]; fulfillments: BenefitFulfillment[] } | null>;
  exportRetailers(q: ListQuery, format: 'xlsx' | 'csv'): Promise<void>;
  getDistributors(q: ListQuery): Promise<Paged<Distributor>>;
  exportDistributors(q: ListQuery, format: 'xlsx' | 'csv'): Promise<void>;
  getTierDefinitions(quarter?: string): Promise<TierDefinition[]>;
  getTierMix(fy?: string): Promise<TierMixRow[]>;
  getTierMovements(q: ListQuery): Promise<Paged<TierMovement>>;

  getBenefits(q: ListQuery): Promise<Paged<Benefit>>;
  createBenefit(input: BenefitInput): Promise<Benefit>;
  updateBenefit(id: string, input: BenefitInput): Promise<Benefit>;
  deleteBenefit(id: string): Promise<void>;

  getFulfillments(q: ListQuery): Promise<Paged<BenefitFulfillment> & { summary: FulfillmentSummary }>;
  createFulfillment(input: FulfillmentInput): Promise<BenefitFulfillment>;
  updateFulfillment(id: string, input: FulfillmentInput): Promise<BenefitFulfillment>;
  deleteFulfillment(id: string): Promise<void>;

  getReports(): Promise<ReportDefinition[]>;
  getReportPreview(id: string, filters?: ReportFilters): Promise<ReportPreview>;
  downloadReport(id: string, format: 'csv' | 'xlsx', filters?: ReportFilters): Promise<void>;
  getBoDataSummary(filters?: ReportFilters): Promise<BoDataSummary>;
  downloadBoData(filters?: ReportFilters): Promise<void>;

  getDatasets(): Promise<DatasetStatus[]>;
  reloadDatasets(): Promise<DatasetStatus[]>;
  downloadDatasetTemplate(dataset: DatasetName): Promise<void>;
  downloadDataset(dataset: DatasetName): Promise<void>;
  validateUpload(file: File, dataset: DatasetName, sheetName?: string): Promise<ValidationReport>;
  upload(file: File, dataset: DatasetName, sheetName?: string, allowDuplicate?: boolean): Promise<UploadResult>;
  activateUpload(uploadId: string, mode: 'replace' | 'append'): Promise<ActivationResult>;
  getUploads(): Promise<UploadRecord[]>;

  getSyncStatus(): Promise<SyncStatus>;
  runSync(force?: boolean): Promise<SyncRun>;
}
