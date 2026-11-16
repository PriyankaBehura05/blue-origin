// Platform comparison page: its own menu item next to the Overview. The card itself (PlatformComparison) is unchanged; it reads
// the saved ad data (useAdBudget) and the lead data, and follows the filter bar like every other page.
import { useAdBudget } from '../adSpend';
import { SECTIONS } from '../sections';
import { NeedsData, Section, useLeads } from '../ui';
import GtCampaigns from './GtCampaigns';
import PlatformComparison from './PlatformComparison';
import PlatformTrends from './PlatformTrends';

export default function Platforms() {
  const { M } = useLeads();
  const budget = useAdBudget(true);
  const def = SECTIONS.find((s) => s.id === 'platforms')!;
  return (
    <Section def={def} n={SECTIONS.findIndex((s) => s.id === 'platforms') + 1}>
      {M.p.hasLeads ? (
        <>
          <GtCampaigns budget={budget} />
          <PlatformComparison budget={budget} />
          <h3 className="ld-subhead">Performance trends <span>Revenue and spend analysis</span></h3>
          <PlatformTrends budget={budget} />
        </>
      ) : <NeedsData what="leads" />}
    </Section>
  );
}
