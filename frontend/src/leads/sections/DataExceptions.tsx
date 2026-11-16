// Data quality and exceptions (Lead journey page): the gaps that would make a number misleading, counted for the period and
// filters, so they are seen before management reads the figures. Click a tile for the rows behind it. Read-only: nothing here
// changes a calculation; it only shows where the inputs are thin.
import { useMemo, useState, type ReactNode } from 'react';
import { BadgeAlert, CircleHelp, Copy, Hash, Megaphone, Receipt, Scale, UserX, type LucideIcon } from 'lucide-react';
import { HelpTip } from '@/components/HelpTip';
import { leadOk } from '../model';
import { isConvertedByAsm } from '../journey';
import type { BudgetPayload } from '../types';
import { Card, ExportBtn, Table, csvRows, downloadCsv, inr, num, useLeads, type Col } from '../ui';

type Tone = 'ok' | 'info' | 'warn' | 'bad';
interface Detail { cols: Col<Record<string, unknown>>[]; rows: Record<string, unknown>[] }
interface Check { id: string; icon: LucideIcon; label: string; count: number; unit: string; tone: Tone; why: string; note?: ReactNode; detail: Detail }

const text = (key: string, label: string, numeric = false): Col<Record<string, unknown>> => ({
  key, label, num: numeric, render: (r) => (numeric && typeof r[key] === 'number' ? (key.toLowerCase().includes('spend') || key.toLowerCase().includes('budget') ? inr(r[key] as number) : num(r[key] as number)) : String(r[key] ?? '')),
  sort: (r) => (r[key] as number | string) ?? '', csv: (r) => r[key],
});

