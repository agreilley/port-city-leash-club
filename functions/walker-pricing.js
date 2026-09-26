// walker-pricing.js
// Single source of truth for walker payout rates and earnings
// calculation — imported by both walker/dashboard.html (what a walker
// sees for themselves) and admin/dashboard.html's walker earnings view
// (so admin can cross-check without a second, possibly-drifting
// calculation). Mirrors pricing.js's pattern, but these are payout
// rates paid TO the walker, not the client-facing charges in
// pricing.js — deliberately a separate table since they're different
// numbers for the same service (the business's margin).
//
// No holiday surcharge — decided against on 2026-08-27, not an
// oversight. It is not listed on the walker Rate Card and does not
// need to be added; do not re-introduce it without a new decision.
//
// MIRRORED INTO functions/walker-pricing.js — Cloud Functions (walk/overnight
// completion triggers, payout generation) can only deploy files inside
// functions/, so firebase.json's predeploy hook copies this file (and its
// pricing.js dependency) there on every `firebase deploy --only functions`.
// This file is the source of truth; functions/walker-pricing.js is a
// generated copy — edit here, never there.

import { getDaysBetween } from './pricing.js';

export const WALKER_RATES = {
  standard: 16,
  extended: 24,
  checkin: 13,
  // $65, not the $45 base overnight rate alone — a composite figure:
  // $45 overnight + $13 check-in + a $7 top-up, since an overnight stay
  // includes a mid-day check-in, not just overnight-only coverage. $45
  // alone works out to under $5/hour for 12+ hours, well below the
  // ~$32/hour walk rate — a retention risk raised and corrected in an
  // earlier session. Don't "simplify" this back down to $45.
  overnight: 65,
};

export const WALKER_EXTRA_PET_FEE = 5;
export const WALKER_MEDICATION_FEE = 5;

export function isCheckinType(serviceType) {
  return serviceType === 'checkin' || serviceType === 'drop-in-visit';
}

// A completed walks/{id} doc -> what the walker is paid for it.
export function calculateWalkPayout(walk) {
  return walk.extended ? WALKER_RATES.extended : WALKER_RATES.standard;
}

// A completed overnights/{id} doc -> what the walker is paid for it.
// Days is at least 1 even if start/end land on the same calendar day —
// getDaysBetween can return 0 for a same-day booking, and a confirmed
// stay/visit is never worth $0.
//
// Check-in stays confirmed with a per-day visit schedule (visitSchedule —
// see admin/dashboard.html's confirmServiceRequest) pay the base rate per
// VISIT, not per day: three visits in one day is three round trips, and
// WALKER_RATES.checkin is a per-visit rate, same as it's always been for a
// single-visit day — a walker doing three visits earns three times what a
// walker doing one does, not the same flat day-rate either way. Overnight
// stays, and any check-in doc with no schedule yet (data written before
// this existed, or an anonymous drop-in-visit booking not yet carrying
// one), fall back to the original days-based rate, unchanged. Multiple
// Pets / Medication Admin stay per-DAY regardless — that matches how the
// member is actually charged for those add-ons (pricing.js's
// calculateServiceTotal multiplies them by days, never by visit count),
// so walker pay for them shouldn't diverge from that.
export function calculateOvernightPayout(overnight) {
  const key = isCheckinType(overnight.serviceType) ? 'checkin' : 'overnight';
  const start = overnight.startDate?.toDate ? overnight.startDate.toDate() : overnight.startDate;
  const end = overnight.endDate?.toDate ? overnight.endDate.toDate() : overnight.endDate;
  const days = Math.max(getDaysBetween(start, end), 1);

  const hasVisitSchedule = key === 'checkin' && Array.isArray(overnight.visitSchedule) && overnight.visitSchedule.length > 0;
  const units = hasVisitSchedule
    ? overnight.visitSchedule.reduce((sum, d) => sum + (Number(d.visits) || 0), 0)
    : days;

  const base = WALKER_RATES[key] * units;

  // Paid add-on drop-ins on an overnight stay (addOnDropIns — see
  // pricing.js's calculateAddOnDropInTotal): WALKER_RATES.checkin per visit,
  // no pet/medication fees — mirrors the member side, which doesn't charge
  // them again on top of the stay's.
  // Overnight-only; a check-in doc never carries them.
  const addOnDays = key === 'overnight' && Array.isArray(overnight.addOnDropIns)
    ? overnight.addOnDropIns.filter(d => (Number(d?.visits) || 0) > 0)
    : [];
  const addOnDropInVisits = addOnDays.reduce((sum, d) => sum + Number(d.visits), 0);
  const addOnDropInBase = WALKER_RATES.checkin * addOnDropInVisits;

  const extraPetTotal = overnight.extraPet ? WALKER_EXTRA_PET_FEE * days : 0;
  const medicationTotal = overnight.medication ? WALKER_MEDICATION_FEE * days : 0;

  return {
    total: base + addOnDropInBase + extraPetTotal + medicationTotal,
    key, base, extraPetTotal, medicationTotal, days, units, addOnDropInVisits, addOnDropInBase,
  };
}

