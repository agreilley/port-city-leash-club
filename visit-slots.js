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
// that needs one more trip out overnight. Two-hour windows (set 2026-09-26)
// that don't touch each other, so two adjacent slots on the same day never
// read as the same visit twice. Separate from the walk windows in
// time-slots.js on purpose — e.g. midday is 12–3pm here, not 11am–2pm.
export const VISIT_SLOT_RANGES = {
  morning: '7–9am',
  midday: '12–3pm',
  evening: '4–7pm',
  'last-out': '8–10pm',
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

// One overnight stay's day-by-day schedule, for the reservation detail cards
// (admin, walker, member). o.visits alone is misleading for a true overnight
// stay: it only holds the midday check-in included with each night (plus any
// paid add-on drop-ins), so a two-night stay listed nothing but two
// "Midday" rows and read as two drop-ins. This interleaves a row for each
// NIGHT (start date through the night before endDate — the departure day
// has no night) after that day's visits, in slot order. Each night row
// carries its `nights` entry (see stayNightDates below), or null when the
// night hasn't been assigned or completed yet.
//
// A drop-in reservation has no nights, so pass isCheckin and it gets its
// visit rows back unchanged. `startDate`/`endDate` may be Firestore
// Timestamps, Dates, or 'YYYY-MM-DD' strings; visit dates are 'YYYY-MM-DD'.
// Pass { nights: false } to leave out the night rows, or { nightsFor:
// walkerId } to keep only the nights that walker is doing (a walker
// covering only some of a stay's work).
export function buildStaySchedule(o, isCheckin, { nights = true, nightsFor = null } = {}) {
  const rows = (Array.isArray(o.visits) ? o.visits : [])
    .map((visit) => ({ kind: 'visit', date: stayDateKey(visit.date) || '', order: VISIT_SLOTS.indexOf(visit.slot), visit }));
  if (!isCheckin && nights) {
    stayNightDates(o)
      .filter((key) => !nightsFor || nightWalkerId(o, key) === nightsFor)
      .forEach((key) => rows.push({ kind: 'night', date: key, order: VISIT_SLOTS.length, night: o.nights?.[key] || null }));
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
}

// 'YYYY-MM-DD' for a stay date (Firestore Timestamp, Date, or already a
// 'YYYY-MM-DD' string), read with local date parts.
export function stayDateKey(val) {
  if (!val) return null;
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Nights ──────────────────────────────────────────────────────────────
// An overnight stay's nights run from the start date up to, not including,
// the end date. Nights aren't generated up front like visits: the stay's
// dates say which nights exist, and `o.nights` is a map keyed by night date
// holding only what's been set on one: { walkerId, walkerName } when admin
// assigns a cover, and { status: 'completed', completedAt, note, photoUrls,
// walkerId, walkerName } once a walker completes it, or { status: 'skipped' }
// when admin marks a night that didn't happen (paid $0). Since 2026-10-04 a
// stay only closes (and its pay is stamped) once every night is completed or
// skipped, same as every visit. Drop-in bookings have no nights.
export function stayNightDates(o) {
  const isCheckin = o?.serviceType === 'drop-in-visit' || o?.serviceType === 'checkin';
  const start = stayDateKey(o?.startDate);
  const end = stayDateKey(o?.endDate);
  if (isCheckin || !start || !end) return [];
  const dates = [];
  const d = new Date(`${start}T12:00:00`);
  for (let key = start; key < end; d.setDate(d.getDate() + 1), key = stayDateKey(d)) dates.push(key);
  return dates;
}

// Who is doing (or did) this night: its cover if admin assigned one, else
// the stay's default walker. Same rule as visitWalkerId (walker-pricing.js).
export function nightWalkerId(o, date) {
  return (o?.nights?.[date]?.walkerId || '').trim() || (o?.walkerId || '').trim();
}

export function nightIsDone(night) {
  return night?.status === 'completed' || night?.status === 'skipped';
}

// Whether every visit and every night on a stay is done, i.e. the stay
// can close. Used by every write that might finish the last piece (walker
// completing a visit or night, admin skipping a night). Requires at least
// one visit or night so an empty stay never closes itself.
export function stayReadyToClose(o) {
  const visits = Array.isArray(o?.visits) ? o.visits : [];
  const nightDates = stayNightDates(o);
  if (!visits.length && !nightDates.length) return false;
  return visits.every((v) => v.status === 'completed')
    && nightDates.every((date) => nightIsDone(o.nights?.[date]));
}

// buildStaySchedule's rows bucketed by date, in order — [{ date, rows }] —
// so a card can read day by day under one heading per day.
export function groupStayScheduleByDay(rows) {
  const days = [];
  for (const row of rows) {
    const last = days[days.length - 1];
    if (last && last.date === row.date) last.rows.push(row);
    else days.push({ date: row.date, rows: [row] });
  }
  return days;
}

// The text for one buildStaySchedule row's service, e.g. "Midday check-in
// (included)", "Evening · Extra drop-in", or "Overnight". "(included)" is a
// pricing note for the admin and member — the walker view passes
// showIncluded: false.
export function stayRowLabel(row, isCheckin, { showIncluded = true } = {}) {
  if (row.kind === 'night') return 'Overnight';
  const slot = VISIT_SLOT_LABELS[row.visit.slot] || row.visit.slot || '–';
  if (row.visit.addOn) return `${slot} · Extra drop-in`;
  if (isCheckin) return slot;
  return showIncluded ? `${slot} check-in (included)` : `${slot} check-in`;
}
