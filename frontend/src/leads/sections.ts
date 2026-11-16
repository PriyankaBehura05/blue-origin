// The 17 pages of the lead dashboard, in menu order: address (/leads/<id>), menu icon, title, one-line "so what".
import {
  Filter, Gauge, GitBranch, GitCompareArrows, PhoneCall, Target, ListChecks, MapPin, Medal, Megaphone, Briefcase, ShieldCheck, SlidersHorizontal, TrendingUp, Truck, UserPlus, Wallet,
  type LucideIcon,
} from 'lucide-react';

export interface SectionDef {
  id: string;
  icon: LucideIcon;
  title: string;
  soWhat: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'cover', icon: Gauge, title: 'Overview', soWhat: 'Are the leads turning into retailers, and what needs attention now?' },
  { id: 'funnel', icon: Filter, title: 'Lead journey', soWhat: 'From enquiry to first order: how many leads make it at each step, and how fast.' },
  { id: 'mix', icon: GitBranch, title: 'Where retailers come from', soWhat: 'New retailers from leads vs on their own, and whether they buy as much.' },
  { id: 'campaigns', icon: Megaphone, title: 'Campaigns', soWhat: 'Which campaigns to grow, fix or stop.' },
  { id: 'field', icon: Truck, title: 'Distributors & ASMs', soWhat: 'Who adds and keeps shops, and how well each ASM follows up their leads.' },
  { id: 'ageing', icon: PhoneCall, title: 'Follow-ups & call lists', soWhat: 'Who to call first, which follow-ups are late, and ready-to-download call lists for open leads and lapsed retailers.' },
  { id: 'retention', icon: Medal, title: 'Repeat buying & tiers', soWhat: 'Do retailers keep ordering and move up tiers, and where sales are lost.' },
  { id: 'geography', icon: MapPin, title: 'States & cities', soWhat: 'Where the leads and retailers are, and which areas have room to grow.' },
  { id: 'untapped', icon: UserPlus, title: 'Who to contact next (now in Follow-ups & call lists)', soWhat: 'Ready-to-use call lists: open leads and retailers worth winning back.' },
  { id: 'forecast', icon: SlidersHorizontal, title: 'Forecast', soWhat: 'Where the current pace lands next quarter, and what a budget change would do.' },
  { id: 'retailers', icon: ListChecks, title: 'Retailers & actions', soWhat: 'The retailers behind every number, and the actions agreed with each owner.' },
  { id: 'quality', icon: ShieldCheck, title: 'Data & settings', soWhat: 'The linked Google Sheet, how the data was cleaned, targets, and how each number is worked out.' },
  { id: 'budget', icon: Wallet, title: 'Ad budget', soWhat: 'Meta and Google ad accounts: campaign budgets, what was spent, and how much of each budget is used.' },
  { id: 'performance', icon: TrendingUp, title: 'Campaign performance', soWhat: 'What the campaigns cost, the enquiries and sales they brought in, how the calls went, and where the leads are.' },
  { id: 'attribution', icon: Target, title: 'Campaign attribution', soWhat: 'Which campaign each lead came from, what every campaign cost and brought in (enquiries, new retailers, BO sales), and which campaigns acquire retailers best.' },
  { id: 'platforms', icon: GitCompareArrows, title: 'Platform comparison', soWhat: 'Meta vs Google side by side, with Print, JustDial, Other and Organic as their own sources: budget, spend, leads, CPL, new retailers and conversion.' },
  { id: 'impact', icon: Briefcase, title: 'BO business impact', soWhat: 'What the leads delivered for BO: retailers won, sales, repeat buying, findings and next steps.' },
];

// Consistent colours (CSS variables in leads.css): one per source, outcome and tier across every chart
export const SOURCE_COLORS = ['var(--ld-src-meta)', 'var(--ld-src-google)', 'var(--ld-src-jd)', 'var(--ld-src-print)', 'var(--ld-src-other)', 'var(--ld-src-organic)'];
export const SOURCE_NAMES = ['Meta', 'Google', 'JustDial', 'Print', 'Other', 'Organic'];
export const OUTCOME_COLORS = ['var(--ld-o-existing)', 'var(--ld-o-react)', 'var(--ld-o-new)', 'var(--ld-o-not)', 'var(--ld-o-unm)', 'var(--ld-o-pending)'];
// call results (the ASMs' Category, grouped): good news in blues/green, waiting in amber, lost in greys
const CATEGORY_TONES: Record<string, string> = {
  Converted: 'var(--ld-cat-win)', 'Already a customer': 'var(--ld-o-existing)', Interested: 'var(--ld-seq-5)',
  'Catalogue sent': 'var(--ld-seq-4)', 'Distributor visit': 'var(--ld-seq-4)', 'Wants distributorship': 'var(--ld-seq-3)',
  'Franchise enquiry': 'var(--ld-seq-3)', Commercial: 'var(--ld-seq-3)', Pending: 'var(--ld-cat-wait)',
  'Not reachable': 'var(--ld-cat-lost)', 'Not interested': 'var(--ld-cat-lost)', 'Outside our area': 'var(--ld-cat-lost)',
  'Wrong number': 'var(--ld-cat-dead)', 'No shop / consumer': 'var(--ld-cat-dead)', 'Other note': 'var(--ld-cat-dead)',
};
export const categoryColor = (c: string) => CATEGORY_TONES[c] ?? 'var(--ld-cat-dead)';
export const TIER_COLORS = ['var(--t0)', 'var(--t1)', 'var(--t2)', 'var(--t3)', 'var(--t4)', 'var(--t5)'];

// Campaign performance, Campaign attribution and BO business impact are detail pages of the Overview, not menu items:
//   Overview -> Campaign performance -> Campaign attribution        Overview -> BO business impact
export const PARENT: Record<string, string> = { performance: 'cover', attribution: 'performance', impact: 'cover' };
/** The page and its parents, top first: 'attribution' -> [cover, performance, attribution]. */
export const trailOf = (id: string): string[] => (PARENT[id] ? [...trailOf(PARENT[id]), id] : [id]);
/** The menu item a page belongs to (itself, or the Overview for its detail pages). */
export const navRootOf = (id: string): string => trailOf(id)[0];

const NAV_ORDER = ['cover', 'platforms', 'funnel', 'mix', 'campaigns', 'field', 'ageing', 'retention', 'geography', 'forecast', 'retailers', 'quality', 'budget'];
export const NAV_SECTIONS: SectionDef[] = NAV_ORDER.map((id) => SECTIONS.find((x) => x.id === id)!);