export default function DataExceptions({ budget }: { budget: BudgetPayload | null }) {
  const { M, f, rg } = useLeads();
  const L = M.p.leads;
  const [open, setOpen] = useState<string | null>(null);

  const checks = useMemo<Check[]>(() => {
    const src = M.p.dims.source;
    const paid = new Set([src.indexOf('Meta'), src.indexOf('Google')]);
    const exact = new Set(M.p.attribution?.exact_methods ?? []);
    const ret = M.ret[f.level];
    const bySource = () => new Map<string, number>();
    const noId = bySource(), noSrc = bySource(), dup = bySource(), noAsm = bySource();
    const noIdHow = new Map<string, number>();
    const convNoRet: Record<string, unknown>[] = [];
    let rows = 0;
    for (let i = 0; i < M.nL; i++) {
      if (!leadOk(M, f, i, rg)) continue;
      rows++;
      const s = src[L.src[i]];
      if (!L.uniq[i]) { dup.set(s, (dup.get(s) ?? 0) + 1); continue; }
      if (paid.has(L.src[i]) && !(L.meth && exact.has(L.meth[i]))) {
        noId.set(s, (noId.get(s) ?? 0) + 1);
        const how = L.att?.[i] === 0 ? 'Linked by the date fallback' : 'Not linked to a campaign';
        noIdHow.set(`${s}|${how}`, (noIdHow.get(`${s}|${how}`) ?? 0) + 1);
      }
      if (s === 'Other') noSrc.set('Sheet tab names no platform', (noSrc.get('Sheet tab names no platform') ?? 0) + 1);
      if (L.valid[i] && L.owner[i] < 0) noAsm.set(s, (noAsm.get(s) ?? 0) + 1);
      if (isConvertedByAsm(M, i) && ret[i] < 0) {
        convNoRet.push({ Lead: L.name[i] || '—', Mobile: L.mob[i], ASM: L.owner[i] >= 0 ? M.p.dims.owner[L.owner[i]] : '—', Source: s,
          Date: new Date(L.day[i] * 864e5).toISOString().slice(0, 10), 'Order value': L.ordv?.[i] || 0 });
      }
    }
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const breakdown = (m: Map<string, number>, what: string) => [...m.entries()].map(([k, v]) => ({ [what]: k, Leads: v })).sort((a, b) => b.Leads - a.Leads);

    // ---- ad data: campaigns in the period, spend with no campaign, budget vs spend
    const keys = new Set(M.p.months.slice(rg[0], rg[1] + 1));
    const ledCampaigns = new Set<string>();
    for (let i = 0; i < M.nL; i++) if (L.m[i] >= rg[0] && L.m[i] <= rg[1] && L.att?.[i] === 0) ledCampaigns.add(M.p.dims.campaign[L.camp[i]]);
    const noLeads: Record<string, unknown>[] = [];
    const orphan: Record<string, unknown>[] = [];
    const budgetIssues: Record<string, unknown>[] = [];
    let adSaved = false;
    for (const p of ['meta', 'google'] as const) {
      const snap = budget?.[p]?.snapshot;
      if (!snap || snap.sample) continue;
      adSaved = true;
      const plat = p === 'meta' ? 'Meta' : 'Google';
      for (const a of snap.accounts) {
        const info = new Map(a.campaigns.map((c) => [c.campaign_id, c]));
        const spent = new Map<string, { spend: number; months: string[] }>();
        let orphanSpend = 0;
        for (const r of a.campaign_monthly) {
          if (!keys.has(r.period) || !r.spend) continue;
          if (!info.has(r.campaign_id)) { orphanSpend += r.spend; continue; }
          const e = spent.get(r.campaign_id) ?? { spend: 0, months: [] };
          e.spend += r.spend;
          e.months.push(r.period);
          spent.set(r.campaign_id, e);
        }
        if (orphanSpend) orphan.push({ Platform: plat, Account: a.account.name ?? a.account.account_id, Spend: orphanSpend });
        const today = new Date(`${a.today}T00:00:00`);
        for (const [cid, e] of spent) {
          const c = info.get(cid)!;
          const leadCampaign = c.objective === 'OUTCOME_LEADS' || /lead/i.test(c.name);
          if (!ledCampaigns.has(c.name)) noLeads.push({ Campaign: c.name, Platform: plat, Kind: leadCampaign ? 'Lead campaign: should bring leads' : 'Other objective (traffic, awareness …)', Spend: e.spend, _lead: leadCampaign ? 1 : 0 });
          let budgetOf = 0;
          if (c.daily_budget) for (const ym of e.months) {
            const [y, mo] = ym.split('-').map(Number);
            budgetOf += c.daily_budget * (y === today.getFullYear() && mo === today.getMonth() + 1 ? today.getDate() : new Date(y, mo, 0).getDate());
          }
          if (!c.daily_budget && !c.lifetime_budget) budgetIssues.push({ Campaign: c.name, Platform: plat, Issue: 'Spent with no budget set', Spend: e.spend, Budget: 0 });
          else if (c.daily_budget && e.spend > 1.1 * budgetOf) budgetIssues.push({ Campaign: c.name, Platform: plat, Issue: `Spent ${((100 * e.spend) / budgetOf).toFixed(0)}% of its budget`, Spend: e.spend, Budget: budgetOf });
          else if (c.lifetime_budget && (c.spend_lifetime ?? 0) > 1.02 * c.lifetime_budget) budgetIssues.push({ Campaign: c.name, Platform: plat, Issue: 'Lifetime spend above the lifetime budget', Spend: c.spend_lifetime ?? 0, Budget: c.lifetime_budget });
        }
      }
    }
    noLeads.sort((a, b) => Number(b._lead) - Number(a._lead) || Number(b.Spend) - Number(a.Spend));
    const leadNoLeads = noLeads.filter((r) => r._lead).length;
    const tone = (n: number, bad: Tone = 'warn'): Tone => (n ? bad : 'ok');
    const adNote = adSaved ? undefined : 'No ad data saved yet (Ad budget page).';

    return [
      { id: 'noid', icon: Hash, label: 'Leads without campaign IDs', count: sum(noId), unit: 'unique ad leads', tone: tone(sum(noId), 'info'),
        why: 'The lead sheet has no campaign ID column, so these Meta and Google leads were linked by the date fallback or not at all. Adding a campaign ID or UTM column (or Meta lead-form access) makes every link exact.',
        detail: { cols: [text('Source', 'Source'), text('How', 'How it was handled'), text('Leads', 'Leads', true)], rows: [...noIdHow.entries()].map(([k, v]) => ({ Source: k.split('|')[0], How: k.split('|')[1], Leads: v })) } },
      { id: 'nosrc', icon: CircleHelp, label: 'Leads without source information', count: sum(noSrc), unit: 'unique leads', tone: tone(sum(noSrc)),
        why: 'Leads from a sheet tab whose name does not say Meta, Google or Print. They count as “platform unknown” and cannot be linked to a campaign.',
        detail: { cols: [text('Why', 'Why'), text('Leads', 'Leads', true)], rows: breakdown(noSrc, 'Why') } },
      { id: 'dup', icon: Copy, label: 'Duplicate lead submissions', count: sum(dup), unit: `of ${num(rows)} submissions`, tone: tone(sum(dup), 'info'),
        why: 'Repeat enquiries from a mobile that already enquired. They are left out of every unique-lead count; a high share means paying twice for the same people.',
        detail: { cols: [text('Source', 'Source'), text('Leads', 'Repeat submissions', true)], rows: breakdown(dup, 'Source') } },
      { id: 'camp', icon: Megaphone, label: 'Campaigns without matching leads', count: noLeads.length, unit: `with spend · ${num(leadNoLeads)} of them lead campaigns`, tone: tone(leadNoLeads), note: adNote,
        why: 'Campaigns that spent in the period but have no lead linked to them. Traffic or awareness campaigns are expected here; a lead campaign here means its leads are not reaching the sheet, or could not be linked.',
        detail: { cols: [text('Campaign', 'Campaign'), text('Platform', 'Platform'), text('Kind', 'Kind'), text('Spend', 'Spend in period', true)], rows: noLeads } },
      { id: 'orphan', icon: Receipt, label: 'Spend without matching campaign information', count: orphan.reduce((s, r) => s + Number(r.Spend), 0), unit: 'spent on campaigns the account no longer lists', tone: tone(orphan.length), note: adNote,
        why: 'Spend reported for campaign IDs that are not in the campaign list any more (deleted campaigns). It is counted in total spend but has no name, objective or budget.',
        detail: { cols: [text('Platform', 'Platform'), text('Account', 'Account'), text('Spend', 'Spend in period', true)], rows: orphan } },
      { id: 'noasm', icon: UserX, label: 'Leads without ASM assignment', count: sum(noAsm), unit: 'unique leads with a working number', tone: tone(sum(noAsm)),
        why: 'Nobody owns these leads, so nobody will call them. Only the Meta tab carries ASM columns today: leads of other tabs always land here.',
        detail: { cols: [text('Source', 'Source'), text('Leads', 'Leads', true)], rows: breakdown(noAsm, 'Source') } },
      { id: 'conv', icon: BadgeAlert, label: 'Converted leads without confirmed retailer IDs', count: convNoRet.length, unit: 'orders reported by ASMs', tone: tone(convNoRet.length, 'bad'),
        why: 'The ASM marked an order, but the lead matches no BO retailer (phone or shop name), so the sale cannot be confirmed or counted. Check the number or add the retailer to BO.',
        detail: { cols: [text('Lead', 'Lead'), text('Mobile', 'Mobile'), text('ASM', 'ASM'), text('Source', 'Source'), text('Date', 'Lead date'), text('Order value', 'Order value', true)], rows: convNoRet } },
      { id: 'budget', icon: Scale, label: 'Campaigns with budget/spend inconsistencies', count: budgetIssues.length, unit: 'campaigns', tone: tone(budgetIssues.length), note: adNote,
        why: "Campaigns that spent with no budget set, spent more than 110% of their daily budget × days, or passed their lifetime budget. Budgets are today's settings, so a budget changed since can also show here.",
        detail: { cols: [text('Campaign', 'Campaign'), text('Platform', 'Platform'), text('Issue', 'Issue'), text('Spend', 'Spend', true), text('Budget', 'Budget', true)], rows: budgetIssues } },
    ];
  }, [M, f, rg, L, budget]);

  const sel = checks.find((c) => c.id === open);
  const issues = checks.filter((c) => c.tone === 'warn' || c.tone === 'bad').length;
  return (
    <Card wide title="Data quality & exceptions" uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window']}
      info={{ what: 'Gaps in the inputs that would make a number misleading, for the period and filters above. Green = all clear, blue = known and handled, amber = check, red = fix before sharing. Click a tile to see the rows behind it. Campaign and spend checks use the period only.' }}
      soWhat={issues ? <>{issues} check{issues > 1 ? 's' : ''} need attention before these numbers go to management.</> : <>All checks are clear for this selection.</>}>
      <div className="ld-dq-grid">
        {checks.map((c) => (
          <button key={c.id} type="button" className={`ld-dq t-${c.tone}${open === c.id ? ' on' : ''}`} onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
            <span className="ld-dq-ico"><c.icon size={17} strokeWidth={2} aria-hidden /></span>
            <span className="ld-dq-l">{c.label} <HelpTip text={c.why} /></span>
            <span className="ld-dq-v">{c.tone === 'ok' ? 'All clear' : c.id === 'orphan' ? inr(c.count) : num(c.count)}</span>
            <span className="ld-dq-u">{c.note ?? (c.tone === 'ok' ? 'nothing to check' : c.unit)}</span>
          </button>
        ))}
      </div>
      {sel && (
        <div className="ld-dq-detail">
          <div className="ld-dq-detail-h">
            <b>{sel.label}</b>
            <span className="ld-muted">{sel.why}</span>
          </div>
          <Table rows={sel.detail.rows} cols={sel.detail.cols} limit={10} empty="Nothing to list." />
          {sel.detail.rows.length > 0 && <ExportBtn onClick={() => downloadCsv(`exceptions_${sel.id}`, csvRows(sel.detail.rows, sel.detail.cols))} />}
        </div>
      )}
    </Card>
  );
}
