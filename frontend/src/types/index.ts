// Domain types for BLUE ORIGIN. They mirror the FastAPI response schemas (camelCase on the wire).
// UI components depend ONLY on these types. Vocabularies (tiers, regions, statuses …) are strings
// because their values come from the stored data and backend config, not from the frontend.

export type TierName = string;

export interface Distributor {
  id: string;
  name: string;
  code: string | null;
  state: string | null;
  city: string | null;
  region: string | null;
  asm: string | null;
  rsm: string | null;
  retailerCount: number;
  currentQuarterSales: number;
  status: string;
  onboardedOn: string | null; // ISO date
  inMaster: boolean;
}

export interface Retailer {
  id: string;
  code: string | null;
  name: string;
  distributorId: string | null;
  distributorName: string | null;
  channel: string | null;
  city: string | null;
  state: string | null;
  region: string | null;
  pincode: string | null;
  asm: string | null;
  rsm: string | null;
  status: string;
  currentTier: TierName;
  previousTier: TierName;
  movement: 'Upgrade' | 'Downgrade' | 'Retained';
  tierStatus: string; // 'valid' | 'needs_review'
  currentQuarterSales: number;
  fySales: number;
  onboardedOn: string | null;
  inMaster: boolean; // false = seen only in sales data
}

export interface SalesRecord {
  id: string;
  date: string; // ISO date
  month: string; // YYYY-MM
  quarter: string; // e.g. "Q2 FY 27" (FY 27 = Apr 2026 – Mar 2027)
  fy: string | null; // e.g. "FY 27"
  retailerId: string;
  retailerName: string;
  distributorId: string;
  distributorName: string;
  state: string | null;
  region: string | null;
  channel: string | null;
  category: string | null;
  quantity: number;
  grossAmount: number;
  returnAmount: number;
  netAmount: number;
}

export interface SalesSummary {
  gross: number;
  returns: number;
  net: number;
  quantity: number;
  records: number;
}

export interface TierDefinition {
  tier: TierName;
  minQuarterlySales: number;
  maxQuarterlySales: number | null;
  color: string;
  retailerCount: number;
  description: string;
  effectiveFrom?: string | null; // first day the tier applies (Platinum: 2026-04-01); null = always
}

export interface TierMovement {
  retailerId: string;
  retailerName: string;
  retailerCode: string | null;
  distributorName: string | null;
  region: string | null;
  city: string | null;
  state: string | null;
  status: string | null;
  from: TierName;
  to: TierName;
  quarter: string;
  previousQuarter: string | null;
  direction: 'Upgrade' | 'Downgrade' | 'Retained';
  quarterlySales: number;
  previousQuarterSales: number;
}

export interface TierMixRow {
  quarter: string;
  buyingRetailers: number;
  tieredRetailers: number;
  netSales: number;
  counts: Record<string, number>;
}

export interface Benefit {
  id: string;
  name: string;
  tier: TierName;
  frequency: string | null;
  quantity: number;
  unitCost: number;
  description: string | null;
}

export type BenefitInput = Omit<Benefit, 'id'>;

export type FulfillmentStatus = 'Planned' | 'In Progress' | 'Fulfilled' | 'Overdue';

export interface BenefitFulfillment {
  id: string;
  benefitId: string;
  benefitName: string;
  retailerId: string;
  retailerName: string;
  tier: TierName;
  quarter: string;
  fy: string | null;
  plannedDate: string;
  actualDate: string | null;
  status: FulfillmentStatus;
  cost: number;
}

export interface FulfillmentInput {
  benefitId: string;
  retailerId: string;
  plannedDate: string;
  actualDate: string | null;
  status: string | null;
  cost: number | null;
}

export interface FulfillmentSummary {
  cost: number;
  fulfilled: number;
  pending: number;
  overdue: number;
  records: number;
}

export interface KpiCard {
  key: string;
  label: string;
  value: number;
  format: 'currency' | 'number' | 'percent';
  deltaPct: number | null; // change vs previous period; null when not comparable
}

export interface TimeSeriesPoint {
  label: string;
  value: number;
  target?: number | null;
}

export interface CategoryPoint {
  name: string;
  value: number;
}

export interface IdName {
  id: string;
  name: string;
}

