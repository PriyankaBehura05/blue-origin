// Contextual help for the dashboard: what every page, filter, KPI card, chart, table and column shows and how it is
// counted. The texts follow the calculations in reports.ts and model.ts; keep them in step when a definition changes.
// withHelp() adds the texts to a built view (by chart / table id, column key and KPI label) without touching the data.
import { fmtINR, fmtSlab, MOVES, qLabel, qSel, slabAt, slabText, tierFrom, tierInForce, type Move } from './model';
import type { Chart, Col, Filters, Kpi, Model, Table, View } from './types';
import type { ViewKey } from './reports';

type PageKey = ViewKey | 'lookup';
type Text = string | ((label: string) => string);
interface Ctx { m: Model; f: Filters; all: boolean; q: string; prev: string; latest: string; yellow: string }

const ACTIVE = 'A retailer counts as active in a period when it bought something (more than ₹0) in it.';
const BADGE = 'The ▲/▼ badge is the % change against the previous quarter.';
const basisText = 'the larger of the 3 months added up and the “Last 3 Months” figure in the distributor sheet';

/* ------------------------------------------------------------ pages (title and sidebar) */
export const PAGE_HELP: Record<string, string> = {
  overview: 'The big picture for the retailers in your filters: revenue, active and new retailers, tier mix, how often retailers buy, and the top retailers.',
  'new-retailers': 'Who started buying and when. A retailer is new in the month of its first-ever purchase. Also shows how each group of new retailers (a cohort) has done since joining.',
  'tier-movement': 'How retailers moved between tiers from one quarter to the next: upgraded, downgraded, stayed, dropped below the tiers, new, or stopped buying.',
  retention: 'Are buyers coming back? Compares each quarter with the one before it: retained (bought in both), lapsed (stopped), reactivated (came back after a gap) and dormant retailers.',
  'upgrade-pipeline': 'Retailers who are close to the next tier’s minimum purchase (slab), and how much more they need to buy to move up. Use it to pick upgrade targets.',
  deliverables: 'Will track the deliverables given to tiered retailers. This page is still being built.',
  'benefits-history': 'Will show the benefits each retailer received by quarter. This page is still being built.',
  'retailer-lookup': 'Find any retailer by name, retailer ID, district, phone or old spelling. Click a name to see its contacts, monthly purchases and tier history.',
};
// Manage pages in the sidebar
export const NAV_HELP: Record<string, string> = {
  '/sales': 'Monthly sales records by retailer and distributor (validated rows only), with gross and net totals.',
  '/retailers': 'The retailer master list with tier, tier movement, location and distributor. Click a row for the retailer’s details.',
  '/distributors': 'Distributors by state and region, with how many retailers they serve and their net sales this quarter.',
  '/tiers': 'The tier ladder (minimum purchase for each tier) and how many retailers were in each tier every quarter.',
  '/benefits': 'The catalogue of tier benefits and tracking of benefits planned or given to retailers.',
  '/reports': 'Standard reports built from the live data. Pick one to preview it and export it.',
  '/data': 'Upload BO files, check the Dropbox sync and rebuild the data the dashboard uses.',
  '/users': 'Admins only: who can sign in and what they can do (admin, editor or viewer).',
};

/* ------------------------------------------------------------ filters */
export function filterHelp(m: Model, f: Filters): Record<string, string> {
  const yellow = m.p.slabs.Yellow;
  return {
    Region: 'Show only retailers whose distributor is in this region. Picking a region also narrows the State and Distributor lists.',
    State: 'Show only retailers whose distributor is in this state. Picking a state narrows the Distributor list.',
    Distributor: 'Show only the retailers of one distributor.',
    Quarter: 'The quarter every card, chart and table looks at, compared with the quarter before it. “All quarters” shows trends over the whole data; pages that need one quarter then use the latest. Financial-year quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.',
    Tier: `Keep only retailers on this tier in the selected quarter (the latest quarter with “All quarters”). “Any tier” means Yellow or above, a quarterly purchase of at least ${fmtSlab(yellow)}.`,
    Movement: 'Narrow the retailer list to one tier-movement category. The cards, chart and summary still show every category.',
    Near: `How close to the next tier’s slab a retailer must be to be listed. ${f.near}% means up to ${f.near}% below the slab: for Yellow (${fmtSlab(yellow)}) that is ${fmtINR(yellow * (1 - f.near / 100))} up to just under ${fmtSlab(yellow)}. Allowed: 1–60%.`,
  };
}

