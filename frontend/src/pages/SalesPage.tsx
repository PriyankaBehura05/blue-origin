import { useEffect } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { useListQuery } from '@/hooks/useListQuery';
import { Card, ErrorBox, KpiTile, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, SearchBox, SelectFilter } from '@/components/FilterBar';
import { QUARTER_RULE, formatINR, formatMonthYear, quarterLong, quarterOptions, quartersOfFy } from '@/utils/format';
import type { SalesRecord } from '@/types';

const columns: Column<SalesRecord>[] = [
  { key: 'date', header: 'Month', sortable: true, render: (r) => formatMonthYear(r.date) },
  { key: 'retailerName', header: 'Retailer', sortable: true },
  { key: 'distributorName', header: 'Distributor', sortable: true },
  { key: 'region', header: 'Region', sortable: true },
  { key: 'grossAmount', header: 'Gross', sortable: true, align: 'right', render: (r) => formatINR(r.grossAmount) },
  { key: 'netAmount', header: 'Net', sortable: true, align: 'right', render: (r) => <strong>{formatINR(r.netAmount)}</strong> },
  { key: 'quarter', header: 'Quarter', sortable: true, render: (r) => quarterLong(r.quarter) },
];

export default function SalesPage() {
  const lq = useListQuery({ sortBy: 'date', sortDir: 'desc', pageSize: 15, waitForDefaults: true });
  const opts = useAsync(() => api.getFilterOptions(), []);
  const { applyDefaults } = lq;
  useEffect(() => {
    if (opts.data) applyDefaults({ quarter: opts.data.currentQuarter });
    else if (opts.error) applyDefaults({});
  }, [opts.data, opts.error, applyDefaults]);
  const { data, loading, error } = useAsync(() => api.getSales(lq.query), [lq.query], lq.ready);
  const f = lq.query.filters ?? {};

  const s = data?.summary;
  const tiles = s
    ? [
        { key: 'gross', label: 'Gross Sales', value: s.gross, format: 'currency' as const, deltaPct: null },
        { key: 'net', label: 'Net Sales', value: s.net, format: 'currency' as const, deltaPct: null },
      ]
    : [];

  return (
    <>
      <PageHeader title="Sales" subtitle={`Monthly sales by retailer and distributor (validated rows only). ${QUARTER_RULE}`} />
      <FilterBar onReset={lq.reset}>
        <SearchBox value={lq.searchInput} onChange={lq.setSearchInput} placeholder="Search retailer, distributor, invoice…" />
        <SelectFilter label="Financial year" value={f.fy ?? ''} options={opts.data?.financialYears ?? []} onChange={(v) => { lq.setFilter('fy', v); lq.setFilter('quarter', ''); }} />
        <SelectFilter label="Quarter" value={f.quarter ?? ''} options={quarterOptions(quartersOfFy(opts.data?.quarters ?? [], f.fy ?? ''))} onChange={(v) => lq.setFilter('quarter', v)} />
        <SelectFilter label="Region" value={f.region ?? ''} options={opts.data?.regions ?? []} onChange={(v) => lq.setFilter('region', v)} />
        <SelectFilter label="State" value={f.state ?? ''} options={opts.data?.states ?? []} onChange={(v) => lq.setFilter('state', v)} />
        <SelectFilter
          label="Distributor"
          value={f.distributorId ?? ''}
          options={(opts.data?.distributors ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => lq.setFilter('distributorId', v)}
        />
      </FilterBar>

      {error && <ErrorBox message={error} />}
      <div className="grid grid-kpi">
        {tiles.map((k) => <KpiTile key={k.key} kpi={k} showDelta={false} />)}
      </div>
      <Card pad={false}>
        <DataTable columns={columns} data={data} loading={loading} query={lq.query} rowKey={(r) => r.id} onSort={lq.toggleSort} onPage={lq.setPage} />
      </Card>
    </>
  );
}
