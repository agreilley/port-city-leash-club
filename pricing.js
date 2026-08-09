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

export const SERVICE_PRICES = {
  'standard-walk':  { name: 'Standard Walk',  price: STANDARD_WALK_PRICE,                        unit: 'walk' },
  'extended-walk':  { name: 'Extended Walk',  price: STANDARD_WALK_PRICE + WALK_EXTENSION_PRICE, unit: 'walk' },
  'drop-in-visit':  { name: 'Drop-In Visit',  price: 25,  unit: 'night' },
  'overnight-stay': { name: 'Overnight Stay', price: 115, unit: 'night' },
};

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
