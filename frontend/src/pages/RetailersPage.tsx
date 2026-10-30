import { useMemo, useState } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { useListQuery } from '@/hooks/useListQuery';
import { Card, ErrorBox, PageHeader, StatusBadge, TierBadge } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, SearchBox, SelectFilter } from '@/components/FilterBar';
import { RetailerDetail } from '@/components/RetailerDetail';
import { ExportButtons } from '@/components/ExportButtons';
import { formatINR } from '@/utils/format';
import type { Retailer } from '@/types';

function buildColumns(quarter: string): Column<Retailer>[] {
  return [
    { key: 'code', header: 'Code', sortable: true, render: (r) => r.code ?? '—' },
    { key: 'name', header: 'Retailer', sortable: true, render: (r) => <strong>{r.name}</strong> },
    { key: 'distributorName', header: 'Distributor', sortable: true },
    { key: 'city', header: 'City', sortable: true },
    { key: 'region', header: 'Region', sortable: true },
    { key: 'currentTier', header: 'Tier', sortable: true, render: (r) => <TierBadge tier={r.currentTier} /> },
    { key: 'movement', header: 'Movement', sortable: true, render: (r) => <StatusBadge status={r.movement} /> },
    { key: 'currentQuarterSales', header: `${quarter} Net Sales`, sortable: true, align: 'right', render: (r) => formatINR(r.currentQuarterSales) },
    { key: 'fySales', header: 'FY Net Sales', sortable: true, align: 'right', render: (r) => formatINR(r.fySales, true) },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
  ];
}

export default function RetailersPage() {
  const lq = useListQuery({ sortBy: 'currentQuarterSales', sortDir: 'desc' });
  const opts = useAsync(() => api.getFilterOptions(), []);
  const { data, loading, error } = useAsync(() => api.getRetailers(lq.query), [lq.query]);
  const [selected, setSelected] = useState<string | null>(null);
  const f = lq.query.filters ?? {};
  const quarter = opts.data?.currentQuarter ?? 'Quarter';
  const columns = useMemo(() => buildColumns(quarter), [quarter]);

  return (
    <>
      <PageHeader
        title="Retailers"
        subtitle="Retailer master with tier, geography and distributor mapping"
        actions={<ExportButtons onExport={(format) => api.exportRetailers(lq.query, format)} />}
      />
      <FilterBar onReset={lq.reset}>
        <SearchBox value={lq.searchInput} onChange={lq.setSearchInput} placeholder="Search name, code, city, pincode…" />
        <SelectFilter label="Region" value={f.region ?? ''} options={opts.data?.regions ?? []} onChange={(v) => lq.setFilter('region', v)} />
        <SelectFilter label="State" value={f.state ?? ''} options={opts.data?.states ?? []} onChange={(v) => lq.setFilter('state', v)} />
        <SelectFilter label="Tier" value={f.tier ?? ''} options={opts.data?.tiers ?? []} onChange={(v) => lq.setFilter('tier', v)} />
        <SelectFilter label="Tier movement" value={f.movement ?? ''} options={opts.data?.movementDirections ?? []} onChange={(v) => lq.setFilter('movement', v)} />
        <SelectFilter label="Status" value={f.status ?? ''} options={opts.data?.retailerStatuses ?? []} onChange={(v) => lq.setFilter('status', v)} />
        <SelectFilter label="Distributor" value={f.distributorId ?? ''} options={(opts.data?.distributors ?? []).map((d) => ({ value: d.id, label: d.name }))} onChange={(v) => lq.setFilter('distributorId', v)} />
      </FilterBar>
      {error && <ErrorBox message={error} />}
      <Card pad={false}>
        <DataTable columns={columns} data={data} loading={loading} query={lq.query} rowKey={(r) => r.id} onSort={lq.toggleSort} onPage={lq.setPage} onRowClick={(r) => setSelected(r.id)} />
      </Card>
      {selected && <RetailerDetail id={selected} quarter={quarter} onClose={() => setSelected(null)} />}
    </>
  );
}
