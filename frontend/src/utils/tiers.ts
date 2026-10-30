import type { TierName } from '@/types';

// Presentation-only badge colours (not business data). Tier names and thresholds come from the API;
// a tier without an entry here falls back to neutral grey.
export const TIER_COLORS: Record<string, string> = {
  Unranked: '#94a3b8',
  Untiered: '#94a3b8',
  Yellow: '#eab308',
  Green: '#22c55e',
  Silver: '#64748b',
  Gold: '#d97706',
  Platinum: '#7c3aed',
};

export const tierColor = (tier: TierName | null | undefined) => TIER_COLORS[tier ?? ''] ?? '#94a3b8';

export const CHART_COLORS = ['#2563eb', '#0ea5e9', '#14b8a6', '#8b5cf6', '#f59e0b', '#ef4444'];
