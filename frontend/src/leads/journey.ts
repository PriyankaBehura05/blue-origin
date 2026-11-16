// Lead journey stages, one definition for the funnel, the ASM tables and the exceptions (Lead journey page):
//   Generated       a unique lead (first enquiry per mobile)
//   Assigned        it has an ASM (ASM NAME on the lead sheet, or the follow-up log)
//   Contacted       the ASM called it (Calling Done = yes, or a contact date)
//   Interested      it showed interest: a visit, an order reported, or a positive call result (Interested, Catalogue sent, ...)
//   Converted       the ASM reports an order (Order Placed = yes, or call result Converted)
//   First purchase  BO confirms it: the matched retailer's first-ever bill came after the lead (outcome New retailer)
// The funnel is nested (each stage counts only leads that passed the one before); BO first purchases that skipped a recorded
// step are counted separately, so nothing is hidden.
import { leadOk, NEW, outcomeOf, PENDING, REACTIVATED, wasCalled, type Filters, type Model, type Range } from './model';

const POSITIVE = new Set(['Interested', 'Catalogue sent', 'Distributor visit', 'Wants distributorship', 'Franchise enquiry', 'Commercial', 'Converted']);

export const STAGES = ['Generated', 'Assigned', 'Contacted', 'Interested', 'Converted', 'First purchase'] as const;

export const isAssigned = (M: Model, i: number) => M.p.leads.owner[i] >= 0;
export const isInterested = (M: Model, i: number) => {
  const L = M.p.leads;
  return L.visited?.[i] === 1 || L.ordered?.[i] === 1 || POSITIVE.has(M.p.dims.status[L.status[i]] ?? '');
};
export const isConvertedByAsm = (M: Model, i: number) => M.p.leads.ordered?.[i] === 1 || M.p.dims.status[M.p.leads.status[i]] === 'Converted';

/** How far a lead got: 0 Generated … 5 First purchase (nested). */
export function stageOf(M: Model, i: number, f: Filters): number {
  if (!isAssigned(M, i)) return 0;
  if (!wasCalled(M, i)) return 1;
  if (!isInterested(M, i)) return 2;
  if (!isConvertedByAsm(M, i)) return 3;
  return outcomeOf(M, i, f.level, f.window) === NEW ? 5 : 4;
}

export interface JourneyAgg {
  stages: number[];          // leads that reached each stage (nested)
  firstPurchaseOther: number; // BO first purchases from leads that skipped a recorded follow-up step
  pending: number;           // assigned, not contacted, not converted: follow-up pending
  judged: number;
  converted: number;         // BO: new retailer or came back
}

export function journeyAgg(M: Model, f: Filters, rg: Range | null, pick?: (i: number) => boolean): JourneyAgg {
  const L = M.p.leads;
  const a: JourneyAgg = { stages: [0, 0, 0, 0, 0, 0], firstPurchaseOther: 0, pending: 0, judged: 0, converted: 0 };
  for (let i = 0; i < M.nL; i++) {
    if (!L.uniq[i] || !leadOk(M, f, i, rg) || (pick && !pick(i))) continue;
    const s = stageOf(M, i, f);
    for (let k = 0; k <= s; k++) a.stages[k]++;
    const o = outcomeOf(M, i, f.level, f.window);
    if (o === NEW && s < 5) a.firstPurchaseOther++;
    if (L.valid[i] && o !== PENDING) a.judged++;
    if (o === NEW || o === REACTIVATED) a.converted++;
    if (isAssigned(M, i) && !wasCalled(M, i) && o !== NEW && o !== REACTIVATED && L.valid[i]) a.pending++;
  }
  return a;
}
