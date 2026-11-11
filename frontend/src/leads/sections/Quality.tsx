import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileText, Link2, Plus, RefreshCw, Save, Sheet, Trash2, Upload } from 'lucide-react';
import { Card, NeedsData, Pct, Section, STROKE, Table, inr, num, useLeads } from '../ui';
import { StackedBars } from '../charts';
import { OUTCOME_COLORS, SECTIONS } from '../sections';
import { LEVEL_NAMES, leadOk, monthName, outcomeOf, revIn } from '../model';
import { leadsApi } from '../api';
import type { LeadsStatus, SheetsStatus } from '../types';

const TARGET_LABELS: Record<string, string> = {
  conversion_pct: 'Lead → retailer conversion %', marketing_share_pct: 'Marketing share of new retailers %', cost_per_retailer: 'Cost per converted retailer (₹)',
  new_retailers_quarter: 'New retailers per quarter', retention_pct: 'Retention %', revenue_at_risk_pct: 'Max revenue at risk (% of sales)',
  unique_leads_quarter: 'Unique leads per quarter', sla_days: 'Follow-up SLA (days)', gross_margin_pct: 'Gross margin % (payback / ROI)',
};
const GLOSSARY: [string, string][] = [
  ['Enquiry', 'One row of a lead sheet (Meta / Google forms, Print), after removing duplicate copies and test rows.'],
  ['Lead', 'A person who enquired, counted once per mobile number (their first enquiry). Later enquiries from the same number are repeats.'],
  ['Working number', 'A valid 10-digit Indian mobile (starts with 6–9). Numbers typed with an extra 1 / 91 / 0 in front are repaired.'],
  ['Matching', 'How a lead is found in the BO sales data. Strict = same mobile only; Normal (default) = same main or other mobile, or a near-identical shop name in the same pincode / city; Loose = also shop names that are only similar.'],
  ['New retailer', 'The shop\'s first-ever order (BO billing) comes within the chosen days after the enquiry (sale within 30, 60 or 90 days).'],
  ['Came back', 'An old retailer who had not ordered for 3 months before the enquiry and ordered again within the chosen days.'],
  ['Already buying', 'The shop had ordered in the 3 months before the enquiry: the lead did not bring it in.'],
  ['Pending sales data', 'The chosen days after the enquiry run past the last month of sales data, so we cannot tell yet if the lead became a retailer. These leads are not counted as "No sale yet" and are left out of the %. They update by themselves when new sales data arrives.'],
  ['Not from a lead (Organic)', 'A new retailer no lead brought in: found by a distributor, an ASM or by word of mouth (the data cannot tell them apart).'],
  ['Health', 'At the period end: Active = billed in the last 2 months; At-risk = last bill 2 months before (45–90 days); Churned = 3+ months.'],
  ['Retention (repeat)', 'Retailers billed in the previous period who billed again ÷ retailers billed in the previous period.'],
  ['Revenue at risk', 'For each at-risk retailer, its last 3 months of billing: the quarter of revenue that stops if it does not come back.'],
];

function Memo({ text }: { text: string }) {
  // the memo is simple Markdown: headings, numbered / bulleted lines, **bold**, *italic*
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((p, i) =>
    p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('*') && p.length > 2 ? <i key={i}>{p.slice(1, -1)}</i> : p);
  return (
    <div className="ld-memo">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('# ')) return <h1 key={i}>{line.slice(2)}</h1>;
        if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>;
        if (line.startsWith('- ')) return <div key={i} style={{ paddingLeft: 14 }}>• {inline(line.slice(2))}</div>;
        return line.trim() ? <p key={i} style={{ margin: '4px 0' }}>{inline(line)}</p> : null;
      })}
    </div>
  );
}

