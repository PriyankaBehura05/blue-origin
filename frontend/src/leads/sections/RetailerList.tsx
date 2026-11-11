import { useMemo, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Card, MiniSelect, Section, STROKE, Table, csvRows, inr, useLeads, type Col } from '../ui';
import { SECTIONS, SOURCE_NAMES } from '../sections';
import { acquisition, health, lastBilledUpTo, monthName, retailerOk, revIn, riskRevenue, tierAt, type Health } from '../model';
import type { ActionItem } from '../types';

const STATUSES: ActionItem['status'][] = ['Not started', 'In progress', 'Done', 'Dropped'];

export default function RetailerList({ actions, setActions, save, saving, dirty }: {
  actions: ActionItem[];
  setActions: (a: ActionItem[]) => void;
  save: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  const { M, f, rg, canEdit } = useLeads();
  const [q, setQ] = useState('');
  const [hf, setHf] = useState<Health | 'all'>('At-risk');
  const R = M.p.retailers;
  const end = Math.min(rg[1], M.p.salesEnd);
  const acq = acquisition(M, f.level, f.window);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out: number[] = [];
    for (let r = 0; r < M.nR; r++) {
      if (R.first[r] < 0 || R.first[r] > end || !retailerOk(M, f, r, end)) continue;
      if (hf !== 'all' && health(M, r, end) !== hf) continue;
      if (needle && !`${R.name[r]} ${R.id[r]} ${R.phone[r]}`.toLowerCase().includes(needle)) continue;
      out.push(r);
    }
    return out;
  }, [M, f, end, q, hf, R]);

  const cols: Col<number>[] = [
    { key: 'name', label: 'Retailer', render: (r) => R.name[r], sort: (r) => R.name[r] },
    { key: 'id', label: 'ID', render: (r) => R.id[r], sort: (r) => R.id[r] },
    { key: 'dist', label: 'Distributor', render: (r) => M.p.dims.dist[R.d[r]] ?? '—', sort: (r) => M.p.dims.dist[R.d[r]] ?? '' },
    { key: 'state', label: 'State', render: (r) => M.p.dims.state[R.s[r]] ?? '—', sort: (r) => M.p.dims.state[R.s[r]] ?? '' },
    { key: 'city', label: 'City', render: (r) => (R.c[r] >= 0 ? M.p.dims.city[R.c[r]] : '—'), sort: (r) => (R.c[r] >= 0 ? M.p.dims.city[R.c[r]] : '') },
    { key: 'tier', label: 'Tier', render: (r) => M.p.dims.tiers[tierAt(M, r, end)] ?? '—', sort: (r) => tierAt(M, r, end) },
    { key: 'first', label: 'First bill', render: (r) => monthName(M, R.first[r]), sort: (r) => R.first[r] },
    { key: 'last', label: 'Last bill', render: (r) => { const l = lastBilledUpTo(M, r, end); return l >= 0 ? monthName(M, l) : '—'; }, sort: (r) => lastBilledUpTo(M, r, end) },
    { key: 'health', label: 'Health', render: (r) => health(M, r, end), sort: (r) => health(M, r, end) },
    { key: 'rev', label: 'Sales in period', num: true, render: (r) => inr(revIn(M, r, rg[0], rg[1])), sort: (r) => revIn(M, r, rg[0], rg[1]) },
    { key: 'risk', label: 'Revenue at risk', num: true, render: (r) => (health(M, r, end) === 'At-risk' ? inr(riskRevenue(M, r, end)) : '—'), sort: (r) => (health(M, r, end) === 'At-risk' ? riskRevenue(M, r, end) : 0) },
    { key: 'life', label: 'Lifetime', num: true, render: (r) => inr(R.life[r]), sort: (r) => R.life[r] },
    { key: 'src', label: 'Acquired by', render: (r) => SOURCE_NAMES[acq.src[r]], sort: (r) => acq.src[r] },
    { key: 'phone', label: 'Phone', render: (r) => R.phone[r] || '—', sort: (r) => R.phone[r] },
  ];

  const edit = (i: number, patch: Partial<ActionItem>) => setActions(actions.map((a, j) => (j === i ? { ...a, ...patch, updatedAt: undefined, updatedBy: undefined } : a)));
  const add = () => setActions([...actions, { id: `a${Date.now()}`, recommendation: '', owner: '', due: '', status: 'Not started', expected: '', achieved: '' }]);

  return (
    <Section def={SECTIONS[10]} n={11}>
      <div className="ld-grid">
        <Card title="Retailers" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          actions={<>
            <input className="ld-search" placeholder="Search name, ID or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search retailers" />
            <MiniSelect label="Health" value={hf} onChange={setHf} options={[{ value: 'all', label: 'All health' }, { value: 'Active', label: 'Active' }, { value: 'At-risk', label: 'At-risk' }, { value: 'Churned', label: 'Churned' }]} />
          </>}
          info={{ what: 'Every retailer billed up to the period end, with the global filters. Health at the period end: Active = billed in the last 2 months, At-risk = last bill 2 months before (45–90 days), Churned = 3+ months. Starts on the at-risk list.', source: 'retailers.csv, retailer_month.csv, retailer_quarter.csv' }}
          csv={{ name: `retailers_${hf}`, rows: () => csvRows(rows, cols) }}>
          <div className="ld-note" style={{ marginTop: 0, marginBottom: 6 }}>{rows.length.toLocaleString('en-IN')} retailers</div>
          <Table rows={rows} cols={cols} initialSort={{ key: hf === 'At-risk' ? 'risk' : 'rev', dir: 'desc' }} limit={20} />
        </Card>
        <Card title="Actions tracker" wide uses={[]}
          actions={canEdit ? <>
            <button type="button" className="ld-btn" onClick={add}><Plus size={14} strokeWidth={STROKE} />Add</button>
            <button type="button" className="ld-btn primary" onClick={save} disabled={!dirty || saving}><Save size={14} strokeWidth={STROKE} />{saving ? 'Saving…' : 'Save'}</button>
          </> : undefined}
          info={{ what: 'What we agreed, who owns it, by when, and whether it worked. Saved for everyone; editors and admins can change it. "+ Action" on a cover insight adds it here.', source: 'Saved in Dropbox (leads/actions.json)' }}
          csv={{ name: 'actions_tracker', rows: () => actions.map((a) => ({ Recommendation: a.recommendation, Owner: a.owner, Due: a.due, Status: a.status, 'Expected impact': a.expected, 'Achieved impact': a.achieved, 'Updated by': a.updatedBy ?? '', 'Updated at': a.updatedAt ?? '' })) }}>
          {!actions.length ? <div className="ld-empty-s">No actions yet.{canEdit ? ' Add one, or use "+ Action" on a cover insight.' : ''}</div> : (
            <div className="ld-table-wrap">
              <table className="ld-table">
                <thead><tr><th style={{ minWidth: 240 }}>Recommendation</th><th>Owner</th><th>Due</th><th>Status</th><th>Expected impact</th><th>Achieved impact</th>{canEdit && <th />}</tr></thead>
                <tbody>
                  {actions.map((a, i) => (
                    <tr key={a.id}>
                      <td>{canEdit ? <textarea className="ld-input" rows={2} value={a.recommendation} onChange={(e) => edit(i, { recommendation: e.target.value })} aria-label="Recommendation" /> : a.recommendation}</td>
                      <td>{canEdit ? <input className="ld-input" value={a.owner} onChange={(e) => edit(i, { owner: e.target.value })} aria-label="Owner" /> : a.owner}</td>
                      <td>{canEdit ? <input className="ld-input" type="date" value={a.due} onChange={(e) => edit(i, { due: e.target.value })} aria-label="Due date" /> : a.due}</td>
                      <td>{canEdit ? <select className="ld-input" value={a.status} onChange={(e) => edit(i, { status: e.target.value as ActionItem['status'] })} aria-label="Status">{STATUSES.map((s) => <option key={s}>{s}</option>)}</select> : a.status}</td>
                      <td>{canEdit ? <input className="ld-input" value={a.expected} onChange={(e) => edit(i, { expected: e.target.value })} aria-label="Expected impact" /> : a.expected}</td>
                      <td>{canEdit ? <input className="ld-input" value={a.achieved} onChange={(e) => edit(i, { achieved: e.target.value })} aria-label="Achieved impact" /> : a.achieved}</td>
                      {canEdit && <td><button type="button" className="ld-iconbtn" onClick={() => setActions(actions.filter((_, j) => j !== i))} aria-label="Delete action" title="Delete"><Trash2 size={14} strokeWidth={STROKE} /></button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Section>
  );
}
