export const formatNumber = (n: number) => new Intl.NumberFormat('en-IN').format(Math.round(n));

export function formatINR(n: number, compact = false): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (compact) {
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
    if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(abs)}`;
}

export const formatPercent = (n: number, digits = 1) => `${n.toFixed(digits)}%`;

// "2026-07-14" -> "Jul 2026"
export function formatMonthYear(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Quarter definition (Indian FY, April–March): Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
// The FY is named after the year it ends in: FY 27 = Apr 2026 – Mar 2027, so "Q1 FY 27" = Apr–Jun 2026 and
// "Q4 FY 27" = Jan–Mar 2027. Dashboard keys ("Q2_FY27") use the same convention.
const QUARTER_MONTHS = ['Apr–Jun', 'Jul–Sep', 'Oct–Dec', 'Jan–Mar'];
export const QUARTER_RULE =
  'Quarters follow the financial year (April–March): Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar of the next year. FY 27 = Apr 2026 – Mar 2027.';

export function quarterMonths(label: string): string | null {
  const m = /^Q([1-4])[ _]?FY[ _]?(\d{2})(?:-(\d{2}))?$/.exec(label.trim());
  if (!m) return null;
  const q = Number(m[1]);
  const fyStart = 2000 + Number(m[2]) - (m[3] ? 0 : 1); // older "FY26-27" labels name the start year
  return `${QUARTER_MONTHS[q - 1]} ${q === 4 ? fyStart + 1 : fyStart}`;
}

// "Q2 FY 27" (or the dashboard key "Q2_FY27") -> "Q2 FY 27 (Jul–Sep 2026)"; other text unchanged
export function quarterLong(label: string | null | undefined): string {
  if (!label) return '—';
  const short = label.replace(/^Q([1-4])_FY(\d{2})$/, 'Q$1 FY $2');
  const months = quarterMonths(short);
  return months ? `${short} (${months})` : label;
}

// Dropdown options that show each quarter's months next to its label
export const quarterOptions = (labels: string[]) => labels.map((q) => ({ value: q, label: quarterLong(q) }));

// Quarters of one financial year ("FY 27") from a list of quarter labels
export const quartersOfFy = (labels: string[], fy: string) => (fy ? labels.filter((q) => q.endsWith(fy)) : labels);
