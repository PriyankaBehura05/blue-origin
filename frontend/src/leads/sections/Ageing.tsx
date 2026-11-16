// Follow-ups & call lists (was "Follow-up queue" + "Who to contact next"): the four numbers that matter, the leads to call
// first, late follow-ups per owner, and the downloadable call lists for open leads and lapsed retailers.
import { useMemo } from 'react';
import { AlarmClock, Inbox, PhoneOff, RotateCcw } from 'lucide-react';
import { Card, Kpi, NeedsData, Section, Table, csvRows, inr, num, useLeads, type Col } from '../ui';
import { SECTIONS } from '../sections';
import { health, isOpen, leadAgeDays, leadOk, NEW, outcomeOf, PENDING, riskRevenue, wasCalled, type Model } from '../model';
import { CallLists, useLapsed } from './Untapped';
const LEAD_USES = ['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'outcome', 'level', 'window'] as const;

/** Score 0-100 for an open lead: campaign conversion (40), recency (30), we already sell in its city (15), complete details (15). */
export function useScores(M: Model, level: number, window: number) {
  return useMemo(() => {
    const L = M.p.leads;
    const camp = new Map<number, { n: number; k: number }>();
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !L.valid[i] || outcomeOf(M, i, level, window) === PENDING) continue;
      const e = camp.get(L.camp[i]) ?? { n: 0, k: 0 };
      e.n++;
      if (outcomeOf(M, i, level, window) === NEW) e.k++;
      camp.set(L.camp[i], e);
    }
    // shrink small campaigns toward the overall rate (10 pseudo-leads) so one lucky lead does not top the list
    let N = 0, K = 0;
    camp.forEach((e) => { N += e.n; K += e.k; });
    const base = N ? K / N : 0;
    const rate = new Map<number, number>();
    camp.forEach((e, c) => rate.set(c, (e.k + 10 * base) / (e.n + 10)));
    const best = Math.max(1e-9, ...rate.values());
    const served = new Set<number>();
    for (let r = 0; r < M.nR; r++) if (M.p.retailers.c[r] >= 0 && health(M, r, M.p.salesEnd) === 'Active') served.add(M.p.retailers.c[r]);
    const score = new Float32Array(M.nL);
    for (let i = 0; i < M.nL; i++) {
      const age = leadAgeDays(M, i);
      score[i] = 40 * ((rate.get(L.camp[i]) ?? 0) / best) + 30 * Math.max(0, 1 - age / 90) + (L.c[i] >= 0 && served.has(L.c[i]) ? 15 : 0) + (L.name[i] && L.pin[i] ? 15 : L.name[i] || L.pin[i] ? 7 : 0);
    }
    return score;
  }, [M, level, window]);
}

