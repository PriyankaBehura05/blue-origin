import { useMemo } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { useListQuery } from '@/hooks/useListQuery';
import { Card, ErrorBox, PageHeader, StatusBadge } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, SearchBox, SelectFilter } from '@/components/FilterBar';
import { ExportButtons } from '@/components/ExportButtons';
import { formatINR } from '@/utils/format';
import type { Distributor } from '@/types';

function buildColumns(quarter: string): Column<Distributor>[] {
  return [
    { key: 'code', header: 'Code', sortable: true, render: (d) => d.code ?? '—' },
    { key: 'name', header: 'Distributor', sortable: true, render: (d) => <strong>{d.name}</strong> },
    { key: 'state', header: 'State', sortable: true },
    { key: 'region', header: 'Region', sortable: true },
    { key: 'retailerCount', header: 'Retailers', sortable: true, align: 'right' },
    { key: 'currentQuarterSales', header: `${quarter} Net Sales`, sortable: true, align: 'right', render: (d) => formatINR(d.currentQuarterSales, true) },
    { key: 'status', header: 'Status', sortable: true, render: (d) => <StatusBadge status={d.status} /> },
  ];
}

export default function DistributorsPage() {
  const lq = useListQuery({ sortBy: 'currentQuarterSales', sortDir: 'desc' }); // highest sales first
  const opts = useAsync(() => api.getFilterOptions(), []);
  const { data, loading, error } = useAsync(() => api.getDistributors(lq.query), [lq.query]);
  const f = lq.query.filters ?? {};
  const columns = useMemo(() => buildColumns(opts.data?.currentQuarter ?? 'Quarter'), [opts.data?.currentQuarter]);
  return (
    <>
      <PageHeader
        title="Distributors"
        subtitle="Distributor network by state and region"
        actions={<ExportButtons onExport={(format) => api.exportDistributors(lq.query, format)} />}
      />
      <FilterBar onReset={lq.reset}>
        <SearchBox value={lq.searchInput} onChange={lq.setSearchInput} placeholder="Search name, code, state…" />
        <SelectFilter label="Region" value={f.region ?? ''} options={opts.data?.regions ?? []} onChange={(v) => lq.setFilter('region', v)} />
        <SelectFilter label="State" value={f.state ?? ''} options={opts.data?.states ?? []} onChange={(v) => lq.setFilter('state', v)} />
        <SelectFilter label="Status" value={f.status ?? ''} options={opts.data?.distributorStatuses ?? []} onChange={(v) => lq.setFilter('status', v)} />
      </FilterBar>
      {error && <ErrorBox message={error} />}
      <Card pad={false}>
        <DataTable columns={columns} data={data} loading={loading} query={lq.query} rowKey={(d) => d.id} onSort={lq.toggleSort} onPage={lq.setPage} />
      </Card>
    </>
  );
}