export interface FilterOptions {
  currentQuarter: string;
  previousQuarter: string;
  currentFy: string;
  regions: string[];
  states: string[];
  channels: string[];
  quarters: string[];
  salesQuarters: string[]; // quarters that have sales, newest first
  months?: string[]; // months with sales, 'YYYY-MM', newest first
  financialYears: string[]; // e.g. ["FY 27", "FY 26", "FY 25"], newest first
  tiers: string[];
  distributors: IdName[];
  retailers: IdName[];
  categories: string[];
  retailerStatuses: string[];
  distributorStatuses: string[];
  fulfillmentStatuses: string[];
  benefitFrequencies: string[];
  benefits: IdName[];
  movementDirections: string[];
}

export interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  lastGenerated: string | null;
  format: 'XLSX' | 'CSV';
  usesPeriod?: boolean; // false: the month / quarter filters do not apply (a master list)
}

// Report filters (all optional; empty = all). A month or quarter sets the period of the period-based reports.
export interface ReportFilters {
  month?: string; // 'YYYY-MM'
  quarter?: string; // 'Q2 FY 27'
  region?: string;
  state?: string;
  distributor?: string; // distributor id
}

export interface ReportPreview {
  reportId: string;
  columns: string[];
  rows: (string | number | null)[][];
  totalRows: number;
  filters?: string; // the filters applied, in words ('' = all)
}

// ---- Data store (Dropbox) --------------------------------------------------
export type DatasetName = 'sales' | 'retailers' | 'distributors' | 'benefits' | 'fulfillments' | 'targets';

export interface DatasetStatus {
  dataset: DatasetName;
  stored: boolean;
  rows: number;
  validRows: number;
  modified: string | null;
  path: string;
  requiredColumns: string[];
  optionalColumns: string[];
}

export interface ValidationIssue {
  row: number | null;
  column: string | null;
  code: string;
  severity: string;
  status: string;
  message: string;
  value: string | null;
}

// Upload endpoints keep the backend's snake_case field names.
export interface ValidationReport {
  dataset: string;
  filename: string;
  sheet_name: string | null;
  total_rows: number;
  can_process: boolean;
  status_counts: Record<string, number>;
  column_mapping: Record<string, string>;
  missing_required_columns: string[];
  unrecognised_columns: string[];
  file_errors: ValidationIssue[];
  file_warnings: ValidationIssue[];
  issues: ValidationIssue[];
  issues_total: number;
  issues_truncated: boolean;
  preview: Record<string, unknown>[];
}

export interface UploadRecord {
  upload_id: string;
  original_filename: string;
  stored_filename: string;
  dataset: string;
  size_bytes: number;
  uploaded_at: string;
  total_rows: number;
  can_process: boolean;
  status_counts: Record<string, number>;
  sheet_name: string | null;
  processed: boolean;
  activated_at: string | null;
  activation_mode: string | null;
}

export interface UploadResult {
  upload: UploadRecord;
  report: ValidationReport;
}

export interface ActivationResult {
  upload: UploadRecord;
  dataset: string;
  mode: string;
  rows_stored: number;
  path: string;
}

export interface HealthStatus {
  status: string;
  version: string;
  data_source: string;
  store: string | null;
  store_ok: boolean;
  store_error: string | null;
}

// ---- Automatic pipeline (Dropbox inbox -> datasets) -------------------------
export interface SyncFileResult {
  path: string;
  sheet: string | null;
  rows: number;
  valid_rows: number;
  issues: number;
  error: string | null;
}

export interface SyncDatasetResult {
  dataset: string;
  status: 'updated' | 'partial' | 'unchanged' | 'failed';
  rows: number;
  files: SyncFileResult[];
  message: string | null;
}

export interface SyncRun {
  trigger: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  error: string | null;
  warnings: string[];
  results: SyncDatasetResult[];
}

export interface SyncStatus {
  inbox: string;
  interval_minutes: number;
  running: boolean;
  next_run_at: string | null;
  last_run: SyncRun | null;
  datasets: Record<string, { synced_at?: string; rows?: number; files?: SyncFileResult[] }>;
  recent_runs: SyncRun[];
}

// Generic query helpers shared by list endpoints
export interface ListQuery {
  search?: string;
  filters?: Record<string, string>;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---- sign-in
export type Role = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

export interface UserInput {
  email?: string;
  name?: string;
  role?: Role;
  active?: boolean;
  password?: string;
}
