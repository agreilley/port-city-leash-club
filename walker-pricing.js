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
// Holiday surcharge (listed on the walker Rate Card at +30%) is
// deliberately NOT implemented — no rule was ever defined for which
// dates count as a holiday or whether it's automatic vs admin-marked.
// Skipped rather than guessed; revisit once that's decided.

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
export function calculateOvernightPayout(overnight) {
  const key = isCheckinType(overnight.serviceType) ? 'checkin' : 'overnight';
  const start = overnight.startDate?.toDate ? overnight.startDate.toDate() : overnight.startDate;
  const end = overnight.endDate?.toDate ? overnight.endDate.toDate() : overnight.endDate;
  const days = Math.max(getDaysBetween(start, end), 1);

  const base = WALKER_RATES[key] * days;
  const extraPetTotal = overnight.extraPet ? WALKER_EXTRA_PET_FEE * days : 0;
  const medicationTotal = overnight.medication ? WALKER_MEDICATION_FEE * days : 0;

  return { total: base + extraPetTotal + medicationTotal, key, base, extraPetTotal, medicationTotal, days };
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
