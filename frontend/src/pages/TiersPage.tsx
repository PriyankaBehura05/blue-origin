import { useMemo, useState } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { useListQuery } from '@/hooks/useListQuery';
import { Card, ErrorBox, Loading, PageHeader, StatusBadge, TierBadge } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, SearchBox, SelectFilter } from '@/components/FilterBar';
import { RetailerDetail } from '@/components/RetailerDetail';
import { QUARTER_RULE, formatINR, formatNumber, quarterLong, quarterMonths, quarterOptions, quartersOfFy } from '@/utils/format';
import type { TierMovement } from '@/types';

function buildColumns(quarter: string, previous: string): Column<TierMovement>[] {
  return [
    { key: 'retailerCode', header: 'Code', sortable: true, render: (m) => m.retailerCode ?? '—' },
    { key: 'retailerName', header: 'Retailer', sortable: true, render: (m) => <strong>{m.retailerName}</strong> },
    { key: 'distributorName', header: 'Distributor', sortable: true },
    { key: 'region', header: 'Region', sortable: true },
    { key: 'to', header: `Tier ${quarter}`, sortable: true, render: (m) => <TierBadge tier={m.to} /> },
    { key: 'quarterlySales', header: `${quarter} Net Sales`, sortable: true, align: 'right', render: (m) => <strong>{formatINR(m.quarterlySales)}</strong> },
    { key: 'from', header: `Tier ${previous}`, sortable: true, render: (m) => <TierBadge tier={m.from} /> },
    { key: 'previousQuarterSales', header: `${previous} Net Sales`, sortable: true, align: 'right', render: (m) => formatINR(m.previousQuarterSales) },
    { key: 'direction', header: 'Movement', sortable: true, render: (m) => <StatusBadge status={m.direction} /> },
  ];
}

