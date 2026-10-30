import { useEffect, useMemo, useState } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { useListQuery } from '@/hooks/useListQuery';
import { Card, EmptyState, ErrorBox, KpiTile, PageHeader, StatusBadge, TierBadge } from '@/components/ui';
import { EMPTY_PAGES, EMPTY_PAGE_NOTE } from '@/config/pages';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, SearchBox, SelectFilter } from '@/components/FilterBar';
import { RecordForm, num, optNum, optStr, str, type FieldDef, type FormValues } from '@/components/RecordForm';
import { formatDate, formatINR, quarterLong, quarterOptions, quartersOfFy } from '@/utils/format';
import type { Benefit, BenefitFulfillment, FilterOptions } from '@/types';

const benefitCols: Column<Benefit>[] = [
  { key: 'id', header: 'ID', sortable: true },
  { key: 'name', header: 'Benefit', sortable: true, render: (b) => <strong>{b.name}</strong> },
  { key: 'tier', header: 'Tier', sortable: true, render: (b) => <TierBadge tier={b.tier} /> },
  { key: 'frequency', header: 'Frequency', sortable: true },
  { key: 'quantity', header: 'Qty', sortable: true, align: 'right' },
  { key: 'unitCost', header: 'Unit Cost', sortable: true, align: 'right', render: (b) => formatINR(b.unitCost) },
  { key: 'description', header: 'Description' },
];

const fulfilCols: Column<BenefitFulfillment>[] = [
  { key: 'retailerName', header: 'Retailer', sortable: true, render: (f) => <strong>{f.retailerName}</strong> },
  { key: 'benefitName', header: 'Benefit', sortable: true },
  { key: 'tier', header: 'Tier', sortable: true, render: (f) => <TierBadge tier={f.tier} /> },
  { key: 'quarter', header: 'Quarter', sortable: true, render: (r) => quarterLong(r.quarter) },
  { key: 'plannedDate', header: 'Planned', sortable: true, render: (f) => formatDate(f.plannedDate) },
  { key: 'actualDate', header: 'Actual', sortable: true, render: (f) => formatDate(f.actualDate) },
  { key: 'status', header: 'Status', sortable: true, render: (f) => <StatusBadge status={f.status} /> },
  { key: 'cost', header: 'Cost', sortable: true, align: 'right', render: (f) => formatINR(f.cost) },
];

function benefitFields(o: FilterOptions | undefined): FieldDef[] {
  return [
    { name: 'name', label: 'Benefit name', required: true },
    { name: 'tier', label: 'Eligible tier', type: 'select', required: true, options: o?.tiers ?? [] },
    { name: 'frequency', label: 'Frequency', type: 'select', options: o?.benefitFrequencies ?? [] },
    { name: 'quantity', label: 'Quantity', type: 'number' },
    { name: 'unitCost', label: 'Unit cost (₹)', type: 'number' },
    { name: 'description', label: 'Description', type: 'textarea' },
  ];
}

function fulfilmentFields(o: FilterOptions | undefined): FieldDef[] {
  return [
    { name: 'retailerId', label: 'Retailer', type: 'select', required: true, options: (o?.retailers ?? []).map((r) => ({ value: r.id, label: r.name })) },
    { name: 'benefitId', label: 'Benefit', type: 'select', required: true, options: (o?.benefits ?? []).map((b) => ({ value: b.id, label: b.name })) },
    { name: 'plannedDate', label: 'Planned date', type: 'date', required: true },
    { name: 'status', label: 'Status', type: 'select', options: (o?.fulfillmentStatuses ?? []).filter((x) => x !== 'Overdue'), hint: 'Overdue is set automatically after the planned date.' },
    { name: 'actualDate', label: 'Actual date', type: 'date', hint: 'Setting this marks the benefit fulfilled.' },
    { name: 'cost', label: 'Cost (₹)', type: 'number', hint: 'Blank = benefit quantity × unit cost' },
  ];
}

