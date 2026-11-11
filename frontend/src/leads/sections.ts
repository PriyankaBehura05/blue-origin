// The 12 pages of the lead dashboard, in menu order: address (/leads/<id>), menu icon, title, one-line "so what".
import {
  Filter, Gauge, GitBranch, Hourglass, ListChecks, MapPin, Medal, Megaphone, ShieldCheck, SlidersHorizontal, Truck, UserPlus,
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
  { id: 'ageing', icon: Hourglass, title: 'Follow-up queue', soWhat: 'Open leads going cold, who is late, and which to call first.' },
  { id: 'retention', icon: Medal, title: 'Repeat buying & tiers', soWhat: 'Do retailers keep ordering and move up tiers, and where sales are lost.' },
  { id: 'geography', icon: MapPin, title: 'States & cities', soWhat: 'Where the leads and retailers are, and which areas have room to grow.' },
  { id: 'untapped', icon: UserPlus, title: 'Who to contact next', soWhat: 'Ready-to-use call lists: open leads and retailers worth winning back.' },
  { id: 'forecast', icon: SlidersHorizontal, title: 'Forecast', soWhat: 'Where the current pace lands next quarter, and what a budget change would do.' },
  { id: 'retailers', icon: ListChecks, title: 'Retailers & actions', soWhat: 'The retailers behind every number, and the actions agreed with each owner.' },
  { id: 'quality', icon: ShieldCheck, title: 'Data & settings', soWhat: 'The linked Google Sheet, how the data was cleaned, targets, and how each number is worked out.' },
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