/* ------------------------------------------------------------ tier movement categories */
export function moveHelp(yellow: string): Record<Move, string> {
  return {
    New: 'Made their first-ever purchase in this quarter.',
    'No sales': 'Bought last quarter but nothing this quarter. The amount shown is what they bought last quarter.',
    Upgraded: 'On a tier this quarter, and higher than last quarter (moving up from Untiered counts).',
    Downgraded: 'On a tier this quarter, but lower than last quarter.',
    'Stayed in same tier': 'On the same tier in both quarters.',
    'Dropped from the tier': `Bought this quarter but less than ${yellow} (Untiered), after being on a tier in some earlier quarter.`,
    'Never been on tier but some sales': `Bought this quarter, less than ${yellow}, and has never been on any tier.`,
  };
}
const MOVE_ORDER = 'Every retailer that bought in this quarter or the one before is put in exactly one category. The first rule that fits wins: New, then No sales, then the tier change, then Dropped, then Never been on tier.';

/* ------------------------------------------------------------ KPI cards */
function kpiRules(page: PageKey, c: Ctx): [RegExp, Text][] {
  const { all, q, prev, latest, yellow, m, f } = c;
  switch (page) {
    case 'overview':
      return [
        [/^Revenue, all quarters$/, `Total purchases by the retailers in your filters, over every quarter in the data (${qLabel(m.Q[0])} to ${latest}).`],
        [/ revenue$/, `Total purchases by the retailers in your filters in ${q} (its 3 months added up). ${BADGE}`],
        [/^Total retailers$/, `Every unique retailer (one per shop name and distributor) listed since the data began (${qLabel(m.Q[0])}) up to ${q}, whether or not it has ever bought. It only grows over time. ${all ? 'With “All quarters” this is the latest quarter.' : BADGE}`],
        [/^Active retailers$/, `Retailers who bought something (more than ₹0) in ${q}, counted from the monthly sales added up for the quarter. ${all ? 'With “All quarters” this is the latest quarter.' : BADGE}`],
        [/^Consistent retailers$/, `Retailers who bought something (more than ₹0) in every quarter available, from the first quarter of the data (${qLabel(m.Q[0])}) up to ${q}. The count can only fall as more quarters are added, because one missed quarter drops a retailer. ${all ? 'With “All quarters” this runs to the latest quarter.' : ''}`],
        [/^Consistent, last 4 quarters$/, `Unique retailers who bought something (more than ₹0) in each of the latest 4 completed, back-to-back quarters. A quarter is completed once its last month is over and its months are in the data, so a quarter still running is left out. The 4-quarter window moves on by itself when a newer quarter completes in the data. It does not depend on the Quarter filter; the Region, State, Distributor and Tier filters apply. The badge compares with the 4 quarters before.`],
        [/^Churned retailers$/, `Retailers who made at least one purchase in ${prev || 'the previous quarter'} and none in ${q}. The note shows what they bought in ${prev || 'the previous quarter'}. With “All quarters” this is the latest quarter. Not shown for the first quarter of data.`],
        [/^Completely new retailers$/, `Retailers whose first-ever purchase with TechnoSport was in ${q}. Retailers who bought earlier and came back are not new. Not shown for ${qLabel(m.Q[0])}, the first quarter of data, where every retailer would look new. ${all ? 'With “All quarters” this is the latest quarter. ' : ''}${BADGE}`],
        [/^Tiered/, `Retailers on any tier (Yellow or above: a quarterly purchase of at least ${yellow}) in ${all ? latest : q}. The tier uses ${basisText}. ${BADGE}`],
        [/^Revenue per active retailer$/, all
          ? 'Average purchase per buying retailer: total revenue over all quarters ÷ retailers who bought at least once.'
          : `Average purchase per buying retailer in ${q}: revenue ÷ active retailers. ${BADGE}`],
      ];
    case 'new':
      return [
        [/^New in (?!Q\d)/, 'Retailers whose first-ever purchase was in this month. Click a bar in “New retailers by month” to pick another month. The badge compares with the month before.'],
        [/^New in Q/, `Retailers whose first-ever purchase was in ${q}. The badge compares with the quarter before.`],
        [/^New, all quarters$/, `All retailers whose first purchase came after ${qLabel(m.Q[0])}, the first quarter of data.`],
        [/^Reactivated/, all
          ? 'Retailers who came back at least once: each had bought before, then had no purchase for at least a whole quarter, then bought again. The note shows how many times that happened in total.'
          : `Retailers who bought in ${q} and had bought before, but not in ${prev || 'the quarter before'} (away for at least one whole quarter). ${BADGE}`],
        [/^Sales: completely new$/, `What the completely new retailers bought ${all ? 'in the quarter they joined, over all quarters' : `in ${q}`}. The note shows how many retailers and their share of all sales.`],
        [/^Sales: reactivated$/, `What the reactivated retailers bought ${all ? 'in the quarter they came back, over all quarters' : `in ${q}`}. The note shows how many retailers and their share of all sales.`],
        [/^Bought again next quarter$/, all
          ? 'For each joining quarter: the % of its new retailers who also bought in the very next quarter. This card is the simple average of those %s.'
          : `Of the retailers who joined in ${q}, the % who also bought in the very next quarter. An early sign that new retailers will stay.`],
      ];
    case 'tier': {
      const mh = moveHelp(yellow);
      return MOVES.map((k) => [new RegExp(`^${k}$`), `${mh[k]} ${k === 'No sales' ? '' : 'The amount shown is their sales this quarter.'}`.trim()]);
    }
    case 'retention':
      return [
        [/^Bought in Q/, `Retailers who bought in the latest quarter, ${latest}.`],
        [/^Average retention$/, 'The simple average of the quarter-by-quarter retention % in the chart. Retention % = retailers who bought in both a quarter and the one before ÷ retailers who bought in the one before.'],
        [/^Dormant/, `Retailers who bought at some point but nothing in ${latest}. The amount shown is everything they bought before.`],
        [/^Active in Q/, `Retailers who bought in ${prev}. Retention is measured against this group.`],
        [/^Retained in/, `% of ${prev}’s buyers who bought again in ${q} = retained ÷ active in ${prev} × 100. Below: how many retailers that is, and what they bought in ${q}.`],
        [/^Lapsed$/, `Bought in ${prev} but nothing in ${q} (they churned). Churn % = 100 − retention %. The amount shown is what they bought in ${prev}: the revenue at risk.`],
        [/^New retailers$/, `Retailers whose first-ever purchase was in ${q} (net purchases above ₹0 that quarter). ${BADGE}`],
        [/^Reactivated retailers$/, `Retailers who bought in ${q} and had bought before, but nothing in ${prev}: away for at least a whole quarter, then back. ${BADGE}`],
        [/^Churned retailers$/, `Retailers who made at least one purchase in ${prev} and none in ${q}. The note shows what they bought in ${prev}. This is the same group as “Lapsed” above.`],
        [/^Net effective additions$/, `New + Reactivated − Churned: how much the number of buying retailers grew or shrank in ${q}. Active in ${prev} + net additions = active in ${q}.`],
        [/^Reactivated$/, `Bought in ${q}, bought nothing in ${prev}, and had bought at some point before that. Brand-new retailers are not counted here.`],
      ];
    case 'pipeline': {
      const qk = m.Q[qSel(m, f)];
      return ['Yellow', 'Green', 'Silver', 'Gold', 'Platinum'].map((t, i) => [new RegExp(`^Near ${t}$`), () => {
        if (!tierInForce(m.p, t, qk)) return `${t} starts in ${qLabel(tierFrom(m.p)[t])}, so nobody can move up to it in ${qLabel(qk)}.`;
        const slab = slabAt(m.p, t, qk);
        const from = i === 0 ? 'Untiered' : ['Yellow', 'Green', 'Silver', 'Gold'][i - 1];
        return `${from} retailers whose quarterly purchase is within ${f.near}% below the ${t} slab of ${fmtSlab(slab)}: from ${fmtINR(slab * (1 - f.near / 100))} up to just under ${fmtSlab(slab)}. They are the closest to moving up to ${t}.`;
      }]);
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------ charts and tables */
function chartHelp(c: Ctx): Record<string, string> {
  const { all, q, yellow, m } = c;
  return {
    rev: `Total purchases per month by the retailers in your filters.${all ? '' : ` The months of ${q} are highlighted.`}`,
    act: `How many retailers bought something in each month. ${ACTIVE}`,
    tier: `How many retailers were on each tier in every quarter (Untiered retailers, below ${yellow}, are not shown). The tier comes from the quarterly purchase (${basisText}) against the slabs: ${slabText(m)}.`,
    growthStack: 'Retailers who entered the buying base in each quarter transition: new (first-ever purchase) and reactivated (back after at least a quarter away), stacked, with the numbers written on the bars. Click a bar to select that quarter.',
    growthCompare: 'For every quarter: new, reactivated and churned retailers side by side. Churned = bought in the quarter before and nothing in this one.',
    growthNet: 'New + Reactivated − Churned for every quarter. A bar above zero means more retailers started buying than stopped; below zero the buying base shrank.',
    cohortTrend: 'Follows each quarter\u2019s new retailers. Period 1 is the quarter they joined (100%); Period 2, 3 … are the % of them that bought in each later quarter. A line that falls slowly means those retailers stay. The newest cohort has no later quarter yet, so it is not drawn.',
    tierRev: 'The tier mix above in rupees: for every quarter, what the retailers on each tier bought. A retailer is counted on the tier its quarterly purchase reaches (Untiered retailers are not shown). Hover a bar for the value of each tier and the total. The selected quarter is highlighted.',
    freq: 'Looks at the last 4 quarters (or fewer if the data is shorter), ending at the selected quarter or the latest one. Of the retailers who bought at least once in that window, it counts how many bought in every quarter, in some, or in just one. A quarter counts when the purchase was above ₹0.',
    newM: 'Retailers making their first-ever purchase in each month. Hover a bar for the sales value of their first month. Click a bar to select that month.',
    catCount: 'How many retailers in each quarter were completely new (first-ever purchase) and how many were reactivated (bought before, away for at least a quarter, bought again). Click a bar to select that quarter.',
    catSalesQ: 'What those two groups bought in each quarter. Hover for the exact value.',
    catSalesM: 'Monthly purchases of the two groups. A month is split by how its quarter classed each retailer, so the 3 months of a quarter add up to the quarter figure.',
    newQ: 'Retailers making their first-ever purchase in each quarter. Hover a bar for what they bought in their joining quarter. Click a bar to select that quarter.',
    moveNow: `How many retailers fell in each tier-movement category. Hover a bar for their sales in both quarters. ${MOVE_ORDER}`,
    moveSteps: `Tier-movement categories for every pair of back-to-back quarters, so you can compare quarters. ${MOVE_ORDER}`,
    ret: 'For each quarter: the % of the previous quarter’s buyers who bought again. Higher means more retailers keep coming back.',
  };
}

function tableHelp(c: Ctx): Record<string, string> {
  const { all, q, prev, latest } = c;
  return {
    breakdown: 'Revenue, active and new retailers and tier counts, grouped one level below your filter: by region, then by state once a region is picked, then by distributor once a state is picked. Highest revenue first.',
    top: all ? 'Retailers ranked by total purchases over all quarters. Click a name to open its details.' : `Retailers ranked by what they bought in ${q}. Click a name to open its details.`,
    qtrkpi: 'The four retailer KPIs for every quarter, grouped by financial year, so you can compare quarters side by side. The Region, State, Distributor and Tier filters apply; the Quarter filter does not (every quarter is listed).',
    freq: 'Retailers from the purchase-frequency chart who need a follow-up. Repeat buyers who stopped buying in the latest quarter of the window come first (win back). Then one-time buyers who bought in that latest quarter (get a second order). Then one-time buyers who have not come back.',
    newQuarter: 'Retailers who made their first-ever purchase in the selected quarter (every quarter with “All quarters”), with what they bought and their tier then and now.',
    reactRows: 'Retailers who came back: bought before, had no purchase in the quarter just before, and bought again in the quarter shown. Shows how long they were away, what they bought in the months of that quarter, and what they bought before the break and since.',
    growthAdds: 'The four numbers for every quarter transition, one column each: new, reactivated, churned, and the net effective add (new + reactivated − churned).',
    growthQoQ: 'Every quarter-to-quarter step with the four numbers side by side: new, reactivated, churned and net effective additions (new + reactivated − churned). Active last quarter + net additions = active this quarter.',
    cohortRet: 'Each row is the retailers whose first-ever purchase was in that quarter. The columns show the % of them that bought in each later quarter. Empty = that quarter is not in the data yet.',
    catQuarter: 'For every quarter: how many retailers were completely new and reactivated, what each group bought, and what the whole quarter bought for comparison.',
    catMonth: 'The same split month by month (all months, or the months of the selected quarter).',
    newMonth: 'Retailers who made their first-ever purchase in the selected month. Click a bar in “New retailers by month” to change the month.',
    newCohorts: `Each row is a group of retailers who joined in the same quarter (a cohort) and how they have done since. “Still active” and “Now tiered” are for ${latest}.`,
    newByDist: 'How many new retailers each distributor brought in, quarter by quarter.',
    moveSummary: `Every retailer that bought in ${prev} or ${q}, counted by tier-movement category, with their sales in both quarters.`,
    moveList: 'One row per retailer with its movement category, tier and sales in both quarters. Use the Movement filter to see one category.',
    tierByDist: 'For each distributor: how many of its retailers fell in each tier-movement category.',
    moveSteps: 'The same counts as the stacked chart: retailers per movement category for every pair of back-to-back quarters.',
    tierJourney: 'The tier of every retailer that reached a tier at least once, quarter by quarter, with how many times it moved up or down.',
    tierMatrix: `Rows are the tier in ${prev}; columns are the tier in ${q}. Each cell counts retailers who moved from the row tier to the column tier. The diagonal stayed put, green cells moved up and red cells moved down.`,
    retByQuarter: 'For every quarter: how many of the previous quarter’s buyers bought again (retained) or stopped (lapsed), and how many came back after a gap (reactivated).',
    retByDist: 'Retention for each distributor’s retailers, lowest retention first. Distributors at the top need the most attention.',
    lapsed: `Retailers who bought in ${prev} but nothing in ${q}, biggest buyers first. These are the ones to call.`,
    reactivated: `Retailers who came back in ${q} after buying nothing in ${prev}, and who had bought before that.`,
    dormant: `Retailers who bought before but nothing in ${latest}, the latest quarter. The most recently lapsed come first.`,
    pipeline: 'Retailers close to the next tier’s slab, smallest gap first. The gap is how much more they must buy in the quarter to move up.',
    register: 'Every retailer in your filters, highest lifetime purchases first. Search above, or click a name for its details.',
  };
}

/* ------------------------------------------------------------ columns */
const QCOL = /^Q\d_FY\d+$/;
const TCOL = /^TQ\d_FY\d+$/;

function colHelp(c: Ctx): { common: Record<string, Text>; byTable: Record<string, Record<string, Text>> } {
  const { all, q, prev, latest, yellow } = c;
  const mh = moveHelp(yellow);
  const moveCols = Object.fromEntries(MOVES.map((k) => [k, `Retailers in “${k}”: ${mh[k].charAt(0).toLowerCase()}${mh[k].slice(1)}`]));
  const tierCols = Object.fromEntries(['Platinum', 'Gold', 'Silver', 'Green', 'Yellow'].map((t) => [t, `Retailers on the ${t} tier in ${all ? latest : q}.`]));
  const retention: Record<string, Text> = {
    Base: 'Retailers who bought in the previous quarter. Retention is measured against them.',
    Kept: 'Of those, how many bought again in this quarter.',
    Rate: 'Retained ÷ active in the previous quarter × 100.',
    KeptRev: 'What the retained retailers bought in this quarter.',
    Lost: 'Bought in the previous quarter but nothing in this one (= active previous quarter − retained).',
    LostRev: 'What the lapsed retailers bought in the previous quarter: the revenue at risk.',
  };
  return {
    common: {
      ID: 'The retailer’s ID in the dashboard. There is one retailer per shop name + distributor.',
      Retailer: 'Shop name. Click it to open the retailer’s details: contacts, monthly purchases and tier history.',
      Distributor: 'The distributor this retailer buys through.',
      District: 'District from the retailer’s details.',
      City: 'City or area from the consolidated retailer information.',
      Phone: 'Main phone number.',
      AltPhone: 'Other phone numbers found for this retailer.',
      State: 'State of the retailer’s distributor.',
      Region: 'Region of the retailer’s distributor.',
      Pincode: 'Pincode of the shop.',
      Life: 'Total purchases across every month in the data.',
      Revenue: `What was bought in ${q}.`,
      Prev: `What was bought in ${prev || 'the previous quarter'}.`,
      Growth: all ? `% change in revenue from ${prev} to ${latest}. Green is up, red is down.` : `% change in revenue from ${prev} to ${q}. Green is up, red is down.`,
      Tier: 'The tier in the quarter shown in the heading, from the quarterly purchase against the slabs.',
      Best: 'The highest tier this retailer has reached in any quarter.',
      Listed: 'All retailers in this group, whether they bought or not.',
      Total: 'Sum of the columns in this row.',
      ...tierCols,
    },
    byTable: {
      breakdown: {
        Group: 'The region, state or distributor in this row.',
        Active: all ? 'Retailers who bought in at least one quarter.' : `Retailers who bought in ${q}.`,
        New: all ? 'Retailers whose first purchase came after the first quarter of data.' : `Retailers whose first-ever purchase was in ${q}.`,
        Total: 'Total purchases over all quarters.',
      },
      top: { Life: 'Total purchases over all quarters.' },
      growthQoQ: {
        Step: 'The two quarters compared.', Before: 'Retailers who bought in the first quarter of the step.', New: 'First-ever purchase in the second quarter.',
        React: 'Bought in the second quarter and earlier, but not in the first.', Churned: 'Bought in the first quarter, nothing in the second.',
        Net: 'New + Reactivated − Churned.', After: 'Retailers who bought in the second quarter.', Rate: 'Retailers who bought in both quarters ÷ retailers who bought in the first.',
        NewS: 'What the new retailers bought in the second quarter.', ReS: 'What the reactivated retailers bought in the second quarter.',
        ChS: 'What the churned retailers bought in the first quarter: the revenue that did not come back.',
      },
      cohortRet: { Cohort: 'The quarter of the first-ever purchase.', Size: 'Retailers whose first-ever purchase was in that quarter.' },
      reactRows: {
        ReactQ: 'The quarter in which the retailer bought again after a break.',
        LastBefore: 'The last quarter before the break in which it had bought.',
        Gap: 'Whole quarters without a purchase between the last purchase and coming back.',
        QRev: 'What the retailer bought in the quarter it came back (its 3 months added up).',
        Before: 'Total purchases in all months before the quarter it came back.',
        Since: 'Total purchases from the quarter it came back up to the latest data.',
        Tier: 'Tier in the quarter it came back.',
      },
      catQuarter: {
        NewN: 'Retailers whose first-ever purchase was in this quarter.', NewS: 'What those retailers bought in this quarter.',
        ReN: 'Retailers who bought in this quarter after a break of at least a quarter.', ReS: 'What those retailers bought in this quarter.',
        Both: 'Completely new plus reactivated sales.', AllS: 'Everything the retailers in your filters bought in the quarter, continuing buyers included.',
      },
      catMonth: {
        NewA: 'Completely new retailers (as classed for the quarter) who bought in this month.', NewS: 'What they bought in this month.',
        ReA: 'Reactivated retailers (as classed for the quarter) who bought in this month.', ReS: 'What they bought in this month.',
      },
      qtrkpi: {
        FY: 'The financial year (April to March) the quarter belongs to.',
        Total: 'Retailers listed up to the end of this quarter, whether or not they bought.',
        Active: 'Retailers who bought something (more than ₹0) in this quarter.',
        Growth: 'Change in active retailers compared with the quarter before.',
        Churned: 'Retailers who bought in the quarter before and nothing in this one.',
        Consistent: 'Retailers who bought in every quarter available, from the first quarter of the data up to this quarter.',
        New: 'Retailers whose first-ever purchase was in this quarter. Not shown for the first quarter of data.',
        Revenue: 'What the retailers in your filters bought in this quarter (its 3 months added up).',
      },
      freq: {
        Status: 'Why the retailer is listed. “Stopped buying: win back” = bought in 2 or more quarters but not the latest. “Bought once, this quarter: get a repeat” = only bought in the latest quarter. “Bought once, not back” = bought once earlier and not since.',
        Quarters: 'In how many quarters of the window the retailer bought.',
        Last: 'The most recent quarter in the window with a purchase.',
        Rev: 'Total purchases in the window.',
      },
      newQuarter: {
        FirstQ: 'The quarter of the first-ever purchase.',
        FirstMonth: 'The month of the first-ever purchase.',
        QRev: 'What the retailer bought in its joining quarter.',
        Tier: 'Tier in the joining quarter.',
        Repeat: 'Did the retailer also buy in the next quarter? “–” means the next quarter is not in the data yet.',
        Since: 'Total purchases from the first month until now.',
        Cur: `Tier in ${latest}, the latest quarter.`,
      },
      newMonth: {
        FirstRev: 'What the retailer bought in its first month.',
        QRev: 'What the retailer bought in the whole quarter of that month.',
        Since: 'Total purchases from the first month until now.',
        Tier: 'Tier in the quarter of that month.',
      },
      newCohorts: {
        Quarter: 'The quarter these retailers made their first purchase.',
        New: 'How many retailers joined in that quarter.',
        Rev: 'What the cohort bought in its joining quarter.',
        Repeat: '% of the cohort who also bought in the next quarter.',
        StillActive: `How many of the cohort bought in ${latest}.`,
        Tiered: `How many of the cohort are on a tier in ${latest}.`,
      },
      newByDist: { Total: 'New retailers across all quarters (the first quarter of data is not counted).' },
      moveSummary: {
        Movement: MOVE_ORDER,
        Retailers: 'Retailers in this category.',
        Share: '% of all retailers in the movement that fell in this category.',
        Cur: `Net purchases in ${q} by these retailers.`,
        Prev: `Net purchases in ${prev} by these retailers.`,
        Change: `${q} sales minus ${prev} sales.`,
      },
      moveList: {
        Movement: MOVE_ORDER,
        From: `Tier in ${prev}. Untiered means less than ${yellow} or nothing.`,
        To: `Tier in ${q}.`,
        Prev: `What the retailer bought in ${prev}.`,
        Cur: `What the retailer bought in ${q}.`,
        Change: `${q} sales minus ${prev} sales.`,
        Growth: '% change in sales between the two quarters.',
      },
      tierByDist: { ...moveCols, Total: 'Retailers in any movement category.' },
      moveSteps: { Period: 'The two back-to-back quarters compared.', ...moveCols, Total: 'Retailers in any movement category in that step.' },
      tierJourney: {
        Ups: 'How many times the tier went up from one quarter to the next.',
        Downs: 'How many times the tier went down from one quarter to the next.',
        Life: 'Total purchases over all quarters.',
      },
      tierMatrix: {
        From: `Rows: tier in ${prev}. Columns: tier in ${q}.`,
        ...Object.fromEntries(c.m.TIERS.map((t) => [t, `Retailers on ${t} in ${q}, coming from the row’s tier in ${prev}.`])),
        Total: `All retailers who were on the row’s tier in ${prev}.`,
      },
      retByQuarter: {
        ...retention,
        Quarter: 'The quarter being checked, compared with the quarter before it.',
        React: 'Bought in this quarter, nothing in the previous one, but had bought before that.',
      },
      retByDist: retention,
      lapsed: {
        Tier: `Tier in ${prev}.`,
        Prev: `What the retailer bought in ${prev}: the revenue at risk.`,
        LastMonth: 'The most recent month with any purchase in the data.',
      },
      reactivated: { Cur: `What the retailer bought in ${q}.`, Tier: `Tier in ${q}.` },
      dormant: {
        LastQ: 'The most recent quarter with a purchase.',
        LastRev: 'What the retailer bought in that quarter.',
      },
      pipeline: {
        Tier: 'Tier in the selected quarter.',
        Next: 'The tier just above.',
        Cur: `The quarterly purchase used for the tier: ${basisText}.`,
        Target: 'The minimum quarterly purchase for the next tier, in this quarter.',
        Pct: 'Quarter purchase ÷ next slab × 100.',
        Gap: 'Next slab − quarter purchase: how much more the retailer must buy this quarter to move up.',
        PerMonth: 'Gap ÷ 3: the extra purchase needed each month over a quarter.',
      },
    },
  };
}

function helpForCol(col: Col, tableId: string, h: ReturnType<typeof colHelp>): string | undefined {
  const own = h.byTable[tableId]?.[col.k];
  if (own) return typeof own === 'function' ? own(col.label) : own;
  if (TCOL.test(col.k)) return `Tier in ${col.label.replace(/ tier$/, '')}.`;
  if (QCOL.test(col.k)) return tableId === 'newByDist' ? `New retailers who joined in ${col.label}.` : `What was bought in ${col.label} (its 3 months added up).`;
  const common = h.common[col.k];
  return typeof common === 'function' ? common(col.label) : common;
}

/** The view with help texts added to its KPI cards, charts, tables and columns. The data itself is not touched. */
const SECTION_HELP: Record<string, string> = {
  growth: 'Is the buying base growing? Counts the retailers who started buying (new), came back after a break (reactivated) and stopped (churned) in every quarter, and the net result. Also follows each quarter\u2019s new retailers over the quarters after they joined.',
};

export function withHelp(page: PageKey, v: View, m: Model, f: Filters): View {
  const qi = qSel(m, f);
  const all = f.q < 0;
  // pages that compare two quarters use the latest step with "All quarters"
  const c: Ctx = { m, f, all, q: qLabel(m.Q[qi]), prev: qi > 0 ? qLabel(m.Q[qi - 1]) : '', latest: qLabel(m.Q[m.LQ]), yellow: fmtSlab(m.p.slabs.Yellow) };
  const rules = kpiRules(page, c);
  const kpiText = (k: Kpi) => {
    const hit = rules.find(([re]) => re.test(k.label));
    return hit ? (typeof hit[1] === 'function' ? hit[1](k.label) : hit[1]) : undefined;
  };
  const charts = chartHelp(c);
  const tables = tableHelp(c);
  const cols = colHelp(c);
  const withKpis = (list?: Kpi[]) => list?.map((k) => ({ ...k, help: kpiText(k) }));
  const withCharts = (list?: Chart[]) => list?.map((ch) => ({ ...ch, help: charts[ch.id] }));
  const withTables = (list: Table[]) => list.map((t) => ({ ...t, help: tables[t.id], cols: t.cols.map((col) => ({ ...col, help: helpForCol(col, t.id, cols) })) }));
  return {
    ...v,
    kpis: withKpis(v.kpis),
    charts: withCharts(v.charts),
    tables: withTables(v.tables),
    sections: v.sections?.map((s) => ({ ...s, help: SECTION_HELP[s.id], kpis: withKpis(s.kpis), charts: withCharts(s.charts), tables: withTables(s.tables) })),
  };
}

/* ------------------------------------------------------------ retailer detail panel */
export const PANEL_HELP: Record<string, string> = {
  current: 'The tier in the latest quarter, from that quarter’s purchase against the slabs.',
  best: 'The highest tier this retailer has reached in any quarter.',
  life: 'Total purchases across every month in the data.',
  first: 'The month of the first-ever purchase. The retailer counts as new in that month.',
  chart: 'This retailer’s purchases, month by month.',
  quarters: 'Purchase and tier for every quarter in the data.',
  purchase: `The quarterly purchase used for the tier: ${basisText}.`,
  tier: 'The tier the dashboard works out from the quarterly purchase.',
  sheetTier: 'The tier written in the distributor’s sheet, for comparison. It can differ from the dashboard tier.',
};