// ── Per-visit walker overrides ──────────────────────────────────────────
// An overnights doc's `walkerId` is the reservation's DEFAULT walker. Any
// entry in its `visits` array can name a different walker (visit.walkerId)
// to cover just that visit. An empty visit.walkerId means the default does
// it. A completed visit is stamped with whoever completed it, the default
// included, so that stamp reads the same way.

// Who is doing (or did) this visit.
export function visitWalkerId(visit, overnight) {
  return (visit?.walkerId || '').trim() || (overnight?.walkerId || '').trim();
}

// Every walker with work on this reservation: the default plus anyone
// covering a visit. Stored on the doc as `walkerIds` so a covering walker
// can query for (and security rules can grant) the reservations they're on.
export function overnightWalkerIds(overnight) {
  const ids = new Set();
  const def = (overnight?.walkerId || '').trim();
  if (def) ids.add(def);
  (Array.isArray(overnight?.visits) ? overnight.visits : []).forEach(v => {
    const id = (v?.walkerId || '').trim();
    if (id) ids.add(id);
  });
  return [...ids];
}

// What each COVERING walker (not the default) earns on this reservation,
// as { [walkerId]: { visits, baseTotal, dropInTotal, extraPetTotal,
// medicationTotal, amount } }. Empty when the default does everything.
// - Each covered visit pays WALKER_RATES.checkin. On a drop-in booking
//   that's the booking's own base unit (baseTotal). On an overnight stay
//   it's filed as a drop-in (dropInTotal), included check-in or paid
//   add-on alike; the night itself always stays with the default.
// - Multiple Pets / Medication are per-day fees. On a drop-in booking, a
//   day whose visits were ALL done by one covering walker moves that day's
//   fees to them. A split day keeps them with the default. On an overnight
//   stay they belong with the night, so they never move.
// The default's share is whatever the whole payout leaves after these (see
// overnightPayoutShare), so the reservation's total never changes.
export function calculateVisitCovers(overnight) {
  const def = (overnight?.walkerId || '').trim();
  const isCheckin = isCheckinType(overnight?.serviceType);
  const visits = Array.isArray(overnight?.visits) ? overnight.visits : [];
  const coverOf = (v) => {
    const id = (v?.walkerId || '').trim();
    return id && id !== def ? id : '';
  };
  const covers = {};
  const cover = (id) => (covers[id] ||= { visits: 0, baseTotal: 0, dropInTotal: 0, extraPetTotal: 0, medicationTotal: 0, amount: 0 });

  visits.forEach(v => {
    const id = coverOf(v);
    if (!id) return;
    const c = cover(id);
    c.visits++;
    if (isCheckin) c.baseTotal += WALKER_RATES.checkin;
    else c.dropInTotal += WALKER_RATES.checkin;
  });

  if (isCheckin && (overnight.extraPet || overnight.medication)) {
    const byDate = {};
    visits.forEach(v => { (byDate[v.date] ||= []).push(coverOf(v)); });
    Object.values(byDate).forEach(ids => {
      if (!ids[0] || !ids.every(id => id === ids[0])) return;
      const c = cover(ids[0]);
      if (overnight.extraPet) c.extraPetTotal += WALKER_EXTRA_PET_FEE;
      if (overnight.medication) c.medicationTotal += WALKER_MEDICATION_FEE;
    });
  }

  Object.values(covers).forEach(c => { c.amount = c.baseTotal + c.dropInTotal + c.extraPetTotal + c.medicationTotal; });
  return covers;
}

