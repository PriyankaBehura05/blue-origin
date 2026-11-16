// Parts shared by "Repeat buying & tiers" and "States & cities" (engine: repeat.ts):
//   ScopeKpis       leads, converted retailers, repeat buyers, conversion rate and revenue for exactly the active filters
//   PurchaseHistory one retailer's details, the leads linked to it and every purchase, month by month
//   CrossLink       a button to the other page, keeping the filters
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { IndianRupee, Percent, Repeat, UserCheck, Users } from 'lucide-react';
import { Drawer } from '@/components/ui';
import { ExportBtn, Kpi, Pct, downloadCsv, inr, num, pctTxt, useLeads } from '../ui';
import { health, monthName, NEW, outcomeOf, REACTIVATED, revIn, tierAt } from '../model';
import { conversions, firstBilledFrom, leadTally, scopeText, statsOf } from '../repeat';

export function ScopeKpis() {
  const { M, f, rg } = useLeads();
  const k = useMemo(() => {
    const conv = conversions(M, f, rg);
    const t = leadTally(M, f, rg);
    const s = statsOf(M, conv, f.rwin);
    return { conv, t, s, fresh: conv.filter((x) => x.kind === NEW).length, rev: s.revFirst + s.revAfter };
  }, [M, f, rg]);
  const sales = monthName(M, M.p.salesEnd);
  if (!M.p.hasLeads) return null;
  return (
    <div className="ld-scope">
      <div className="ld-scope-h">For <b>{scopeText(M, f)}</b></div>
      <div className="ld-kpis ld-kpis-5">
        <Kpi icon={Users} label="Leads" rag="none" value={num(k.t.leads)} sub="unique leads (first enquiry per mobile)"
          info="Unique leads of the period that pass every filter. A lead counts where it said it is; without a city, where its matched retailer is." />
        <Kpi icon={UserCheck} label="Converted retailers" rag="none" value={num(k.conv.length)} sub={`${num(k.fresh)} new · ${num(k.conv.length - k.fresh)} came back`}
          info="Distinct BO retailers that a lead of the period reached by mobile number (main or alternate) and that billed after it: a New retailer or Came back. Each retailer counts once. Matches by similar shop name are not counted here." />
        <Kpi icon={Repeat} label="Repeat buyers" rag="none" value={num(k.s.second)}
          sub={k.s.eligible ? <>{pctTxt(k.s.repeatIn, k.s.eligible)} bought again within {f.rwin} months</> : `repeat rate N/A: no retailer has completed ${f.rwin} months yet`}
          info={`Converted retailers that bought again after their first purchase after the lead (up to ${sales}). The rate counts only retailers whose ${f.rwin}-month window is fully in the sales data: ${num(k.s.repeatIn)} of ${num(k.s.eligible)}.`} />
        <Kpi icon={Percent} label="Conversion rate" rag="none" value={k.t.judged ? <Pct k={k.t.converted} n={k.t.judged} label="Converted leads ÷ leads that can be judged" /> : 'N/A'}
          sub={`${num(k.t.converted)} of ${num(k.t.judged)} leads that can be judged`}
          info="Leads that became a New retailer or Came back (mobile-number match) ÷ valid leads whose sales window is covered by the sales data. Leads still waiting for sales data are left out." />
        <Kpi icon={IndianRupee} label="Revenue" rag="none" value={k.conv.length ? inr(k.rev) : 'N/A'} sub={`billed by the converted retailers, first purchase to ${sales}`}
          info="BO billing of the converted retailers from their first purchase after the lead up to the last sales month." />
      </div>
    </div>
  );
}

export function CrossLink({ to, label }: { to: 'retention' | 'geography'; label: string }) {
  const go = useNavigate();
  return <button type="button" className="ld-btn" onClick={() => go(`/leads/${to}`)}>{label} →</button>;
}

const MATCH = ['', 'Same mobile number', 'Alternate mobile number', 'Similar shop name (not used for repeat figures)'];

