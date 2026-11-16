// Campaign comparison: every campaign on Meta and Google with budget, spend, budget used, reach, impressions, clicks, CTR, CPC,
// leads, CPL and ROAS for the selected period - campaign by campaign, combined per platform, and all together. One calculation
// for the whole dashboard (gt.ts); shown on the Overview, Campaign performance and Platform comparison pages.
import { useMemo } from 'react';
import { HelpTip } from '@/components/HelpTip';
import { cpcOf, cplOf, cpmOf, ctrOf, freqOf, gtSummary, leadRateOf, roasOf, utilOf, type GtLine } from '../gt';
import { objectiveName } from '../adSpend';
import type { BudgetPayload } from '../types';
import { Card, inr, num, useLeads } from '../ui';

const dash = (v: number | null, f: (n: number) => string, none = '—') => (v === null ? none : f(v));
const cmpTxt = (l: GtLine) => cpmOf(l)?.toFixed(2) ?? '';

export default function GtCampaigns({ budget, title = 'Campaign comparison' }: { budget: BudgetPayload | null; title?: string }) {
  const { M, f, rg } = useLeads();
  const s = useMemo(() => gtSummary(budget, M, f, rg), [budget, M, f, rg]);
  const noSales = rg[0] > M.p.salesEnd;
  const csv = () => s.lines.map((l: GtLine) => ({
    Platform: l.platform, Campaign: l.name, Row: l.kind === 'campaign' ? 'Campaign' : l.kind === 'platform' ? 'Platform total' : 'Overall total',
    Status: l.status ?? '', 'Daily budget': l.dailyBudget ?? '', 'Budget (period)': l.budget ?? '', Spend: Math.round(l.spend),
    'Campaign ID': l.campaignId ?? '', 'Objective / type': l.objective ? objectiveName(l.objective) : '',
    'Budget used %': utilOf(l)?.toFixed(1) ?? '', Reach: l.reach === null ? '' : Math.round(l.reach), Frequency: freqOf(l)?.toFixed(2) ?? '', Impressions: l.impressions, Clicks: l.clicks,
    'CTR %': ctrOf(l)?.toFixed(2) ?? '', CPC: cpcOf(l)?.toFixed(2) ?? '', CPM: cmpTxt(l), Leads: l.leads, 'Lead rate % (leads per click)': leadRateOf(l)?.toFixed(2) ?? '', CPL: cplOf(l)?.toFixed(2) ?? 'N/A',
    'Attributed BO sales': l.revenue ?? '', ROAS: roasOf(l)?.toFixed(2) ?? '',
  }));

  return (
    <Card wide title={title} uses={['period', 'source', 'campaign']}
      info={{ what: <>Every lead-generation campaign of the GT team on Meta and Google: campaign rows, the combined total of each platform, and the overall total. Leads are the platforms&apos; own counts ({Object.entries(s.leadsBasis).map(([p, b]) => `${p}: ${b}`).join('; ')}). Reach counts people, so it does not add up: a platform&apos;s combined reach is its own de-duplicated figure; “≈” marks reach added over several months; Google reports no reach. ROAS = BO sales from the retailers the campaign&apos;s leads brought in or back ÷ spend.</>,
        formula: 'CPL = spend ÷ leads (N/A with no leads) · CTR = clicks ÷ impressions × 100 · CPC = spend ÷ clicks · CPM = spend ÷ impressions × 1000 · frequency = impressions ÷ reach · lead rate = leads ÷ clicks · budget used = spend ÷ budget × 100 · totals add spend and leads first, never average CPLs',
        source: `Meta and Google, as saved on the Ad budget page${s.saved ? ` (${s.saved.slice(0, 16).replace('T', ' ')})` : ''}` }}
      csv={{ name: 'campaign_comparison', rows: csv }}
      soWhat={s.googleAllConversions ? 'Google leads are still all conversions: run the updated Google Ads script (backend/docs/google_ads_to_sheet.js) to count only the “Conversion” action.' : noSales ? 'ROAS needs BO sales data, which does not reach this period yet.' : undefined}>
      {!s.lines.length ? <div className="ld-empty-s">No campaign data saved yet for these filters. An admin can fetch it on the Ad budget page.</div> : (
        <div className="ld-table-wrap">
          <table className="ld-table ld-gt">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Campaign</th>
                <th className="num">Budget <HelpTip text="Budget for the period: daily budget × the days the campaign actually spent in the period (today's daily budget below). Meta and Google keep no budget history." /></th>
                <th className="num">Spend</th>
                <th className="num">Budget used</th>
                <th className="num">Reach</th>
                <th className="num">Frequency <HelpTip text="Impressions ÷ reach: how many times the average person saw the ads. Shown when reach is exact (the whole campaign life or one month); Google reports no reach." /></th>
                <th className="num">Impressions</th>
                <th className="num">Clicks</th>
                <th className="num">CTR</th>
                <th className="num">CPC</th>
                <th className="num">CPM <HelpTip text="Cost per 1,000 impressions." /></th>
                <th className="num">Leads</th>
                <th className="num">Lead rate <HelpTip text="Leads ÷ clicks: how many clicks turn into a lead. For Google this is the conversion rate." /></th>
                <th className="num">CPL</th>
                <th className="num">ROAS</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={l.key} className={l.kind === 'campaign' ? '' : `ld-gt-${l.kind}`}>
                  <td>{l.kind === 'campaign' && <i className={`ld-dot ${l.platform === 'Meta' ? 'meta' : 'google'}`} />}{l.platform === 'All' ? 'Meta + Google' : l.platform}</td>
                  <td>{l.name}{l.kind === 'campaign' ? <div className="ld-muted">{[l.status, l.objective ? objectiveName(l.objective) : null, l.campaignId ? `ID ${l.campaignId}` : null].filter(Boolean).join(' · ')}</div> : null}</td>
                  <td className="num">{dash(l.budget, inr)}{l.dailyBudget ? <div className="ld-muted">{inr(l.dailyBudget)}/day</div> : null}</td>
                  <td className="num">{inr(l.spend)}</td>
                  <td className="num">{dash(utilOf(l), (v) => `${v.toFixed(0)}%`)}</td>
                  <td className="num">{l.reach === null ? '—' : `${l.reachApprox ? '≈ ' : ''}${num(Math.round(l.reach))}`}</td>
                  <td className="num">{dash(freqOf(l), (v) => v.toFixed(2))}</td>
                  <td className="num">{num(Math.round(l.impressions))}</td>
                  <td className="num">{num(Math.round(l.clicks))}</td>
                  <td className="num">{dash(ctrOf(l), (v) => `${v.toFixed(2)}%`)}</td>
                  <td className="num">{dash(cpcOf(l), (v) => `₹${v.toFixed(2)}`)}</td>
                  <td className="num">{dash(cpmOf(l), (v) => `₹${v.toFixed(2)}`)}</td>
                  <td className="num">{num(Math.round(l.leads))}</td>
                  <td className="num">{dash(leadRateOf(l), (v) => `${v.toFixed(2)}%`)}</td>
                  <td className="num"><b>{dash(cplOf(l), (v) => `₹${v.toFixed(0)}`, 'N/A')}</b></td>
                  <td className="num">{dash(roasOf(l), (v) => `${v.toFixed(2)}×`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