// The whole-reservation payout in the stamped shape onOvernightCompleted
// writes (functions/index.js), computed live — for readers that price
// work not yet stamped. `covers` is included the same way it's stamped.
export function liveOvernightPayout(overnight) {
  const p = calculateOvernightPayout(overnight);
  return {
    rateKey: p.key, baseTotal: p.base, addOnDropInBaseTotal: p.addOnDropInBase,
    extraPetTotal: p.extraPetTotal, medicationTotal: p.medicationTotal, amount: p.total,
    covers: calculateVisitCovers(overnight),
  };
}

// One walker's share of a reservation's payout, from a payout in the
// stamped shape (overnight.payout, or liveOvernightPayout). Returns
// { baseTotal, dropInTotal, extraPetTotal, medicationTotal, amount }:
// baseTotal files under the reservation's own rateKey, dropInTotal under
// Drop-In Visit. A payout with no `covers` (every reservation stamped
// before overrides existed) is paid whole to the default, as it always was.
// The default gets the payout minus every cover. If the default changed
// after stamping and the new default was a covering walker, they get both.
export function overnightPayoutShare(overnight, walkerId, payout = overnight?.payout) {
  const share = { baseTotal: 0, dropInTotal: 0, extraPetTotal: 0, medicationTotal: 0, amount: 0 };
  if (!payout || !walkerId) return share;
  const covers = payout.covers || {};
  const sum = (field) => Object.values(covers).reduce((s, c) => s + (Number(c[field]) || 0), 0);

  if (walkerId === (overnight?.walkerId || '').trim()) {
    const extraPetTotal = Math.max(0, (payout.extraPetTotal || 0) - sum('extraPetTotal'));
    const medicationTotal = Math.max(0, (payout.medicationTotal || 0) - sum('medicationTotal'));
    const dropInTotal = Math.max(0, (payout.addOnDropInBaseTotal || 0) - sum('dropInTotal'));
    // Whatever's left after the covers is the default's base — for an
    // overnight stay that's the night rate less any covered included
    // check-ins, which is why this isn't just baseTotal minus covers' base.
    const baseTotal = Math.max(0, (payout.amount || 0) - sum('amount') - extraPetTotal - medicationTotal - dropInTotal);
    share.baseTotal += baseTotal;
    share.dropInTotal += dropInTotal;
    share.extraPetTotal += extraPetTotal;
    share.medicationTotal += medicationTotal;
  }
  const own = covers[walkerId];
  if (own) {
    share.baseTotal += own.baseTotal || 0;
    share.dropInTotal += own.dropInTotal || 0;
    share.extraPetTotal += own.extraPetTotal || 0;
    share.medicationTotal += own.medicationTotal || 0;
  }
  share.amount = share.baseTotal + share.dropInTotal + share.extraPetTotal + share.medicationTotal;
  return share;
}

// Whether this walker has a share of this reservation's payout to be paid:
// the default always does, a covering walker only when the stamped payout
// names them. Reads the stamp, not live visits, so a reservation stamped
// before overrides existed can never pick up a second payee after the fact.
export function isOvernightPayee(overnight, walkerId, payout = overnight?.payout) {
  if (!walkerId) return false;
  return walkerId === (overnight?.walkerId || '').trim() || !!payout?.covers?.[walkerId];
}