export default function Ageing() {
  const { M, f, rg } = useLeads();
  const L = M.p.leads;
  const sla = M.p.targets.sla_days ?? 2;
  const scores = useScores(M, f.level, f.window);
  const lapsed = useLapsed();

  const open = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < M.nL; i++) if (L.uniq[i] && L.valid[i] && isOpen(outcomeOf(M, i, f.level, f.window)) && leadOk(M, f, i, rg)) out.push(i);
    return out;
  }, [M, f, rg, L]);

  // with no call date (ASM sheet), a called lead counts as on time
  const isLate = (i: number) => (L.contact[i] >= 0 ? L.contact[i] - L.day[i] > sla : wasCalled(M, i) ? false : leadAgeDays(M, i) > sla);
  const breaches = useMemo(() => {
    const by = new Map<string, { owner: string; open: number; breaches: number; notCalled: number; oldest: number }>();
    for (const i of open) {
      const owner = L.owner[i] >= 0 ? M.p.dims.owner[L.owner[i]] : 'Not assigned';
      const e = by.get(owner) ?? by.set(owner, { owner, open: 0, breaches: 0, notCalled: 0, oldest: 0 }).get(owner)!;
      e.open++;
      if (isLate(i)) e.breaches++;
      if (!wasCalled(M, i)) e.notCalled++;
      e.oldest = Math.max(e.oldest, leadAgeDays(M, i));
    }
    return [...by.values()];
  }, [M, open, L, sla]); // eslint-disable-line react-hooks/exhaustive-deps

  const hot = useMemo(() => [...open].sort((a, b) => scores[b] - scores[a]), [open, scores]);
  const fresh = open.filter((i) => leadAgeDays(M, i) <= 30).length;
  const notCalled = open.filter((i) => !wasCalled(M, i)).length;
  const late = breaches.reduce((s, b) => s + b.breaches, 0);
  const lapsedN = lapsed.reduce((s, g) => s + g.length, 0);
  const lapsedRev = lapsed.reduce((s, g) => s + g.reduce((x, r) => x + riskRevenue(M, r, M.p.salesEnd), 0), 0);

  const hotCols: Col<number>[] = [
    { key: 'score', label: 'Score', num: true, render: (i) => scores[i].toFixed(0), sort: (i) => scores[i] },
    { key: 'name', label: 'Name', render: (i) => L.name[i] || '—', sort: (i) => L.name[i] },
    { key: 'mob', label: 'Mobile', render: (i) => L.mob[i], sort: (i) => L.mob[i] },
    { key: 'city', label: 'City', render: (i) => (L.c[i] >= 0 ? M.p.dims.city[L.c[i]] : '—'), sort: (i) => (L.c[i] >= 0 ? M.p.dims.city[L.c[i]] : '') },
    { key: 'src', label: 'Source', render: (i) => M.p.dims.source[L.src[i]], sort: (i) => L.src[i] },
    { key: 'camp', label: 'Campaign', render: (i) => M.p.dims.campaign[L.camp[i]] ?? '—', sort: (i) => M.p.dims.campaign[L.camp[i]] ?? '' },
    { key: 'age', label: 'Age (days)', num: true, render: (i) => num(leadAgeDays(M, i)), sort: (i) => leadAgeDays(M, i) },
    { key: 'owner', label: 'Owner', render: (i) => (L.owner[i] >= 0 ? M.p.dims.owner[L.owner[i]] : '—'), sort: (i) => L.owner[i] },
    { key: 'called', label: 'Called', render: (i) => (wasCalled(M, i) ? 'Yes' : L.called?.[i] === 0 ? 'No' : '—'), sort: (i) => (wasCalled(M, i) ? 1 : 0) },
    { key: 'cat', label: 'Category', render: (i) => (L.status[i] >= 0 ? M.p.dims.status[L.status[i]] : '—'), sort: (i) => (L.status[i] >= 0 ? M.p.dims.status[L.status[i]] : '') },
  ];

  return (
    <Section def={SECTIONS.find((s) => s.id === 'ageing')!} n={6}>
      {M.p.hasLeads && (
        <div className="ld-kpis ld-kpis-4">
          <Kpi icon={Inbox} label="Open leads" rag="none" value={num(open.length)} sub={`${num(fresh)} under 30 days old: the best time to convert`}
            info="Unique leads with a valid mobile that have not turned into a retailer yet (in the period and filters)." />
          <Kpi icon={PhoneOff} label="Not called yet" rag={notCalled ? 'amber' : 'green'} value={num(notCalled)} sub={open.length ? `${((100 * notCalled) / open.length).toFixed(0)}% of open leads` : undefined}
            info="Open leads with no call recorded in the follow-up sheet." />
          <Kpi icon={AlarmClock} label="Late follow-ups" rag={late ? 'red' : 'green'} value={M.p.hasFollowup ? num(late) : '—'} sub={`first contact later than ${sla} days, or none yet`}
            info={`Open leads whose first contact came more than ${sla} days after the lead, or that are older than ${sla} days with no contact.${M.p.hasContactDates ? '' : ' The ASM sheet has no call dates, so a lead marked Calling Done counts as on time.'}`} />
          <Kpi icon={RotateCcw} label="Lapsed retailers to win back" rag="none" value={num(lapsedN)} sub={`${inr(lapsedRev)} billed in their last quarter`}
            info="Retailers with a phone number and no bill for 3 or more months before the last sales month." />
        </div>
      )}
      <div className="ld-grid">
        <Card title="Call these first" wide uses={[...LEAD_USES]}
          info={{ what: 'Open leads, best chance first. Score 0–100: its campaign\'s conversion rate relative to the best campaign (40, small campaigns pulled toward the average), recency (30, zero after 90 days), we already have an active retailer in its city (15), name and pincode given (15). The download has every open lead in score order.', source: 'Lead dump, lead outcomes, retailers' }}
          csv={{ name: 'call_first', rows: () => csvRows(hot, hotCols) }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : <Table rows={hot} cols={hotCols} limit={15} empty="No open leads for these filters." />}
        </Card>
        <Card title="Late follow-ups by owner" uses={[...LEAD_USES]}
          info={{ what: `Open leads per owner, how many are late (first contact after ${sla} days, or none yet) and how many were never called.${M.p.hasContactDates ? '' : ' The ASM sheet has no call dates, so a lead marked Calling Done counts as on time.'}`, source: 'Follow-up log' }}
          csv={{ name: 'late_followups_by_owner', rows: () => breaches.map((b) => ({ Owner: b.owner, 'Open leads': b.open, Late: b.breaches, 'Not called': b.notCalled, 'Oldest (days)': b.oldest })) }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : !M.p.hasFollowup ? <NeedsData what="followup" /> : (
            <Table rows={breaches} initialSort={{ key: 'b', dir: 'desc' }} limit={10} cols={[
              { key: 'o', label: 'Owner', render: (b) => b.owner, sort: (b) => b.owner },
              { key: 'n', label: 'Open', num: true, render: (b) => num(b.open), sort: (b) => b.open },
              { key: 'b', label: 'Late', num: true, render: (b) => num(b.breaches), sort: (b) => b.breaches },
              { key: 'nc', label: 'Not called', num: true, render: (b) => num(b.notCalled), sort: (b) => b.notCalled },
              { key: 'old', label: 'Oldest (days)', num: true, render: (b) => num(b.oldest), sort: (b) => b.oldest },
            ]} />
          )}
        </Card>
        <CallLists lapsed={lapsed} />
      </div>
    </Section>
  );
}