function CatalogTab({ opts, onChanged }: { opts: FilterOptions | undefined; onChanged: () => void }) {
  const lq = useListQuery({ sortBy: 'tier', sortDir: 'asc', pageSize: 20 });
  const list = useAsync(() => api.getBenefits(lq.query), [lq.query]);
  const [editing, setEditing] = useState<Benefit | 'new' | null>(null);
  const catalogCols = useMemo<Column<Benefit>[]>(
    () => [...benefitCols, {
      key: 'actions', header: '', align: 'right',
      render: (b) => (
        <button className="btn" onClick={(e) => { e.stopPropagation(); setEditing(b); }}>✎ Edit</button>
      ),
    }],
    [],
  );
  const f = lq.query.filters ?? {};

  const save = async (v: FormValues) => {
    const input = { name: v.name, tier: v.tier, frequency: optStr(v.frequency), quantity: num(v.quantity, 1), unitCost: num(v.unitCost), description: optStr(v.description) };
    if (editing === 'new') await api.createBenefit(input);
    else if (editing) await api.updateBenefit(editing.id, input);
    list.reload();
    onChanged();
  };

  return (
    <>
      <FilterBar onReset={lq.reset}>
        <SearchBox value={lq.searchInput} onChange={lq.setSearchInput} placeholder="Search benefit…" />
        <SelectFilter label="Tier" value={f.tier ?? ''} options={opts?.tiers ?? []} onChange={(v) => lq.setFilter('tier', v)} />
        <SelectFilter label="Frequency" value={f.frequency ?? ''} options={opts?.benefitFrequencies ?? []} onChange={(v) => lq.setFilter('frequency', v)} />
        <button className="btn primary" onClick={() => setEditing('new')}>+ New benefit</button>
      </FilterBar>
      {list.error && <ErrorBox message={list.error} />}
      <Card pad={false}>
        <DataTable columns={catalogCols} data={list.data} loading={list.loading} query={lq.query} rowKey={(b) => b.id} onSort={lq.toggleSort} onPage={lq.setPage} onRowClick={(b) => setEditing(b)} />
      </Card>
      {editing && (
        <RecordForm
          title={editing === 'new' ? 'New benefit' : `Edit ${editing.name}`}
          fields={benefitFields(opts)}
          initial={editing === 'new' ? { quantity: '1' } : {
            name: editing.name, tier: editing.tier, frequency: str(editing.frequency), quantity: str(editing.quantity),
            unitCost: str(editing.unitCost), description: str(editing.description),
          }}
          onSubmit={save}
          onDelete={editing === 'new' ? undefined : async () => { await api.deleteBenefit(editing.id); list.reload(); onChanged(); }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function FulfilmentTab({ opts, optsError }: { opts: FilterOptions | undefined; optsError: string | null }) {
  const lq = useListQuery({ sortBy: 'plannedDate', sortDir: 'desc', waitForDefaults: true });
  const { applyDefaults } = lq;
  useEffect(() => {
    if (opts) applyDefaults({ quarter: opts.currentQuarter });
    else if (optsError) applyDefaults({});
  }, [opts, optsError, applyDefaults]);
  const list = useAsync(() => api.getFulfillments(lq.query), [lq.query], lq.ready);
  const [editing, setEditing] = useState<BenefitFulfillment | 'new' | null>(null);
  const f = lq.query.filters ?? {};
  const s = list.data?.summary;
  const tiles = [
    { key: 'cost', label: 'Benefit Cost (filtered)', value: s?.cost ?? 0, format: 'currency' as const },
    { key: 'ful', label: 'Fulfilled', value: s?.fulfilled ?? 0, format: 'number' as const },
    { key: 'pend', label: 'Planned / In Progress', value: s?.pending ?? 0, format: 'number' as const },
    { key: 'over', label: 'Overdue', value: s?.overdue ?? 0, format: 'number' as const },
  ];

  const save = async (v: FormValues) => {
    const input = { retailerId: v.retailerId, benefitId: v.benefitId, plannedDate: v.plannedDate, actualDate: optStr(v.actualDate), status: optStr(v.status), cost: optNum(v.cost) };
    if (editing === 'new') await api.createFulfillment(input);
    else if (editing) await api.updateFulfillment(editing.id, input);
    list.reload();
  };

  return (
    <>
      <div className="grid grid-kpi">
        {tiles.map((t) => <KpiTile key={t.key} kpi={{ ...t, deltaPct: null }} showDelta={false} />)}
      </div>
      <FilterBar onReset={lq.reset}>
        <SearchBox value={lq.searchInput} onChange={lq.setSearchInput} placeholder="Search retailer or benefit…" />
        <SelectFilter label="Financial year" value={f.fy ?? ''} options={opts?.financialYears ?? []} onChange={(v) => { lq.setFilter('fy', v); lq.setFilter('quarter', ''); }} />
        <SelectFilter label="Quarter" value={f.quarter ?? ''} options={quarterOptions(quartersOfFy(opts?.quarters ?? [], f.fy ?? ''))} onChange={(v) => lq.setFilter('quarter', v)} />
        <SelectFilter label="Tier" value={f.tier ?? ''} options={opts?.tiers ?? []} onChange={(v) => lq.setFilter('tier', v)} />
        <SelectFilter label="Status" value={f.status ?? ''} options={opts?.fulfillmentStatuses ?? []} onChange={(v) => lq.setFilter('status', v)} />
        <button className="btn primary" onClick={() => setEditing('new')} disabled={!opts?.benefits.length}>+ Plan benefit</button>
      </FilterBar>
      {list.error && <ErrorBox message={list.error} />}
      <Card pad={false}>
        <DataTable columns={fulfilCols} data={list.data} loading={list.loading} query={lq.query} rowKey={(r) => r.id} onSort={lq.toggleSort} onPage={lq.setPage} onRowClick={(r) => setEditing(r)} />
      </Card>
      {editing && (
        <RecordForm
          title={editing === 'new' ? 'Plan a benefit' : `${editing.benefitName} — ${editing.retailerName}`}
          fields={fulfilmentFields(opts)}
          initial={editing === 'new' ? {} : {
            retailerId: editing.retailerId, benefitId: editing.benefitId, plannedDate: editing.plannedDate,
            actualDate: str(editing.actualDate), status: editing.status === 'Overdue' ? '' : editing.status, cost: str(editing.cost),
          }}
          onSubmit={save}
          onDelete={editing === 'new' ? undefined : async () => { await api.deleteFulfillment(editing.id); list.reload(); }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

export default function BenefitsPage() {
  if (EMPTY_PAGES.benefits) {
    return (
      <>
        <PageHeader title="Benefits" subtitle="Tier benefit catalogue and fulfilment tracking" />
        <EmptyState title="Nothing to show yet">{EMPTY_PAGE_NOTE}</EmptyState>
      </>
    );
  }
  return <BenefitsTabs />;
}

function BenefitsTabs() {
  const [tab, setTab] = useState<'fulfilment' | 'catalog'>('fulfilment');
  const opts = useAsync(() => api.getFilterOptions(), []);
  return (
    <>
      <PageHeader title="Benefits" subtitle="Tier benefit catalogue and fulfilment tracking" />
      <div className="tabs">
        <button className={`tab ${tab === 'fulfilment' ? 'active' : ''}`} onClick={() => setTab('fulfilment')}>Fulfilment</button>
        <button className={`tab ${tab === 'catalog' ? 'active' : ''}`} onClick={() => setTab('catalog')}>Benefit catalogue</button>
      </div>
      {opts.error && <ErrorBox message={opts.error} />}
      {tab === 'fulfilment' ? <FulfilmentTab opts={opts.data} optsError={opts.error} /> : <CatalogTab opts={opts.data} onChanged={opts.reload} />}
    </>
  );
}
