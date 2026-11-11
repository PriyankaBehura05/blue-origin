import { useMemo } from 'react';
import { MessageCircle, PhoneCall, Footprints } from 'lucide-react';
import { Card, ExportBtn, NeedsData, Section, STROKE, downloadCsv, inr, num, useLeads } from '../ui';
import { heat } from '../charts';
import { SECTIONS } from '../sections';
import { health, isOpen, lastBilledUpTo, leadAgeDays, leadOk, monthName, outcomeOf, retailerOk, riskRevenue, tierAt } from '../model';

const RECENCY = [{ label: '0–30 days', max: 30 }, { label: '31–90 days', max: 90 }, { label: '91–180 days', max: 180 }, { label: '180+ days', max: Infinity }];
type Channel = 'ASM visit' | 'AI voice call' | 'WhatsApp blast';
const CH_ICON = { 'ASM visit': Footprints, 'AI voice call': PhoneCall, 'WhatsApp blast': MessageCircle };

// the rule, by city tier (0 Tier 1, 1 Tier 2, 2 Tier 3, 3 Unknown) and recency band
function channelFor(tier: number, band: number): Channel {
  if (band === 0) return tier <= 1 ? 'ASM visit' : 'AI voice call';
  if (band === 1) return 'AI voice call';
  return 'WhatsApp blast';
}
// lapsed retailers: by their last tier (0 Untiered .. 5 Platinum)
const lapsedChannel = (t: number): Channel => (t >= 3 ? 'ASM visit' : t >= 1 ? 'AI voice call' : 'WhatsApp blast');

function ChannelTag({ c }: { c: Channel }) {
  const I = CH_ICON[c];
  return <span className="ld-tag" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><I size={12} strokeWidth={STROKE} aria-hidden />{c}</span>;
}

