// visit-slots.js
// Single source of truth for the overnight/check-in VISIT time-of-day slot —
// used by overnights/{id}.visits[].slot and the admin per-day visit
// schedule editor (admin/dashboard.html). Deliberately SEPARATE from:
//   - time-slots.js (WALK_TIME_SLOTS) — that vocabulary is for scheduling a
//     single walk (morning / early-afternoon / late-afternoon), a different
//     service with different time buckets. A check-in/overnight visit can
//     happen well outside walk hours (a last-out visit before bed), so
//     folding these into one shared vocabulary would force one file to keep
//     both concerns' buckets in sync for no shared benefit.
//   - the walker-screening slot vocabulary (walker-screening.html's
//     SCREEN_SLOTS, admin/dashboard.html's buildScreeningAvailabilityGrid,
//     firestore.rules' validScreeningAvailDay) — that's a walker's own
//     general availability for onboarding purposes, not a specific visit's
//     scheduled time. Same reasoning time-slots.js already gives for why
//     it stays out of that vocabulary too.
//
// MIRRORED INTO functions/visit-slots.js — Cloud Functions can only deploy
// files inside functions/, so firebase.json's predeploy hook copies this
// file there on every `firebase deploy --only functions`. This file is the
// source of truth; functions/visit-slots.js is a generated copy — edit
// here, never there.

export const VISIT_SLOTS = ['morning', 'midday', 'evening', 'last-out'];

export const VISIT_SLOT_LABELS = {
  morning: 'Morning',
  midday: 'Midday',
  evening: 'Evening',
  'last-out': 'Last Out',
};

// Chosen to spread a day's visits into distinct, non-overlapping windows a
// member can actually picture: a morning let-out/feeding, a midday potty
// break, an evening feeding/walk, and a last-out just before bed for a dog
// that needs one more trip out overnight. Ranges are deliberately wide
// (pet-sitting visits aren't scheduled to the hour the way a walk is) and
// don't touch each other, so two adjacent slots on the same day never read
// as the same visit twice.
export const VISIT_SLOT_RANGES = {
  morning: '7–10am',
  midday: '11am–2pm',
  evening: '5–8pm',
  'last-out': '9–11pm',
};

// Fail loudly at module load if the three exports ever disagree on which
// keys exist — see time-slots.js's identical assertion for the full
// reasoning (this file follows that same pattern byte-for-byte in spirit).
for (const key of VISIT_SLOTS) {
  if (!(key in VISIT_SLOT_LABELS) || !(key in VISIT_SLOT_RANGES)) {
    throw new Error(`visit-slots.js: '${key}' is in VISIT_SLOTS but missing from VISIT_SLOT_LABELS or VISIT_SLOT_RANGES.`);
  }
}

// Default slot assignment for a given visit count on one day — used by the
// admin visit-schedule editor to pre-fill sensible slots before the admin
// makes any manual change, and by the overnight_request "one visit per day"
// generation path (see runServiceOrOvernightBookingDoc) for its single-visit
// case. Spreads visits across the day rather than clustering them, and a
// count beyond the 4 named slots repeats 'last-out' for the overflow rather
// than throwing — an admin who dials a day up to 5+ visits still gets a
// full array back, just with a slot value that no longer maps to a unique
// window.
export function defaultSlotsForCount(count) {
  const progressions = {
    1: ['morning'],
    2: ['morning', 'evening'],
    3: ['morning', 'midday', 'evening'],
    4: ['morning', 'midday', 'evening', 'last-out'],
  };
  if (progressions[count]) return progressions[count];
  if (count <= 0) return [];
  return [...progressions[4], ...Array(count - 4).fill('last-out')];
}

// A version marker for cross-context drift checks — see time-slots.js's
// TIME_SLOTS_VERSION for the full reasoning; this is the identical
// mechanism applied to this file's own exports.
function checksum(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
export const VISIT_SLOTS_VERSION = checksum(JSON.stringify({ VISIT_SLOTS, VISIT_SLOT_LABELS, VISIT_SLOT_RANGES }));