function TierMixTable({ tiers, fy }: { tiers: string[]; fy: string }) {
  const mix = useAsync(() => api.getTierMix(fy || undefined), [fy]);
  if (mix.error) return <ErrorBox message={mix.error} />;
  if (!mix.data) return <Loading />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Quarter</th>
            {tiers.map((t) => <th key={t} className="right"><TierBadge tier={t} /></th>)}
            <th className="right">Tiered</th><th className="right">Buying retailers</th><th className="right">Net sales</th>
          </tr>
        </thead>
        <tbody>
          {mix.data.map((r) => (
            <tr key={r.quarter}>
              <td><strong>{quarterLong(r.quarter)}</strong></td>
              {tiers.map((t) => <td key={t} className="right" title={r.counts[t] == null ? `No ${t} tier in this quarter` : undefined}>{r.counts[t] == null ? '—' : formatNumber(r.counts[t])}</td>)}
              <td className="right">{formatNumber(r.tieredRetailers)}</td>
              <td className="right">{formatNumber(r.buyingRetailers)}</td>
              <td className="right">{formatINR(r.netSales, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PLATINUM = 'Platinum';

// Every Platinum member of the selected quarter (all rows, no paging); a row opens the full retailer profile.
function PlatinumMembers({ quarter, label, inForce }: { quarter: string; label: string; inForce: boolean }) {
  const lq = useListQuery({ sortBy: 'quarterlySales', sortDir: 'desc', pageSize: 500 });
  const query = useMemo(() => ({ ...lq.query, filters: { ...(lq.query.filters ?? {}), quarter, tier: PLATINUM } }), [lq.query, quarter]);
  const { data, loading, error } = useAsync(() => api.getTierMovements(query), [query], inForce);
  const [selected, setSelected] = useState<string | null>(null);
  const total = data?.items.reduce((t, m) => t + m.quarterlySales, 0) ?? 0;
  const columns: Column<TierMovement>[] = [
    { key: 'retailerCode', header: 'Code', sortable: true, render: (m) => m.retailerCode ?? '—' },
    { key: 'retailerName', header: 'Retailer', sortable: true, render: (m) => <strong>{m.retailerName}</strong> },
    { key: 'distributorName', header: 'Distributor', sortable: true },
    { key: 'city', header: 'City', sortable: true },
    { key: 'state', header: 'State', sortable: true },
    { key: 'region', header: 'Region', sortable: true },
    { key: 'status', header: 'Status', sortable: true, render: (m) => (m.status ? <StatusBadge status={m.status} /> : '—') },
    { key: 'quarterlySales', header: `${label} Net Sales`, sortable: true, align: 'right', render: (m) => <strong>{formatINR(m.quarterlySales)}</strong> },
    { key: 'from', header: 'Previous tier', sortable: true, render: (m) => <TierBadge tier={m.from} /> },
    { key: 'previousQuarterSales', header: 'Previous quarter', sortable: true, align: 'right', render: (m) => formatINR(m.previousQuarterSales) },
    { key: 'direction', header: 'Movement', sortable: true, render: (m) => <StatusBadge status={m.direction} /> },
  ];
  if (!inForce) {
    return (
      <Card title={`Platinum members — ${label}`}>
        <div className="note">The Platinum tier starts in Q1 FY 27 (April 2026). Up to Q4 FY 26 the highest tier is Gold, so {label} has no Platinum members.</div>
      </Card>
    );
  }
  return (
    <Card title={`Platinum members — ${label}${data ? ` (${formatNumber(data.total)} retailers, ${formatINR(total, true)})` : ''}`} pad={false}>
      <div style={{ padding: '0 16px 12px' }}>
        <SearchBox value={lq.searchInput} onChange={lq.setSearchInput} placeholder="Search Platinum member, code or distributor…" />
        <span className="note" style={{ marginLeft: 12 }}>Click a member to see all of its sales records, details and benefits.</span>
      </div>
      {error && <ErrorBox message={error} />}
      <DataTable columns={columns} data={data} loading={loading} query={lq.query} rowKey={(m) => m.retailerId} onSort={lq.toggleSort} onPage={lq.setPage} onRowClick={(m) => setSelected(m.retailerId)} />
      {selected && <RetailerDetail id={selected} quarter={label} onClose={() => setSelected(null)} />}
    </Card>
  );
}

export default function TiersPage() {
  const opts = useAsync(() => api.getFilterOptions(), []);
  const lq = useListQuery({ sortBy: 'quarterlySales', sortDir: 'desc' });
  const [fy, setFy] = useState('');
  const f = lq.query.filters ?? {};
  const fyQuarters = quartersOfFy(opts.data?.salesQuarters ?? [], fy);
  const chooseFy = (v: string) => {
    setFy(v);
    lq.setFilter('quarter', v ? quartersOfFy(opts.data?.salesQuarters ?? [], v)[0] ?? '' : ''); // latest quarter of that FY
  };
  const quarter = f.quarter || opts.data?.currentQuarter || '';
  const defs = useAsync(() => api.getTierDefinitions(f.quarter || undefined), [f.quarter]);
  const { data, loading, error } = useAsync(() => api.getTierMovements(lq.query), [lq.query]);
  const previous = data?.items[0]?.previousQuarter ?? (quarter === opts.data?.currentQuarter ? opts.data?.previousQuarter ?? '' : 'previous quarter');
  const columns = useMemo(() => buildColumns(quarter || 'Quarter', previous || 'Previous'), [quarter, previous]);
  const ladder = defs.data ? [...defs.data].reverse() : [];
  // every tier, highest first (the ladder above only has the tiers in force in the selected quarter)
  const allTiers = [...(opts.data?.tiers ?? []).filter((t) => t !== 'Unranked')].reverse().concat(opts.data ? ['Unranked'] : []);

  return (
    <>
      <PageHeader title="Tiers" subtitle={`Tier ladder, retailer tiers and sales for every quarter (tiers are based on each quarter's net sales). Platinum applies from Q1 FY 27 (April 2026); before that Gold is the top tier. Silver is ₹2.5 L – 5 L up to Q1 FY 27 and ₹3 L – 5 L from Q2 FY 27 (July 2026), when Green runs up to ₹3 L; the tier cards show the ranges of the selected quarter. ${QUARTER_RULE}`} />
      <FilterBar>
        <SelectFilter label="Financial year" value={fy} options={opts.data?.financialYears ?? []} onChange={chooseFy} />
        <SelectFilter
          label="Quarter"
          value={f.quarter ?? ''}
          options={quarterOptions(fyQuarters)}
          emptyLabel={opts.data ? `Latest — ${opts.data.currentQuarter} (${quarterMonths(opts.data.currentQuarter)})` : 'Latest'}
          onChange={(v) => lq.setFilter('quarter', v)}
        />
        <span className="note">Tier cards and the retailer table below show {quarter || 'the latest quarter'}.</span>
      </FilterBar>

      {defs.error && <ErrorBox message={defs.error} />}
      {!defs.data ? (
        !defs.error && <Loading />
      ) : (
        <div className="grid grid-kpi">
          {ladder.map((t) => (
            <div key={t.tier} className="card tier-card" style={{ ['--tier' as string]: t.color }}>
              <h3><TierBadge tier={t.tier} /></h3>
              <div className="tier-range">
                {t.maxQuarterlySales === null
                  ? `Above ${formatINR(t.minQuarterlySales, true)} / qtr`
                  : `${formatINR(t.minQuarterlySales, true)} – ${formatINR(t.maxQuarterlySales, true)} / qtr`}
              </div>
              <div className="tier-count">{formatNumber(t.retailerCount)}</div>
              <div className="note">retailers in {quarter} · {t.description}</div>
            </div>
          ))}
        </div>
      )}

      <FilterBar onReset={lq.reset}>
        <SearchBox value={lq.searchInput} onChange={lq.setSearchInput} placeholder="Search retailer, code or distributor…" />
        <SelectFilter label="Tier" value={f.tier ?? ''} options={opts.data?.tiers ?? []} onChange={(v) => lq.setFilter('tier', v)} />
        <SelectFilter label="Movement" value={f.direction ?? ''} options={opts.data?.movementDirections ?? []} onChange={(v) => lq.setFilter('direction', v)} />
        <SelectFilter label="Region" value={f.region ?? ''} options={opts.data?.regions ?? []} onChange={(v) => lq.setFilter('region', v)} />
      </FilterBar>
      {error && <ErrorBox message={error} />}
      <Card title={`Retailer tiers — ${quarter}${previous ? ` vs ${previous}` : ''}`} pad={false}>
        <DataTable columns={columns} data={data} loading={loading} query={lq.query} rowKey={(m) => m.retailerId} onSort={lq.toggleSort} onPage={lq.setPage} />
      </Card>

      {defs.data && <PlatinumMembers quarter={f.quarter ?? ''} label={quarter} inForce={defs.data.some((t) => t.tier === PLATINUM)} />}

      <Card title={fy ? `Tier mix — ${fy} quarters` : 'Tier mix — all quarters'} pad={false}>
        <TierMixTable tiers={allTiers.length ? allTiers : ladder.map((t) => t.tier)} fy={fy} />
      </Card>
    </>
  );
}
