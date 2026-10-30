import { useState } from 'react';

// "Excel" / "CSV" buttons for a table: the download follows the table's current search, filters and sort.
export function ExportButtons({ onExport }: { onExport: (format: 'xlsx' | 'csv') => Promise<void> }) {
  const [busy, setBusy] = useState<'xlsx' | 'csv' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (format: 'xlsx' | 'csv') => {
    setBusy(format);
    setError(null);
    try {
      await onExport(format);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className="toolbar" title="Downloads every row matching the current search and filters">
      <button className="btn" disabled={busy !== null} onClick={() => run('xlsx')}>{busy === 'xlsx' ? 'Preparing…' : '⬇ Excel'}</button>
      <button className="btn" disabled={busy !== null} onClick={() => run('csv')}>{busy === 'csv' ? 'Preparing…' : '⬇ CSV'}</button>
      {error && <span className="error-text">{error}</span>}
    </span>
  );
}
