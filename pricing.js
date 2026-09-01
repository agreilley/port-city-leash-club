// pricing.js
// Single source of truth for one-time service pricing — used by
// service-request.html, portal-request-extras.html, portal-extend-walk.html,
// and admin/dashboard.html's request review-and-charge UI. Before this file
// existed, service-request.html and portal-request-extras.html each kept
// their own independent PRICES object with the same dollar amounts typed
// twice, and portal-extend-walk.html had its own separate flat constant —
// three places a price change could be made in one and silently drift out
// of sync with the others. Now there's exactly one place.
//
// MIRRORED INTO functions/pricing.js — Cloud Functions can only deploy files
// inside functions/, so firebase.json's predeploy hook copies this file (and
// walker-pricing.js, which imports it) there on every `firebase deploy
// --only functions`. This file is the source of truth; functions/pricing.js
// is a generated copy — edit here, never there.

// The base single-walk price and the extended-walk upcharge, each defined
// once. A non-member extended walk is the base plus the upcharge, and a member
// extending a walk pays the same upcharge on top of their per-walk rate — so
// the $12 lives in exactly one place. (Extended-walk used to be a standalone
// literal that had drifted: 29 + 12 = 41, but it was hardcoded 40. Deriving it
// keeps them reconciled.)
const STANDARD_WALK_PRICE = 30;
export const WALK_EXTENSION_PRICE = 12;

// Flat per-walk rate for every recurring member — replaces the old
// Essential/Standard/Daily per-tier rates (functions/index.js's
// MEMBER_PRICE_ID is the Stripe-side counterpart to this number; this is a
// client-side DISPLAY estimate only, same posture as everything else in this
// file — the real charge is computed server-side).
export const MEMBER_WALK_RATE = 27;

// travelDiscountEligible is explicit and required on every entry — see the
// load-time assertion immediately below. This replaced an earlier separate
// TRAVEL_DISCOUNT_SERVICE_KEYS allowlist (2026-08-24): a standalone list is
// silently correct-by-omission (a service left out just doesn't appear, no
// error); a required per-entry field on the one table every service is
// already defined in can't be silently left out — a missing field throws at
// load, not at charge time for one specific Friends & Family member.
export const SERVICE_PRICES = {
  'standard-walk':  { name: 'Standard Walk',  price: STANDARD_WALK_PRICE,                        unit: 'walk',  travelDiscountEligible: false },
  'extended-walk':  { name: 'Extended Walk',  price: STANDARD_WALK_PRICE + WALK_EXTENSION_PRICE, unit: 'walk',  travelDiscountEligible: false },
  'drop-in-visit':  { name: 'Drop-In Visit',  price: 25,  unit: 'night', travelDiscountEligible: true },
  'overnight-stay': { name: 'Overnight Stay', price: 115, unit: 'night', travelDiscountEligible: true },
};

// Fail loudly at module load, not silently at charge time. Runs the moment
// this module is first evaluated — client-side, that's every admin/dashboard.html
// page load (a static <script type="module"> import); server-side, that's
// the first `await import('./pricing.js')` any Cloud Function instance
// happens to execute (functions/index.js is CommonJS and can only reach this
// ES module via dynamic import — there's no top-level static import
// available to force this earlier, at Cloud Functions cold-start, without
// converting the whole file to ESM). Either way: a SERVICE_PRICES entry
// missing an explicit travelDiscountEligible boolean throws immediately,
// everywhere this module loads, rather than quietly resolving to "not
// travel" (see isTravelDiscountService) and letting a Friends & Family
// member get charged full price for it with no error anywhere.
for (const [key, info] of Object.entries(SERVICE_PRICES)) {
  if (typeof info.travelDiscountEligible !== 'boolean') {
    throw new Error(`pricing.js: SERVICE_PRICES['${key}'] is missing an explicit travelDiscountEligible boolean — every service must declare whether it's Friends & Family discount-eligible.`);
  }
}

// portal-request-extras.html historically used 'overnight'/'checkin' as its
// service keys for the same two services above — normalized here so every
// caller can share the one SERVICE_PRICES table regardless of which naming
// scheme its form uses.
export const SERVICE_KEY_ALIASES = {
  overnight: 'overnight-stay',
  checkin: 'drop-in-visit',
};

