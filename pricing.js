// pricing.js
// Single source of truth for one-time service pricing — used by
// service-request.html, portal-request-extras.html, portal-extend-walk.html,
// and admin/dashboard.html's request review-and-charge UI. Before this file
// existed, service-request.html and portal-request-extras.html each kept
// their own independent PRICES object with the same dollar amounts typed
// twice, and portal-extend-walk.html had its own separate flat constant —
// three places a price change could be made in one and silently drift out
// of sync with the others. Now there's exactly one place.

export const SERVICE_PRICES = {
  'standard-walk':  { name: 'Standard Walk',  price: 29,  unit: 'walk' },
  'extended-walk':  { name: 'Extended Walk',  price: 40,  unit: 'walk' },
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
export const WALK_EXTENSION_PRICE = 12;

export function resolveServiceKey(key) {
  return SERVICE_KEY_ALIASES[key] || key;
}

export function getDaysBetween(start, end) {
  if (!start || !end) return 0;
  const s = start instanceof Date ? start : new Date(start);
  const e = end instanceof Date ? end : new Date(end);
  return Math.max(0, Math.round((e - s) / 86400000));
}

// Computes the total for a one-time service (walk, drop-in visit, or
// overnight stay). Covers both existing call shapes: service-request.html
// knows a real pet count (petCount, from its dogs[] list); portal-request-
// extras.html only has a member-checked boolean (extraPet) since it never
// captured an actual pet count. Pass whichever one the caller has — extraPet
// takes precedence if both are given.
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
  petCount = 1,
  extraPet = null,
  medication = false,
} = {}) {
  const key = resolveServiceKey(serviceKey);
  const info = SERVICE_PRICES[key];
  if (!info) return { total: 0, breakdown: [], days: 0, unitCount: 0 };

  const isNightService = info.unit === 'night';
  const isDropIn = key === 'drop-in-visit';
  const days = isNightService ? getDaysBetween(startDate, endDate) : 1;
  const unitCount = isNightService ? (isDropIn ? days * Math.max(visitsPerDay, 1) : days) : 1;
  const serviceTotal = info.price * unitCount;

  const hasExtraPet = isNightService && (extraPet != null ? extraPet : petCount > 1);
  const hasMedication = isNightService && medication;
  const multiplier = Math.max(days, 1);
  const extraPetTotal = hasExtraPet ? EXTRA_PET_FEE * multiplier : 0;
  const medsTotal = hasMedication ? MEDICATION_FEE * multiplier : 0;

  const breakdown = [
    { label: info.name, amount: serviceTotal },
    ...(hasExtraPet ? [{ label: 'Extra pet', amount: extraPetTotal }] : []),
    ...(hasMedication ? [{ label: 'Medication admin', amount: medsTotal }] : []),
  ];

  return { total: serviceTotal + extraPetTotal + medsTotal, breakdown, days, unitCount };
}

export function calculateWalkExtensionTotal(walkCount) {
  return Math.max(walkCount, 0) * WALK_EXTENSION_PRICE;
}
