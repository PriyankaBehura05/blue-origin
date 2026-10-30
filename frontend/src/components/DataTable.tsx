import type { ReactNode } from 'react';
import type { ListQuery, Paged } from '@/types';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
}

interface Props<T> {
  columns: Column<T>[];
  data: Paged<T> | undefined;
  loading: boolean;
  query: ListQuery;
  rowKey: (row: T) => string;
  onSort: (key: string) => void;
  onPage: (page: number) => void;
  onRowClick?: (row: T) => void;
}

export function DataTable<T extends object>({ columns, data, loading, query, rowKey, onSort, onPage, onRowClick }: Props<T>) {
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? query.pageSize ?? 15;
  const page = data?.page ?? 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <>
      <div className={`table-wrap ${loading && data ? 'loading-overlay' : ''}`}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`${c.sortable ? 'sortable' : ''} ${c.align === 'right' ? 'right' : ''}`}
                  onClick={c.sortable ? () => onSort(c.key) : undefined}
                >
                  {c.header}
                  {query.sortBy === c.key ? (query.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={rowKey(row)} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'right' : ''}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!data && loading && <div className="empty">Loading…</div>}
        {data && data.items.length === 0 && <div className="empty">No records match the current filters.</div>}
      </div>
      <div className="table-foot">
        <span>{total === 0 ? '0 records' : `${from}–${to} of ${total.toLocaleString('en-IN')} records`}</span>
        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => onPage(1)}>«</button>
          <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
          <span>Page {page} / {pages}</span>
          <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
          <button className="btn" disabled={page >= pages} onClick={() => onPage(pages)}>»</button>
        </div>
      </div>
    </>
  );
}