export const EXTRA_PET_FEE = 10;
export const MEDICATION_FEE = 10;

export function resolveServiceKey(key) {
  return SERVICE_KEY_ALIASES[key] || key;
}

export function getDaysBetween(start, end) {
  if (!start || !end) return 0;
  const s = start instanceof Date ? start : new Date(start);
  const e = end instanceof Date ? end : new Date(end);
  const days = Math.round((e - s) / 86400000);
  // An inverted range must never silently price at $0 — fail loudly instead
  // of clamping, so a bad range can't reach a charge path unnoticed.
  if (days < 0) throw new Error('End date is before start date.');
  return days;
}

// Computes the total for a one-time service (walk, drop-in visit, or
// overnight stay). Both service-request.html and portal-request-extras.html
// use the same shape here: extraPet/medication are plain member-checked
// booleans, not derived from pet count — a household's dogs[] list is
// profile data, not a pricing input.
//
// Extra-pet and medication add-ons only apply to night-based services
// (drop-in visits, overnight stays) — a plain walk doesn't involve watching
// an extra pet overnight, so those fees are deliberately excluded when
// unit !== 'night', even if a multi-dog household is walking together.
export function calculateServiceTotal({
  serviceKey,
  startDate = null,
  endDate = null,
  visitsPerDay = 1,
  extraPet = false,
  medication = false,
} = {}) {
  const key = resolveServiceKey(serviceKey);
  const info = SERVICE_PRICES[key];
  if (!info) return { total: 0, breakdown: [], days: 0, unitCount: 0 };

  const isNightService = info.unit === 'night';
  const isDropIn = key === 'drop-in-visit';
  // Overnight stays and drop-in/check-in visits share these same two date
  // fields but need OPPOSITE day-count conventions, and getDaysBetween
  // itself stays a plain exclusive diff (overnight-stay payout math and
  // other callers depend on that) — the inclusive adjustment for check-ins
  // happens only here, at this one call site:
  //  - overnight-stay: nights = exclusive diff (Mon->Tue = 1 night; a
  //    same-day range is 0 nights, not a real stay). getDaysBetween's
  //    return value is exactly this — no adjustment.
  //  - drop-in-visit (check-in): inclusive day count — every calendar day
  //    in the range gets its own visit-count (Mon->Fri = 5 days, not the 4
  //    the exclusive diff gives; a same-day range is 1 valid day, not 0).
  //    +1 only applies once a real range exists (both dates present) — an
  //    empty/incomplete range must still price at 0, not "1 day of nothing".
  const exclusiveDays = isNightService ? getDaysBetween(startDate, endDate) : 0;
  const hasFullRange = !!startDate && !!endDate;
  const days = isNightService
    ? (isDropIn && hasFullRange ? exclusiveDays + 1 : exclusiveDays)
    : 1;
  const unitCount = isNightService ? (isDropIn ? days * Math.max(visitsPerDay, 1) : days) : 1;
  const serviceTotal = info.price * unitCount;

  const hasExtraPet = isNightService && extraPet;
  const hasMedication = isNightService && medication;
  const multiplier = Math.max(days, 1);
  const extraPetTotal = hasExtraPet ? EXTRA_PET_FEE * multiplier : 0;
  const medsTotal = hasMedication ? MEDICATION_FEE * multiplier : 0;

  const breakdown = [
    { label: info.name, amount: serviceTotal },
    ...(hasExtraPet ? [{ label: 'Multiple pets', amount: extraPetTotal }] : []),
    ...(hasMedication ? [{ label: 'Medication admin', amount: medsTotal }] : []),
  ];

  return { total: serviceTotal + extraPetTotal + medsTotal, breakdown, days, unitCount };
}

export function calculateWalkExtensionTotal(walkCount) {
  return Math.max(walkCount, 0) * WALK_EXTENSION_PRICE;
}