// The walkerPayments id that has claimed this walker's share, if any. The
// default's claim lives in `payoutId` (unchanged from before overrides);
// a covering walker's lives in `payoutIds[walkerId]`.
export function overnightClaimFor(overnight, walkerId) {
  if (walkerId && walkerId === (overnight?.walkerId || '').trim()) return overnight?.payoutId || null;
  return overnight?.payoutIds?.[walkerId] || null;
}

// Tips on this reservation that go to this walker. The reservation-wide tip
// goes to the default. An older per-visit tip goes to whoever did the visit.
export function overnightTipShare(overnight, walkerId) {
  const charged = (tip) => (tip?.chargeStatus === 'charged' ? tip.amountCents / 100 : 0);
  let total = walkerId && walkerId === (overnight?.walkerId || '').trim() ? charged(overnight?.tip) : 0;
  (Array.isArray(overnight?.visits) ? overnight.visits : []).forEach(v => {
    if (visitWalkerId(v, overnight) === walkerId) total += charged(v.tip);
  });
  return total;
}

// Aggregates a walker's payout across a set of already-completed walks
// and already-completed overnights (caller is responsible for both the
// status==='completed' filter and whatever date-range filter applies —
// this function only sums and categorizes what it's handed). Returns a
// total plus a per-category breakdown so both portals can render the
// same "This Month" / "All Time" style cards and a service-type table
// from one calculation.
// Pass walkerId to count only that walker's share of each reservation
// (see overnightPayoutShare) — needed once other walkers can cover
// individual visits. Without it, each reservation counts whole.
export function calculateEarnings(completedWalks, completedOvernights, walkerId) {
  const breakdown = {
    standard: { label: 'Standard Walk', count: 0, total: 0 },
    extended: { label: 'Extended Walk', count: 0, total: 0 },
    checkin: { label: 'Drop-In Visit', count: 0, total: 0 },
    overnight: { label: 'Overnight Stay', count: 0, total: 0 },
    extraPet: { label: 'Multiple Pets', count: 0, total: 0 },
    medication: { label: 'Medication Admin', count: 0, total: 0 },
  };
  let total = 0;

  (completedWalks || []).forEach(w => {
    const amount = calculateWalkPayout(w);
    const key = w.extended ? 'extended' : 'standard';
    breakdown[key].count++;
    breakdown[key].total += amount;
    total += amount;
  });

  (completedOvernights || []).forEach(o => {
    if (walkerId) {
      // Live base amounts, same as the no-walkerId path. Covers come from
      // the stamp once there is one, so this agrees with what payout
      // generation will actually split (a pre-overrides stamp has none).
      const live = liveOvernightPayout(o);
      const payout = o.payout ? { ...live, covers: o.payout.covers || {} } : live;
      const { baseTotal, dropInTotal, extraPetTotal, medicationTotal } = overnightPayoutShare(o, walkerId, payout);
      if (baseTotal) { breakdown[live.rateKey].count++; breakdown[live.rateKey].total += baseTotal; total += baseTotal; }
      if (dropInTotal) { breakdown.checkin.count++; breakdown.checkin.total += dropInTotal; total += dropInTotal; }
      if (extraPetTotal) { breakdown.extraPet.count++; breakdown.extraPet.total += extraPetTotal; total += extraPetTotal; }
      if (medicationTotal) { breakdown.medication.count++; breakdown.medication.total += medicationTotal; total += medicationTotal; }
      return;
    }
    const { key, base, extraPetTotal, medicationTotal, addOnDropInBase } = calculateOvernightPayout(o);
    breakdown[key].count++;
    breakdown[key].total += base;
    total += base;
    if (addOnDropInBase) { breakdown.checkin.count++; breakdown.checkin.total += addOnDropInBase; total += addOnDropInBase; }
    if (extraPetTotal) { breakdown.extraPet.count++; breakdown.extraPet.total += extraPetTotal; total += extraPetTotal; }
    if (medicationTotal) { breakdown.medication.count++; breakdown.medication.total += medicationTotal; total += medicationTotal; }
  });

  return { total, breakdown, walkCount: (completedWalks || []).length, overnightCount: (completedOvernights || []).length };
}
