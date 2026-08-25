// time-slots.js
// Single source of truth for the walk time-of-day slot: the three keys
// used by walks/{id}.timeSlot, members/{id}.defaultTimeSlot, submissions'
// timeSlot field, and walkers/{id}.availability's per-day slot lists.
// Before this file existed, the same three key/label pairs were typed
// independently in ~20 places across admin/dashboard.html, walker/dashboard.html,
// four portal-*.html pages, service-request.html, and functions/index.js/
// functions/templates/_layout.js — no single place a slot rename or addition
// could be made once and trusted everywhere else to follow.
//
// Deliberately does NOT export one composed display string ("Morning
// (8–11am)" vs "Morning · 8–11am" vs the abbreviated "Early Aft.") — those
// wording differences are real, existing, per-page layout choices (a narrow
// admin grid column vs. a spacious walker list), not drift. Only the keys
// and the base label are shared; each call site keeps composing its own
// format string from WALK_TIME_SLOT_LABELS and WALK_TIME_SLOT_RANGES.
//
// MIRRORED INTO functions/time-slots.js — Cloud Functions can only deploy
// files inside functions/, so firebase.json's predeploy hook copies this
// file (alongside pricing.js and walker-pricing.js) there on every
// `firebase deploy --only functions`. This file is the source of truth;
// functions/time-slots.js is a generated copy — edit here, never there.
//
// Explicitly OUT of scope, and must stay that way: the careers.html
// application-availability grid (admin/dashboard.html's
// buildApplicationAvailabilityGrid) and the walker-screening availability
// grid (walker-screening.html's SCREEN_SLOTS, admin/dashboard.html's
// buildScreeningAvailabilityGrid, firestore.rules' validScreeningAvailDay)
// are BOTH deliberately separate vocabularies, not drift — the screening
// grid adds a 4th 'overnight' slot the walk time slot never has, and both
// already carry their own comments explaining why they're kept apart
// (avoiding exactly the cross-grid coupling this file's own consolidation
// is otherwise meant to fix). Do not fold either into this file.

export const WALK_TIME_SLOTS = ['morning', 'early-afternoon', 'late-afternoon'];

export const WALK_TIME_SLOT_LABELS = {
  morning: 'Morning',
  'early-afternoon': 'Early Afternoon',
  'late-afternoon': 'Late Afternoon',
};

export const WALK_TIME_SLOT_RANGES = {
  morning: '8–11am',
  'early-afternoon': '11am–2pm',
  'late-afternoon': '2–5pm',
};

// Fail loudly at module load if the three exports ever disagree on which
// keys exist — e.g. a slot added to WALK_TIME_SLOTS without also adding its
// label/range, or vice versa. Because this file is copied byte-for-byte
// into functions/ (not hand-edited there — see the MIRRORED INTO note
// above), this exact check runs identically in every context that loads it:
// every admin/dashboard.html (etc.) page load, and every Cloud Function
// instance's first `await import('./time-slots.js')`. There's no live
// channel for the two contexts to compare against each other at import
// time — a browser session and a Cloud Function instance are different
// processes with nothing to diff — so the real guarantee isn't "the two
// copies agree," it's stronger: whichever one you're running is either
// byte-identical to this file, or the copy step never ran at all and the
// import itself already failed with "module not found" before this line
// could execute. This assertion only catches the third case: the file
// exists (copied or original) but its own three exports are internally
// inconsistent.
for (const key of WALK_TIME_SLOTS) {
  if (!(key in WALK_TIME_SLOT_LABELS) || !(key in WALK_TIME_SLOT_RANGES)) {
    throw new Error(`time-slots.js: '${key}' is in WALK_TIME_SLOTS but missing from WALK_TIME_SLOT_LABELS or WALK_TIME_SLOT_RANGES.`);
  }
}

// A version marker for the "at minimum, a version constant that has to
// match" case: a human-visible value to compare when someone suspects a
// client bundle and a functions/ instance have drifted (e.g. an old browser
// tab cached against a pre-change deploy, or a support conversation trying
// to rule this out), without diffing two files by hand. Computed from the
// exports' own content, not hand-bumped — a manually-maintained version
// number would carry the exact same "someone forgot to update it" risk
// this whole file exists to eliminate, so there's nothing to remember to
// change; it simply IS whatever the three exports above currently are.
// Not a cryptographic hash and not a live cross-process check (see the
// assertion's own comment above for why no such check is buildable) — a
// plain content checksum, good enough to tell "identical" from "not"
// when eyeballed or logged from two different running contexts.
function checksum(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
export const TIME_SLOTS_VERSION = checksum(JSON.stringify({ WALK_TIME_SLOTS, WALK_TIME_SLOT_LABELS, WALK_TIME_SLOT_RANGES }));
