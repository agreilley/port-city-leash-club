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

function isCheckinType(serviceType) {
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
    ? overnight.visitSchedule.reduce((sum, d) => sum + (d.visits || 0), 0)
    : days;

  const base = WALKER_RATES[key] * units;
  const extraPetTotal = overnight.extraPet ? WALKER_EXTRA_PET_FEE * days : 0;
  const medicationTotal = overnight.medication ? WALKER_MEDICATION_FEE * days : 0;

  return { total: base + extraPetTotal + medicationTotal, key, base, extraPetTotal, medicationTotal, days, units };
}

// Aggregates a walker's payout across a set of already-completed walks
// and already-completed overnights (caller is responsible for both the
// status==='completed' filter and whatever date-range filter applies —
// this function only sums and categorizes what it's handed). Returns a
// total plus a per-category breakdown so both portals can render the
// same "This Month" / "All Time" style cards and a service-type table
// from one calculation.
export function calculateEarnings(completedWalks, completedOvernights) {
  const breakdown = {
    standard: { label: 'Standard Walk', count: 0, total: 0 },
    extended: { label: 'Extended Walk', count: 0, total: 0 },
    checkin: { label: 'Check-In Visit', count: 0, total: 0 },
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
    const { key, base, extraPetTotal, medicationTotal } = calculateOvernightPayout(o);
    breakdown[key].count++;
    breakdown[key].total += base;
    total += base;
    if (extraPetTotal) { breakdown.extraPet.count++; breakdown.extraPet.total += extraPetTotal; total += extraPetTotal; }
    if (medicationTotal) { breakdown.medication.count++; breakdown.medication.total += medicationTotal; total += medicationTotal; }
  });

  return { total, breakdown, walkCount: (completedWalks || []).length, overnightCount: (completedOvernights || []).length };
}