// Per-day drop-in visit pricing, for a caller that has (or is building) an
// actual per-day visit-count schedule rather than one flat visits-per-day
// estimate applied uniformly across every day — e.g. a request where the
// visitor is back mid-day and needs fewer visits that one day. schedule is
// a plain {[dateStr]: count} map; days is simply how many keys it has, not
// derived from any date-range math, so a caller building the schedule from
// a start/end range already controls that via however many keys it puts
// in. Mirrors admin/dashboard.html's own computeDropInVisitTotal (the
// confirmed-schedule total there) rather than replacing it — that
// function stays as-is; this is the same math made reusable for the
// request forms' own live estimate, so a schedule-aware total exists in
// exactly one place going forward instead of being reimplemented per form.
export function calculateDropInScheduleTotal({ schedule, extraPet = false, medication = false } = {}) {
  const info = SERVICE_PRICES['drop-in-visit'];
  const days = Object.keys(schedule || {}).length;
  const totalVisits = Object.values(schedule || {}).reduce((a, c) => a + (Number(c) || 0), 0);
  const serviceTotal = info.price * totalVisits;
  const extraPetTotal = extraPet ? EXTRA_PET_FEE * days : 0;
  const medicationTotal = medication ? MEDICATION_FEE * days : 0;
  const breakdown = [
    { label: info.name, amount: serviceTotal },
    ...(extraPet ? [{ label: 'Multiple pets', amount: extraPetTotal }] : []),
    ...(medication ? [{ label: 'Medication admin', amount: medicationTotal }] : []),
  ];
  return { total: serviceTotal + extraPetTotal + medicationTotal, breakdown, days, totalVisits };
}

// The ONE place discount eligibility is decided — used by both the
// discount-application call sites (admin/dashboard.html) and the
// server-side assertion (functions/index.js's chargeCustomerCard), so they
// read off the same SERVICE_PRICES field and can never disagree with each
// other. Reads travelDiscountEligible directly off the resolved
// SERVICE_PRICES entry rather than a separate allowlist — see that field's
// own comment (and the load-time assertion right after SERVICE_PRICES) for
// why: a standalone list can be silently left out of date; a required field
// on the one table every service is already defined in can't be.
//
// Extra pet (EXTRA_PET_FEE) and medication (MEDICATION_FEE) have no entry
// of their own here — they're add-on line items calculateServiceTotal folds
// into whichever primary service total they ride along with, and they only
// ever apply when that primary service is already night-based (see
// calculateServiceTotal's isNightService gate). Marking drop-in-visit and
// overnight-stay eligible therefore covers all four of "overnight,
// check-in, extra pet, medication" — there's nothing separate to mark.
export function isTravelDiscountService(serviceKey) {
  const info = SERVICE_PRICES[resolveServiceKey(serviceKey)];
  return !!info?.travelDiscountEligible;
}

// Friends & Family travel discount — the ONE place a member's
// travelDiscountPercent (members/{id}/private/billing, see
// functions/index.js's claimFriendsFamilyRedemption) turns into an actual
// dollar reduction. Every travel-service total in admin/dashboard.html
// (confirmRequestDates' overnight/drop-in branches, reviewRecalcOvernight's
// auto-fill) routes through this instead of each computing its own
// percentage math — a deliberate single choke point so a future travel
// charge path can't quietly reimplement (and drift from) this formula.
// Never called for walk/extended-walk totals — those aren't travel
// services and a Friends & Family code must never discount them.
//
// Cents-rounded at each step (matches chargeCustomerCard's own
// Math.round-to-cents discipline) so this can never drift by fractions of a
// cent the way a single floating-point multiply/subtract could.
export function applyTravelDiscount(total, breakdown, discountPercent) {
  const pct = Number.isInteger(discountPercent) && discountPercent > 0 ? discountPercent : 0;
  if (!pct) {
    return { total, breakdown, discountPercent: 0, discountAmount: 0, preDiscountTotal: total };
  }
  const preDiscountTotal = total;
  const discountAmount = Math.round(preDiscountTotal * pct) / 100;
  const discountedTotal = Math.round((preDiscountTotal - discountAmount) * 100) / 100;
  return {
    total: discountedTotal,
    breakdown: [...breakdown, { label: `Friends & Family discount (${pct}%)`, amount: -discountAmount }],
    discountPercent: pct,
    discountAmount,
    preDiscountTotal,
  };
}