export default function Untapped() {
  const { M, f, rg } = useLeads();
  const L = M.p.leads;
  const R = M.p.retailers;
  const T = M.p.dims.cityTiers;

  const seg = useMemo(() => {
    const cells = T.map(() => RECENCY.map(() => [] as number[]));
    for (let i = 0; i < M.nL; i++) {
      if (!L.uniq[i] || !L.valid[i] || !isOpen(outcomeOf(M, i, f.level, f.window)) || !leadOk(M, f, i, rg, ['outcome'])) continue;
      const t = L.c[i] >= 0 ? M.p.dims.cityTier[L.c[i]] : T.length - 1;
      const age = leadAgeDays(M, i);
      cells[t][RECENCY.findIndex((b) => age <= b.max)].push(i);
    }
    return cells;
  }, [M, f, rg, L, T]);

  const lapsed = useMemo(() => {
    const end = M.p.salesEnd;
    const groups = M.p.dims.tiers.map(() => [] as number[]);
    for (let r = 0; r < M.nR; r++) {
      if (!R.phone[r] || health(M, r, end) !== 'Churned' || !retailerOk(M, f, r, end, ['tier'])) continue;
      const last = lastBilledUpTo(M, r, end);
      const t = Math.max(0, tierAt(M, r, last));
      if (f.tier >= 0 && t !== f.tier) continue;
      groups[t].push(r);
    }
    return groups;
  }, [M, f, R]);

  const leadList = (idx: number[], channel: Channel) => idx.map((i) => ({
    Name: L.name[i], Mobile: L.mob[i], City: L.c[i] >= 0 ? M.p.dims.city[L.c[i]] : '', Pincode: L.pin[i], State: L.s[i] >= 0 ? M.p.dims.state[L.s[i]] : '',
    Source: M.p.dims.source[L.src[i]], Campaign: M.p.dims.campaign[L.camp[i]] ?? '', 'Lead date': new Date(L.day[i] * 86400000).toISOString().slice(0, 10),
    'Age (days)': leadAgeDays(M, i), Channel: channel,
  }));
  const retList = (idx: number[], channel: Channel) => idx.map((r) => {
    const last = lastBilledUpTo(M, r, M.p.salesEnd);
    return { Retailer: R.name[r], 'Retailer ID': R.id[r], Phone: R.phone[r], Distributor: M.p.dims.dist[R.d[r]] ?? '', State: M.p.dims.state[R.s[r]] ?? '',
      City: R.c[r] >= 0 ? M.p.dims.city[R.c[r]] : '', 'Last bill': last >= 0 ? monthName(M, last) : '', 'Last quarter billing (₹)': Math.round(riskRevenue(M, r, M.p.salesEnd)), Channel: channel };
  });

  const total = seg.flat().reduce((s, c) => s + c.length, 0);
  const maxCell = Math.max(1, ...seg.flat().map((c) => c.length));
  return (
    <Section def={SECTIONS[8]} n={9}>
      <div className="ld-grid">
        <Card title="Not-converted leads: city tier × recency" wide uses={['period', 'source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          info={{ what: 'Valid unique leads that have not converted (JustDial and business-repository contacts arrive through the lead dump with their source), by city tier and days since the lead. Each cell shows the recommended channel; the arrow downloads its call / blast list.',
            formula: 'Channel rule: 0–30 days → ASM visit in Tier 1–2 cities, AI voice call elsewhere; 31–90 days → AI voice call; over 90 days → WhatsApp blast',
            source: 'Lead dump, lead outcomes; city tiers: Tier 1 = 9 metros, Tier 2 = HRA "Y" cities' }}
          csv={{ name: 'untapped_leads_all', rows: () => seg.flatMap((row, t) => row.flatMap((cell, b) => leadList(cell, channelFor(t, b)))) }}
          soWhat={total ? <>{num(total)} leads paid for but not converted. Start with the 0–30 day cells: they are the cheapest retailers you will ever acquire.</> : undefined}>
          {!M.p.hasLeads ? <NeedsData what="leads" /> : (
            <div className="ld-table-wrap">
              <table className="ld-table ld-heat">
                <thead><tr><th>City tier</th>{RECENCY.map((b) => <th key={b.label} className="num">{b.label}</th>)}</tr></thead>
                <tbody>
                  {T.map((t, ti) => (
                    <tr key={t}>
                      <td>{t}</td>
                      {RECENCY.map((b, bi) => {
                        const cell = seg[ti][bi];
                        const ch = channelFor(ti, bi);
                        return (
                          <td key={b.label} className="cell" style={{ ...heat(cell.length / maxCell), verticalAlign: 'middle' }}>
                            <div style={{ fontWeight: 700 }}>{num(cell.length)}</div>
                            {cell.length > 0 && <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center', marginTop: 3 }}>
                              <ChannelTag c={ch} />
                              <ExportBtn label={`Download ${t} · ${b.label} list`} onClick={() => downloadCsv(`untapped_${t}_${b.label}`.replace(/\W+/g, '_'), leadList(cell, ch))} />
                            </div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Lapsed retailers to win back" wide uses={['source', 'campaign', 'state', 'city', 'dist', 'tier', 'level', 'window']}
          info={{ what: 'Retailers with a phone number whose last bill was 3 or more months before the last sales month (Churned), by their tier when they last billed. Higher tiers get a visit.', formula: 'Channel: Silver and above → ASM visit; Yellow / Green → AI voice call; Untiered → WhatsApp blast', source: 'retailers.csv, retailer_month.csv, retailer_quarter.csv' }}
          csv={{ name: 'lapsed_retailers_all', rows: () => lapsed.flatMap((g, t) => retList(g, lapsedChannel(t))) }}>
          <table className="ld-table">
            <thead><tr><th>Last tier</th><th className="num">Retailers</th><th className="num">Their last-quarter billing</th><th>Channel</th><th /></tr></thead>
            <tbody>
              {lapsed.map((g, t) => ({ g, t })).reverse().filter(({ g }) => g.length).map(({ g, t }) => (
                <tr key={t}>
                  <td>{M.p.dims.tiers[t]}</td>
                  <td className="num">{num(g.length)}</td>
                  <td className="num">{inr(g.reduce((s, r) => s + riskRevenue(M, r, M.p.salesEnd), 0))}</td>
                  <td><ChannelTag c={lapsedChannel(t)} /></td>
                  <td><ExportBtn label={`Download lapsed ${M.p.dims.tiers[t]} list`} onClick={() => downloadCsv(`lapsed_${M.p.dims.tiers[t]}`, retList(g, lapsedChannel(t)))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </Section>
  );
}
