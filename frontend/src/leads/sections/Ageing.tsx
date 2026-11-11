import { useMemo } from 'react';
import { Card, NeedsData, Section, Table, csvRows, num, useLeads, type Col } from '../ui';
import { StackedBars } from '../charts';
import { SECTIONS } from '../sections';
import { health, isOpen, leadAgeDays, leadOk, NEW, outcomeOf, PENDING, wasCalled, type Model } from '../model';

const AGE = [{ label: '0–7 days', max: 7 }, { label: '8–30 days', max: 30 }, { label: '31–60 days', max: 60 }, { label: '60+ days', max: Infinity }];
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

  const open = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < M.nL; i++) if (L.uniq[i] && L.valid[i] && isOpen(outcomeOf(M, i, f.level, f.window)) && leadOk(M, f, i, rg)) out.push(i);
    return out;
  }, [M, f, rg, L]);

  const ageData = useMemo(() => {
    const rows = AGE.map((a) => ({ label: a.label, contacted: 0, assigned: 0, none: 0 }));
    for (const i of open) {
      const age = leadAgeDays(M, i);
      const row = rows[AGE.findIndex((a) => age <= a.max)];
      if (wasCalled(M, i)) row.contacted++;
      else if (L.owner[i] >= 0 || L.fdist[i] >= 0) row.assigned++;
      else row.none++;
    }
    return rows;
  }, [M, open, L]);

  const breaches = useMemo(() => {
    const by = new Map<string, { owner: string; open: number; breaches: number; oldest: number }>();
    for (const i of open) {
      const owner = L.owner[i] >= 0 ? M.p.dims.owner[L.owner[i]] : 'Not assigned';
      const e = by.get(owner) ?? by.set(owner, { owner, open: 0, breaches: 0, oldest: 0 }).get(owner)!;
      e.open++;
      // with no call date (ASM sheet), a called lead counts as on time
      const late = L.contact[i] >= 0 ? L.contact[i] - L.day[i] > sla : wasCalled(M, i) ? false : leadAgeDays(M, i) > sla;
      if (late) e.breaches++;
      e.oldest = Math.max(e.oldest, leadAgeDays(M, i));
    }
    return [...by.values()];
  }, [M, open, L, sla]);

  const hot = useMemo(() => [...open].sort((a, b) => scores[b] - scores[a]), [open, scores]);
  const dist = useMemo(() => {
    const bands = ['0–19', '20–39', '40–59', '60–79', '80–100'].map((label) => ({ label, leads: 0 }));
    for (const i of open) bands[Math.min(4, Math.floor(scores[i] / 20))].leads++;
    return bands;
  }, [open, scores]);

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
    <Section def={SECTIONS[5]} n={6}>
      <div className="ld-grid">
        <Card title="Open leads by age" uses={[...LEAD_USES]}
          info={{ what: 'Unique leads with a valid mobile that have not converted, by days since the lead (as of the data date), split by follow-up state.', source: 'Lead dump + follow-up log' }}
          csv={{ name: 'open_leads_by_age', rows: () => ageData.map((r) => ({ Age: r.label, Contacted: r.contacted, 'Assigned, no contact': r.assigned, 'Not assigned': r.none })) }}
          soWhat={open.length ? <>{num(ageData[0].contacted + ageData[0].assigned + ageData[0].none + ageData[1].contacted + ageData[1].assigned + ageData[1].none)} open leads are under 30 days old: the window where most conversions happen.</> : undefined}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <StackedBars data={ageData} x="label" fmt={num} series={[
              { key: 'contacted', label: 'Contacted', color: 'var(--ld-seq-5)' },
              { key: 'assigned', label: 'Assigned, no contact', color: 'var(--ld-seq-3)' },
              { key: 'none', label: 'No follow-up recorded', color: 'var(--ld-o-not)' }]} />
          )}
        </Card>
        <Card title="SLA breaches by owner" uses={[...LEAD_USES]}
          info={{ what: `Open leads whose first contact came more than ${sla} days after the lead, or that are older than ${sla} days with no contact.${M.p.hasContactDates ? '' : ' The ASM sheet has no call dates, so a lead marked Calling Done counts as on time.'}`, formula: 'breaches ÷ open leads per owner', source: 'Follow-up log' }}
          csv={{ name: 'sla_breaches', rows: () => breaches.map((b) => ({ Owner: b.owner, 'Open leads': b.open, Breaches: b.breaches, 'Oldest (days)': b.oldest })) }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : !M.p.hasFollowup ? <NeedsData what="followup" /> : (
            <Table rows={breaches} initialSort={{ key: 'b', dir: 'desc' }} cols={[
              { key: 'o', label: 'Owner', render: (b) => b.owner, sort: (b) => b.owner },
              { key: 'n', label: 'Open', num: true, render: (b) => num(b.open), sort: (b) => b.open },
              { key: 'b', label: 'Breaches', num: true, render: (b) => num(b.breaches), sort: (b) => b.breaches },
              { key: 'old', label: 'Oldest (days)', num: true, render: (b) => num(b.oldest), sort: (b) => b.oldest },
            ]} />
          )}
        </Card>
        <Card title="Lead score: who to call first" wide uses={[...LEAD_USES]}
          info={{ what: 'Score 0–100 for each open lead: its campaign\'s conversion rate relative to the best campaign (40, small campaigns pulled toward the average), recency (30, zero after 90 days), we already have an active retailer in its city (15), name and pincode given (15).', source: 'Lead dump, lead outcomes, retailers' }}
          csv={{ name: 'hot_leads', rows: () => csvRows(hot, hotCols) }}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <div className="ld-split">
              <StackedBars data={dist} x="label" fmt={num} height={200} series={[{ key: 'leads', label: 'Open leads', color: 'var(--ld-seq-4)' }]} />
              <Table rows={hot} cols={hotCols} limit={10} />
            </div>
          )}
        </Card>
      </div>
    </Section>
  );
}