// Linked Google Sheets: read on their own by the backend (sheets_source.py), so nobody uploads lead files by hand
function SheetsCard({ sheets, busy, canEdit, onSheets }: {
  sheets: SheetsStatus | undefined;
  busy: string | null;
  canEdit: boolean;
  onSheets: (label: string, fn: () => Promise<unknown>) => void;
}) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const sources = sheets?.sources ?? [];
  const last = sheets?.last;
  const read = (u: string) => last?.sources?.find((x) => x.url === u);
  const add = () => {
    if (!url.trim()) return;
    onSheets('Reading the sheet and rebuilding…', () => leadsApi.saveSheets([...sources, { url: url.trim(), name: name.trim() }]));
    setUrl('');
    setName('');
  };
  const remove = (u: string) => {
    if (confirm('Stop reading this Google Sheet? The dashboard rebuilds without it.')) onSheets('Removing and rebuilding…', () => leadsApi.saveSheets(sources.filter((x) => x.url !== u)));
  };
  return (
    <Card title="Google Sheets (automatic)" wide uses={[]}
      actions={canEdit && sources.length > 0 ? <button type="button" className="ld-btn" disabled={!!busy} onClick={() => onSheets('Reading the sheets…', () => leadsApi.refreshSheets())}><RefreshCw size={14} strokeWidth={STROKE} />Check now</button> : undefined}
      info={{ what: <>Lead, spend, follow-up or targets tabs kept in Google Sheets are read on their own{sheets?.everyMinutes ? <> every <b>{sheets.everyMinutes} minutes</b></> : ''}, and the dashboard rebuilds when a tab changed: nothing to download or upload. A link with a tab (…#gid=…) reads that tab; a link without one reads every tab and keeps the ones it recognises. A read with far fewer rows than before (sharing removed, Google error) never replaces the last good copy.</>, source: 'backend/app/leads/services/sheets_source.py' }}>
      <div className="ld-note" style={{ marginTop: 0 }}>
        <Sheet size={14} strokeWidth={STROKE} aria-hidden style={{ verticalAlign: '-2px' }} />{' '}
        {sheets?.serviceAccount
          ? <>Share each sheet as <b>Viewer</b> with <code>{sheets.serviceAccount}</code> (Share → add this email). </>
          : <>No Google service account is set up on the backend (BO_GOOGLE_KEY), so only sheets shared as “Anyone with the link can view” can be read. </>}
        {last?.checked_at && <>Last checked {new Date(last.checked_at).toLocaleString('en-IN')}.</>}
      </div>
      <Table rows={sources} limit={20} empty="No Google Sheets linked yet." cols={[
        { key: 'name', label: 'Sheet', render: (x) => <a href={x.url} target="_blank" rel="noreferrer"><Link2 size={13} strokeWidth={STROKE} style={{ verticalAlign: '-2px' }} /> {x.name || read(x.url)?.title || 'Google Sheet'}</a> },
        { key: 'tabs', label: 'Tabs read', render: (x) => read(x.url)?.tabs.map((t) => `${t.tab} (${num(t.rows)} rows)`).join(', ') || '—' },
        { key: 'state', label: 'Status', render: (x) => {
          const r = read(x.url);
          if (!r) return '—';
          if (r.error) return <span className="ld-tag kill" title={r.error}>{r.error}</span>;
          const note = r.tabs.find((t) => t.note)?.note;
          return note ? <span className="ld-tag fix" title={note}>{note}</span> : <span className="ld-tag scale">OK</span>;
        } },
        ...(canEdit ? [{ key: 'del', label: '', render: (x: (typeof sources)[number]) => <button type="button" className="ld-iconbtn" onClick={() => remove(x.url)} aria-label="Stop reading this sheet" title="Stop reading this sheet"><Trash2 size={14} strokeWidth={STROKE} /></button> }] : []),
      ]} />
      {canEdit && (
        <form className="ld-sheet-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input type="url" required placeholder="Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/…)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Google Sheets link" />
          <input type="text" placeholder="Name (optional, e.g. Meta leads)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <button type="submit" className="ld-btn primary" disabled={!!busy || !url.trim()}><Plus size={14} strokeWidth={STROKE} />Add sheet</button>
        </form>
      )}
    </Card>
  );
}

export default function Quality({ status, busy, onUpload, onDelete, onRebuild, onSaveTargets, onSheets }: {
  status: LeadsStatus | null;
  busy: string | null;
  onUpload: (files: FileList) => void;
  onDelete: (name: string) => void;
  onRebuild: () => void;
  onSaveTargets: (t: Record<string, number>) => void;
  onSheets: (label: string, fn: () => Promise<unknown>) => void;
}) {
  const { M, f, rg, canEdit } = useLeads();
  const L = M.p.leads;
  const fileRef = useRef<HTMLInputElement>(null);
  const [targets, setTargets] = useState<Record<string, number>>(M.p.targets);
  useEffect(() => { setTargets(M.p.targets); }, [M]);
  const [memo, setMemo] = useState<string | null>(null);
  const [memoErr, setMemoErr] = useState<string | null>(null);

  const passes = useMemo(() => {
    const n = [0, 0, 0, 0];
    const conf = [0, 0, 0, 0, 0];
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !L.valid[i] || !leadOk(M, f, i, rg, ['outcome'])) continue;
      n[L.pass[i]]++;
      if (L.pass[i] === 3) conf[Math.min(4, Math.max(0, Math.floor((L.conf[i] - 75) / 5)))]++;
    }
    return { n, conf };
  }, [M, f, rg, L]);

  const sensitivity = useMemo(() => M.p.dims.levels.map((lv, li) => {
    const row: { level: string; cells: { k: number; n: number }[] } = { level: LEVEL_NAMES[li] ?? lv, cells: [] };
    for (const w of M.p.dims.windows) {
      let k = 0, n = 0;
      for (let i = 0; i < M.nL; i++) {
        if (!L.uniq[i] || !L.valid[i] || !leadOk(M, { ...f, level: li, window: w }, i, rg, ['outcome'])) continue;
        n++;
        if (outcomeOf(M, i, li, w) === 2) k++;
      }
      row.cells.push({ k, n });
    }
    return row;
  }), [M, f, rg, L]);

  const recon = useMemo(() => {
    const out = M.p.dims.outcomes.map(() => 0);
    let unique = 0;
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !leadOk(M, f, i, rg, ['outcome'])) continue;
      unique++;
      const o = outcomeOf(M, i, f.level, f.window);
      if (o >= 0) out[o]++;
    }
    return { out, unique, sum: out.reduce((s, v) => s + v, 0) };
  }, [M, f, rg, L]);

  const missing = useMemo(() => {
    let noPhone = 0, revNo = 0, revAll = 0, n = 0;
    for (let r = 0; r < M.nR; r++) {
      const v = revIn(M, r, rg[0], rg[1]);
      if (M.p.retailers.first[r] < 0) continue;
      n++;
      revAll += v;
      if (!M.p.retailers.phone[r]) { noPhone++; revNo += v; }
    }
    let rows = 0, invalid = 0;
    for (let i = 0; i < M.nL; i++) { rows++; if (!L.valid[i]) invalid++; }
    return { noPhone, n, revNo, revAll, rows, invalid };
  }, [M, rg, L]);

  // the lead's own answer ("retailer" / "Existing Retailer") against what the BO data shows
  const selfCheck = useMemo(() => {
    const t = { yy: 0, yn: 0, ny: 0, nn: 0 };
    const ret = M.ret[f.level];
    for (let i = 0; i < M.nL; i++) {
      const said = L.selfEx?.[i];
      if (!L.uniq[i] || !L.valid[i] || said === undefined || said < 0 || !leadOk(M, f, i, rg, ['outcome'])) continue;
      const r = ret[i];
      const inBo = r >= 0 && M.p.retailers.first[r] >= 0 && M.p.retailers.first[r] < L.m[i]; // billed before the lead
      if (said === 1) { if (inBo) t.yy++; else t.yn++; } else if (inBo) t.ny++; else t.nn++;
    }
    return t;
  }, [M, f, rg, L]);

  const openMemo = async () => {
    setMemoErr(null);
    try { setMemo(await leadsApi.memo()); } catch (e) { setMemoErr(e instanceof Error ? e.message : String(e)); }
  };

  const built = new Date(M.p.builtAt);
  return (
    <Section def={SECTIONS[11]} n={12}>
      <div className="ld-grid">
        <SheetsCard sheets={status?.sheets} busy={busy} canEdit={canEdit} onSheets={onSheets} />
        <Card title="Input files and refresh" wide uses={[]}
          actions={<>
            {canEdit && <>
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.xlsm" multiple hidden onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ''; }} />
              <button type="button" className="ld-btn primary" onClick={() => fileRef.current?.click()} disabled={!!busy}><Upload size={14} strokeWidth={STROKE} />Add files</button>
              <button type="button" className="ld-btn" onClick={onRebuild} disabled={!!busy}><RefreshCw size={14} strokeWidth={STROKE} />Rebuild now</button>
            </>}
            <button type="button" className="ld-btn" onClick={() => void leadsApi.downloadReconciliation()}><Download size={14} strokeWidth={STROKE} />Reconciliation (.xlsx)</button>
            <button type="button" className="ld-btn" onClick={() => void openMemo()}><FileText size={14} strokeWidth={STROKE} />Findings memo</button>
          </>}
          info={{ what: <>Drop lead exports, spend, the follow-up log and a targets sheet (CSV or Excel) here or straight into the Dropbox folder below. The pipeline recognises each file by its name and columns, and the dashboard rebuilds itself on the next visit when anything changes. Expected columns: <b>leads</b> lead date, mobile, name, city, pincode, source, campaign, ad set · <b>spend</b> campaign, month, amount · <b>follow-up</b> mobile, assigned to, distributor, contact date, status · <b>targets</b> metric, target.</>, source: 'backend/app/leads/pipeline (python -m app.leads.pipeline to run it on local folders)' }}>
          <div className="ld-note" style={{ marginTop: 0 }}>
            Data built {built.toLocaleString('en-IN')} · sales to {monthName(M, M.p.salesEnd)} · as of {M.p.asOf}
            {status && <> · inbox: <code>{status.inbox_folder}</code></>}
            {busy && <> · <b>{busy}</b></>}
          </div>
          <Table rows={M.p.files} limit={20} empty="No files in the leads inbox yet: the lead-based sections are waiting for them." cols={[
            { key: 'file', label: 'File', render: (x) => x.file, sort: (x) => x.file },
            { key: 'kind', label: 'Read as', render: (x) => (x.kind === 'unknown' ? <span className="ld-tag kill">not used</span> : x.kind), sort: (x) => x.kind },
            { key: 'rows', label: 'Rows', num: true, render: (x) => num(x.rows), sort: (x) => x.rows },
            { key: 'note', label: 'Note', render: (x) => x.note || '—' },
            ...(canEdit ? [{ key: 'del', label: '', render: (x: (typeof M.p.files)[number]) => x.file.startsWith('Sheet tab - ') ? null : <button type="button" className="ld-iconbtn" onClick={() => onDelete(x.file.split(' / ')[0])} aria-label={`Remove ${x.file}`} title="Remove from the inbox"><Trash2 size={14} strokeWidth={STROKE} /></button> }] : []),
          ]} />
          {memoErr && <div className="ld-needs" style={{ marginTop: 10 }}>{memoErr}</div>}
          {memo && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button type="button" className="ld-btn" onClick={() => void leadsApi.downloadMemo()}><Download size={14} strokeWidth={STROKE} />Download (.md)</button>
                <button type="button" className="ld-btn" onClick={() => setMemo(null)}>Close</button>
              </div>
              <Memo text={memo} />
            </div>
          )}
        </Card>
        <Card title="Lead says 'already a retailer' vs BO" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level']}
          info={{ what: 'The lead\'s own answer on the sheet (retailer / Existing Retailer) against the BO data: is its matched retailer billing in BO before the lead date? Disagreements show where matching misses shops (they buy under another name or number) or where leads answer loosely. Read-only: BO data is not changed.', formula: 'found in BO = matched retailer with a first bill before the lead month', source: 'Lead sheet + BO retailers.csv / retailer_month.csv' }}
          csv={{ name: 'self_reported_vs_bo', rows: () => [{ 'Says retailer, in BO': selfCheck.yy, 'Says retailer, not found in BO': selfCheck.yn, 'Says not, but in BO': selfCheck.ny, 'Says not, not in BO': selfCheck.nn }] }}
          soWhat={selfCheck.yy + selfCheck.yn ? <>{num(selfCheck.yn)} of {num(selfCheck.yy + selfCheck.yn)} leads that say they are retailers are not found billing in BO: they may buy under another name or number.</> : undefined}>
          {selfCheck.yy + selfCheck.yn + selfCheck.ny + selfCheck.nn === 0 ? <div className="ld-note">The lead sheets have no "retailer" / "Existing Retailer" column.</div> : (
            <table className="ld-table">
              <thead><tr><th>Lead says</th><th className="num">Billing in BO</th><th className="num">Not found in BO</th></tr></thead>
              <tbody>
                <tr><td>Already a retailer</td><td className="num">{num(selfCheck.yy)}</td><td className="num">{num(selfCheck.yn)}</td></tr>
                <tr><td>Not a retailer</td><td className="num">{num(selfCheck.ny)}</td><td className="num">{num(selfCheck.nn)}</td></tr>
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Rows kept and dropped at each step" wide uses={[]}
          info={{ what: 'Every cleaning step, with rows in, rows out and what was dropped. Rows with an invalid mobile are kept as \'Invalid number\'.', source: 'Pipeline log' }}
          csv={{ name: 'rows_by_step', rows: () => M.p.steps.map((s) => ({ Table: s.table, Step: s.step, 'Rows in': s.rows_in, 'Rows out': s.rows_out, Dropped: s.dropped, Note: s.note })) }}>
          <Table rows={M.p.steps} limit={20} cols={[
            { key: 't', label: 'Table', render: (s) => s.table },
            { key: 's', label: 'Step', render: (s) => s.step },
            { key: 'i', label: 'In', num: true, render: (s) => num(s.rows_in) },
            { key: 'o', label: 'Out', num: true, render: (s) => num(s.rows_out) },
            { key: 'd', label: 'Dropped', num: true, render: (s) => (s.dropped ? <b>{num(s.dropped)}</b> : '0') },
            { key: 'n', label: 'Note', render: (s) => s.note || '' },
          ]} />
        </Card>
        <Card title="Missing data" uses={['period']}
          info={{ what: 'Lead rows without a valid mobile (cannot be matched by number), and retailers with no phone (their leads can only be matched by name) with their share of the period\'s sales.', source: 'Lead dump, retailers.csv' }}>
          <table className="ld-table"><tbody>
            <tr><td>Lead rows with a missing / invalid mobile</td><td className="num">{M.p.hasLeads ? <Pct k={missing.invalid} n={missing.rows} label="Invalid ÷ lead rows" ci={false} /> : '—'}</td></tr>
            <tr><td>Retailers with no phone</td><td className="num"><Pct k={missing.noPhone} n={missing.n} label="No phone ÷ retailers" ci={false} /></td></tr>
            <tr><td>… their share of period sales</td><td className="num">{missing.revAll ? `${((100 * missing.revNo) / missing.revAll).toFixed(1)}% (${inr(missing.revNo)})` : '—'}</td></tr>
          </tbody></table>
        </Card>
        <Card title="Match rate by pass" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level']}
          info={{ what: 'Valid unique leads by the pass that matched them: 1 exact main phone, 2 alternate numbers, 3 fuzzy business name in the same pincode / city (score 75–100). The fuzzy score spread shows how much rests on name matching.', source: 'Pipeline match step' }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <div className="ld-split">
              <table className="ld-table"><tbody>
                {['Not matched', '1 · exact mobile', '2 · alternate numbers', '3 · fuzzy name'].map((l, j) => (
                  <tr key={l}><td>{l}</td><td className="num">{num(passes.n[j])}</td><td className="num"><Pct k={passes.n[j]} n={passes.n.reduce((s, v) => s + v, 0)} label={`${l} ÷ valid unique leads`} /></td></tr>
                ))}
              </tbody></table>
              <StackedBars height={170} data={['75–79', '80–84', '85–89', '90–94', '95–100'].map((label, j) => ({ label, leads: passes.conf[j] }))} x="label" fmt={num}
                series={[{ key: 'leads', label: 'Fuzzy matches', color: 'var(--ld-seq-4)' }]} />
            </div>
          )}
        </Card>
        <Card title="How the % changes with the settings" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier']}
          info={{ what: 'Share of leads that became new retailers for each matching setting and number of days. The spread from Strict to Loose shows how much the result depends on matching leads to shops.', formula: 'new retailers ÷ leads with a working number and sales data' }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <table className="ld-table">
              <thead><tr><th>Matching</th>{M.p.dims.windows.map((w) => <th key={w} className="num">Sale within {w} days</th>)}</tr></thead>
              <tbody>{sensitivity.map((r) => (
                <tr key={r.level}><td style={{ textTransform: 'capitalize' }}>{r.level}</td>{r.cells.map((c, j) => <td key={j} className="num"><Pct k={c.k} n={c.n} /></td>)}</tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Check: every lead is counted once" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          info={{ what: 'Each lead lands in exactly one result, so the results must add up to the number of leads. The downloadable check workbook repeats this for every setting, and checks that monthly sales add up to each retailer\'s total.', source: 'Check workbook' }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <table className="ld-table"><tbody>
              {M.p.dims.outcomes.map((o, j) => <tr key={o}><td><span className="ld-legend" style={{ margin: 0 }}><span><i style={{ background: OUTCOME_COLORS[j] }} />{o}</span></span></td><td className="num">{num(recon.out[j])}</td></tr>)}
              <tr><td><b>All results added up</b></td><td className="num"><b>{num(recon.sum)}</b></td></tr>
              <tr><td><b>Leads</b></td><td className="num"><b>{num(recon.unique)}</b></td></tr>
              <tr><td>Check</td><td className="num">{recon.sum === recon.unique ? <span className="ld-tag scale">Reconciles</span> : <span className="ld-tag kill">Off by {num(recon.unique - recon.sum)}</span>}</td></tr>
            </tbody></table>
          )}
        </Card>
        <Card title="Targets (the coloured dots)" uses={[]}
          actions={canEdit ? <button type="button" className="ld-btn primary" disabled={!!busy} onClick={() => onSaveTargets(targets)}><Save size={14} strokeWidth={STROKE} />Save targets</button> : undefined}
          info={{ what: 'The targets behind every coloured dot: green = on target, amber = within 20%, red = further off. Values saved here are used unless a targets sheet is linked.' }}>
          <table className="ld-table"><tbody>
            {Object.keys(TARGET_LABELS).map((k) => {
              const from = M.p.targetsFromFile.includes(k) ? 'targets sheet' : (M.p.targetsSet ?? []).includes(k) ? 'saved here' : 'placeholder';
              return (
                <tr key={k}>
                  <td>{TARGET_LABELS[k]}</td>
                  <td style={{ width: 130 }}>{canEdit && from !== 'targets sheet'
                    ? <input className="ld-input" type="number" value={targets[k] ?? ''} onChange={(e) => setTargets({ ...targets, [k]: Number(e.target.value) })} aria-label={TARGET_LABELS[k]} />
                    : num(targets[k] ?? 0)}</td>
                  <td className="ld-muted">{from}</td>
                </tr>
              );
            })}
          </tbody></table>
        </Card>
        <Card title="Assumptions" uses={[]} info={{ what: 'Every assumption the numbers rest on. Also in the reconciliation workbook.' }}
          csv={{ name: 'assumptions', rows: () => M.p.assumptions.map((a, i) => ({ '#': i + 1, Assumption: a })) }}>
          <ol className="ld-list">{M.p.assumptions.map((a) => <li key={a}>{a}</li>)}</ol>
        </Card>
        <Card title="Data gaps" uses={[]} info={{ what: 'What is missing or weak in the inputs, and what it switches off.' }}
          csv={{ name: 'data_gaps', rows: () => M.p.gaps.map((g, i) => ({ '#': i + 1, Gap: g })) }}>
          <ol className="ld-list">{M.p.gaps.map((g) => <li key={g}>{g}</li>)}</ol>
        </Card>
        <Card title="Glossary" uses={[]} info={{ what: 'Definitions used everywhere on this page.' }}>
          <dl style={{ margin: 0, fontSize: 13 }}>
            {GLOSSARY.map(([t, d]) => <div key={t} style={{ marginBottom: 6 }}><dt style={{ fontWeight: 650 }}>{t}</dt><dd style={{ margin: 0, color: 'var(--muted)' }}>{d}</dd></div>)}
          </dl>
        </Card>
      </div>
    </Section>
  );
}