export function PurchaseHistory({ r, onClose }: { r: number; onClose: () => void }) {
  const { M, f } = useLeads();
  const R = M.p.retailers;
  const L = M.p.leads;
  const d = M.p.dims;
  const end = M.p.salesEnd;
  const leads = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < M.nL; i++) if (L.uniq[i] && M.ret[f.level][i] === r) out.push(i);
    return out.sort((a, b) => L.day[a] - L.day[b]);
  }, [M, f.level, r, L]);
  // the first purchase after the earliest converting, phone-matched lead
  const conv = leads.find((i) => (L.pass[i] === 1 || L.pass[i] === 2) && [NEW, REACTIVATED].includes(outcomeOf(M, i, f.level, f.window)));
  const convMonth = conv === undefined ? -1 : firstBilledFrom(M, r, L.m[conv]);
  const hist = useMemo(() => {
    const out: { m: number; v: number; n: number; tier: number }[] = [];
    let n = 0;
    for (let m = 0; m <= end; m++) {
      const v = M.rev[r * M.nM + m];
      if (v > 0) out.push({ m, v, n: ++n, tier: tierAt(M, r, m) });
    }
    return out;
  }, [M, r, end]);
  const tierNow = tierAt(M, r, end);
  const rows = () => hist.map((h) => ({ Month: monthName(M, h.m), 'Purchase no.': h.n, 'Billing (₹)': Math.round(h.v), 'Tier that quarter': d.tiers[h.tier] ?? '', Note: h.m === convMonth ? 'First purchase after the lead' : '' }));
  return (
    <Drawer title={R.name[r]} onClose={onClose}
      subtitle={<span className="ld-muted">{R.id[r]} · {d.dist[R.d[r]] ?? '—'} · {[d.city[R.c[r]], d.state[R.s[r]]].filter(Boolean).join(', ') || 'location not set'}{R.phone[r] ? ` · ${R.phone[r]}` : ''}</span>}>
      <div className="ld-ph-kv">
        <div><span>Tier now</span><b>{tierNow >= 0 ? d.tiers[tierNow] : 'No tier'}</b></div>
        <div><span>Purchases</span><b>{num(hist.length)}</b></div>
        <div><span>First purchase</span><b>{hist.length ? monthName(M, hist[0].m) : '—'}</b></div>
        <div><span>Last purchase</span><b>{hist.length ? monthName(M, hist[hist.length - 1].m) : '—'}</b></div>
        <div><span>Lifetime billing</span><b>{inr(revIn(M, r, 0, end))}</b></div>
        <div><span>Status</span><b>{health(M, r, end)}</b></div>
      </div>
      <h4 className="ld-ph-h">Leads linked to this retailer</h4>
      {!leads.length ? <div className="ld-empty-s">No lead is matched to this retailer: it came in on its own (organic).</div> : (
        <div className="ld-table-wrap">
          <table className="ld-table">
            <thead><tr><th>Lead date</th><th>Platform</th><th>Campaign</th><th>Matched by</th><th>Result</th></tr></thead>
            <tbody>{leads.map((i) => (
              <tr key={i}>
                <td>{new Date(L.day[i] * 86400000).toISOString().slice(0, 10)}</td>
                <td>{d.source[L.src[i]] ?? '—'}</td>
                <td>{d.campaign[L.camp[i]] ?? '—'}</td>
                <td>{MATCH[L.pass[i]] ?? '—'}</td>
                <td>{d.outcomes[outcomeOf(M, i, f.level, f.window)] ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <h4 className="ld-ph-h">Purchase history <ExportBtn label="Download purchase history" onClick={() => downloadCsv(`purchases_${R.id[r]}`, rows())} /></h4>
      <p className="ld-muted ld-ph-note">One row per month with BO billing (BO billing is monthly, so invoices of the same month are one purchase).</p>
      {!hist.length ? <div className="ld-empty-s">No billing up to {monthName(M, end)}.</div> : (
        <div className="ld-table-wrap">
          <table className="ld-table">
            <thead><tr><th className="num">#</th><th>Month</th><th className="num">Billing</th><th>Tier that quarter</th><th /></tr></thead>
            <tbody>{hist.map((h) => (
              <tr key={h.m} className={h.m === convMonth ? 'ld-ph-conv' : ''}>
                <td className="num">{h.n}</td><td>{monthName(M, h.m)}</td><td className="num">{inr(h.v)}</td>
                <td>{d.tiers[h.tier] ?? '—'}</td><td className="ld-muted">{h.m === convMonth ? 'First purchase after the lead' : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}

