// functions/index.js
//
// Port City Leash Club — Stripe payment backend.
//
// Payment model (revised August 2026 — see individual function comments for
// the pieces that changed):
//   - No card is ever collected on the public request forms. A meet & greet
//     happens first; only once admin marks it complete does an account get
//     created (completeMeetGreetAndCreateAccount) — no billing yet, just an
//     account and a portal-access email.
//   - The member adds a card themselves, in the portal, after that email
//     (createAuthenticatedSetupIntent + confirmCardOnFile). That's the ONLY
//     place a card is ever captured now — no request form does it anymore.
//   - Billing then starts automatically the moment BOTH a card is on file
//     AND (for a one-time service/overnight booking) dates are confirmed —
//     whichever finishes second (finalizeSubmissionIfReady). A returning
//     member already has a card, so in practice this fires the instant
//     admin confirms their dates, same as before in effect, just routed
//     through this shared path instead of charging inline.
//   - Walk memberships: recurring monthly charge on the 1st of the month,
//     starting the month after the membership is confirmed — unchanged.
//
// None of the charge functions below run automatically from an admin
// click anymore in every case — finalizeSubmissionIfReady can also fire
// from confirmCardOnFile, a MEMBER's own portal action. Every path still
// requires a human confirmation somewhere upstream of it, though: the
// meet & greet gate (server-enforced) before an account ever exists, and
// dates admin-confirmed before a one-time booking is billable.

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { sendEmail, RESEND_API_KEY, ADMIN_EMAIL } = require('./lib/email');

initializeApp();
const db = getFirestore();

// Billing (M-1): the five sensitive billing fields live in
// members/{id}/private/billing, OFF the member doc, so walkers (who can read
// member docs) never see them. Written ONLY here via the Admin SDK. This
// helper is the single source of that path.
function billingRef(memberId) {
  return db.collection('members').doc(memberId).collection('private').doc('billing');
}

// Set this once via:
//   firebase functions:secrets:set STRIPE_SECRET_KEY
// Never hardcode the real key here or commit it to the repo.
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

// Set this once via:
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
// Value comes from the Stripe Dashboard endpoint's "Signing secret" — never
// hardcode it here or commit it to the repo.
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

function stripeClient(key) {
  // Lazy-require so the Stripe SDK is only loaded inside a function
  // invocation, once the secret is available.
  return require('stripe')(key);
}

// Per-walk Stripe Price ID (LIVE mode) for the flat member rate. Every
// recurring member (tier: 'Member') is billed the same per-walk price now —
// the old three-tier map (Essential/Standard/Daily) is retired. 'tier' still
// carries a second, unrelated concept: 'Travel' means a one-time/pet-sitting
// client with no recurring subscription at all, and is intentionally never
// resolved against this constant.
//
// This is a per-unit recurring monthly price: the subscription is created
// with an explicit quantity (walk days in the billed month) and
// syncMonthlyWalkQuantities updates that quantity on the 1st. A metered
// price would reject quantity and break both paths.
//
// This is the ONLY place the Price ID lives. admin/dashboard.html used to keep a
// duplicate copy and pass priceId in with the call, which meant a tier missing
// or stale on the client silently skipped billing for that member. The client
// now sends nothing but the member, and the tier is resolved from the member
// document here. (A literal shared module isn't possible: Firebase uploads only
// the functions/ directory, and the browser can't import from it.)
const MEMBER_PRICE_ID = 'price_1U3NghBYaaTA3vAvHzpaaHmg'; // $27/walk flat rate

// Resolves a member's tier to their per-walk Stripe Price ID. Returns null
// for the expected, non-error case ('Travel' — one-time/pet-sitting clients
// never get a subscription), and THROWS for anything else that isn't
// 'Member' — a stale/garbage tier value is a data problem, not a normal
// skip, and every caller below needs to know the difference rather than
// silently treating both cases as "nothing to bill."
function resolveMemberPriceId(tier) {
  if (tier === 'Member') return MEMBER_PRICE_ID;
  if (tier === 'Travel') return null;
  throw new HttpsError('failed-precondition', `Unrecognized member tier "${tier || ''}" — expected "Member" or "Travel".`);
}

const WEEKDAY_NUMBERS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// Which day-numbers in a given calendar month land on one of a member's
// scheduled walk days (["monday", "wednesday"]), from fromDay through the
// end of the month. fromDay defaults to 1 (the whole month); callers pass
// a later fromDay to prorate a partial period — the first billed month, or
// the remainder of a month a paused member resumes into.
//
// Single source of truth for "which dates count this period" — both the
// Stripe billing quantity (countWalkDaysInMonth, below) and walk-document
// generation (generateWalksForMember) derive from this exact list, so they
// can't drift out of sync with each other.
function datesMatchingWeekdaysInMonth(walkDays, year, monthIndex, fromDay = 1) {
  const targetDayNumbers = new Set((walkDays || []).map(d => WEEKDAY_NUMBERS[(d || '').toLowerCase()]).filter(n => n !== undefined));
  if (!targetDayNumbers.size) return [];
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const days = [];
  for (let day = Math.max(fromDay, 1); day <= daysInMonth; day++) {
    if (targetDayNumbers.has(new Date(Date.UTC(year, monthIndex, day)).getUTCDay())) days.push(day);
  }
  return days;
}

// How many times a member's scheduled walk days fall within a given
// calendar month — this is the subscription quantity, since each Price is
// unit-priced per walk, not a flat monthly fee. Thin wrapper so the two
// existing billing callers see zero behavior change from the extraction.
function countWalkDaysInMonth(walkDays, year, monthIndex, fromDay = 1) {
  return datesMatchingWeekdaysInMonth(walkDays, year, monthIndex, fromDay).length;
}

// Normalize a Firestore Timestamp / Date / "YYYY-MM-DD" string to a Date.
// The string branch is a fallback for pre-existing docs written before
// start dates were stored as Timestamps.
function toDateOrNull(value) {
  if (!value) return null;
  const d = value.toDate ? value.toDate() : new Date(value);
  return isNaN(d) ? null : d;
}

// The day of `year`/`monthIndex` a member's billing and walk generation
// should start from. Normally 1 (the whole month), but a member whose
// membership starts partway through THIS month is only billed for — and
// only gets walks on — the days from their start date onward.
//
// Both scheduled jobs on the 1st and createMembershipSubscription derive
// fromDay through this one function. They used to disagree: the
// subscription honored the requested start date, then the two jobs on the
// 1st both recomputed from day 1 and silently reverted it — re-billing the
// full month and generating a walk before the member had agreed to start.
function firstBilledMonthFromDay(startDateValue, year, monthIndex) {
  const start = toDateOrNull(startDateValue);
  if (!start) return 1;
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== monthIndex) return 1;
  return start.getUTCDate();
}

// Strict "YYYY-MM-DD" parser used for member-supplied dates (vacation hold).
// Rejects anything that isn't that exact format AND rejects calendar dates
// that don't actually exist (e.g. "2026-02-30") by round-tripping through
// Date.UTC and checking the parts survived unchanged — new Date(str) alone
// would silently normalize an invalid date instead of catching it. Returns
// noon UTC (not midnight) for the same day-shift-avoidance reason
// generateWalksForMember uses noon for its own dates.
function parseIsoDateStrict(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [year, month, day] = str.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

// Convert a wall-clock date/time in America/New_York to the equivalent UTC
// Date, accounting for EDT/EST automatically — Stripe's billing_cycle_anchor
// is a literal UTC instant, not a timezone-aware "local" time, so a fixed
// UTC offset would be wrong for half the year. Cloud Functions' Node.js
// runtime ships full ICU data, so Intl.DateTimeFormat has real tz support.
function easternTimeToUtc(year, monthIndex, day, hour, minute) {
  const approx = new Date(Date.UTC(year, monthIndex, day, hour, minute, 0));
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(approx).find(p => p.type === 'timeZoneName').value; // "GMT-4" or "GMT-5"
  const offsetHours = parseInt(offsetPart.replace('GMT', ''), 10);
  return new Date(Date.UTC(year, monthIndex, day, hour - offsetHours, minute, 0));
}

// The reverse of easternTimeToUtc: given any UTC instant, what calendar date
// is it on the business's own clock? Reading a Date's own getUTCDate()/
// getUTCMonth() answers "what calendar date in UTC", which is only the same
// answer for an instant that isn't within a few hours of UTC midnight — true
// today for every pauseEndDate (parseIsoDateStrict stamps noon UTC
// specifically to stay clear of that boundary), but this makes the "what
// date is this in America/New_York" question answered explicitly rather
// than relying on that margin, for any instant this might ever be called on.
function easternDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  return { year: get('year'), monthIndex: get('month') - 1, day: get('day') };
}

// Create the actual walks/{memberId}_{date} documents for a member's
// scheduled walk days in one month, from fromDay through month end.
// Deterministic IDs (not addDoc-style random ones) make this naturally
// idempotent — .create() throws ALREADY_EXISTS instead of overwriting a
// walk that's since been reassigned, rescheduled, extended, or completed,
// so it's always safe to re-run without a separate existence check *and*
// without ever clobbering real operational state. Individual per-date
// writes, not a single batch — a batch's create-if-not-exists would fail
// the whole batch the moment one date already exists, which defeats the
// point of being safe to re-run.
async function generateWalksForMember(memberId, member, year, monthIndex, fromDay) {
  if (!member.defaultTimeSlot) {
    return { created: 0, skipped: 0, failed: 0, blocked: 'no-time-slot' };
  }

  const days = datesMatchingWeekdaysInMonth(member.defaultWalkDays, year, monthIndex, fromDay);
  let created = 0, skipped = 0, failed = 0;

  for (const day of days) {
    const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const docId = `${memberId}_${dateStr}`;
    try {
      await db.collection('walks').doc(docId).create({
        memberId,
        // Noon UTC, same convention as submitAddWalk() — avoids the date
        // shifting a day back when re-read in US timezones.
        date: Timestamp.fromDate(new Date(Date.UTC(year, monthIndex, day, 12, 0, 0))),
        timeSlot: member.defaultTimeSlot,
        walkerId: member.assignedWalkerId || null,
        notes: '',
        status: 'scheduled',
        createdAt: FieldValue.serverTimestamp(),
      });
      created++;
    } catch (e) {
      if (e.code === 6 /* ALREADY_EXISTS */) {
        skipped++;
      } else {
        failed++;
        console.error(`generateWalksForMember: ${docId} failed:`, e.message);
      }
    }
  }

  return { created, skipped, failed, blocked: null };
}

async function assertIsAdmin(auth) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const adminDoc = await db.collection('admins').doc(auth.uid).get();
  if (!adminDoc.exists) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
}

// createSetupIntent removed — card capture no longer happens at public-form
// signup. Its only callers were membership-request.html and
// service-request.html (via firebase-payments.js, also removed), both cut
// over to the portal-based flow below in this same change. No submission
// can carry stripeCustomerId anymore; see createAuthenticatedSetupIntent's
// own header for the replacement flow.

// ─────────────────────────────────────────────────────────────────────────
// 1a-ii/1a-iii. Authenticated card capture — the ONLY card-capture path now.
// A card is added from the member portal AFTER account creation, never on
// the public request forms — createSetupIntent and the forms' card-capture
// UI were both removed together, in one deploy (an unbillable request in a
// gap between the two would have been worse than the brief window of
// leaving either one stale).
//
// AUTH BOUNDARY — read this before touching either function below. Neither
// one EVER accepts a memberId/uid from the client. Both derive the member
// entirely from request.auth.uid, the subject of the server-verified
// Firebase Auth ID token — not a value the caller can set by passing
// something different in the request body. There is no parameter on
// either function through which a caller could name someone else's
// account. A valid token only ever authenticates as its own subject; it
// grants nothing toward another uid's billing, memberId or not.
// ─────────────────────────────────────────────────────────────────────────

// createAuthenticatedSetupIntent: starts a card save for the CALLER's own
// account. Reuses their existing Stripe customer (read from their own
// billing subdoc) if they have one already — a repeat call, e.g. "replace
// my card" — or creates a new one from their OWN member doc's name/email,
// never client-supplied, so a caller can't cause a Stripe customer to be
// created under someone else's name or email either.
//
// The only Firestore write here is stripeCustomerId, onto
// members/{request.auth.uid}/private/billing — never cardOnFile:true. A
// SetupIntent existing is not a card on file; that only becomes true once
// Stripe confirms it succeeded, in confirmCardOnFile below. (Two rapid
// double-clicks with no customer yet on file could each create a Stripe
// customer before either write lands — a real but low-stakes race: worst
// case is one harmless orphaned customer object, never a wrong-account
// write, so not worth a transaction here.)
exports.createAuthenticatedSetupIntent = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const uid = request.auth.uid;

  const memberSnap = await db.collection('members').doc(uid).get();
  const member = memberSnap.data();
  if (!member) throw new HttpsError('not-found', 'No member account found for this login.');
  if (!member.email) throw new HttpsError('failed-precondition', 'This account has no email on file.');

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const billing = billingRef(uid);
  const billingSnap = await billing.get();
  let customerId = billingSnap.data()?.stripeCustomerId || null;

  if (!customerId) {
    const customer = await stripe.customers.create({ name: member.name || undefined, email: member.email });
    customerId = customer.id;
    await billing.set({ stripeCustomerId: customerId }, { merge: true });
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  });

  return { clientSecret: setupIntent.client_secret };
});

// confirmCardOnFile: members/{id}/private/billing only ever accepts writes
// from the Admin SDK (firestore.rules: allow write: if false), so this
// exists purely to make that write — gated on independently verifying
// with STRIPE, never trusting the client's say-so, that a real SetupIntent
// actually succeeded AND belongs to the Stripe customer THIS uid's own
// billing doc already points at (the one createAuthenticatedSetupIntent
// wrote, from their own server-derived email).
//
// That customer-match check is the actual security boundary: without it, a
// caller who supplied a different, genuinely-succeeded setupIntentId — a
// stale one of their own from before a customer change, or one obtained
// some other way — could get their OWN account marked cardOnFile:true
// without their own card ever having been attached to their own Stripe
// customer. With it, the only thing this call can ever do is confirm a
// SetupIntent this exact uid's own prior createAuthenticatedSetupIntent
// call itself created.
//
// Also sets the newly-attached payment method as the Stripe customer's
// default, so a "replace my card" call actually results in future charges
// using the new card — chargeCurrentMonthWalks and chargeCustomerCard both
// currently take paymentMethods.list()'s first result, which is otherwise
// an ambiguous way to land on "the card just added" versus an older one.
exports.confirmCardOnFile = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const uid = request.auth.uid;
  const { setupIntentId } = request.data || {};
  if (!setupIntentId) throw new HttpsError('invalid-argument', 'setupIntentId is required.');

  const billing = billingRef(uid);
  const billingSnap = await billing.get();
  const billingData = billingSnap.data();
  if (!billingData?.stripeCustomerId) {
    throw new HttpsError('failed-precondition', 'No card setup in progress for this account.');
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

  if (setupIntent.status !== 'succeeded') {
    throw new HttpsError('failed-precondition', `Card setup hasn't succeeded yet (status: ${setupIntent.status}).`);
  }
  if (setupIntent.customer !== billingData.stripeCustomerId) {
    throw new HttpsError('permission-denied', "This card setup doesn't belong to this account.");
  }

  if (setupIntent.payment_method) {
    await stripe.customers.update(setupIntent.customer, {
      invoice_settings: { default_payment_method: setupIntent.payment_method },
    });

    // Detach every OTHER payment method still attached to this customer, so
    // "replace my card" actually leaves at most one card attached rather
    // than accumulating stale ones — see NEEDS_REVIEW_LABELS.
    // multiple_payment_methods_attached in admin/dashboard.html for why
    // more than one attached card is a real charging risk, not just
    // clutter: chargeCustomerCard and friends charge whichever card Stripe's
    // list() happens to return first, not the invoice_settings default set
    // above. A detach failure here does NOT roll back the new default — the
    // new card is already correctly in place and already the right thing to
    // charge — it only means a stale, unused card stays attached until an
    // admin cleans it up manually, so this logs and flags for review rather
    // than throwing.
    try {
      const existing = await stripe.paymentMethods.list({ customer: setupIntent.customer, type: 'card' });
      const stale = existing.data.filter(pm => pm.id !== setupIntent.payment_method);
      for (const pm of stale) {
        await stripe.paymentMethods.detach(pm.id);
      }
    } catch (e) {
      console.error(`confirmCardOnFile: failed to detach stale payment method(s) for ${uid}:`, e.message);
      await billing.set({
        needsReview: true,
        needsReviewReason: 'stale_payment_method_detach_failed',
      }, { merge: true }).catch(() => {});
    }
  }

  await billing.set({
    cardOnFile: true,
    cardOnFileAt: FieldValue.serverTimestamp(),
    // A card being added directly resolves the one needsReview reason
    // whose entire premise is "there's no card yet" — without this, that
    // flag (and admin's "No card on file" badge) sat there forever even
    // after a member added a real card, since nothing else ever cleared
    // it. Scoped to that one reason only — every other needsReview reason
    // (a failed charge, a detach failure, etc.) is left exactly as-is;
    // this isn't a general "clear all flags on any card write" reset.
    ...(billingData?.needsReviewReason === 'no_card_on_file' ? { needsReview: false, needsReviewReason: null } : {}),
  }, { merge: true });

  // Card-on-file trigger for finalizeSubmissionIfReady (the other trigger
  // is markDatesConfirmed, below). Member-scoped, not submission-scoped —
  // this uid can have more than one submission waiting on a card
  // (membership_request is ready the instant cardOnFile is true; a
  // service_request/overnight_request also needs its OWN datesConfirmedAt)
  // — so every one of this member's still-open submissions gets checked,
  // not just a single id this function was never given.
  //
  // Two separate equality-only queries, not one query with
  // status in ['pending', 'account_created'] — this file already leans on
  // "equality-only compound queries need no composite index" elsewhere
  // (see runGenerateWalkerPayout's walkerId+status query), a guarantee that
  // doesn't extend as cleanly to an equality field combined with an `in`
  // clause. Two known-safe queries avoid finding out the hard way against
  // a live index.  finalizeSubmissionIfReady's own type/status re-checks
  // make a doc showing up in both irrelevant — it can't.
  const [pendingSnap, accountCreatedSnap] = await Promise.all([
    db.collection('submissions').where('memberId', '==', uid).where('status', '==', 'pending').get(),
    db.collection('submissions').where('memberId', '==', uid).where('status', '==', 'account_created').get(),
  ]);
  for (const doc of [...pendingSnap.docs, ...accountCreatedSnap.docs]) {
    await finalizeSubmissionIfReady(doc.id);
  }

  return { success: true };
});

// getCardOnFile: live read of the caller's own saved card, straight from
// Stripe — nothing beyond the existing cardOnFile boolean is ever stored in
// Firestore. Returns { card: null } when there's no card on file (no
// customer yet, or a customer with nothing attached) rather than throwing,
// since that's an expected, normal state for the account page's empty
// state — not an error.
//
// Auth boundary: uid is request.auth.uid alone, same as
// createAuthenticatedSetupIntent/confirmCardOnFile above — a caller can
// only ever resolve their OWN billing doc's stripeCustomerId, never
// anyone else's.
//
// Two defensive side effects, both cheap given the paymentMethods.list()
// call this needs anyway, both Admin-SDK writes (firestore.rules already
// makes that the only way to write private/billing):
//   1. If Stripe shows MORE than one attached card, confirmCardOnFile's
//      detach-on-replace above should make that impossible going forward,
//      but this flags it rather than silently trusting data[0] — see
//      NEEDS_REVIEW_LABELS.multiple_payment_methods_attached in
//      admin/dashboard.html, which spells out why that's a real
//      wrong-card-gets-charged risk, not just clutter.
//   2. If Stripe and the stored cardOnFile boolean disagree, correct the
//      boolean. Every charge function in this file reads that flag —
//      letting it drift from what Stripe actually has attached is worse
//      than a stale read.
exports.getCardOnFile = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const uid = request.auth.uid;

  const billing = billingRef(uid);
  const billingSnap = await billing.get();
  const billingData = billingSnap.data();
  const stripeCustomerId = billingData?.stripeCustomerId;
  if (!stripeCustomerId) return { card: null };

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const paymentMethods = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card' });

  if (paymentMethods.data.length > 1) {
    console.error(`getCardOnFile: Stripe customer ${stripeCustomerId} (member ${uid}) has ${paymentMethods.data.length} attached cards — expected at most 1.`);
    await billing.set({
      needsReview: true,
      needsReviewReason: 'multiple_payment_methods_attached',
    }, { merge: true }).catch(() => {});
  }

  const pm = paymentMethods.data[0] || null;
  const isOnFile = !!pm;
  // A card genuinely on file should always resolve a stray "no card on
  // file" review flag — independent of whether the cardOnFile boolean
  // itself needed correcting. Nesting this check inside the mismatch
  // branch below (its original form) meant a member whose cardOnFile was
  // ALREADY correctly true, but whose needsReviewReason got set to
  // 'no_card_on_file' by some other confirmation run around the same
  // time (finalizeSubmissionIfReady flags this per-submission, not
  // per-billing-write, so it can race a card being added), would never
  // self-heal here — this function saw no boolean mismatch, skipped the
  // whole block, and nothing else ever re-checked it. Confirmed live: a
  // member's billing doc sat at cardOnFile:true, needsReviewReason:
  // 'no_card_on_file' indefinitely, surviving both a page reload and an
  // admin dashboard fix to the table's own staleness.
  const staleNoCardFlag = isOnFile && billingData?.needsReviewReason === 'no_card_on_file';
  if (!!billingData?.cardOnFile !== isOnFile || staleNoCardFlag) {
    await billing.set({
      cardOnFile: isOnFile,
      ...(staleNoCardFlag ? { needsReview: false, needsReviewReason: null } : {}),
    }, { merge: true }).catch(() => {});
  }

  if (!pm) return { card: null };
  return {
    card: {
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    },
  };
});

// removeCardOnFile: detaches the caller's own saved card(s) from Stripe and
// clears cardOnFile on their own billing doc.
//
// Guard: fails CLOSED. hasActiveSubscription is only ever written true (by
// createMembershipSubscription) or false (by the subscription.deleted
// webhook handler) — it's never initialized at member-doc creation, so
// "missing" is the default state for two very different members: a
// Travel-tier/one-time client (who never gets a subscription, ever) and a
// membership-tier client whose subscription creation is pending or failed
// (subscription_creation_failed is an existing needsReview reason — a real
// window, not hypothetical). A plain truthy check on hasActiveSubscription
// can't tell those apart and would let the second case remove its only
// card. tier can: it's set once at account creation from what was actually
// signed up for, never reflects billing state, and is 'Travel' ONLY for
// clients who will never have a recurring subscription. So removal is
// allowed ONLY with positive evidence there's no recurring obligation —
// tier === 'Travel', or hasActiveSubscription === false (explicitly
// canceled/ended, same flag chargeCurrentMonthWalks/generateMonthlyWalks/
// resumePausedMemberships filter on; pausing does NOT clear it, so a
// paused member is correctly still blocked too — pause doesn't mean
// billing has stopped for good). Every other case, including missing/
// undefined on an otherwise-membership-tier member, is blocked.
//
// Auth boundary: uid is request.auth.uid alone, same as getCardOnFile/
// confirmCardOnFile above.
exports.removeCardOnFile = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const uid = request.auth.uid;

  const memberSnap = await db.collection('members').doc(uid).get();
  const memberData = memberSnap.data();
  const noRecurringObligation = memberData?.tier === 'Travel' || memberData?.hasActiveSubscription === false;

  // A member with no recurring subscription can still owe a real, already-
  // confirmed one-off charge: markDatesConfirmed schedules an overnight/
  // check-in charge 24 hours out (runServiceOrOvernightBookingDoc — "the
  // member has a real chance to change plans"), during which the
  // overnights doc sits at chargePending: true with nothing else tracking
  // that a card needs to survive until then. chargeScheduledReservations
  // (the scheduled job that actually charges it) only discovers a missing
  // card AT charge time, and its failure is caught and flagged, not
  // prevented — exactly the outcome this guard exists to avoid. Checked
  // ONLY when the subscription check alone would otherwise allow removal —
  // a member already blocked by hasActiveSubscription doesn't need a
  // second reason. Two equality filters, no orderBy, needs no composite
  // index — same pattern chargeScheduledReservations' own query already
  // relies on.
  let hasPendingReservationCharge = false;
  if (noRecurringObligation) {
    const pendingSnap = await db.collection('overnights')
      .where('memberId', '==', uid)
      .where('chargePending', '==', true)
      .limit(1)
      .get();
    hasPendingReservationCharge = !pendingSnap.empty;
  }

  if (!noRecurringObligation || hasPendingReservationCharge) {
    // Three distinct blocked states, three distinct messages — none may
    // claim more than what's actually true, and none may imply removal is
    // an action available right now (the client hides the Remove button in
    // every blocked state — see renderCardOnFile in portal-account.html —
    // so "before removing your card" would describe an action that screen
    // doesn't actually offer):
    //   - a confirmed reservation with chargePending: true has a real,
    //     already-scheduled charge, independent of subscription status —
    //     checked first since it can be true even for a Travel-tier member
    //     who'd otherwise pass the subscription check freely.
    //   - hasActiveSubscription === true genuinely has a subscription
    //     charging every month, so saying so is accurate.
    //   - every other blocked case (a membership-tier member whose
    //     subscription is still pending or failed to create — see
    //     subscription_creation_failed in NEEDS_REVIEW_LABELS) has NO
    //     confirmed subscription yet, so asserting one would be false —
    //     this member needs a human, not a "just add a card" prompt for a
    //     charge that isn't actually scheduled.
    //
    // KEEP IN SYNC with the same three strings in portal-account.html's
    // renderCardOnFile (the proactive client-side hint mirrors this exact
    // guard and message split) — no shared module between this file and
    // the portal pages, so this is a manual duplication, not automatic.
    const message = hasPendingReservationCharge
      ? "Add a new card before removing this one. You have a confirmed reservation that hasn't been charged yet."
      : memberData?.hasActiveSubscription === true
        ? 'Add a new card before removing this one. Your membership charges automatically each month.'
        : "Your billing setup is still being finalized. Email us at hello@portcityleashclub.com and we'll help sort it out.";
    throw new HttpsError('failed-precondition', message);
  }

  const billing = billingRef(uid);
  const billingSnap = await billing.get();
  const stripeCustomerId = billingSnap.data()?.stripeCustomerId;
  if (!stripeCustomerId) return { removed: false };

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const paymentMethods = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card' });
  for (const pm of paymentMethods.data) {
    await stripe.paymentMethods.detach(pm.id);
  }

  await billing.set({ cardOnFile: false, cardOnFileAt: FieldValue.delete() }, { merge: true });

  return { removed: true };
});

// ─────────────────────────────────────────────────────────────────────────
// 1b. Decline a membership_request or service_request, cleaning up whatever
//    orphan an account_created-but-never-billed request leaves behind.
//
//    Account creation (completeMeetGreetAndCreateAccount) now happens at
//    meet-greet completion, well before a card exists, so a declined
//    request can have a real orphaned Auth user + member doc, and possibly
//    a Stripe customer too — createAuthenticatedSetupIntent writes
//    stripeCustomerId to the member's OWN billing subdoc the moment they
//    start adding a card in their portal, before confirmCardOnFile ever
//    completes. So the Stripe customer to clean up (if any) lives on
//    billing, keyed by memberId — no submission ever carries one; card
//    capture only ever happens post-account, in the portal.
//
//    Blocked once status is 'confirmed' (billing actually started — nothing
//    to decline anymore) or already 'declined'. Everything here runs
//    BEFORE the status write: if any delete fails, this throws and the
//    request stays pending for a retry, rather than marking declined while
//    something silently orphans. An already-deleted Stripe customer/Auth
//    user (resource_missing / auth/user-not-found) is treated as success so
//    a retry after a partial failure is safe.
// ─────────────────────────────────────────────────────────────────────────
async function runDeclineRequestOrphanCleanup(stripe, subRef, sub) {
  if (sub.status === 'confirmed') {
    throw new HttpsError('failed-precondition', 'This request already has billing started — decline does not apply.');
  }
  if (sub.status === 'declined') {
    throw new HttpsError('failed-precondition', 'This request was already declined.');
  }

  const memberId = sub.memberId || null;
  let stripeCustomerDeleted = true; // stays true — "nothing to delete" — unless a real customer is found below

  // This cleanup exists for a NET-NEW customer's account — one that only
  // exists because of THIS request (completeMeetGreetAndCreateAccount,
  // triggered by that same one submission) — so declining it means the
  // account was never really "a member" to begin with. It has no business
  // running for an EXISTING member's request (e.g. a portal-submitted
  // service_request from someone who already has an account, dogs, and
  // other bookings): that decline should only ever touch THIS submission.
  // Distinguishes the two the only reliable way available — any OTHER
  // trace of this member (another submission, a walk, an overnight)
  // means the account predates and outlives this one request, so the
  // account/Stripe/Auth teardown below must be skipped entirely.
  if (memberId) {
    const [otherSubsSnap, overnightsSnap, walksSnap] = await Promise.all([
      db.collection('submissions').where('memberId', '==', memberId).get(),
      db.collection('overnights').where('memberId', '==', memberId).limit(1).get(),
      db.collection('walks').where('memberId', '==', memberId).limit(1).get(),
    ]);
    const hasOtherSubmission = otherSubsSnap.docs.some((d) => d.id !== subRef.id);
    const isEstablishedMember = hasOtherSubmission || !overnightsSnap.empty || !walksSnap.empty;
    if (isEstablishedMember) {
      await subRef.set({
        status: 'declined', read: true, declinedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { success: true, stripeCustomerDeleted: false, accountDeleted: false };
    }
  }

  if (memberId) {
    const billingSnap = await billingRef(memberId).get();
    const stripeCustomerId = billingSnap.data()?.stripeCustomerId;
    if (stripeCustomerId) {
      try {
        const res = await stripe.customers.del(stripeCustomerId);
        stripeCustomerDeleted = !!res.deleted;
      } catch (e) {
        if (e.code === 'resource_missing') {
          stripeCustomerDeleted = true;
        } else {
          throw new HttpsError('internal', `Could not delete the Stripe customer (${e.message}). The request was left pending — try again.`);
        }
      }
    }

    const { getAuth } = require('firebase-admin/auth');
    try {
      await getAuth().deleteUser(memberId);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        throw new HttpsError('internal', `Could not delete the orphaned account (${e.message}). The request was left pending — try again.`);
      }
    }

    await db.collection('members').doc(memberId).delete();
    await billingRef(memberId).delete().catch(() => {});
  }

  await subRef.set({
    status: 'declined',
    read: true,
    stripeCustomerDeleted,
    accountDeleted: !!memberId,
    declinedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { success: true, stripeCustomerDeleted, accountDeleted: !!memberId };
}

// Sent from declineServiceRequest, declineOvernightRequest, and
// cancelOvernightReservation — NOT declineMembershipRequest, which stays
// silent for now (not asked for, and a declined membership signup usually
// follows a conversation that already happened elsewhere, unlike a
// one-time request/reservation that could otherwise be declined or
// cancelled with zero visible sign anything happened).
//
// Accepts either shape this codebase uses for "someone's one-time
// booking" — a submissions doc (service/dogs/ownerName, and email present
// only for a public, net-new service_request) or an overnights doc
// (serviceType/dogName singular/memberName, never its own email at all).
// Falls back to the member doc for whichever fields the given shape
// doesn't carry directly. Callers must call this BEFORE
// runDeclineRequestOrphanCleanup for a true net-new decline: that function
// can delete the member doc, and this needs to have already read it by
// then.
async function sendRequestDeclinedEmail(doc, contextId) {
  let email = doc.email || null;
  let name = doc.ownerName || doc.memberName || null;
  // doc.dogs (a real array) only ever comes from a submissions doc — an
  // overnights doc has no such field, only a single dogName (the FIRST
  // dog's name only — see runServiceOrOvernightBookingDoc). That singular
  // fallback must never be treated as "good enough" ahead of the member
  // record's full dogs[] — otherwise a multi-dog household's cancellation
  // email silently drops every dog but the first. Only used as a last
  // resort, after a member-record lookup has already been tried.
  let dogs = (doc.dogs && doc.dogs.length) ? doc.dogs : null;
  if ((!email || !name || !dogs) && doc.memberId) {
    const memberSnap = await db.collection('members').doc(doc.memberId).get();
    const member = memberSnap.data();
    if (member) {
      email = email || member.email;
      name = name || member.name;
      dogs = dogs || member.dogs;
    }
  }
  if (!dogs || !dogs.length) {
    dogs = doc.dogName ? [{ name: doc.dogName }] : [];
  }
  if (!email) {
    console.error(`sendRequestDeclinedEmail: no email found for ${contextId}.`);
    return;
  }

  const { SERVICE_PRICES, resolveServiceKey } = await import('./pricing.js');
  const serviceLabel = SERVICE_PRICES[resolveServiceKey(doc.service || doc.serviceType)]?.name
    || doc.service || doc.serviceType || 'your request';
  const petNames = (dogs || []).map((d) => d && d.name).filter(Boolean);
  const startDateStr = doc.startDate?.toDate ? isoDateStr(doc.startDate.toDate()) : null;
  const endDateStr = doc.endDate?.toDate ? isoDateStr(doc.endDate.toDate()) : null;

  try {
    await sendEmail({
      to: email,
      template: 'request-declined',
      data: {
        firstName: (name || '').trim().split(/\s+/)[0] || 'there',
        petNames, serviceLabel, startDateStr, endDateStr,
      },
      idempotencyKey: `request-declined:${contextId}`,
    });
  } catch (e) {
    // sendEmail's own contract is "never throws" — this catch exists only
    // as defense-in-depth so a future change to that contract can't
    // silently take the decline action down with it.
    console.error(`sendRequestDeclinedEmail: threw unexpectedly for ${contextId}:`, e.message);
  }
}

exports.declineMembershipRequest = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { submissionId } = request.data || {};
  if (!submissionId) throw new HttpsError('invalid-argument', 'submissionId is required.');

  const subRef = db.collection('submissions').doc(submissionId);
  const subSnap = await subRef.get();
  const sub = subSnap.data();
  if (!sub) throw new HttpsError('not-found', 'Submission not found.');
  if (sub.type !== 'membership_request') {
    throw new HttpsError('failed-precondition', `Expected a membership_request, got ${sub.type}.`);
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  return runDeclineRequestOrphanCleanup(stripe, subRef, sub);
});

// service_request never carried this cleanup before — declining used to be
// a plain client-side status update (admin/dashboard.html), safe only
// because no account could exist yet at decline time under the old flow.
// Same orphan-cleanup logic as declineMembershipRequest above, now that
// completeMeetGreetAndCreateAccount can leave a net-new service_request
// with a real account and no card. overnight_request is NOT covered here —
// it never creates a new account (always an existing member), so its
// decline stays the simple client-side status update it always was.
// True when this submission's own reservation (an overnights doc,
// submissionId-linked — see runServiceOrOvernightBookingDoc) was already
// cancelled via cancelOvernightReservation, which sends this exact same
// decline email itself. Without this check, the recommended sequence for
// an already-confirmed-but-stuck request — Cancel Reservation, then
// Decline the request too, so it can't later auto-finalize in the
// background and send a contradictory "confirmed" email — would email the
// member the SAME "we can't accommodate this" message twice.
async function reservationAlreadyDeclinedFor(submissionId) {
  const snap = await db.collection('overnights')
    .where('submissionId', '==', submissionId)
    .where('status', '==', 'cancelled')
    .limit(1)
    .get();
  return !snap.empty;
}

exports.declineServiceRequest = onCall({ secrets: [STRIPE_SECRET_KEY, RESEND_API_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { submissionId } = request.data || {};
  if (!submissionId) throw new HttpsError('invalid-argument', 'submissionId is required.');

  const subRef = db.collection('submissions').doc(submissionId);
  const subSnap = await subRef.get();
  const sub = subSnap.data();
  if (!sub) throw new HttpsError('not-found', 'Submission not found.');
  if (sub.type !== 'service_request') {
    throw new HttpsError('failed-precondition', `Expected a service_request, got ${sub.type}.`);
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const result = await runDeclineRequestOrphanCleanup(stripe, subRef, sub);
  // Safe to run AFTER cleanup even though cleanup can delete the member
  // doc: that only happens for a true net-new decline, and a net-new
  // service_request always carries email/ownerName directly on the
  // submission itself (the public form collects them) — sendRequestDeclinedEmail
  // reads those first and only falls back to the member doc for an
  // established member's request, which cleanup never deletes.
  if (!(await reservationAlreadyDeclinedFor(submissionId))) {
    await sendRequestDeclinedEmail(sub, `sub:${submissionId}`);
  }
  return result;
});

// overnight_request never needed runDeclineRequestOrphanCleanup's account
// teardown — unlike a net-new service_request, this type is only ever
// submitted by an existing, authenticated member (portal-request-extras.html),
// so there's never an orphaned account to worry about. Was a plain
// client-side updateDoc for exactly that reason; now a callable purely so
// it can send the same decline notification declineServiceRequest does —
// the status write itself is otherwise unchanged.
exports.declineOvernightRequest = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { submissionId } = request.data || {};
  if (!submissionId) throw new HttpsError('invalid-argument', 'submissionId is required.');

  const subRef = db.collection('submissions').doc(submissionId);
  const subSnap = await subRef.get();
  const sub = subSnap.data();
  if (!sub) throw new HttpsError('not-found', 'Submission not found.');
  if (sub.type !== 'overnight_request') {
    throw new HttpsError('failed-precondition', `Expected an overnight_request, got ${sub.type}.`);
  }
  if (sub.status === 'confirmed') {
    throw new HttpsError('failed-precondition', 'This request already has billing started — decline does not apply.');
  }
  if (sub.status === 'declined') {
    throw new HttpsError('failed-precondition', 'This request was already declined.');
  }

  await subRef.set({
    status: 'declined', read: true, declinedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (!(await reservationAlreadyDeclinedFor(submissionId))) {
    await sendRequestDeclinedEmail(sub, `sub:${submissionId}`);
  }
  return { success: true };
});

// Cancels an already-CONFIRMED reservation (an overnights doc), not just
// the request that created it — the gap that surfaced when a service/
// overnight request got stuck (confirmed dates, no card, never finished —
// see finalizeSubmissionIfReady) with a real reservation already created
// and a walker already assigned: declining the SUBMISSION never touched
// that reservation at all, leaving it live, still assigned, and still on
// chargeScheduledReservations' every-15-minutes charge sweep regardless of
// the submission's own status. This is the missing other half — it acts
// directly on the reservation itself, independent of whatever the
// originating submission's status says.
//
// chargePending: false stops chargeScheduledReservations from ever
// touching this doc again (it only queries chargePending == true); status:
// 'cancelled' is belt-and-suspenders, since CHARGEABLE_OVERNIGHT_STATUSES
// no longer includes it either. Unassigns the walker unconditionally —
// there's nothing left for them to do once this is cancelled, and an admin
// shouldn't have to remember that as a separate manual step.
exports.cancelOvernightReservation = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { overnightId } = request.data || {};
  if (!overnightId) throw new HttpsError('invalid-argument', 'overnightId is required.');

  const ref = db.collection('overnights').doc(overnightId);
  const snap = await ref.get();
  const data = snap.data();
  if (!data) throw new HttpsError('not-found', 'Reservation not found.');
  if (data.status === 'cancelled') {
    throw new HttpsError('failed-precondition', 'This reservation was already cancelled.');
  }
  if (data.status === 'completed') {
    throw new HttpsError('failed-precondition', "This reservation is already completed — it can't be cancelled.");
  }
  if (data.chargeAttempt?.status === 'charged') {
    throw new HttpsError('failed-precondition', 'This reservation was already charged — cancelling here would not refund it. Refund in Stripe first, then cancel.');
  }

  await ref.set({
    status: 'cancelled', chargePending: false, cancelledAt: FieldValue.serverTimestamp(),
    walkerId: '', walkerName: '',
  }, { merge: true });
  await sendRequestDeclinedEmail(data, `ovn:${overnightId}`);
  return { success: true };
});

// linkServiceRequestBilling removed — its only caller was
// confirmServiceRequest (admin/dashboard.html), which markDatesConfirmed/
// confirmRequestDates replaced. stripeCustomerId now only ever lands on
// billing via createAuthenticatedSetupIntent, and referral-field copying
// moved to completeMeetGreetAndCreateAccount — see its own comment.

// ─────────────────────────────────────────────────────────────────────────
// Core one-time-charge logic, extracted from chargeSavedCard below so it can
// be shared with chargeScheduledReservations (the 24h-delayed reservation
// charge) — a scheduled function has no request.auth, so it can never call
// an onCall function like chargeSavedCard directly. attemptField defaults to
// 'lastChargeAttempt' (chargeSavedCard's original field name, unchanged);
// the scheduled function passes 'chargeAttempt', matching the overnights
// schema.
//
// stripeCustomerId is resolved from members/{memberId}/private/billing, not
// from docData — a submission or overnights doc no longer carries its own
// copy (card capture now happens once, in the portal, after the account
// exists). Both callers' docs always carry memberId by the time either can
// reach a chargeable state: a submission only gets here via completeMeetGreet-
// AndCreateAccount (public/net-new) or the authenticated portal create path
// (already an existing member); an overnights doc is never created for
// anyone but an existing member. So requiring memberId here, rather than a
// per-doc stripeCustomerId, is strictly narrowing what this function trusts,
// not widening it.
// ─────────────────────────────────────────────────────────────────────────
async function chargeCustomerCard(stripe, docRef, docData, { chargeKey, amountInDollars, description, attemptField = 'lastChargeAttempt' }) {
  const memberId = docData?.memberId || null;
  if (!memberId) {
    throw new HttpsError('failed-precondition', 'No member linked to this charge.');
  }

  const billingSnap = await billingRef(memberId).get();
  const billingData = billingSnap.data() || {};
  const stripeCustomerId = billingData.stripeCustomerId;
  if (!stripeCustomerId) {
    throw new HttpsError('failed-precondition', 'No saved card found for this member.');
  }

  // Idempotency guard #1: never charge the same chargeKey twice, however
  // this call is retried (double-click, two admin tabs open on the same
  // request, a retried call after a network hiccup) — same pattern as
  // chargeCurrentMonthWalks' currentMonthCharge guard. Blocks ONLY on a
  // prior 'charged' outcome for this exact key — never on 'failed', so a
  // transient Stripe error can always be retried rather than permanently
  // wedging a legitimate charge.
  const priorAttempt = docData[attemptField];
  if (priorAttempt && priorAttempt.chargeKey === chargeKey && priorAttempt.status === 'charged') {
    return {
      success: true, alreadyCharged: true,
      paymentIntentId: docData.lastChargeId || null,
      creditApplied: docData.referralCreditApplied || 0,
      referralDiscountApplied: docData.referralDiscountApplied || 0,
    };
  }

  // Friends & Family silent-failure guard. Travel service totals are
  // computed client-side in admin/dashboard.html (confirmRequestDates,
  // reviewRecalcOvernight) — this function has always trusted whatever
  // amountInDollars it's handed, the same trust boundary chargeSavedCard has
  // had since before this feature. That's fine for a normal charge, but a
  // member with a snapshotted travelDiscountPercent is exactly the case
  // where "trust the client" can silently cost real money: any travel
  // charge path — today's or a future one — that forgets to apply the
  // discount would otherwise charge full price with no error at all. Rather
  // than re-deriving the correct amount here (which would mean duplicating
  // pricing.js's whole calculation, the bigger server-recompute rework this
  // build deliberately avoided), this only checks for a marker —
  // travelDiscountApplied — that every travel-total call site now sets
  // alongside amountInDollars (see markDatesConfirmed's `reviewed` object).
  // Missing marker + a travel-type charge + a member who has a discount to
  // apply = hard fail, never a silent full-price charge. isTravelDiscountService
  // reads travelDiscountEligible directly off each SERVICE_PRICES entry
  // (pricing.js), not a unit check or a separate list — the exact same
  // function admin/dashboard.html's discount application reads, so this
  // assertion and that application can never disagree about what counts as
  // "travel." A walk/extended-walk charge for the same member is correctly
  // exempt, since Friends & Family never discounts those.
  //
  // travelDiscountActive gates this whole guard — Alison can turn an
  // individual member's discount off (setFriendsFamilyDiscountActive) without
  // clearing travelDiscountPercent, so the percent alone is no longer proof
  // the discount should apply. Checked with === true, not truthiness: a
  // member with travelDiscountPercent set but no travelDiscountActive field
  // at all (every Friends & Family member granted before this switch
  // existed) must resolve to inactive, not active — same "explicit state,
  // never an inferred default" posture as hasActiveSubscription elsewhere in
  // this file. Concretely: this guard is skipped entirely while inactive, so
  // a charge proceeds at full price with no travelDiscountApplied
  // requirement, which is correct — there's nothing to enforce when no
  // discount should be applied.
  if (billingData.travelDiscountPercent > 0 && billingData.travelDiscountActive === true) {
    const { isTravelDiscountService } = await import('./pricing.js');
    const rawServiceKey = docData.service || docData.serviceType || null;
    const isTravelCharge = !!rawServiceKey && isTravelDiscountService(rawServiceKey);
    if (isTravelCharge && !docData.travelDiscountApplied) {
      throw new HttpsError('failed-precondition', `Member ${memberId} has an active Friends & Family travel discount, but this charge was not computed with it applied — recompute from the review screen before charging.`);
    }
  }

  // Symmetric case to the guard directly above, added alongside it rather
  // than folded in: that guard only catches a discount that SHOULD have
  // applied and didn't (billingData.travelDiscountActive === true). This
  // catches the mirror gap — a discount that shouldn't apply anymore but
  // was submitted as applied anyway. Concretely: an admin has a review
  // screen open in one browser tab, the discount gets turned off for this
  // member in another tab (setFriendsFamilyDiscountActive), and the first
  // tab's stale in-memory billing state still computes and submits
  // amountInDollars with travelDiscountApplied: true. billingData here is
  // read fresh from Firestore in this same function, so it's already
  // correctly travelDiscountActive: false by the time this runs — that
  // freshness is what makes this check trustworthy regardless of how stale
  // the client's own state was. Without this, that charge would sail
  // through at the stale discounted amount, since the guard above only
  // fires while travelDiscountActive is true and is skipped entirely here.
  if (docData.travelDiscountApplied === true && billingData.travelDiscountActive !== true) {
    throw new HttpsError('failed-precondition', `Member ${memberId}'s Friends & Family discount is not currently active, but this charge was computed with it applied — likely a stale admin tab left open from before the discount was turned off. Reopen the review screen to recompute the total, then charge again.`);
  }

  // Travel-tier clients receive referral credit as a Firestore balance
  // (members/{id}/private/billing.pendingReferralCredit) instead of a Stripe
  // customer balance — see issueReferralCredit — since they have no ongoing
  // Stripe subscription for a balance credit to naturally apply against.
  // Whatever's pending gets applied here, on their next charge, capped at
  // this charge's own amount (never a negative charge, never over-applies).
  // Cents throughout to avoid floating-point drift on the subtraction.
  const amountInCentsRequested = Math.round(amountInDollars * 100);
  let creditAppliedCents = 0;
  const pendingCredit = billingData.pendingReferralCredit || 0;
  if (pendingCredit > 0) {
    creditAppliedCents = Math.min(Math.round(pendingCredit * 100), amountInCentsRequested);
  }

  // New-member referral discount — a separate mechanism from pendingReferralCredit
  // above (that one only ever holds a balance from a PRIOR completed payment; a
  // brand-new Travel-tier member has nothing pending yet). Decided fresh right
  // here, a pure read that commits nothing (see resolveNewMemberReferralDiscount),
  // so a retried/failed charge safely re-evaluates instead of trusting a stale
  // decision. Gated on billingData.referralCreditChecked: once this member's
  // first-payment outcome has ever been recorded, every later chargeSavedCard
  // call (a returning Travel-tier client's next booking) must never re-discount
  // them again. Capped at 50% of the ORIGINAL requested amount — never more than
  // half off any one charge — and separately bounded by whatever's left after
  // the pendingReferralCredit application above, so the two mechanisms can never
  // combine to charge less than $0. Applies ONLY to this one charge: whatever
  // the cap leaves unclaimed is forfeited, not carried forward or credited
  // later — a $25 drop-in visit against a $50 code caps the discount at
  // $12.50, and the other $37.50 is simply gone. Deliberate: the code's full
  // face value was never a guarantee, only an upper bound on this charge.
  let referralDiscount = null;
  let discountCents = 0;
  if (!billingData.referralCreditChecked) {
    const memberSnap = await db.collection('members').doc(memberId).get();
    const memberData = memberSnap.data();
    if (memberData) {
      referralDiscount = await resolveNewMemberReferralDiscount(memberId, billingData, memberData);
      if (referralDiscount.decision === 'approved') {
        const cappedAtHalf = Math.floor(amountInCentsRequested / 2);
        const remainingAfterPendingCredit = Math.max(0, amountInCentsRequested - creditAppliedCents);
        discountCents = Math.min(referralDiscount.discountCents, cappedAtHalf, remainingAfterPendingCredit);
      }
    }
  }

  const chargeAmountInCents = amountInCentsRequested - creditAppliedCents - discountCents;
  const creditApplied = creditAppliedCents / 100;
  const referralDiscountApplied = discountCents / 100;
  const chargeAmountInDollars = chargeAmountInCents / 100;

  let paymentIntent = null;
  if (chargeAmountInCents > 0) {
    // Off-session because the client isn't present re-entering their card —
    // they authorized this charge when they added the card in their portal.
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const paymentMethods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card' });
    if (!paymentMethods.data.length) {
      throw new HttpsError('failed-precondition', 'Customer has no saved payment method.');
    }

    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: chargeAmountInCents,
        currency: 'usd',
        customer: customer.id,
        payment_method: paymentMethods.data[0].id,
        off_session: true,
        confirm: true,
        description: description || 'Port City Leash Club service',
      }, {
        // Idempotency guard #2, at Stripe itself: a retry that gets past the
        // Firestore guard above (e.g. two clicks racing before the first
        // write lands) resolves to the same PaymentIntent rather than a
        // second charge. Same pattern as chargeCurrentMonthWalks.
        idempotencyKey: `charge-saved-card:${chargeKey}`,
      });
    } catch (e) {
      // Durable failure record, not a block — the guard above only ever
      // matches on status 'charged', so this same chargeKey stays retryable
      // rather than getting permanently wedged by one transient Stripe error.
      // failureCount tracks consecutive failures for this exact chargeKey —
      // chargeScheduledReservations reads it to cap automatic retries (see
      // MAX_SCHEDULED_CHARGE_ATTEMPTS below); chargeSavedCard's callers don't
      // read it, it's just harmless metadata for them. Resets to 1 rather
      // than carrying forward if priorAttempt belongs to a different
      // chargeKey (e.g. confirmWalkExtension charging a different subset of
      // walks) — that's a distinct logical charge, not a retry of this one.
      await docRef.set({
        [attemptField]: {
          chargeKey, status: 'failed', amount: chargeAmountInDollars,
          reason: e.message, failedAt: FieldValue.serverTimestamp(),
          failureCount: (priorAttempt?.chargeKey === chargeKey ? (priorAttempt.failureCount || 0) : 0) + 1,
        },
      }, { merge: true }).catch(() => {});
      throw new HttpsError('internal', `Card charge failed: ${e.message}`);
    }
  }
  // chargeAmountInCents === 0 means the referral credit fully covered this
  // charge — Stripe doesn't allow a $0 PaymentIntent, so it's skipped
  // entirely rather than attempted; paymentIntent stays null and the
  // doc is still marked charged, since nothing further is owed.

  await docRef.set({
    paymentMethodStatus: 'charged',
    lastChargeId: paymentIntent ? paymentIntent.id : null,
    lastChargeAmount: chargeAmountInDollars,
    lastChargedAt: FieldValue.serverTimestamp(),
    [attemptField]: {
      chargeKey, status: 'charged', amount: chargeAmountInDollars,
      paymentIntentId: paymentIntent ? paymentIntent.id : null,
      chargedAt: FieldValue.serverTimestamp(),
    },
    ...(creditApplied > 0 ? { referralCreditApplied: creditApplied } : {}),
    ...(referralDiscountApplied > 0 ? { referralDiscountApplied } : {}),
  }, { merge: true });

  if (creditAppliedCents > 0 && memberId) {
    await billingRef(memberId).set({
      pendingReferralCredit: FieldValue.increment(-creditApplied),
    }, { merge: true });
  }

  // Post-charge commit for the discount decided above — see
  // finalizeNewMemberReferralDiscount. This is Travel-tier's equivalent of
  // stripeWebhook's invoice.paid branch: Travel-tier clients are charged via
  // a one-off PaymentIntent, never a Stripe Invoice, so invoice.paid never
  // fires for them at all. Only called when referralDiscount was actually
  // computed above (i.e. this genuinely might be the member's first
  // payment) — never throws, never re-decides eligibility, only records
  // what was already applied to the charge that just succeeded.
  if (referralDiscount) {
    await finalizeNewMemberReferralDiscount(stripe, memberId, billingData.referralSubmissionId || null, referralDiscount, discountCents);
  }

  return {
    success: true, paymentIntentId: paymentIntent ? paymentIntent.id : null,
    creditApplied, referralDiscountApplied,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1b. Member-initiated feedback + tips on a completed walk or overnight/
//    check-in visit (portal-walk-history.html's Care History cards). Both
//    submitWalkFeedback and chargeWalkTip need the exact same "is this my
//    own, already-completed record" lookup, over two different shapes (a
//    single walks/{id} doc vs. one entry inside an overnights/{id}.visits[]
//    array) — factored out once here rather than duplicated in both.
// ─────────────────────────────────────────────────────────────────────────
async function resolveOwnedCompletedRecord(uid, { recordType, walkId, overnightId, visitId } = {}) {
  if (recordType === 'walk') {
    if (!walkId) throw new HttpsError('invalid-argument', 'walkId is required.');
    const ref = db.collection('walks').doc(walkId);
    const snap = await ref.get();
    const data = snap.data();
    if (!data) throw new HttpsError('not-found', 'Walk not found.');
    if (data.memberId !== uid) throw new HttpsError('permission-denied', 'That walk does not belong to you.');
    if (data.status !== 'completed') throw new HttpsError('failed-precondition', 'This walk is not completed yet.');
    return { kind: 'walk', ref, data, memberId: data.memberId };
  }
  if (recordType === 'visit') {
    if (!overnightId || !visitId) throw new HttpsError('invalid-argument', 'overnightId and visitId are required.');
    const ref = db.collection('overnights').doc(overnightId);
    const snap = await ref.get();
    const overnight = snap.data();
    if (!overnight) throw new HttpsError('not-found', 'Reservation not found.');
    if (overnight.memberId !== uid) throw new HttpsError('permission-denied', 'That reservation does not belong to you.');
    const visit = (Array.isArray(overnight.visits) ? overnight.visits : []).find(v => v.id === visitId);
    if (!visit) throw new HttpsError('not-found', 'Visit not found.');
    if (visit.status !== 'completed') throw new HttpsError('failed-precondition', 'This visit is not completed yet.');
    return { kind: 'visit', ref, data: visit, memberId: overnight.memberId };
  }
  throw new HttpsError('invalid-argument', 'recordType must be "walk" or "visit".');
}

// Merges `patch` onto the resolved record — a top-level field set for a
// walk doc, or a replace-in-place of the matching visits[] element inside a
// transaction for a visit (re-read fresh each retry, same pattern as
// completeVisit's own visits-array update in walker/dashboard.html).
async function writeOwnedRecordPatch(record, patch) {
  if (record.kind === 'walk') {
    await record.ref.set(patch, { merge: true });
    return;
  }
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(record.ref);
    const freshVisits = (freshSnap.data()?.visits || [])
      .map(v => v.id === record.data.id ? { ...v, ...patch } : v);
    tx.update(record.ref, { visits: freshVisits });
  });
}

exports.submitWalkFeedback = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { rating, comment } = request.data || {};
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    throw new HttpsError('invalid-argument', 'rating must be an integer from 1 to 5.');
  }
  const trimmedComment = (typeof comment === 'string' ? comment : '').trim().slice(0, 1000) || null;

  const record = await resolveOwnedCompletedRecord(request.auth.uid, request.data || {});
  if (record.data.feedback) {
    throw new HttpsError('already-exists', 'Feedback was already submitted for this one.');
  }

  await writeOwnedRecordPatch(record, {
    feedback: { rating: ratingNum, comment: trimmedComment, submittedAt: Timestamp.now() },
  });
  return { success: true };
});

// Small, self-contained Stripe charge for a member-initiated tip —
// deliberately NOT built on chargeCustomerCard below. That helper is wired
// for SERVICE charges: it auto-applies a member's pendingReferralCredit
// balance toward whatever it's charging, and unconditionally stamps
// lastChargeId/lastChargeAmount/paymentMethodStatus onto whatever doc it's
// handed. A tip must never silently consume credit meant for the member's
// next real charge, and must never overwrite a reservation's own
// charge-audit fields — portal-walk-history.html's tip-percentage presets
// themselves read confirmedTotalCents/lastChargeAmount, so those fields
// have to keep meaning exactly what the reservation was actually charged.
async function runTipCharge(stripe, memberId, idempotencyKey, amountCents) {
  const billingSnap = await billingRef(memberId).get();
  const stripeCustomerId = billingSnap.data()?.stripeCustomerId;
  if (!stripeCustomerId) {
    return { chargeStatus: 'failed', amountCents, failureReason: 'No saved card on file.', attemptedAt: Timestamp.now() };
  }
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const paymentMethods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card' });
    if (!paymentMethods.data.length) {
      return { chargeStatus: 'failed', amountCents, failureReason: 'No saved payment method.', attemptedAt: Timestamp.now() };
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customer.id,
      payment_method: paymentMethods.data[0].id,
      off_session: true,
      confirm: true,
      description: 'Port City Leash Club — tip',
    }, { idempotencyKey });
    return { chargeStatus: 'charged', amountCents, paymentIntentId: paymentIntent.id, chargedAt: Timestamp.now() };
  } catch (e) {
    return { chargeStatus: 'failed', amountCents, failureReason: e.message, attemptedAt: Timestamp.now() };
  }
}

exports.chargeWalkTip = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const amountCents = Math.round(Number(request.data?.amountInDollars) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 100) {
    throw new HttpsError('invalid-argument', 'Tip must be at least $1.');
  }

  const record = await resolveOwnedCompletedRecord(request.auth.uid, request.data || {});
  if (record.data.tip?.chargeStatus === 'charged') {
    throw new HttpsError('already-exists', 'This one has already been tipped.');
  }

  const idempotencyKey = record.kind === 'walk'
    ? `tip:walk:${record.ref.id}`
    : `tip:visit:${record.ref.id}:${record.data.id}`;
  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const result = await runTipCharge(stripe, record.memberId, idempotencyKey, amountCents);

  await writeOwnedRecordPatch(record, { tip: result });

  if (result.chargeStatus === 'failed') {
    throw new HttpsError('internal', result.failureReason || 'Tip charge failed — please try again.');
  }
  return { success: true, amountCents };
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Charge the saved card for a one-time service (drop-in visit,
//    overnight stay, standard/extended walk). Admin-triggered only —
//    call this from the admin dashboard's "Confirm" button, after the
//    meet & greet (first-time clients) or immediately (returning clients).
//    Thin onCall wrapper around chargeCustomerCard above — auth check and
//    request-payload validation only; the charging logic itself is shared
//    with chargeScheduledReservations.
// ─────────────────────────────────────────────────────────────────────────
exports.chargeSavedCard = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);

  const { submissionId, amountInDollars, description, chargeKey: chargeKeyInput } = request.data || {};
  if (!submissionId || !amountInDollars) {
    throw new HttpsError('invalid-argument', 'submissionId and amountInDollars are required.');
  }
  // Defaults to submissionId — correct for every caller except
  // confirmWalkExtension, which confirms a checked SUBSET of a submission's
  // walks at a time. A later confirm of the remaining walks from that same
  // submission is a legitimate second charge, not a duplicate, so that
  // caller passes a finer key (submissionId + the sorted walk ids) instead.
  // See the idempotencyKey note on sendBookingConfirmedEmail in
  // confirmWalkExtension for the same problem solved the same way.
  const chargeKey = chargeKeyInput || submissionId;

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const subRef = db.collection('submissions').doc(submissionId);
  const subDoc = await subRef.get();
  const sub = subDoc.data();

  return chargeCustomerCard(stripe, subRef, sub, { chargeKey, amountInDollars, description });
});

// A reservation whose card keeps failing stops being retried automatically
// after this many consecutive failures (roughly 1 hour at the 15-minute
// schedule below) — a declined card doesn't get better by asking again every
// 15 minutes for a full day. needsReview is already set by the first failed
// attempt and stays set, so admin isn't relying on the retries themselves for
// visibility; once capped, resolution is manual via chargeSavedCard once the
// card issue is sorted out.
const MAX_SCHEDULED_CHARGE_ATTEMPTS = 4;

// Only these statuses are safe to charge — an allowlist, not a denylist, so
// any future status this doc might carry (e.g. a cancellation status, if one
// is ever added) fails safe by default instead of becoming chargeable by
// accident. Both values are real, current states: 'confirmed' is set at
// write time (confirmServiceRequest/confirmOvernight) and 'completed' is set
// by the walker's "Mark as Completed" action (walker/dashboard.html) — a
// walker finishing early shouldn't be able to make a reservation invisible
// to its own scheduled charge.
const CHARGEABLE_OVERNIGHT_STATUSES = ['confirmed', 'completed'];

// ─────────────────────────────────────────────────────────────────────────
// 2b. Charge pet-sitting reservations (check-in visits and overnight stays)
//    24 hours after admin confirms them — confirmServiceRequest/confirmOvernight
//    (admin/dashboard.html) write chargeScheduledFor, confirmedTotalCents, and
//    chargePending: true onto the overnights doc at confirm time, but never
//    charge immediately; this is what actually charges the card later.
//
//    Query filters on chargePending == true — a single equality filter, so
//    no composite index is needed, same reasoning as resumePausedMemberships'
//    single-filter pattern above. Deliberately NOT filtered on status: an
//    earlier version filtered on status == 'confirmed', which meant a walker
//    marking the reservation 'completed' before the 24-hour window elapsed
//    silently dropped it out of this query forever — an unpaid, completed
//    service with no error and no flag. chargePending is set true exactly
//    while a charge is owed and cleared the instant one succeeds, so it
//    tracks "is money owed" independently of the reservation's service-status
//    lifecycle. The "is it due yet" (chargeScheduledFor) and "is this status
//    safe to charge" (CHARGEABLE_OVERNIGHT_STATUSES) checks both happen in JS
//    inside the loop, same codebase convention.
//
//    Each candidate gets a FRESH .get() immediately before charging, not
//    just the query snapshot from the top of the run — admin may have
//    cancelled or modified this exact reservation sometime in the 24-hour
//    window, and a long-running batch can go stale by the time it reaches
//    a given doc.
//
//    Uses chargeCustomerCard (shared with chargeSavedCard above) with
//    attemptField: 'chargeAttempt' — the overnights-doc idempotency guard,
//    same shape and semantics as chargeSavedCard's lastChargeAttempt and
//    chargeCurrentMonthWalks' currentMonthCharge, just a different field
//    name so it reads clearly on this collection. chargePending is cleared
//    here, not inside chargeCustomerCard, so the shared helper stays
//    collection-agnostic — chargeSavedCard's submissions docs have no such
//    field.
//
//    A charge failure is not re-thrown past this loop (this is a scheduled
//    job, nothing is waiting to catch it) — chargeCustomerCard's own
//    failure branch already durably records the attempt (including
//    failureCount, which the cap above reads) on the overnights doc; on top
//    of that, this flags the member's billing record the same way
//    onOvernightCompleted already does for a payout-calc failure, so a
//    failed automated charge is visible on the admin Members table instead
//    of silently vanishing — see NEEDS_REVIEW_LABELS.reservation_charge_failed
//    in admin/dashboard.html.
// ─────────────────────────────────────────────────────────────────────────
exports.chargeScheduledReservations = onSchedule({
  schedule: 'every 15 minutes',
  secrets: [STRIPE_SECRET_KEY],
}, async () => {
  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const now = new Date();
  const dueSnap = await db.collection('overnights').where('chargePending', '==', true).get();

  for (const candidate of dueSnap.docs) {
    const data = candidate.data();
    const scheduledFor = data.chargeScheduledFor?.toDate ? data.chargeScheduledFor.toDate() : null;
    if (!scheduledFor || scheduledFor > now) continue;
    if (data.chargeAttempt?.status === 'charged') continue; // cheap skip before the fresh re-read below
    if (data.chargeAttempt?.status === 'failed' && (data.chargeAttempt.failureCount || 0) >= MAX_SCHEDULED_CHARGE_ATTEMPTS) continue; // capped — needsReview already flagged, leave for manual resolution

    // Fresh read immediately before charging — see comment above.
    const freshSnap = await candidate.ref.get();
    const freshData = freshSnap.data();
    if (!freshData || !CHARGEABLE_OVERNIGHT_STATUSES.includes(freshData.status)) continue;

    const isCheckin = freshData.serviceType === 'checkin' || freshData.serviceType === 'drop-in-visit';
    try {
      await chargeCustomerCard(stripe, candidate.ref, freshData, {
        chargeKey: `scheduled-reservation:${candidate.id}`,
        amountInDollars: (freshData.confirmedTotalCents || 0) / 100,
        description: `Port City Leash Club - ${isCheckin ? 'Drop-In Visits' : 'Overnight Stay'}`,
        attemptField: 'chargeAttempt',
      });
      await candidate.ref.set({ chargePending: false }, { merge: true });
    } catch (e) {
      console.error(
        `chargeScheduledReservations: charge failed for overnights/${candidate.id} `
        + `(memberId=${freshData.memberId || 'unknown'}, amount=${(freshData.confirmedTotalCents || 0) / 100}):`,
        e.message
      );
      if (freshData.memberId) {
        await billingRef(freshData.memberId).set({
          needsReview: true, needsReviewReason: 'reservation_charge_failed',
        }, { merge: true }).catch(writeErr => {
          console.error(`chargeScheduledReservations: failed to write needsReview for ${freshData.memberId}:`, writeErr.message);
        });
      }
    }
  }
});

// retryReservationCharge: admin-only manual retry for a reservation whose
// scheduled charge failed (see NEEDS_REVIEW_LABELS.reservation_charge_failed,
// admin/dashboard.html) — chargeScheduledReservations above gives up after
// MAX_SCHEDULED_CHARGE_ATTEMPTS and just leaves the flag for manual
// resolution, which until now meant charging in Stripe directly. This lets
// admin retry the exact same charge in-app once the underlying problem
// (usually: member had no card on file yet) is actually fixed.
//
// Uses the SAME chargeKey the scheduled sweep uses — chargeCustomerCard's
// own idempotency guard #1 blocks only a prior 'charged' outcome for that
// key, never a prior 'failed' one, so this can never double-charge a
// reservation the sweep already succeeded on, and is safe to click more
// than once if it fails again.
exports.retryReservationCharge = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { overnightId } = request.data || {};
  if (!overnightId) throw new HttpsError('invalid-argument', 'overnightId is required.');

  const ref = db.collection('overnights').doc(overnightId);
  const snap = await ref.get();
  const data = snap.data();
  if (!data) throw new HttpsError('not-found', 'Reservation not found.');
  if (!CHARGEABLE_OVERNIGHT_STATUSES.includes(data.status)) {
    throw new HttpsError('failed-precondition', `This reservation's status (${data.status}) can't be charged.`);
  }
  if (data.chargeAttempt?.status === 'charged') {
    throw new HttpsError('failed-precondition', 'This reservation was already charged.');
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const isCheckin = data.serviceType === 'checkin' || data.serviceType === 'drop-in-visit';
  await chargeCustomerCard(stripe, ref, data, {
    chargeKey: `scheduled-reservation:${overnightId}`,
    amountInDollars: (data.confirmedTotalCents || 0) / 100,
    description: `Port City Leash Club - ${isCheckin ? 'Drop-In Visits' : 'Overnight Stay'}`,
    attemptField: 'chargeAttempt',
  });
  await ref.set({ chargePending: false }, { merge: true });

  // Only clears the review flag on an EXACT reason match — same posture as
  // confirmCardOnFile/getCardOnFile's own needsReview clears — so this
  // never clobbers a different, unrelated needsReview reason that happens
  // to be set on this member at the same time.
  if (data.memberId) {
    const billing = billingRef(data.memberId);
    const billingSnap = await billing.get();
    if (billingSnap.data()?.needsReviewReason === 'reservation_charge_failed') {
      await billing.set({ needsReview: false, needsReviewReason: null }, { merge: true }).catch(() => {});
    }
  }

  return { success: true };
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Start a recurring monthly membership subscription (Essential /
//    Standard / Daily). Triggered after a member's card is confirmed on
//    file. Uses billing_cycle_anchor so the recurring charge lands on the
//    1st of the month regardless of the day the membership actually starts.
//
//    Core logic lives in runCreateMembershipSubscription, a plain function,
//    not inline in the onCall handler below — finalizeSubmissionIfReady (the
//    card-on-file/dates-confirmed trigger) has no request.auth to hand an
//    onCall function, the same reason chargeCustomerCard was already
//    extracted from chargeSavedCard. The onCall export is now a thin
//    wrapper kept for the still-live saveMember() admin flow during the
//    build — removed once admin/dashboard.html is cut over to the new flow.
//
//    stripeCustomerId is resolved from members/{memberId}/private/billing,
//    not from the submission — a submission no longer carries its own copy.
//    submissionId is still used, for sub.startDate/referredByCode only —
//    both unrelated to card capture and unaffected by that move.
// ─────────────────────────────────────────────────────────────────────────
async function runCreateMembershipSubscription(submissionId, memberId) {
  // Resolve the member and their tier BEFORE touching the submission or
  // Stripe. Travel-tier (and any non-billed tier) has no subscription price,
  // and such a member may legitimately have no card on file — so that case
  // has to return before the card check below, not fall into it.
  const memberDoc = await db.collection('members').doc(memberId).get();
  const member = memberDoc.data();
  if (!member) {
    throw new HttpsError('not-found', 'Member record not found.');
  }

  // resolveMemberPriceId throws for anything that isn't 'Member'/'Travel'.
  // Nothing has been written yet at this point (this is still before the
  // try block below), so propagating that throw is safe.
  const priceId = resolveMemberPriceId(member.tier);
  if (!priceId) {
    // Not an error: this is the normal path for Travel-tier members. The
    // caller uses `skipped` to decide whether to generate walks.
    return { success: true, skipped: true, tier: member.tier || null };
  }

  // Idempotency guard — required now that finalizeSubmissionIfReady is
  // retryable (recordFinalizeFailure clears billingFinalized on failure).
  // stripe.subscriptions.create() below has no Stripe-level idempotencyKey
  // of its own, unlike every charge call in this file (chargeCustomerCard,
  // runChargeCurrentMonthWalks) — so without this check, a retry after a
  // LATER step in the same finalize run failed (generateInitialWalks,
  // chargeCurrentMonthWalks, the email) would call it again and create a
  // genuine second Stripe subscription for this member. stripeSubscriptionId
  // only ever lands on billing via the batch.commit() below, which writes
  // it together with everything else in ONE atomic commit — so its
  // presence means that whole commit already succeeded; there is nothing
  // left for a retry to do here.
  const existingBillingSnap = await billingRef(memberId).get();
  const existingSubscriptionId = existingBillingSnap.data()?.stripeSubscriptionId;
  if (existingSubscriptionId) {
    return { success: true, skipped: false, alreadyExists: true, subscriptionId: existingSubscriptionId };
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());

  // Everything below this point either succeeds with a real subscription or
  // throws — no more early "not an error" returns past this line. On any
  // throw, needsReview is set on the billing subdoc before rethrowing, so a
  // member left active with no subscription is never silently unbilled — see
  // dismissBillingReview for how this clears.
  try {
    const subDoc = await db.collection('submissions').doc(submissionId).get();
    const sub = subDoc.data();

    const billingSnap = await billingRef(memberId).get();
    const stripeCustomerId = billingSnap.data()?.stripeCustomerId;
    if (!stripeCustomerId) {
      throw new HttpsError('failed-precondition', 'No saved card found for this member.');
    }

    const paymentMethods = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card' });
    if (!paymentMethods.data.length) {
      throw new HttpsError('failed-precondition', 'Customer has no saved payment method.');
    }

    // Set as the default payment method for invoices on this customer, and tag
    // the customer with the Firestore memberId — stripeWebhook's Stripe-side
    // fallback lookup (see findMemberIdByStripeCustomerId) reads this back when
    // the Firestore-side lookup (billing.stripeCustomerId) can't resolve it.
    await stripe.customers.update(stripeCustomerId, {
      metadata: { memberId },
      invoice_settings: { default_payment_method: paymentMethods.data[0].id },
    });

    // Target billing month: the 1st of next calendar month — used below both
    // for the walk-day quantity (that first period this subscription is
    // actually billed for) and as the date billing_cycle_anchor lands on.
    const now = new Date();
    const nextFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    // 6:00 PM ET on the 1st, not midnight — gives syncMonthlyWalkQuantities
    // (which runs at 12:05 AM ET that same day) an ~18-hour buffer to push the
    // correct quantity before Stripe actually generates this invoice. Deliberately
    // kept under the UTC day boundary (18:00 ET is 22:00-23:00 UTC depending on
    // DST) so Stripe's dashboard — which displays in UTC — also shows the 1st,
    // not the 2nd, even though the underlying instant is what actually matters.
    const billingCycleAnchor = Math.floor(
      easternTimeToUtc(nextFirst.getUTCFullYear(), nextFirst.getUTCMonth(), 1, 18, 0).getTime() / 1000
    );

    // If the member's requested start date (submission.startDate, a Firestore
    // Timestamp — written as local noon so its UTC calendar-date components
    // never roll over a day boundary) falls inside the anchor month, that
    // first invoice is a partial month — only count walk days from that date
    // through month end. Any other case (no start date given, or it falls
    // outside the anchor month entirely) bills the full month, same as every
    // month after.
    const fromDay = firstBilledMonthFromDay(sub?.startDate, nextFirst.getUTCFullYear(), nextFirst.getUTCMonth());
    const quantity = countWalkDaysInMonth(member.defaultWalkDays, nextFirst.getUTCFullYear(), nextFirst.getUTCMonth(), fromDay);

    if (!quantity) {
      throw new HttpsError('failed-precondition', 'This member has no scheduled walk days next month — set defaultWalkDays before starting billing.');
    }

    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: priceId, quantity }],
      billing_cycle_anchor: billingCycleAnchor,
      proration_behavior: 'none',
    });

    // membershipStartDate is copied onto the member so the scheduled jobs on
    // the 1st can honor a mid-month start. It lived only on the submission
    // before, which those jobs never read — which is exactly why they used to
    // revert the proration set here.
    const startDate = toDateOrNull(sub?.startDate);
    // Atomic split write. The 4 billing fields go to the protected subdoc; the
    // member doc keeps membershipStartDate (scheduled jobs read it) and gains
    // hasActiveSubscription — a NON-sensitive boolean the crons filter on in
    // place of the now-relocated stripeSubscriptionItemId.
    const batch = db.batch();
    batch.set(db.collection('members').doc(memberId), {
      hasActiveSubscription: true,
      ...(startDate ? { membershipStartDate: Timestamp.fromDate(startDate) } : {}),
    }, { merge: true });
    batch.set(billingRef(memberId), {
      stripeCustomerId,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionItemId: subscription.items.data[0].id,
      billingStatus: 'active',
      // Referral credit intake: normally already written by
      // completeMeetGreetAndCreateAccount at account-creation time — this is
      // a redundant, idempotent re-write (merge:true, same values), kept as
      // a safety net for the still-live old saveMember() flow during the
      // build, which never calls that function. One code per member,
      // structurally: only written if billingSnap (read above, before this
      // batch was built) shows nothing already there — never overwrites a
      // real value with a second write, even a same-flow retry.
      ...(billingSnap.data()?.referredByCode ? {} : {
        referredByCode: sub?.referredByCode || null,
        referralSubmissionId: submissionId,
      }),
    }, { merge: true });
    await batch.commit();

    // TODO(cancel): a future cancellation flow MUST do all three together:
    //   (a) set hasActiveSubscription: false on the member doc
    //   (b) delete or null the billing subdoc (members/{id}/private/billing)
    //   (c) stripe.subscriptions.cancel(...)
    // Missing (a) or (b) will leave crons trying to bill a cancelled member.

    return { success: true, subscriptionId: subscription.id, quantity };
  } catch (e) {
    // Best-effort — a failure to write this flag must never hide the real
    // error above from the admin who needs to see and act on it.
    await billingRef(memberId).set({
      needsReview: true, needsReviewReason: 'subscription_creation_failed',
    }, { merge: true }).catch(writeErr => {
      console.error(`createMembershipSubscription: failed to write needsReview for ${memberId}:`, writeErr.message);
    });
    throw e;
  }
}

exports.createMembershipSubscription = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { submissionId, memberId } = request.data || {};
  if (!submissionId || !memberId) {
    throw new HttpsError('invalid-argument', 'submissionId and memberId are required.');
  }
  return runCreateMembershipSubscription(submissionId, memberId);
});

// ─────────────────────────────────────────────────────────────────────────
// 3a-review. Clears billing.needsReview/needsReviewReason on a member's
// billing subdoc. Generic across every reason that flag gets set for
// (subscription_creation_failed here, plus runFirstPaymentReferralCredit's
// possible_self_referral/single_use_code_already_redeemed and the walk
// extension credit failure) — same acknowledgment posture as the
// tier_change "Mark Applied" and walker_incident "Mark Done" actions in
// admin/dashboard.html: admin has resolved it themselves (in Stripe, in
// Firestore, wherever the actual fix lives — there's no in-app retry for
// any of these yet), and is manually clearing the flag, not the app
// verifying the underlying problem is actually fixed.
// ─────────────────────────────────────────────────────────────────────────
exports.dismissBillingReview = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);

  const { memberId } = request.data || {};
  if (!memberId) {
    throw new HttpsError('invalid-argument', 'memberId is required.');
  }

  // Without this, set({merge:true}) on an unknown memberId would silently
  // create a fresh billing subdoc at a path with no member behind it,
  // rather than failing — same not-found check createMembershipSubscription
  // does just above.
  const memberDoc = await db.collection('members').doc(memberId).get();
  if (!memberDoc.data()) {
    throw new HttpsError('not-found', 'Member record not found.');
  }

  // dismissedBy/dismissedAt: this flag means "a human manually verified the
  // underlying issue was fixed elsewhere" — worth knowing who and when,
  // same accountability reasoning as meetGreetCompletedAt on membership
  // requests. Last-write-wins across repeat dismissals, same as every other
  // single-attempt field in this file (e.g. lastChargeAttempt) — acceptable
  // since only the most recent dismissal is ever actionable.
  await billingRef(memberId).set({
    needsReview: false, needsReviewReason: null,
    dismissedBy: request.auth.uid, dismissedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { success: true };
});

// ─────────────────────────────────────────────────────────────────────────
// Turns an already-granted Friends & Family discount on or off for one
// member, without touching travelDiscountPercent — that field is the
// historical record of what claimFriendsFamilyRedemption granted; this is a
// separate switch layered on top, so Alison can pause a member's discount
// (a falling-out, a code given in error, whatever the reason) and restore it
// later without the member re-claiming a code they may not even still have.
// One code per person is the model (see FRIENDS_FAMILY_DEFAULT_MAX_REDEMPTIONS),
// so this is deliberately per-member state, not a lookup against the
// referralCodes doc at charge time.
//
// Every read site (chargeCustomerCard's guard above, and every review/recalc
// site in admin/dashboard.html) requires travelDiscountActive === true
// explicitly — a member who has travelDiscountPercent set but no
// travelDiscountActive field (every Friends & Family member granted before
// this switch shipped) resolves to inactive until an admin turns it on here.
// Requires travelDiscountPercent already on file: this switch has nothing to
// turn on or off for a member who never claimed a code at all.
// ─────────────────────────────────────────────────────────────────────────
exports.setFriendsFamilyDiscountActive = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);

  const { memberId, active } = request.data || {};
  if (!memberId || typeof active !== 'boolean') {
    throw new HttpsError('invalid-argument', 'memberId and a boolean active are required.');
  }

  const billingSnap = await billingRef(memberId).get();
  const billingData = billingSnap.data();
  if (!billingData || !(billingData.travelDiscountPercent > 0)) {
    throw new HttpsError('failed-precondition', 'This member has no Friends & Family discount on file.');
  }

  await billingRef(memberId).set({
    travelDiscountActive: active,
    travelDiscountActiveChangedBy: request.auth.uid,
    travelDiscountActiveChangedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { success: true, active };
});

// ─────────────────────────────────────────────────────────────────────────
// 3b. Generate walk documents for a brand-new member's first (partial)
//    billed month. Called as a separate follow-up step right after
//    createMembershipSubscription succeeds — not folded into that
//    function's body — so a bug here can never affect the billing path
//    it's paired with. Records initialWalksGenerated on the member doc
//    (true/false) so a failure is durable, checkable state rather than
//    just a banner that disappears when the modal closes.
//
//    Extracted to a plain function for the same reason as
//    runCreateMembershipSubscription above — finalizeSubmissionIfReady has
//    no request.auth to hand an onCall function.
// ─────────────────────────────────────────────────────────────────────────
async function runGenerateInitialWalks(submissionId, memberId) {
  try {
    const subDoc = await db.collection('submissions').doc(submissionId).get();
    const sub = subDoc.data() || {};

    const memberDoc = await db.collection('members').doc(memberId).get();
    const member = memberDoc.data();
    if (!member) {
      throw new HttpsError('not-found', 'Member record not found.');
    }

    // Same target-month/fromDay derivation as createMembershipSubscription,
    // so the walks generated here line up exactly with what was billed.
    // sub.startDate is a Firestore Timestamp (new Date(sub.startDate) below
    // is a fallback for any pre-existing docs still stored as a string).
    //
    // "Now" is Eastern time, same as every other date-sensitive function
    // here (chargeCurrentMonthWalks, updateWalkSchedule, submitVacationHold)
    // — a bare `new Date()` + UTC getters used to disagree with those in the
    // ~7pm-midnight ET window on the last day of a month (UTC already reads
    // the next month while ET doesn't), computing the wrong "next month".
    const { year: todayYear, monthIndex: todayMonthIndex } = easternTodayParts();
    const nextMonthIndex = todayMonthIndex === 11 ? 0 : todayMonthIndex + 1;
    const nextYear = todayMonthIndex === 11 ? todayYear + 1 : todayYear;
    const nextFirst = new Date(Date.UTC(nextYear, nextMonthIndex, 1));
    let fromDay = 1;
    if (sub.startDate) {
      const startDateObj = sub.startDate.toDate ? sub.startDate.toDate() : new Date(sub.startDate);
      const startYear = startDateObj.getUTCFullYear();
      const startMonth = startDateObj.getUTCMonth() + 1;
      const startDay = startDateObj.getUTCDate();
      if (startYear === nextFirst.getUTCFullYear() && startMonth - 1 === nextFirst.getUTCMonth()) {
        fromDay = startDay;
      }
    }

    const result = await generateWalksForMember(memberId, member, nextFirst.getUTCFullYear(), nextFirst.getUTCMonth(), fromDay);
    if (result.blocked) {
      throw new HttpsError('failed-precondition', 'This member has no preferred time slot set — set defaultTimeSlot before generating walks.');
    }
    if (result.failed > 0) {
      throw new HttpsError('internal', `${result.failed} of ${result.created + result.failed} walk(s) failed to generate — check function logs.`);
    }

    await db.collection('members').doc(memberId).set({ initialWalksGenerated: true }, { merge: true });
    return { success: true, ...result };
  } catch (e) {
    // Record the failure durably before re-throwing, so admin can see it
    // without depending on this one-time error banner.
    await db.collection('members').doc(memberId).set({ initialWalksGenerated: false }, { merge: true }).catch(() => {});
    throw e;
  }
}

exports.generateInitialWalks = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);
  const { submissionId, memberId } = request.data || {};
  if (!submissionId || !memberId) {
    throw new HttpsError('invalid-argument', 'submissionId and memberId are required.');
  }
  return runGenerateInitialWalks(submissionId, memberId);
});

// ─────────────────────────────────────────────────────────────────────────
// Member self-service: change preferred walk days / time slot.
//
// defaultWalkDays drives the Stripe billing quantity (countWalkDaysInMonth)
// AND walk generation (datesMatchingWeekdaysInMonth), so it is deliberately
// EXCLUDED from the member-writable allowlist in firestore.rules — a direct
// client write is rejected. This callable is the only path a member has to
// change it, and it validates the day-count against the member's tier so a
// member can't quietly inflate their walk quantity (e.g. an Essential member
// jumping to 5 days) without the billing tier to match. Only defaultWalkDays
// and defaultTimeSlot are ever written here — nothing billing-adjacent.
//
// Returns { success:false, error } for the expected member-facing outcomes
// (not a member, invalid input, tier violation) so the portal can show the
// reason inline. Throws HttpsError only for no-auth and infrastructure faults.
const VALID_WALK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
// The valid time-slot keys now live in time-slots.js (mirrored the same way
// pricing.js/walker-pricing.js are — see firebase.json's predeploy cp), not
// a local literal here — fetched via dynamic import at the one call site
// below, same pattern as every other pricing.js import in this file (this
// module is CommonJS; a static top-level import of an ES module isn't
// available without converting the whole file).
// Flat day-count rule for every recurring member. The old per-tier ranges
// (Essential 1-2, Standard 3-4, Daily fixed at 5) are retired along with the
// tiers themselves — this also lifts the previous restriction that Daily
// members couldn't change their days at all; every recurring member can now
// pick any 1-7 day count, weekends included.
const RECURRING_MEMBER_DAY_RULE = { min: 1, max: 7, label: 'Choose between 1 and 7 walk days per week' };

exports.updateWalkSchedule = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  // No auth context at all — callable convention is to throw (the client's
  // try/catch surfaces it). Everything else is a returned {success:false}.
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const uid = request.auth.uid;

  const memberDoc = await db.collection('members').doc(uid).get();
  if (!memberDoc.exists) {
    return { success: false, error: 'Not a member.' };
  }
  const member = memberDoc.data() || {};

  const rule = member.tier === 'Member' ? RECURRING_MEMBER_DAY_RULE : null;
  if (!rule) {
    return { success: false, error: `Your account tier (${member.tier || 'none'}) does not support schedule changes here. Please contact us.` };
  }

  const { defaultWalkDays, defaultTimeSlot, resolutions } = request.data || {};

  // Normalize days: lowercase + trim, drop blanks, dedupe. Reject anything
  // that isn't a recognized day name.
  if (!Array.isArray(defaultWalkDays)) {
    return { success: false, error: 'Please select your walk days.' };
  }
  const days = [...new Set(defaultWalkDays.map(d => String(d || '').toLowerCase().trim()).filter(Boolean))];
  const invalidDay = days.find(d => !VALID_WALK_DAYS.includes(d));
  if (invalidDay) {
    return { success: false, error: `"${invalidDay}" is not a valid walk day.` };
  }

  // Time slot must be one of the canonical values the walk generator understands.
  const { WALK_TIME_SLOTS } = await import('./time-slots.js');
  if (!WALK_TIME_SLOTS.includes(defaultTimeSlot)) {
    return { success: false, error: 'Please choose a valid time slot (morning, early afternoon, or late afternoon).' };
  }

  // Day-count must fit the member's tier.
  if (days.length < rule.min || days.length > rule.max) {
    return { success: false, error: `${rule.label}. You selected ${days.length}.` };
  }

  // Store days in canonical weekday order so the record is stable regardless
  // of the order the member checked them.
  const orderedDays = VALID_WALK_DAYS.filter(d => days.includes(d));

  // Reconcile NEXT month's walk docs against the new schedule. Under the
  // rolling two-month window next month always has generated walks by the
  // time a member can see/edit it, so this fires on essentially every
  // schedule change, not just the rare mid-signup edge case it used to be
  // limited to. Current month is never touched — already billed, and
  // "changes take effect next month" covers it.
  const { year, monthIndex } = easternTodayParts();
  const nextMonthIndex = monthIndex === 11 ? 0 : monthIndex + 1;
  const nextYear = monthIndex === 11 ? year + 1 : year;

  // Query by memberId (not constructed IDs) so this also catches any walk
  // added manually via the admin "Add Walk" modal or moved by an approved
  // reschedule (approveReschedule updates date/timeSlot on the walk's
  // ORIGINAL doc in place, so its live `date` can diverge from what its own
  // deterministic ID implies) — same reasoning as submitVacationHold's
  // identical query. Everything below keys off each walk's live `date`
  // field, never its doc ID, for the same reason.
  const memberWalksSnap = await db.collection('walks').where('memberId', '==', uid).get();

  // Snapshot every next-month, non-completed walk BEFORE deleting anything,
  // keyed by ISO date — this is what makes regeneration below able to
  // restore per-walk state (walker assignment, an in-progress extension,
  // a rescheduled time slot) on any date that survives into the new
  // schedule, instead of silently discarding it the way a plain
  // delete-and-regenerate would.
  //
  // Two or more docs can in principle share a date (an ad hoc admin-added
  // walk on a day the recurring schedule also covers, most likely) — a
  // pre-existing possibility this change doesn't introduce. When that
  // happens, the canonical deterministic-ID doc wins if one of them is it
  // (since that's the one regeneration will recreate); otherwise the most
  // recently created doc wins and the collision is logged.
  const snapshotByDate = new Map(); // dateStr -> snapshot
  const oldDateStrs = new Set();
  memberWalksSnap.forEach(snap => {
    const walk = snap.data();
    if (walk.status === 'completed') return; // never touch history
    const walkDate = walk.date?.toDate?.();
    if (!walkDate) return;
    if (walkDate.getUTCFullYear() !== nextYear || walkDate.getUTCMonth() !== nextMonthIndex) return; // this month or beyond next month — not our concern
    const dateStr = isoDateStr(walkDate);
    oldDateStrs.add(dateStr);
    const isCanonicalId = snap.id === `${uid}_${dateStr}`;
    const existing = snapshotByDate.get(dateStr);
    const createdAtMs = walk.createdAt?.toMillis?.() || 0;
    if (existing && !isCanonicalId && (existing.isCanonicalId || existing.createdAtMs >= createdAtMs)) {
      console.warn(`updateWalkSchedule: multiple walks for member ${uid} on ${dateStr} (${existing.docId}, ${snap.id}) — keeping ${existing.docId}.`);
      return;
    }
    if (existing) {
      console.warn(`updateWalkSchedule: multiple walks for member ${uid} on ${dateStr} (${existing.docId}, ${snap.id}) — keeping ${snap.id}.`);
    }
    snapshotByDate.set(dateStr, {
      date: dateStr,
      docId: snap.id,
      isCanonicalId,
      createdAtMs,
      walkerId: walk.walkerId || null,
      extended: !!walk.extended,
      extendedStatus: walk.extendedStatus || null,
      duration: walk.duration || null,
      timeSlot: walk.timeSlot || null,
      // Stamped by confirmWalkExtension (admin/dashboard.html) at the moment
      // this specific walk's extension was actually charged — see the credit
      // idempotency key below for why this, not just the date, is what a
      // credit gets keyed on.
      extensionChargeId: walk.extensionChargeId || null,
    });
  });

  // Canonical dates the PROPOSED schedule would produce. Uses the same
  // fromDay regeneration below will actually use (normally 1, but a member
  // whose billing start date falls IN this exact target month — the narrow
  // window between confirmation and their first billed month starting — is
  // only ever generated from that start day forward). Computed once here so
  // eligibleDates/newDateStrs can never disagree with what regeneration
  // actually produces.
  const fromDay = firstBilledMonthFromDay(member.membershipStartDate, nextYear, nextMonthIndex);
  const newDateNums = datesMatchingWeekdaysInMonth(orderedDays, nextYear, nextMonthIndex, fromDay);
  const newDateStrs = new Set(newDateNums.map(day =>
    `${nextYear}-${String(nextMonthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  ));

  // Extension pricing/description — needed for the preview response, the
  // credit description, and rewriting a scrubbed pending-extension submission.
  const { WALK_EXTENSION_PRICE, calculateWalkExtensionTotal } = await import('./pricing.js');

  // Dates being dropped that carried a CONFIRMED (paid) extension — the
  // only case with real money already spent that a plain delete would
  // otherwise silently erase. A PENDING extension on a dropped date is
  // handled separately below (no money moved, so no member resolution is
  // needed — just cleanup of the submission that references it).
  const orphanedConfirmed = [...oldDateStrs]
    .filter(d => !newDateStrs.has(d))
    .map(d => snapshotByDate.get(d))
    .filter(s => s && s.extendedStatus === 'confirmed');

  // Eligible "move a paid extension here" targets: survives into the new
  // schedule AND isn't already extended itself.
  const eligibleDates = [...newDateStrs].filter(d => {
    const existing = snapshotByDate.get(d);
    return !existing || !existing.extended;
  }).sort();

  let validatedResolutions = [];
  if (orphanedConfirmed.length > 0) {
    if (!Array.isArray(resolutions)) {
      // First pass: report what needs resolving, write nothing.
      return {
        success: false,
        needsResolution: true,
        orphanedExtensions: orphanedConfirmed.map(o => ({ date: o.date, amount: WALK_EXTENSION_PRICE })),
        eligibleDates,
      };
    }

    // Re-derive the orphan set fresh (above) rather than trusting the
    // client's copy of it — reject a stale/mismatched submission (e.g. the
    // schedule changed again, or admin declined an extension, since the
    // member last saw the preview) instead of silently mis-crediting.
    const orphanedDateSet = new Set(orphanedConfirmed.map(o => o.date));
    const resolvedDateSet = new Set(resolutions.map(r => r && r.date));
    const missing = [...orphanedDateSet].filter(d => !resolvedDateSet.has(d));
    const extra = [...resolvedDateSet].filter(d => !orphanedDateSet.has(d));
    if (missing.length || extra.length) {
      return {
        success: false,
        needsResolution: true,
        error: 'Your schedule may have changed since you last reviewed this — please review the affected extensions again.',
        orphanedExtensions: orphanedConfirmed.map(o => ({ date: o.date, amount: WALK_EXTENSION_PRICE })),
        eligibleDates,
      };
    }

    const chosenTargets = new Set();
    for (const r of resolutions) {
      if (r.action === 'move') {
        if (!eligibleDates.includes(r.targetDate)) {
          return { success: false, error: `"${r.targetDate}" isn't an eligible date for moving an extension to.` };
        }
        if (chosenTargets.has(r.targetDate)) {
          return { success: false, error: `More than one extension was moved to ${r.targetDate} — each date can only take one.` };
        }
        chosenTargets.add(r.targetDate);
      } else if (r.action !== 'credit') {
        return { success: false, error: `Unrecognized resolution action "${r.action}".` };
      }
    }
    validatedResolutions = resolutions;
  }

  // Dropped dates with a PENDING (unpaid, unconfirmed) extension — no money
  // involved, so no member resolution is needed. But the walk_extension
  // submission that named this walkId will otherwise reference a deleted
  // doc, which throws if admin later tries to confirm it — scrub the stale
  // ID out of that submission (or mark it stale if that empties it) rather
  // than leaving a landmine. Computed now, applied after the delete below.
  const droppedPendingDates = [...oldDateStrs]
    .filter(d => !newDateStrs.has(d))
    .map(d => snapshotByDate.get(d))
    .filter(s => s && s.extendedStatus === 'pending');

  const batch = db.batch();
  batch.set(
    db.collection('members').doc(uid),
    { defaultWalkDays: orderedDays, defaultTimeSlot },
    { merge: true }
  );

  memberWalksSnap.forEach(snap => {
    const walk = snap.data();
    if (walk.status === 'completed') return; // never touch history
    const walkDate = walk.date?.toDate?.();
    if (!walkDate) return;
    if (walkDate.getUTCFullYear() !== nextYear || walkDate.getUTCMonth() !== nextMonthIndex) return; // this month or beyond next month — not our concern
    batch.delete(snap.ref);
  });

  try {
    await batch.commit();
  } catch (e) {
    console.error('updateWalkSchedule write failed:', e);
    throw new HttpsError('internal', 'Could not save schedule.');
  }

  // Everything past this point is best-effort, sequential follow-through —
  // same pattern as chargeCurrentMonthWalks/createMembershipSubscription's
  // own multi-step flows, not a single mega-transaction (generateWalksForMember's
  // per-date .create() loop and the Stripe credit call below can't
  // meaningfully participate in one Firestore transaction anyway). The
  // schedule change itself already committed above; a failure from here on
  // is logged and, for walk generation, self-healing via the same
  // deterministic-ID/.create() idempotency every other caller relies on.
  const updatedMember = { ...member, defaultWalkDays: orderedDays, defaultTimeSlot };
  try {
    const result = await generateWalksForMember(uid, updatedMember, nextYear, nextMonthIndex, fromDay);
    if (result.failed > 0) {
      console.error(`updateWalkSchedule: ${result.failed} walk(s) failed to regenerate for member ${uid} after schedule change`);
    }
  } catch (e) {
    console.error(`updateWalkSchedule: regeneration failed for member ${uid}:`, e.message);
  }

  // Restore per-walk state onto any date that survived the change.
  const defaultWalkerId = updatedMember.assignedWalkerId || null;
  const survivingDates = [...oldDateStrs].filter(d => newDateStrs.has(d));
  for (const dateStr of survivingDates) {
    const snap = snapshotByDate.get(dateStr);
    if (!snap) continue;
    const update = {};
    if (snap.walkerId && snap.walkerId !== defaultWalkerId) update.walkerId = snap.walkerId;
    if (snap.extended) {
      update.extended = true;
      if (snap.extendedStatus) update.extendedStatus = snap.extendedStatus;
      if (snap.duration) update.duration = snap.duration;
    }
    if (snap.timeSlot && snap.timeSlot !== defaultTimeSlot) update.timeSlot = snap.timeSlot;
    if (!Object.keys(update).length) continue; // regenerated doc's defaults already match
    try {
      await db.collection('walks').doc(`${uid}_${dateStr}`).update(update);
    } catch (e) {
      console.error(`updateWalkSchedule: failed to restore state for ${uid}_${dateStr}:`, e.message);
    }
  }

  // Apply move/credit resolutions for orphaned confirmed extensions.
  const failedMoves = [];
  const creditResults = [];
  for (const r of validatedResolutions) {
    if (r.action === 'move') {
      try {
        await db.collection('walks').doc(`${uid}_${r.targetDate}`).update({
          extended: true,
          extendedStatus: 'confirmed',
          duration: '45-minute walk',
        });
      } catch (e) {
        console.error(`updateWalkSchedule: failed to move extension from ${r.date} to ${r.targetDate} for member ${uid}:`, e.message);
        failedMoves.push(r);
      }
    }
  }

  const creditResolutions = validatedResolutions.filter(r => r.action === 'credit');
  if (creditResolutions.length) {
    const billingSnap = await billingRef(uid).get();
    const stripeCustomerId = billingSnap.data()?.stripeCustomerId;
    const stripe = stripeClient(STRIPE_SECRET_KEY.value());
    for (const r of creditResolutions) {
      // Keyed on the SPECIFIC charge that paid for this extension
      // (extensionChargeId, stamped by confirmWalkExtension), not just the
      // date — a calendar date can cycle through extend -> drop -> re-add ->
      // re-extend -> drop more than once while it's still reachable here,
      // and each cycle is a genuinely distinct paid extension with its own
      // Stripe PaymentIntent. Keying on date alone would make the SECOND
      // cycle's credit collide with (and silently no-op against) the
      // FIRST's already-issued record. Falls back to the walk's own
      // createdAt (also changes every regeneration cycle) only if
      // extensionChargeId is somehow missing — see the comment where it's
      // stamped for when that can happen. Either way, this is a permanent,
      // safe-to-retry idempotency key: a retried call that already claimed
      // this credit record (tx.create() below) skips straight to checking
      // its status rather than issuing a second Stripe credit.
      const snap = snapshotByDate.get(r.date);
      const keyPart = snap?.extensionChargeId || `c${snap?.createdAtMs || 0}`;
      const creditRef = db.collection('walkExtensionCredits').doc(`${uid}_${r.date}_${keyPart}`);
      let claimed = true;
      try {
        await db.runTransaction(async (tx) => {
          const existing = await tx.get(creditRef);
          if (existing.exists) throw new Error('already-claimed');
          tx.create(creditRef, {
            memberId: uid,
            date: r.date,
            amount: WALK_EXTENSION_PRICE,
            chargeId: snap?.extensionChargeId || null,
            reason: 'schedule_change_orphan',
            status: 'pending',
            createdAt: FieldValue.serverTimestamp(),
          });
        });
      } catch (e) {
        claimed = false;
      }
      if (!claimed) {
        const existing = (await creditRef.get()).data() || {};
        if (existing.status === 'issued') {
          creditResults.push({ ...r, status: 'issued' });
          continue;
        }
        // status is 'pending' or 'failed' from an earlier attempt — fall
        // through and retry issuing it below, same record, no re-claim needed.
      }
      if (!stripeCustomerId) {
        await creditRef.set({ status: 'failed', error: 'No stripeCustomerId on file', failedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
        creditResults.push({ ...r, status: 'failed', error: 'no-stripe-customer' });
        continue;
      }
      try {
        const bt = await issueStripeBalanceCredit(
          stripe, stripeCustomerId, Math.round(WALK_EXTENSION_PRICE * 100),
          `Port City Leash Club walk extension credit — schedule change (${r.date})`
        );
        await creditRef.set({ status: 'issued', stripeBalanceTransactionId: bt.id, issuedAt: FieldValue.serverTimestamp() }, { merge: true });
        creditResults.push({ ...r, status: 'issued' });
      } catch (e) {
        console.error(`updateWalkSchedule: extension credit failed for member ${uid} date ${r.date}:`, e.message);
        await creditRef.set({ status: 'failed', error: e.message, failedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
        await billingRef(uid).set({ needsReview: true, needsReviewReason: 'walk_extension_credit_failed' }, { merge: true }).catch(() => {});
        creditResults.push({ ...r, status: 'failed', error: e.message });
      }
    }
  }

  // Scrub stale walkIds out of any still-pending walk_extension submission
  // that named a date we just dropped for free (unpaid, so nothing to
  // credit — see droppedPendingDates above).
  if (droppedPendingDates.length) {
    const staleWalkIds = new Set(droppedPendingDates.map(s => s.docId));
    try {
      const pendingExtSnap = await db.collection('submissions')
        .where('memberId', '==', uid)
        .where('type', '==', 'walk_extension')
        .where('status', '==', 'pending')
        .get();
      for (const doc of pendingExtSnap.docs) {
        const sub = doc.data();
        const walkIds = Array.isArray(sub.walkIds) ? sub.walkIds : [];
        const kept = walkIds.filter(id => !staleWalkIds.has(id));
        if (kept.length === walkIds.length) continue; // nothing stale in this one
        if (kept.length === 0) {
          await doc.ref.update({ status: 'stale', walkIds: kept, count: 0 });
        } else {
          await doc.ref.update({ walkIds: kept, count: kept.length, estimatedTotal: calculateWalkExtensionTotal(kept.length) });
        }
      }
    } catch (e) {
      console.error(`updateWalkSchedule: failed to scrub stale walk_extension submissions for member ${uid}:`, e.message);
    }
  }

  // Admin-visible record of what happened — mirrors pause_membership's
  // informational-record pattern. Only written when there was something to
  // resolve; a plain day/time-slot change writes nothing here, same as today.
  const failedCredits = creditResults.filter(c => c.status === 'failed');
  if (validatedResolutions.length) {
    const needsManualHandling = failedMoves.length > 0 || failedCredits.length > 0;
    try {
      await db.collection('submissions').add({
        type: 'walk_extension_reassignment',
        memberId: uid,
        memberName: member.name || '',
        status: needsManualHandling ? 'pending' : 'applied',
        read: false,
        resolutions: validatedResolutions.map(r => ({ date: r.date, action: r.action, targetDate: r.targetDate || null })),
        failedMoves: failedMoves.map(r => r.date),
        failedCredits: failedCredits.map(c => ({ date: c.date, error: c.error })),
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error(`updateWalkSchedule: failed to write the schedule-change record for member ${uid}:`, e.message);
    }
  }

  return { success: true, message: 'Walk schedule updated', resolutions: validatedResolutions };
});

// Today's calendar date in Eastern time, as UTC-style components.
//
// Deliberately not `new Date().getUTCDate()`: after 8pm ET the UTC date is
// already tomorrow, so a member converted on a July evening would have their
// partial month computed against July 21 when it's still July 20 locally.
// Every other date in this system is a local calendar date, so this one has
// to be too.
function easternTodayParts() {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number);
  return { year, monthIndex: month - 1, day };
}

// ─────────────────────────────────────────────────────────────────────────
// 3b-ii. Charge for the remainder of the CURRENT month at conversion.
//
//    The subscription's first invoice is the 1st of next month, so without
//    this a member converting mid-month gets no walks and no charge for the
//    rest of the month they actually signed up in — and converting ON the 1st
//    means a whole free month. This generates the remaining walks and charges
//    for exactly those walks, once.
//
//    Deliberately a separate call from createMembershipSubscription and
//    generateInitialWalks, same as those two are from each other: this is the
//    only code path in the app that charges a card without an admin clicking
//    a charge button, so it must not be able to take the conversion down
//    with it.
//
//    Extracted to a plain function for the same reason as
//    runCreateMembershipSubscription above — finalizeSubmissionIfReady has
//    no request.auth to hand an onCall function. Already read
//    stripeCustomerId from the billing subdoc, not the submission — no
//    repoint needed here, unlike createMembershipSubscription/
//    chargeCustomerCard.
// ─────────────────────────────────────────────────────────────────────────
async function runChargeCurrentMonthWalks(memberId) {
  const memberRef = db.collection('members').doc(memberId);
  const billing = billingRef(memberId);
  // Dual-read: member doc (tier, schedule, membershipStartDate) + billing
  // subdoc (currentMonthCharge idempotency guard, stripeCustomerId). Both are
  // needed before we can decide whether to charge.
  const [memberDoc, billingDoc] = await Promise.all([memberRef.get(), billing.get()]);
  const member = memberDoc.data();
  if (!member) throw new HttpsError('not-found', 'Member record not found.');
  const billingData = billingDoc.data() || {};

  // resolveMemberPriceId throws for anything that isn't 'Member'/'Travel'.
  // Nothing has been written yet at this point — the idempotency guard, walk
  // generation, and the charge itself all come after — so propagating that
  // throw is safe.
  const priceId = resolveMemberPriceId(member.tier);
  if (!priceId) {
    return { success: true, skipped: true, reason: 'no-subscription-tier', tier: member.tier || null };
  }

  const { year, monthIndex, day: todayDay } = easternTodayParts();
  const periodKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

  // Idempotency guard #1: never charge the same member twice for the same
  // month, however this call is retried (double-click, retry after a partial
  // failure, an admin re-running it). currentMonthCharge lives in the billing subdoc.
  const currentMonthCharge = billingData.currentMonthCharge;
  if (currentMonthCharge && currentMonthCharge.periodKey === periodKey
      && currentMonthCharge.status === 'charged') {
    return {
      success: true, alreadyCharged: true, periodKey,
      walkCount: currentMonthCharge.walkCount || 0,
      amount: currentMonthCharge.amount || 0,
    };
  }

  // Earliest billable day is tomorrow — walks can't be scheduled into the
  // past, and nothing in this system is scheduled same-day (the meet & greet
  // calendar applies the same rule).
  const tomorrow = new Date(Date.UTC(year, monthIndex, todayDay + 1));
  if (tomorrow.getUTCFullYear() !== year || tomorrow.getUTCMonth() !== monthIndex) {
    return { success: true, skipped: true, reason: 'month-already-over', periodKey };
  }
  let fromDay = tomorrow.getUTCDate();

  // A start date later than this month means there's nothing to bill now —
  // the subscription's first invoice already covers it.
  const start = toDateOrNull(member.membershipStartDate);
  if (start) {
    const startsLaterMonth = start.getUTCFullYear() > year
      || (start.getUTCFullYear() === year && start.getUTCMonth() > monthIndex);
    if (startsLaterMonth) {
      return { success: true, skipped: true, reason: 'starts-next-month', periodKey };
    }
    if (start.getUTCFullYear() === year && start.getUTCMonth() === monthIndex) {
      fromDay = Math.max(fromDay, start.getUTCDate());
    }
  }

  const days = datesMatchingWeekdaysInMonth(member.defaultWalkDays, year, monthIndex, fromDay);
  if (!days.length) {
    await billing.set({
      currentMonthCharge: { periodKey, walkCount: 0, amount: 0, status: 'skipped', reason: 'no-walks-remaining' },
    }, { merge: true });
    return { success: true, skipped: true, reason: 'no-walks-remaining', periodKey, fromDay };
  }

  // Generate the walks BEFORE charging: charging for walks that then fail to
  // appear is the one outcome worth avoiding outright. If they can't be
  // generated, nothing is charged.
  const walkResult = await generateWalksForMember(memberId, member, year, monthIndex, fromDay);
  if (walkResult.blocked) {
    throw new HttpsError('failed-precondition', 'This member has no preferred time slot set — set defaultTimeSlot before charging for this month.');
  }
  if (walkResult.failed > 0) {
    throw new HttpsError('internal', `${walkResult.failed} of ${walkResult.created + walkResult.failed} walk(s) failed to generate — nothing was charged.`);
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  if (!billingData.stripeCustomerId) {
    throw new HttpsError('failed-precondition', 'No Stripe customer on this member — start the membership subscription first.');
  }
  const paymentMethods = await stripe.paymentMethods.list({ customer: billingData.stripeCustomerId, type: 'card' });
  if (!paymentMethods.data.length) {
    throw new HttpsError('failed-precondition', 'Customer has no saved payment method.');
  }

  // Per-walk rate comes from the tier's Stripe Price, never a hardcoded
  // number — same source the subscription bills against.
  const price = await stripe.prices.retrieve(priceId);
  const unitAmount = price.unit_amount || 0;
  const amountInCents = unitAmount * days.length;
  if (amountInCents <= 0) {
    throw new HttpsError('failed-precondition', `Price ${priceId} has no unit_amount — cannot charge for this month.`);
  }

  // New-member referral discount is deliberately NEVER applied to this
  // charge — a decision, not an oversight. It's applied instead by
  // runFirstPaymentReferralCredit, on the subscription's first FULL-MONTH
  // invoice, via the invoice.paid webhook. Why: this charge is prorated to
  // whatever walk days remain in the signup month, which can be as low as a
  // single walk — $27 at this tier's per-walk rate. Against that, the
  // existing 50%-of-this-charge cap (see resolveNewMemberReferralDiscount)
  // would bind hard and forfeit most of a $50 credit, with no carry-forward
  // to make up the difference later. A full month is at least $108, so the
  // same cap never binds there and the member always receives the full
  // credit instead. referralDiscount/discountCents stay fixed at
  // null/0 — not deleted outright, since chargeAmountInCents and the
  // currentMonthCharge/return-value guards below all still read them by
  // name; restructuring those wasn't part of this change.
  //
  // CRITICAL OPERATIONAL DEPENDENCY: this only works because
  // runFirstPaymentReferralCredit is reachable at all, which requires
  // invoice.paid to be an enabled event on the Stripe Dashboard's webhook
  // endpoint (Developers → Webhooks). If that event is ever removed,
  // membership referral credits stop being applied ANYWHERE, for ANY
  // member, silently — no error, no needsReview flag, nothing to notice
  // until someone asks why their referral credit never showed up.
  const referralDiscount = null;
  const discountCents = 0;
  const chargeAmountInCents = amountInCents - discountCents;

  const monthName = new Date(Date.UTC(year, monthIndex, 1))
    .toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const description = `Port City Leash Club - ${member.tier} Membership (${monthName} ${days[0]}-${days[days.length - 1]}, ${days.length} walk${days.length === 1 ? '' : 's'})`;

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: chargeAmountInCents,
      currency: price.currency || 'usd',
      customer: billingData.stripeCustomerId,
      payment_method: paymentMethods.data[0].id,
      off_session: true,
      confirm: true,
      description,
      metadata: { memberId, periodKey, walkCount: String(days.length) },
    }, {
      // Idempotency guard #2, at Stripe itself: a retry that gets past the
      // Firestore guard above (e.g. two clicks racing before the first write
      // lands) resolves to the same PaymentIntent rather than a second charge.
      idempotencyKey: `current-month-walks:${memberId}:${periodKey}`,
    });
  } catch (e) {
    await billing.set({
      currentMonthCharge: {
        periodKey, walkCount: days.length, amount: chargeAmountInCents / 100,
        status: 'failed', reason: e.message, failedAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true }).catch(() => {});
    // isChargeFailure marked HERE, at the one point in this function where a
    // real Stripe charge attempt actually failed — not by a wrapper further
    // up the call stack that can't tell this apart from the five
    // precondition throws above (no time slot, walk generation failed, no
    // Stripe customer, no payment method, no unit_amount), none of which
    // ever reach Stripe or write a currentMonthCharge record at all. Marking
    // here, at the source, guarantees the two travel together: any caller
    // that sees isChargeFailure can rely on amount/failedAt having just been
    // written above in this same catch, not merely "usually" written by
    // some other path. See finalizeSubmissionIfReady's outer catch for where
    // this becomes finalizeErrorKind:'charge_failed', and
    // retryFinalizeSubmission for why that distinction (real money attempted
    // vs. a precondition that was never going to touch Stripe) has to be
    // exact, not approximate.
    const chargeError = new HttpsError('internal', `Card charge for this month failed: ${e.message}`);
    chargeError.isChargeFailure = true;
    throw chargeError;
  }

  await billing.set({
    currentMonthCharge: {
      periodKey, walkCount: days.length, amount: chargeAmountInCents / 100,
      status: 'charged', paymentIntentId: paymentIntent.id,
      chargedAt: FieldValue.serverTimestamp(),
      ...(discountCents > 0 ? { referralDiscountApplied: discountCents / 100 } : {}),
    },
  }, { merge: true });

  // Unreachable from this function — referralDiscount is permanently null
  // (see the comment where it's declared above), so this block can never
  // run here. Retained rather than deleted so this function's shape stays
  // parallel with chargeCustomerCard, which still resolves and applies its
  // own new-member discount and still calls finalizeNewMemberReferralDiscount
  // through this exact same guard — a reader comparing the two sees the
  // same structure in both, with only the one declaration above explaining
  // why this copy never fires, rather than this function silently missing a
  // block chargeCustomerCard still has.
  if (referralDiscount) {
    await finalizeNewMemberReferralDiscount(stripe, memberId, billingData.referralSubmissionId || null, referralDiscount, discountCents);
  }

  return {
    success: true, periodKey, walkCount: days.length,
    amount: chargeAmountInCents / 100, fromDay, dates: days,
    paymentIntentId: paymentIntent.id,
    ...(discountCents > 0 ? { referralDiscountApplied: discountCents / 100 } : {}),
  };
}

exports.chargeCurrentMonthWalks = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { memberId } = request.data || {};
  if (!memberId) throw new HttpsError('invalid-argument', 'memberId is required.');
  return runChargeCurrentMonthWalks(memberId);
});

// previewChargeCurrentMonthWalks: read-only counterpart to
// chargeCurrentMonthWalks, for the admin dashboard's "Charge Current Month
// Walks" button (member detail modal) — lets an admin see the walk count,
// date range, and dollar amount BEFORE committing to a real charge, and
// says plainly if this member has already been charged for the current
// period so a second click doesn't double-charge someone.
//
// Deliberately NOT a refactor of runChargeCurrentMonthWalks into a shared
// helper — that function moves real money and writes real walk docs, and
// bending its guard order to also serve a preview isn't worth the risk to
// the thing that already works. Instead this mirrors the SAME guard order
// (idempotency check, month-already-over, starts-next-month,
// no-walks-remaining, no-time-slot, no-stripe-customer, no-payment-method)
// using the same pure helpers (datesMatchingWeekdaysInMonth,
// resolveMemberPriceId, easternTodayParts, toDateOrNull), but never calls
// generateWalksForMember or paymentIntents.create — nothing here writes
// anything. If runChargeCurrentMonthWalks's guard order or reasons ever
// change, update this to match, or the preview will start lying.
exports.previewChargeCurrentMonthWalks = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const { memberId } = request.data || {};
  if (!memberId) throw new HttpsError('invalid-argument', 'memberId is required.');

  const memberRef = db.collection('members').doc(memberId);
  const billing = billingRef(memberId);
  const [memberDoc, billingDoc] = await Promise.all([memberRef.get(), billing.get()]);
  const member = memberDoc.data();
  if (!member) throw new HttpsError('not-found', 'Member record not found.');
  const billingData = billingDoc.data() || {};

  const priceId = resolveMemberPriceId(member.tier);
  if (!priceId) {
    return { ready: false, reason: 'no-subscription-tier', tier: member.tier || null };
  }

  const { year, monthIndex, day: todayDay } = easternTodayParts();
  const periodKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

  const currentMonthCharge = billingData.currentMonthCharge;
  if (currentMonthCharge && currentMonthCharge.periodKey === periodKey
      && currentMonthCharge.status === 'charged') {
    return {
      ready: false, reason: 'already-charged', periodKey,
      walkCount: currentMonthCharge.walkCount || 0,
      amount: currentMonthCharge.amount || 0,
      chargedAt: currentMonthCharge.chargedAt?.toDate?.().toISOString() || null,
      paymentIntentId: currentMonthCharge.paymentIntentId || null,
    };
  }

  const tomorrow = new Date(Date.UTC(year, monthIndex, todayDay + 1));
  if (tomorrow.getUTCFullYear() !== year || tomorrow.getUTCMonth() !== monthIndex) {
    return { ready: false, reason: 'month-already-over', periodKey };
  }
  let fromDay = tomorrow.getUTCDate();

  const start = toDateOrNull(member.membershipStartDate);
  if (start) {
    const startsLaterMonth = start.getUTCFullYear() > year
      || (start.getUTCFullYear() === year && start.getUTCMonth() > monthIndex);
    if (startsLaterMonth) {
      return { ready: false, reason: 'starts-next-month', periodKey };
    }
    if (start.getUTCFullYear() === year && start.getUTCMonth() === monthIndex) {
      fromDay = Math.max(fromDay, start.getUTCDate());
    }
  }

  const days = datesMatchingWeekdaysInMonth(member.defaultWalkDays, year, monthIndex, fromDay);
  if (!days.length) {
    return { ready: false, reason: 'no-walks-remaining', periodKey, fromDay };
  }

  if (!member.defaultTimeSlot) {
    return { ready: false, reason: 'no-time-slot', periodKey, walkCount: days.length };
  }

  if (!billingData.stripeCustomerId) {
    return { ready: false, reason: 'no-stripe-customer', periodKey, walkCount: days.length };
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const paymentMethods = await stripe.paymentMethods.list({ customer: billingData.stripeCustomerId, type: 'card' });
  if (!paymentMethods.data.length) {
    return { ready: false, reason: 'no-payment-method', periodKey, walkCount: days.length };
  }

  // Read-only price lookup — same call runChargeCurrentMonthWalks makes
  // before charging, safe to repeat here since it never mutates anything.
  const price = await stripe.prices.retrieve(priceId);
  const unitAmount = price.unit_amount || 0;
  const monthName = new Date(Date.UTC(year, monthIndex, 1))
    .toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });

  return {
    ready: true, periodKey, walkCount: days.length,
    startDay: days[0], endDay: days[days.length - 1], monthName,
    amount: (unitAmount * days.length) / 100, currency: price.currency || 'usd',
  };
});

// ─────────────────────────────────────────────────────────────────────────
// 3c. Recalculate every active member's walk-day count for the month that's
//    just starting and push it to their Stripe subscription item. Runs at
//    12:05 AM ET on the 1st — ~18 hours before Stripe actually generates
//    that month's invoice, at the 6:00 PM ET billing_cycle_anchor set in
//    createMembershipSubscription.
// ─────────────────────────────────────────────────────────────────────────
exports.syncMonthlyWalkQuantities = onSchedule({
  schedule: '5 0 1 * *',
  timeZone: 'America/New_York',
  secrets: [STRIPE_SECRET_KEY],
}, async () => {
  const stripe = stripeClient(STRIPE_SECRET_KEY.value());

  // "Now" already IS the 1st of the billed month at this point — unlike
  // the old few-days-early schedule, there's no "next month" to look ahead
  // to anymore.
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const membersSnap = await db.collection('members').where('status', '==', 'active').get();

  for (const memberDoc of membersSnap.docs) {
    const member = memberDoc.data();
    if (!member.hasActiveSubscription) continue; // Travel-tier / one-time clients

    // The Stripe subscription-item id now lives in the billing subdoc.
    const billingData = (await billingRef(memberDoc.id).get()).data() || {};
    if (!billingData.stripeSubscriptionItemId) continue; // flag set but subdoc absent — skip, don't throw

    // A member starting partway through THIS month is billed only from
    // their start date; every later month bills in full (membershipStartDate
    // is then in the past, so fromDay falls back to 1).
    const fromDay = firstBilledMonthFromDay(member.membershipStartDate, year, month);
    const quantity = countWalkDaysInMonth(member.defaultWalkDays, year, month, fromDay);
    try {
      await stripe.subscriptionItems.update(billingData.stripeSubscriptionItemId, {
        quantity,
        proration_behavior: 'none',
      });
    } catch (e) {
      console.error(`Failed to sync walk quantity for member ${memberDoc.id}:`, e.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3d. Generate walk documents for every active member with a subscription,
//    one month ahead of the month that just started — this is what keeps
//    the rolling two-month window (current + next always generated) intact
//    going forward. Same schedule as syncMonthlyWalkQuantities, but a
//    separate function — a bug in walk generation can't take down the
//    Stripe quantity sync, or vice versa. syncMonthlyWalkQuantities and
//    resumePausedMemberships deliberately stay bound to the month that just
//    started (billing/reactivation, not schedule-visibility, concerns) —
//    only this function's target shifts.
// ─────────────────────────────────────────────────────────────────────────
exports.generateMonthlyWalks = onSchedule({
  schedule: '5 0 1 * *',
  timeZone: 'America/New_York',
}, async () => {
  // "Now" is the month that just started (this cron fires 5 minutes after
  // midnight ET on the 1st) — the target for generation is one month past
  // that, so next month is always generated a full month ahead of when it
  // starts, same as this month was.
  const now = new Date();
  const thisRunMonth = now.getUTCMonth();
  const thisRunYear = now.getUTCFullYear();
  const month = thisRunMonth === 11 ? 0 : thisRunMonth + 1;
  const year = thisRunMonth === 11 ? thisRunYear + 1 : thisRunYear;

  const membersSnap = await db.collection('members').where('status', '==', 'active').get();

  for (const memberDoc of membersSnap.docs) {
    const member = memberDoc.data();
    if (!member.hasActiveSubscription) continue; // Travel-tier / one-time clients

    // Same fromDay as syncMonthlyWalkQuantities computes for this member, so
    // the walks generated match the quantity billed. Passing 1 unconditionally
    // used to create a walk before a mid-month member's start date.
    const fromDay = firstBilledMonthFromDay(member.membershipStartDate, year, month);
    const result = await generateWalksForMember(memberDoc.id, member, year, month, fromDay);
    if (result.blocked) {
      console.error(`generateMonthlyWalks: member ${memberDoc.id} has no defaultTimeSlot — skipped`);
    } else if (result.failed > 0) {
      console.error(`generateMonthlyWalks: member ${memberDoc.id} had ${result.failed} failed walk(s)`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3d-backfill. One-time cutover helper for the rolling two-month window
// above: generates NEXT month for every currently active, subscribed
// member, using the exact same selection/generation logic
// generateMonthlyWalks uses every month — not a special-cased alternate
// path, just that same logic invoked once, by hand, ahead of its next
// scheduled run. Safe to run more than once: generateWalksForMember's doc
// IDs are deterministic (memberId_date) and it creates with .create(),
// which throws ALREADY_EXISTS (caught, counted as skipped, never
// overwrites) for anything already there — the same guarantee every other
// caller (generateMonthlyWalks, generateInitialWalks, chargeCurrentMonthWalks,
// updateWalkSchedule) already relies on.
//
// dryRun:true computes and returns what WOULD be created/skipped/blocked
// without writing anything — mirrors generateWalksForMember's own decision
// logic (has a defaultTimeSlot? which dates match defaultWalkDays?) plus an
// existence check per candidate date, but never calls .create().
// ─────────────────────────────────────────────────────────────────────────
exports.backfillNextMonthWalks = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);
  const dryRun = !!(request.data && request.data.dryRun);

  const { year: todayYear, monthIndex: todayMonthIndex } = easternTodayParts();
  const nextMonthIndex = todayMonthIndex === 11 ? 0 : todayMonthIndex + 1;
  const nextYear = todayMonthIndex === 11 ? todayYear + 1 : todayYear;

  const membersSnap = await db.collection('members').where('status', '==', 'active').get();

  const perMember = [];
  let totalCreated = 0, totalSkipped = 0, totalFailed = 0, totalBlocked = 0;

  for (const memberDoc of membersSnap.docs) {
    const member = memberDoc.data();
    if (!member.hasActiveSubscription) continue; // Travel-tier / one-time clients — same filter generateMonthlyWalks uses

    const fromDay = firstBilledMonthFromDay(member.membershipStartDate, nextYear, nextMonthIndex);

    if (dryRun) {
      if (!member.defaultTimeSlot) {
        perMember.push({ memberId: memberDoc.id, wouldCreate: 0, alreadyExists: 0, blocked: 'no-time-slot' });
        totalBlocked++;
        continue;
      }
      const days = datesMatchingWeekdaysInMonth(member.defaultWalkDays, nextYear, nextMonthIndex, fromDay);
      let wouldCreate = 0, alreadyExists = 0;
      for (const day of days) {
        const dateStr = `${nextYear}-${String(nextMonthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const exists = (await db.collection('walks').doc(`${memberDoc.id}_${dateStr}`).get()).exists;
        if (exists) alreadyExists++; else wouldCreate++;
      }
      perMember.push({ memberId: memberDoc.id, wouldCreate, alreadyExists, blocked: null });
      totalCreated += wouldCreate;
      totalSkipped += alreadyExists;
    } else {
      const result = await generateWalksForMember(memberDoc.id, member, nextYear, nextMonthIndex, fromDay);
      perMember.push({ memberId: memberDoc.id, created: result.created, skipped: result.skipped, failed: result.failed, blocked: result.blocked });
      totalCreated += result.created;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      if (result.blocked) totalBlocked++;
    }
  }

  return {
    success: true,
    dryRun,
    targetMonth: `${nextYear}-${String(nextMonthIndex + 1).padStart(2, '0')}`,
    memberCount: perMember.length,
    totals: { created: totalCreated, skipped: totalSkipped, failed: totalFailed, blocked: totalBlocked },
    perMember,
  };
});

// ─────────────────────────────────────────────────────────────────────────
// 3e. Resume memberships whose pause window has ended. Runs daily — doesn't
//    need to be precise-to-the-minute — at midnight ET, 5 minutes before
//    the monthly jobs above, so a hold ending on the 1st is reactivated in
//    time to be picked up by that same morning's run. Backfills the rest
//    of the resume month directly (generateMonthlyWalks already covers
//    next month and beyond from its normal run).
// ─────────────────────────────────────────────────────────────────────────
exports.resumePausedMemberships = onSchedule({
  schedule: '0 0 * * *',
  timeZone: 'America/New_York',
  secrets: [RESEND_API_KEY],
}, async () => {
  const now = new Date();

  // Filtered in JS after a single equality query rather than a Firestore
  // range filter on pauseEndDate, to avoid needing a composite index —
  // same approach syncMonthlyWalkQuantities already uses for its own
  // date-window logic. Trivial at this business's scale.
  const pausedSnap = await db.collection('members').where('status', '==', 'paused').get();

  for (const memberDoc of pausedSnap.docs) {
    const member = memberDoc.data();
    const endDate = member.pauseEndDate?.toDate?.();
    if (!endDate || endDate > now) continue;

    await memberDoc.ref.update({ status: 'active' });

    // Admin push notification — the pause side of a hold at least leaves an
    // unread submissions row (see submitVacationHold's own 'vacation-hold'
    // email); the resume side had NO admin-visible signal at all before this.
    // Both manual-Stripe follow-ups this email prompts (clearing
    // pause_collection, running chargeCurrentMonthWalks) apply whether or not
    // this member has a subscription to resume walks for, so this fires
    // unconditionally, ahead of the hasActiveSubscription check below.
    //
    // endedMidMonth: true whenever the hold's end date isn't the last day of
    // its month, on the business's own America/New_York calendar (not
    // endDate's raw UTC calendar date — see easternDateParts). syncMonthlyWalkQuantities
    // only resyncs quantity on the 1st, so a mid-month resume leaves real,
    // already-walked days this month that no automated job will bill —
    // chargeCurrentMonthWalks is the existing manual tool for exactly that gap.
    const { year: endYear, monthIndex: endMonthIndex, day: endDay } = easternDateParts(endDate);
    const lastDayOfEndMonth = new Date(Date.UTC(endYear, endMonthIndex + 1, 0)).getUTCDate();
    const endedMidMonth = endDay < lastDayOfEndMonth;

    // sendEmail never throws (see functions/lib/email.js) and this runs
    // after the status flip above has already committed, so a failed send
    // has nothing left to roll back — same reasoning as onBillingNeedsReview.
    await sendEmail({
      to: ADMIN_EMAIL,
      template: 'vacation-hold-resumed',
      data: {
        memberName: member.name || '',
        memberId: memberDoc.id,
        startDateStr: member.pauseStartDate?.toDate ? isoDateStr(member.pauseStartDate.toDate()) : null,
        endDateStr: isoDateStr(endDate),
        endedMidMonth,
      },
      idempotencyKey: `vacation-hold-resumed:${memberDoc.id}:${isoDateStr(endDate)}`,
    });

    // Option 1 flag semantics: a paused subscribed member still has
    // hasActiveSubscription === true (pause is expressed by status alone), so
    // this correctly proceeds to regenerate their walks on resume.
    if (!member.hasActiveSubscription) continue; // Travel-tier/no subscription — nothing to generate

    const result = await generateWalksForMember(
      memberDoc.id, { ...member, status: 'active' },
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    );
    if (result.blocked) {
      console.error(`resumePausedMemberships: member ${memberDoc.id} has no defaultTimeSlot — skipped supplemental generation`);
    } else if (result.failed > 0) {
      console.error(`resumePausedMemberships: member ${memberDoc.id} had ${result.failed} failed walk(s) in supplemental generation`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VACATION HOLD — self-service, no admin approval gate (per business
// decision, July 2026; no policy-limit enforcement yet either — that's a
// deliberate later addition, not an oversight here). First member-facing
// (non-admin) callable in this app, and the first code in this file that
// issues a Stripe refund.
// ═══════════════════════════════════════════════════════════════════════════

// Called by portal-pause-membership.html instead of writing to Firestore
// directly — the old direct-write version silently corrupted pauseEndDate
// on bad input (see investigation notes) and never cleaned up already-
// generated walks in the hold window. This does both in one place:
//   1. Validates real dates, end after start.
//   2. Pauses the member and deletes already-generated walk docs inside
//      the hold window, atomically (one batch — never leaves the member
//      paused with stale walks still sitting there, or vice versa).
//   3. If any of those deleted walks were in the CURRENT, already-billed
//      calendar month, flags a suggested refund for admin review — never
//      auto-refunds.
exports.submitVacationHold = onCall({ secrets: [STRIPE_SECRET_KEY, RESEND_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const memberId = request.auth.uid;

  const { pauseStartDate, pauseEndDate } = request.data || {};
  const startDate = parseIsoDateStrict(pauseStartDate);
  const endDate = parseIsoDateStrict(pauseEndDate);
  if (!startDate || !endDate) {
    throw new HttpsError('invalid-argument', 'pauseStartDate and pauseEndDate must be valid dates in YYYY-MM-DD format.');
  }
  if (endDate <= startDate) {
    throw new HttpsError('invalid-argument', 'pauseEndDate must be after pauseStartDate.');
  }

  const memberRef = db.collection('members').doc(memberId);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError('not-found', 'Member record not found.');
  }
  const member = memberSnap.data();
  // Billing fields (for the refund suggestion below) now live in the subdoc.
  // Pause does NOT touch hasActiveSubscription — status:'paused' alone expresses
  // the hold (Option 1 flag semantics), so the flag stays accurate for resume.
  const billingData = (await billingRef(memberId).get()).data() || {};

  // Single equality query on memberId (auto-indexed, no composite index
  // needed) rather than looking up specific deterministic IDs — the old
  // approach (walkDocIdsInRange, computing ${memberId}_${dateStr} from
  // defaultWalkDays) only ever found walks generateWalksForMember created,
  // silently missing any walk added manually via the admin "Add Walk"
  // modal (random addDoc IDs). Querying by memberId and filtering the
  // status/date window in JS — same pattern resumePausedMemberships
  // already uses for the same reason — finds every scheduled walk that
  // actually exists in the window, regardless of how it was created.
  const memberWalksSnap = await db.collection('walks').where('memberId', '==', memberId).get();

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth();

  const batch = db.batch();
  batch.update(memberRef, {
    status: 'paused',
    pauseStartDate: Timestamp.fromDate(startDate),
    pauseEndDate: Timestamp.fromDate(endDate),
  });

  let cancelledCount = 0;
  let currentPeriodCount = 0;
  const currentPeriodDates = [];

  memberWalksSnap.forEach(snap => {
    const walk = snap.data();
    if (walk.status === 'completed') return; // never touch history
    const walkDate = walk.date?.toDate?.();
    if (!walkDate || walkDate < startDate || walkDate > endDate) return; // outside the hold window
    batch.delete(snap.ref);
    cancelledCount++;
    if (walkDate.getUTCFullYear() === currentYear && walkDate.getUTCMonth() === currentMonth) {
      currentPeriodCount++;
      const dateStr = `${walkDate.getUTCFullYear()}-${String(walkDate.getUTCMonth() + 1).padStart(2, '0')}-${String(walkDate.getUTCDate()).padStart(2, '0')}`;
      currentPeriodDates.push(dateStr);
    }
  });

  await batch.commit();

  // Suggest a refund only if some of the cancelled walks were already part
  // of a month that's been synced/billed to Stripe, and only if this member
  // actually has an active subscription (Travel-tier/no-subscription
  // members have nothing to refund). Never auto-refunds — this only ever
  // creates a submission for admin to review.
  let suggestedRefundAmount = 0;
  if (currentPeriodCount > 0 && billingData.stripeSubscriptionItemId && billingData.stripeSubscriptionId) {
    // Unlike createMembershipSubscription/chargeCurrentMonthWalks, this runs
    // AFTER the pause/cancellation batch above has already committed — a
    // throw here can't be undone and would show a real member a false error
    // on a hold that actually succeeded. So an unresolvable tier is caught
    // rather than propagated: logged loudly, AND left as an admin-visible
    // submissions entry (same visibility goal as the billing.needsReview
    // flags used elsewhere) so it doesn't silently disappear into Cloud
    // Function logs nobody's watching. The hold itself is unaffected either
    // way — only the refund suggestion is skipped.
    let priceId = null;
    try {
      priceId = resolveMemberPriceId(member.tier);
    } catch (e) {
      console.error(`submitVacationHold: ${e.message} (member ${memberId}) — hold succeeded, refund suggestion skipped.`);
      await db.collection('submissions').add({
        type: 'vacation_hold_refund',
        memberId,
        memberName: member.name || '',
        status: 'needs_review',
        read: false,
        needsReviewReason: e.message,
        cancelledWalkCount: currentPeriodCount,
        cancelledWalkDates: currentPeriodDates,
        stripeCustomerId: billingData.stripeCustomerId || '',
        stripeSubscriptionId: billingData.stripeSubscriptionId || '',
        refundPeriodYear: currentYear,
        refundPeriodMonth: currentMonth,
        pauseStartDate: Timestamp.fromDate(startDate),
        pauseEndDate: Timestamp.fromDate(endDate),
        createdAt: FieldValue.serverTimestamp(),
      }).catch(writeErr => {
        console.error(`submitVacationHold: failed to write needs-review submission for ${memberId}:`, writeErr.message);
      });
    }
    if (priceId) {
      const stripe = stripeClient(STRIPE_SECRET_KEY.value());
      const price = await stripe.prices.retrieve(priceId);
      const perWalkRate = (price.unit_amount || 0) / 100;
      suggestedRefundAmount = Math.round(currentPeriodCount * perWalkRate * 100) / 100;

      await db.collection('submissions').add({
        type: 'vacation_hold_refund',
        memberId,
        memberName: member.name || '',
        status: 'pending',
        read: false,
        cancelledWalkCount: currentPeriodCount,
        cancelledWalkDates: currentPeriodDates,
        suggestedRefundAmount,
        stripeCustomerId: billingData.stripeCustomerId || '',
        stripeSubscriptionId: billingData.stripeSubscriptionId || '',
        refundPeriodYear: currentYear,
        refundPeriodMonth: currentMonth,
        pauseStartDate: Timestamp.fromDate(startDate),
        pauseEndDate: Timestamp.fromDate(endDate),
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }

  // Informational record only — already took effect above, nothing for
  // admin to approve/decline. status: 'applied' (not 'pending') so it
  // doesn't show up looking like it's awaiting action.
  await db.collection('submissions').add({
    type: 'pause_membership',
    memberId,
    memberName: member.name || '',
    pauseStartDate: Timestamp.fromDate(startDate),
    pauseEndDate: Timestamp.fromDate(endDate),
    status: 'applied',
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Admin push notification — the pause_membership submission above is
  // status: 'applied' (informational, not actionable) and only ever
  // surfaces as an unread badge in the dashboard's Requests tab, which
  // nobody sees until they happen to open it. This is the actual signal.
  // sendEmail never throws (see functions/lib/email.js) and this runs
  // after the hold has already committed above, so a failed send has
  // nothing left to roll back — same reasoning as onBillingNeedsReview.
  await sendEmail({
    to: ADMIN_EMAIL,
    template: 'vacation-hold',
    data: {
      memberName: member.name || '',
      memberId,
      startDateStr: isoDateStr(startDate),
      endDateStr: isoDateStr(endDate),
    },
    idempotencyKey: `vacation-hold:${memberId}:${isoDateStr(startDate)}`,
  });

  return { success: true, cancelledWalkCount: cancelledCount, suggestedRefundAmount };
});

// Admin-triggered — refunds part of an already-paid invoice for walks
// cancelled by a vacation hold. amountInDollars is always an admin-
// confirmed value (see confirmVacationHoldRefund in admin/dashboard.html),
// never the raw suggestedRefundAmount applied automatically.
//
// Double-refund guard: the status flip from 'pending' to 'processing'
// happens inside a Firestore transaction before any Stripe call. Firestore
// transactions serialize the read+write, so if "Confirm & Refund" is
// clicked twice (double-click, two admin tabs), only one call ever
// observes status === 'pending' — the other's transaction re-reads after
// the first commits and sees 'processing', so it throws instead of
// refunding twice. If the Stripe call itself fails after the claim
// succeeds, the status is reverted to 'pending' so admin can retry rather
// than the submission getting stuck forever.
exports.issueRefund = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);

  const { submissionId, amountInDollars, description } = request.data || {};
  if (!submissionId || !(amountInDollars > 0)) {
    throw new HttpsError('invalid-argument', 'submissionId and a positive amountInDollars are required.');
  }

  const subRef = db.collection('submissions').doc(submissionId);

  let sub;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(subRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Submission not found.');
    sub = snap.data();
    if (sub.status !== 'pending') {
      throw new HttpsError('failed-precondition', 'This refund has already been processed or declined.');
    }
    tx.update(subRef, { status: 'processing' });
  });

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());

  try {
    if (!sub.stripeSubscriptionId || sub.refundPeriodYear == null || sub.refundPeriodMonth == null) {
      throw new HttpsError('failed-precondition', 'This submission is missing subscription/period data needed to locate a charge.');
    }

    // Match the invoice by its billing period, not by recency — "most
    // recent paid invoice" would silently grab the WRONG invoice if admin
    // doesn't confirm this until after the next month's invoice has fired.
    // If nothing matches the stored period, this throws rather than
    // falling back to any other invoice.
    const periodStart = Math.floor(Date.UTC(sub.refundPeriodYear, sub.refundPeriodMonth, 1) / 1000);
    const periodEnd = Math.floor(Date.UTC(sub.refundPeriodYear, sub.refundPeriodMonth + 1, 1) / 1000);

    const invoices = await stripe.invoices.list({ subscription: sub.stripeSubscriptionId, status: 'paid', limit: 100 });
    const invoice = invoices.data.find(inv => inv.period_start >= periodStart && inv.period_start < periodEnd);

    if (!invoice) {
      throw new HttpsError(
        'failed-precondition',
        `No paid invoice found for this member's ${sub.refundPeriodMonth + 1}/${sub.refundPeriodYear} billing period on subscription ${sub.stripeSubscriptionId} — cannot determine which charge to refund. Refund manually in Stripe if the charge exists under a different period.`
      );
    }

    const chargeRef = invoice.payment_intent
      ? { payment_intent: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent.id }
      : invoice.charge
        ? { charge: typeof invoice.charge === 'string' ? invoice.charge : invoice.charge.id }
        : null;
    if (!chargeRef) {
      throw new HttpsError('failed-precondition', 'Matched invoice has no associated charge or payment intent to refund.');
    }

    const refund = await stripe.refunds.create({
      ...chargeRef,
      amount: Math.round(amountInDollars * 100),
      reason: 'requested_by_customer',
      metadata: { submissionId, description: description || 'Vacation hold refund' },
    });

    await subRef.update({
      status: 'confirmed',
      refundId: refund.id,
      refundedAmount: amountInDollars,
      refundedAt: FieldValue.serverTimestamp(),
    });

    return { success: true, refundId: refund.id };
  } catch (e) {
    await subRef.update({ status: 'pending' }).catch(() => {});
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3f. Stripe webhook — the ONLY place this system reacts to something Stripe
//    does on its own clock (automatic subscription renewal billing), rather
//    than in direct response to one of the onCall functions above. Scope is
//    deliberately minimal: exactly three events.
//      - invoice.payment_failed: FLAG only (billingStatus: 'past_due', plus
//        needsReview so onBillingNeedsReview actually emails admin — see that
//        trigger and functions/templates/billing-needs-review.js) — does NOT
//        stop walk generation. Both monthly crons run once a month, so the
//        exposure window is already bounded by that cadence; Stripe's own
//        retry schedule is what actually decides whether a decline resolves
//        itself, and re-implementing that logic here would be redundant at
//        best. This just gives admin visibility to act sooner than Stripe's
//        own timeline if they choose to.
//      - customer.subscription.deleted: Stripe's definitive final word
//        (fires only after retries are exhausted, or a manual cancel) — THIS
//        is what flips hasActiveSubscription: false, which both monthly
//        crons already gate walk generation on (see 3c/3d above).
//      - invoice.paid: triggers runFirstPaymentReferralCredit — see that
//        function. Usually a membership member's SECOND real payment, not
//        their first: their subscription's first Invoice isn't until the
//        1st of the month after signup, and chargeCurrentMonthWalks' one-off
//        charge for the remainder of their signup month (which now resolves
//        and applies the new member's own referral discount pre-charge —
//        see resolveNewMemberReferralDiscount) is what usually lands first
//        and claims that member's referralCreditChecked flag. This handler
//        is the fallback for the one case chargeCurrentMonthWalks can't
//        cover: a member who signs up with zero remaining walk days this
//        month skips that charge entirely, so THIS invoice really is their
//        first payment — and since Stripe has already finalized and paid it
//        by the time this fires, there's no pre-charge hook available, so
//        that member's credit still arrives as a balance credit rather than
//        an upfront discount — capped at 50% of that invoice's amount_paid,
//        same rule the pre-charge paths apply to their own first charge.
//        referralCreditChecked (not which event delivered it) is what
//        actually decides "first" either way.
//    Everything else — payment_succeeded logging, disputes, a real
//    cancellation flow, subscription.updated — is explicitly out of scope.
//
//    ⚠ DEPLOYMENT NOTE: as of the invoice.paid addition, confirm in the
//    Stripe Dashboard (Developers → Webhooks → this endpoint) that
//    invoice.paid is actually selected. It was NOT needed — and, per prior
//    setup notes, deliberately not enabled — for the original two-event
//    scope above. This code can't add it for you; nothing fires until the
//    Dashboard's event selection is updated to match.
// ─────────────────────────────────────────────────────────────────────────

// Resolves a Stripe customer ID back to a Firestore memberId. Firestore is
// checked FIRST: billing.stripeCustomerId is the original source of truth,
// written by createAuthenticatedSetupIntent when a member adds a card in
// the portal, well before any subscription exists, so querying it directly
// avoids a Stripe round-trip on every webhook delivery and doesn't depend
// on customer metadata being set. Falls
// back to Stripe customer metadata.memberId (set by createMembershipSubscription)
// only if the Firestore lookup comes up empty — covers the collection-group
// index not existing/still building, or a customer created before that
// metadata tagging existed.
async function findMemberIdByStripeCustomerId(stripe, customerId) {
  const snap = await db.collectionGroup('private')
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
  if (!snap.empty) {
    // Doc path is members/{memberId}/private/billing — memberId is two
    // segments up from the matched 'billing' doc.
    return snap.docs[0].ref.parent.parent.id;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return (customer && customer.metadata && customer.metadata.memberId) || null;
  } catch (e) {
    console.error(`findMemberIdByStripeCustomerId: Stripe lookup failed for ${customerId}:`, e.message);
    return null;
  }
}

// A single Stripe customer-balance credit — negative amount reduces what
// the customer owes, applied automatically to their next invoice with no
// separate "redeem" step on their end. Shared by issueReferralCredit below
// and updateWalkSchedule's extension-credit path, so there's one place that
// knows how a credit actually gets issued.
async function issueStripeBalanceCredit(stripe, stripeCustomerId, amountCents, description) {
  return stripe.customers.createBalanceTransaction(stripeCustomerId, {
    amount: -amountCents,
    currency: 'usd',
    description,
  });
}

// ── Referral credit issuance ────────────────────────────────────────────
// amountCents issued to a single member, via whichever mechanism matches
// their OWN tier — never the tier of whoever they were credited in relation
// to. A membership-tier referrer still gets their credit as a Stripe balance
// credit even when the new member they referred is Travel-tier, and vice
// versa. amountCents is REQUIRED — every caller now passes the actual code's
// entitlement (see resolveNewMemberReferralDiscount) explicitly rather than
// relying on an implicit $50 default, so a code with a different amount
// (e.g. the $20 email-capture offer) can never silently issue $50.
// Throws on failure (never swallows) — the caller (runFirstPaymentReferralCredit
// for the invoice.paid fallback's own capped credit and its referrer credit,
// finalizeNewMemberReferralDiscount for the pre-charge path's referrer
// credit) is what decides how a failure here affects creditIssued/redemption
// status.
async function issueReferralCredit(stripe, memberId, memberData, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`issueReferralCredit: amountCents must be a positive integer, got ${amountCents} for member ${memberId}.`);
  }
  const isMembershipTier = memberData.tier === 'Member';
  if (isMembershipTier) {
    const billingSnap = await billingRef(memberId).get();
    const stripeCustomerId = billingSnap.data()?.stripeCustomerId;
    if (!stripeCustomerId) {
      throw new Error(`Membership-tier member ${memberId} has no stripeCustomerId on file — cannot issue a Stripe balance credit.`);
    }
    await issueStripeBalanceCredit(stripe, stripeCustomerId, amountCents, `Port City Leash Club referral credit ($${(amountCents / 100).toFixed(2)})`);
  } else {
    // Travel-tier: no ongoing subscription for a Stripe balance credit to
    // apply against, so it accrues here instead and is applied as a
    // discount the next time chargeSavedCard charges this member (see
    // there for the apply/decrement logic). pendingReferralCredit is stored
    // in DOLLARS, not cents — same unit chargeSavedCard reads it back in.
    await billingRef(memberId).set({
      pendingReferralCredit: FieldValue.increment(amountCents / 100),
    }, { merge: true });
  }
}

// Shared expiry check for a referralCodes doc — the ONE place this logic
// lives, called identically from validateReferralCode (signup-time,
// client-facing pre-check) and resolveNewMemberReferralDiscount (charge-time
// resolution), so a code can never validate cleanly at signup and then fail
// at charge time (or vice versa) because the two checks drifted apart.
// codeData.expiresAt is optional — existing $50 partner/member-referral
// codes never set it and so never expire; only codes that set it (e.g. the
// $20 email-capture offer, at 90 days) are subject to this check at all.
function isReferralCodeExpired(codeData) {
  if (!codeData.expiresAt) return false;
  // expiresAt is only ever written by this codebase as a Firestore
  // Timestamp (Timestamp.fromMillis in runGenerateEmailCaptureCode) — but a
  // hand-edit via the console (a raw date/time picker, a pasted string) can
  // land something else entirely. This runs inside the charge path
  // (resolveNewMemberReferralDiscount) — a TypeError here would crash the
  // charge itself, not just skip the discount, so a malformed value must
  // degrade to "not expired" and get logged, never throw.
  if (typeof codeData.expiresAt.toMillis !== 'function') {
    console.warn(`isReferralCodeExpired: expiresAt is not a Firestore Timestamp (got ${typeof codeData.expiresAt}) — treating as not expired.`, codeData.expiresAt);
    return false;
  }
  return codeData.expiresAt.toMillis() < Date.now();
}

// Pure read: decides whether memberId's referral code entitles them to the
// new-member $50 discount, WITHOUT committing anything (no writes anywhere).
// Safe to call on every retry of a not-yet-charged attempt — the "this
// member's first-payment outcome is now decided" state is only ever
// committed afterward, by finalizeNewMemberReferralDiscount (the pre-charge
// callers, chargeCurrentMonthWalks/chargeSavedCard) or inline below in
// runFirstPaymentReferralCredit (stripeWebhook's invoice.paid, which has no
// pre-charge hook to use — see that function's own comment). Both paths
// share this exact lookup rather than each re-implementing it, so a
// self-referral or duplicate-partner-code case is judged identically no
// matter which path a given member's first payment happens to take.
//
// billingData/memberData are passed in rather than fetched here since every
// caller already has them in hand from its own dual-read.
async function resolveNewMemberReferralDiscount(memberId, billingData, memberData) {
  const referredByCode = billingData.referredByCode || null;
  const NONE = { referredByCode, decision: 'none', flagReason: null, discountCents: 0, isMemberReferral: false, referrerId: null };
  if (!referredByCode) return NONE;

  const codeSnap = await db.collection('referralCodes').doc(referredByCode).get();
  if (!codeSnap.exists || codeSnap.data().status !== 'active') {
    console.warn(`resolveNewMemberReferralDiscount: referredByCode ${referredByCode} not found or inactive for member ${memberId} — no discount.`);
    return NONE;
  }
  const codeData = codeSnap.data();
  if (isReferralCodeExpired(codeData)) {
    console.warn(`resolveNewMemberReferralDiscount: referredByCode ${referredByCode} expired for member ${memberId} — no discount.`);
    return NONE;
  }
  // Friends & Family codes don't participate in this decision at all — they
  // grant an ONGOING per-service percentage set once at signup (see
  // claimFriendsFamilyRedemption), not a one-time charge-time discount, and
  // must never stack with the $50 new-member discount or trigger a referrer
  // credit. Without this early return, a friends_family code would fall
  // through to the 'approved' path below and grant codeData.amountCents ??
  // 5000 (a flat $50) — friends_family docs never set amountCents, so that
  // fallback would silently apply. This single branch is what excludes
  // every issueReferralCredit/$50-discount trigger point at once
  // (chargeCustomerCard, runChargeCurrentMonthWalks, runFirstPaymentReferralCredit,
  // finalizeNewMemberReferralDiscount) — they all decide off this function's
  // return value, so there's no separate exclusion needed at each site.
  if (codeData.source === 'friends_family') {
    return NONE;
  }
  const isMemberReferral = codeData.source === 'member_referral' && !!codeData.referrerId;
  // Single-redemption codes: apartment/agent partner codes AND email_capture
  // codes are each generated for ONE specific lead/signup (partner:
  // runGenerateReferralCode; email_capture: runGenerateEmailCaptureCode) —
  // unlike a member's own evergreen code, which is designed to be shared
  // with and redeemed by many different friends. Grouped under one flag
  // since all three non-member_referral sources share this exact
  // reuse-prevention behavior; only member_referral is the deliberate
  // exception.
  const isSingleUseCode = codeData.source === 'apartment' || codeData.source === 'agent' || codeData.source === 'email_capture';

  // redeemedByMemberId is set once a single-use code's first successful
  // discount/credit lands; a SECOND, different member reaching this point
  // with the same code (photographed/shared physical card, a forwarded
  // email-capture code, genuine duplicate entry, etc.) gets flagged instead
  // of silently benefiting a second time.
  if (isSingleUseCode && codeData.creditIssued && codeData.redeemedByMemberId
      && codeData.redeemedByMemberId !== memberId) {
    console.warn(`resolveNewMemberReferralDiscount: single-use code ${referredByCode} (source: ${codeData.source}) was already redeemed by member ${codeData.redeemedByMemberId} — member ${memberId} flagged, no discount.`);
    return { referredByCode, decision: 'flagged', flagReason: 'single_use_code_already_redeemed', discountCents: 0, isMemberReferral, referrerId: null };
  }

  // Self-referral check: only meaningful for member_referral codes, which
  // have an actual referring member (referrerId) with their own phone
  // number to compare against. Partner (apartment/agent) codes have no
  // referrer, so there's nothing to self-refer.
  if (isMemberReferral) {
    const referrerSnap = await db.collection('members').doc(codeData.referrerId).get();
    const referrerData = referrerSnap.data();
    if (referrerData) {
      const newPhone = memberData.phoneDigits || normalizePhoneDigits(memberData.phone);
      const referrerPhone = referrerData.phoneDigits || normalizePhoneDigits(referrerData.phone);
      if (newPhone && referrerPhone && newPhone === referrerPhone) {
        console.warn(`resolveNewMemberReferralDiscount: possible self-referral — member ${memberId} and referrer ${codeData.referrerId} share phone digits ${newPhone}. Flagged, no discount.`);
        return { referredByCode, decision: 'flagged', flagReason: 'possible_self_referral', discountCents: 0, isMemberReferral, referrerId: codeData.referrerId };
      }
    }
  }

  return {
    referredByCode, decision: 'approved', flagReason: null,
    // codeData.amountCents is the code's own entitlement (e.g. 2000 for the
    // $20 email-capture offer). Existing partner/member-referral codes never
    // wrote this field, so they fall back to the original flat $50 — no
    // backfill needed, no source-to-amount branch here. Callers cap this
    // against their own charge amount (currently: never more than 50% of
    // that one charge).
    discountCents: codeData.amountCents ?? 5000,
    isMemberReferral, referrerId: isMemberReferral ? codeData.referrerId : null,
  };
}

// Post-charge commit for the pre-charge discount path (chargeCurrentMonthWalks,
// chargeSavedCard). The discount itself was already decided by
// resolveNewMemberReferralDiscount and subtracted from the charge BEFORE this
// runs — nothing here can undo that — so this only ever records what already
// happened and issues the referrer's own credit (member_referral codes only;
// the new member's own discount was already realized as the charge-time
// reduction, not a separate issuance here). The claim transaction below
// mirrors runFirstPaymentReferralCredit's, but happens here, post-charge,
// rather than pre-decision — the discount decision itself has to stay a
// repeatable, non-committing read (see resolveNewMemberReferralDiscount),
// since claiming it before a charge that might then fail would permanently
// strand a legitimate retry with no discount and no way to reclaim it.
//
// referralSubmissionId may be null (a discount decision with no code, or no
// submission on file) — every write below is skipped in that case, same as
// the 'none' decision.
//
// appliedDiscountCents is whatever the 50%-of-charge cap actually let
// through on this one charge — recorded for the redemption doc, nothing
// more. Any gap between the code's full entitlement and appliedDiscountCents
// is forfeited, not carried forward or credited later: the code's face
// value was always an upper bound on THIS charge, never a guarantee of the
// full amount eventually landing. There is deliberately no code here that
// issues the difference.
async function finalizeNewMemberReferralDiscount(stripe, memberId, referralSubmissionId, discount, appliedDiscountCents) {
  const billing = billingRef(memberId);
  let claimed;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(billing);
      if (snap.data()?.referralCreditChecked) return false;
      tx.set(billing, { referralCreditChecked: true }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error(`finalizeNewMemberReferralDiscount: claim transaction failed for member ${memberId}:`, e.message);
    return;
  }
  if (!claimed) {
    // Extremely narrow race: some other path (stripeWebhook's invoice.paid,
    // in practice — chargeCurrentMonthWalks never produces an invoice.paid
    // event of its own, so this is not a realistic concern between the two
    // pre-charge callers) already recorded this member's first-payment
    // outcome between our pre-charge read and now. The discount already
    // applied to THIS charge can't be undone — logged for admin visibility,
    // not thrown, since the charge itself already succeeded correctly.
    console.warn(`finalizeNewMemberReferralDiscount: referral outcome for member ${memberId} was already recorded elsewhere — the $${(appliedDiscountCents / 100).toFixed(2)} discount already applied to this charge is not re-recorded.`);
    return;
  }

  if (discount.decision === 'none') return; // no code entered — nothing to record

  if (discount.decision === 'flagged') {
    if (referralSubmissionId) {
      await db.collection('referralCodes').doc(discount.referredByCode)
        .collection('redemptions').doc(referralSubmissionId)
        .set({ status: 'flagged_review', needsReview: true }, { merge: true });
    }
    // Also mirrored onto the new member's own billing doc, purely so the
    // admin Members table (which already subscribes to every member's
    // billing doc for the existing billing-status badge) can surface this
    // without a new query — see renderBillingBadge in admin/dashboard.html.
    await billing.set({ needsReview: true, needsReviewReason: discount.flagReason }, { merge: true });
    return;
  }

  let stage = 'code-bookkeeping';
  try {
    // redeemedByMemberId is written for every source, not just partner
    // codes — harmless bookkeeping for member_referral (never read back for
    // gating, since reuse is intended there), and it's what the
    // single-redemption check in resolveNewMemberReferralDiscount compares
    // against for apartment/agent.
    await db.collection('referralCodes').doc(discount.referredByCode)
      .set({ creditIssued: true, redeemedByMemberId: memberId }, { merge: true });
    if (referralSubmissionId) {
      await db.collection('referralCodes').doc(discount.referredByCode)
        .collection('redemptions').doc(referralSubmissionId)
        .set({ status: 'credit_applied', creditIssued: true, discountAppliedCents: appliedDiscountCents }, { merge: true });
    }

    if (discount.isMemberReferral && discount.referrerId) {
      stage = 'referrer-credit';
      const referrerSnap = await db.collection('members').doc(discount.referrerId).get();
      const referrerData = referrerSnap.data();
      if (!referrerData) {
        // The new member's discount is already baked into the charge that
        // already succeeded — this throw deliberately stops short of
        // marking anything further done: a missing referrer is exactly the
        // "stuck case" an admin needs to see and resolve manually.
        throw new Error(`Referrer member ${discount.referrerId} not found — cannot issue their credit (new member ${memberId}'s discount was already applied at charge time).`);
      }
      // The referrer gets the same flat entitlement the new member's own
      // discount was resolved from (discount.discountCents) — not
      // appliedDiscountCents, which is only the portion the 50% cap let
      // through on this one charge.
      await issueReferralCredit(stripe, discount.referrerId, referrerData, discount.discountCents);
    }
  } catch (e) {
    console.error(`finalizeNewMemberReferralDiscount: failed at stage '${stage}' for member ${memberId} (code ${discount.referredByCode}):`, e.message);
    await billing.set({
      creditIssuanceError: `[${stage}] ${e.message}`,
      creditIssuanceFailedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch((writeErr) => {
      console.error(`finalizeNewMemberReferralDiscount: failed to record creditIssuanceError for member ${memberId}:`, writeErr.message);
    });
  }
}

// Runs once per member, on whichever payment genuinely lands first for
// them via stripeWebhook's invoice.paid — the ONLY remaining caller of this
// function. chargeCurrentMonthWalks and chargeSavedCard used to call this
// too, but now resolve+apply the new member's own discount pre-charge (see
// resolveNewMemberReferralDiscount / finalizeNewMemberReferralDiscount) and
// no longer need it. This function keeps the old post-charge-credit
// behavior intact for the one case that still needs it: a membership member
// whose signup lands with zero remaining walk days this month (no prorated
// remainder for chargeCurrentMonthWalks to charge at all — it skips
// entirely), so their real first payment is their subscription's own
// Stripe-generated invoice. Stripe has already finalized and paid that
// invoice by the time this webhook fires — there's no "before the charge"
// point available the way there is in the other two functions — so this
// member's credit arrives as a Stripe balance credit (or pendingReferralCredit
// for Travel-tier) applied toward their NEXT invoice, rather than a
// reduction of the invoice that triggered this call. invoiceAmountPaidCents
// (the Stripe invoice's own amount_paid, threaded from stripeWebhook) exists
// specifically so this path applies the SAME Math.floor(amount / 2) cap the
// other two pre-charge paths apply to their own first charge — capped
// against the invoice that made this their first payment, one rule
// everywhere, not an uncapped exception just because this path has no
// PaymentIntent of its own to reduce. Same forfeiture rule too: whatever the
// cap leaves unclaimed is gone, not carried to a later payment.
//
// The member's own private/billing.referralCreditChecked flag is BOTH the
// "is this genuinely the first payment" check and the idempotency guard
// against re-running this for a later payment (or a retried/duplicate
// delivery of whichever event triggered this call) — deliberately one
// mechanism, not two, and the SAME flag finalizeNewMemberReferralDiscount
// claims for the other two functions' pre-charge path — whichever path gets
// there first for a given member locks the other out. It's flipped true
// INSIDE the transaction that reads it, before any credit is actually
// issued, so a failure partway through issuance never causes an automatic
// retry on the member's next payment — that's intentional: this pass
// surfaces a stuck case clearly (console.error + a creditIssuanceError
// breadcrumb on the billing doc) for an admin to resolve manually, rather
// than risking a double-credit via automatic retry logic.
//
// For a Member-tier (membership) signup specifically, this is now the SOLE
// claimant of referralCreditChecked, not a fallback for the narrow
// zero-walk-days-remaining edge case it originally was. runChargeCurrentMonthWalks
// deliberately never resolves or applies the new-member discount at all
// (see that function's own comment) — the prorated remainder-of-month
// charge it makes can be too small for the 50% cap to preserve a full $50
// credit. So for every membership signup, not just the edge case, this
// function's invoice.paid-triggered pass against the subscription's first
// FULL-MONTH invoice is the only place that credit is ever decided and
// applied.
//
// Never throws — the caller runs this after its own success and must
// never have a referral-credit bug make that success look like a failure.
async function runFirstPaymentReferralCredit(stripe, memberId, invoiceAmountPaidCents) {
  const billing = billingRef(memberId);
  let proceed, billingData;
  try {
    ({ proceed, billingData } = await db.runTransaction(async (tx) => {
      const snap = await tx.get(billing);
      const data = snap.data() || {};
      if (data.referralCreditChecked) {
        return { proceed: false };
      }
      tx.set(billing, { referralCreditChecked: true }, { merge: true });
      return { proceed: true, billingData: data };
    }));
  } catch (e) {
    console.error(`runFirstPaymentReferralCredit: first-payment flag transaction failed for member ${memberId}:`, e.message);
    return;
  }

  // Not the first payment (flag was already set), or the first payment but
  // no referral code was ever entered — either way, nothing more to do.
  if (!proceed || !billingData.referredByCode) return;
  const referralSubmissionId = billingData.referralSubmissionId || null;

  let stage = 'lookup';
  try {
    const memberSnap = await db.collection('members').doc(memberId).get();
    const memberData = memberSnap.data();
    if (!memberData) {
      console.error(`runFirstPaymentReferralCredit: member ${memberId} not found — no credit issued.`);
      return;
    }

    const discount = await resolveNewMemberReferralDiscount(memberId, billingData, memberData);

    if (discount.decision === 'flagged') {
      stage = 'flagged';
      if (referralSubmissionId) {
        await db.collection('referralCodes').doc(discount.referredByCode)
          .collection('redemptions').doc(referralSubmissionId)
          .set({ status: 'flagged_review', needsReview: true }, { merge: true });
      }
      // Also mirrored onto the new member's own billing doc, purely so the
      // admin Members table (which already subscribes to every member's
      // billing doc for the existing billing-status badge) can surface this
      // without a new query — see renderBillingBadge in admin/dashboard.html.
      await billing.set({ needsReview: true, needsReviewReason: discount.flagReason }, { merge: true });
      return;
    }
    if (discount.decision !== 'approved') return; // 'none' — no valid code, nothing more to do

    // Same Math.floor(amount / 2) cap chargeCustomerCard/runChargeCurrentMonthWalks
    // apply to their own first charge, applied here against the invoice that
    // made this the member's first payment — one formula, no path-specific
    // exception. Anything the cap leaves unclaimed is forfeited, same as the
    // other two paths; skip the issuance entirely rather than call
    // issueReferralCredit with a $0 amount (it throws on that) if the cap
    // happens to zero it out.
    stage = 'new-member-credit';
    // invoiceAmountPaidCents comes from the invoice.paid webhook event —
    // trust nothing about its shape. An undefined/missing amount_paid would
    // otherwise propagate as Math.floor(undefined / 2) === NaN,
    // Math.min(x, NaN) === NaN, and NaN > 0 === false — silently skipping
    // the issuance while referralCreditChecked (already set above, by the
    // claim transaction) makes this member look fully handled forever.
    // Handled as its own early return, NOT a throw into the shared catch
    // below — that catch also covers the referrer-not-found and
    // issueReferralCredit-failure cases below, which stay Cloud-Functions-
    // log-only same as before. This specific failure is the one that gets
    // needsReview:true (see NEEDS_REVIEW_LABELS.credit_issuance_failed in
    // admin/dashboard.html) so it surfaces as a dashboard badge, not just a
    // log line — referralCreditChecked is already true by this point (see
    // above) and nothing else has been written yet (no Stripe call, no
    // referralCodes doc touch), so clearing it is the full, sufficient
    // manual recovery.
    if (!Number.isInteger(invoiceAmountPaidCents) || invoiceAmountPaidCents <= 0) {
      const msg = `invoiceAmountPaidCents must be a positive integer, got ${invoiceAmountPaidCents} for member ${memberId} — cannot compute the referral discount cap.`;
      console.error(`runFirstPaymentReferralCredit: ${msg}`);
      await billing.set({
        needsReview: true, needsReviewReason: 'credit_issuance_failed',
        creditIssuanceError: `[${stage}] ${msg}`,
        creditIssuanceFailedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }
    const cappedDiscountCents = Math.min(discount.discountCents, Math.floor(invoiceAmountPaidCents / 2));
    if (cappedDiscountCents > 0) {
      await issueReferralCredit(stripe, memberId, memberData, cappedDiscountCents);
    } else {
      // A legitimate $0 cap (an extremely small invoice) is NOT an error —
      // it's the rule working as designed — but it must be visibly
      // distinguishable from a normal successful issuance, not just a
      // silently-skipped call that looks identical to one in the logs.
      console.warn(`runFirstPaymentReferralCredit: cap zeroed out the discount for member ${memberId} — discount.discountCents=${discount.discountCents}, invoiceAmountPaidCents=${invoiceAmountPaidCents}. No credit issued; code still marked redeemed below.`);
    }

    if (discount.isMemberReferral && discount.referrerId) {
      stage = 'referrer-credit';
      const referrerSnap = await db.collection('members').doc(discount.referrerId).get();
      const referrerData = referrerSnap.data();
      if (!referrerData) {
        // The new member has already been credited above — this throw
        // deliberately stops short of marking creditIssued/credit_applied
        // (Step 6): half a payout going out is exactly the "stuck case" an
        // admin needs to see and resolve manually, not silently call done.
        throw new Error(`Referrer member ${discount.referrerId} not found — cannot issue their credit (new member ${memberId} was already credited).`);
      }
      await issueReferralCredit(stripe, discount.referrerId, referrerData, discount.discountCents);
    }

    stage = 'bookkeeping';
    await db.collection('referralCodes').doc(discount.referredByCode).set({ creditIssued: true, redeemedByMemberId: memberId }, { merge: true });
    if (referralSubmissionId) {
      await db.collection('referralCodes').doc(discount.referredByCode)
        .collection('redemptions').doc(referralSubmissionId)
        .set({ status: 'credit_applied', creditIssued: true }, { merge: true });
    }
  } catch (e) {
    // Deliberately does NOT set creditIssued/credit_applied — see the
    // function comment. The 'stage' value distinguishes "nothing happened
    // yet" from "the money already moved and only the bookkeeping failed"
    // — the latter needs an admin to reconcile Stripe/Firestore state by
    // hand, not re-run this (which would issue a second $50).
    console.error(`runFirstPaymentReferralCredit: failed at stage '${stage}' for member ${memberId}:`, e.message);
    await billing.set({
      creditIssuanceError: `[${stage}] ${e.message}`,
      creditIssuanceFailedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch((writeErr) => {
      console.error(`runFirstPaymentReferralCredit: failed to record creditIssuanceError for member ${memberId}:`, writeErr.message);
    });
  }
}
// Exposed directly, same reasoning as runGenerateReferralCode/runGenerateWalkerPayout
// above — testable without needing a real, signed Stripe webhook delivery
// (stripeWebhook itself is the only other caller, gated behind
// stripe.webhooks.constructEvent's signature check, which can't be forged
// from a test script). Note this still makes a REAL Stripe API call
// (issueStripeBalanceCredit) if invoked with a live-mode stripeCustomerId —
// test against a disposable customer, not a real member's.
exports.runFirstPaymentReferralCredit = runFirstPaymentReferralCredit;

exports.stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  const stripe = stripeClient(STRIPE_SECRET_KEY.value());

  // Signature verification is the ONLY case that returns non-200 here — an
  // unverified request is rejected outright. Everything past this point
  // always returns 200: Stripe retries indefinitely (and eventually disables
  // the endpoint) on a non-2xx response, so a no-op — duplicate delivery,
  // an unresolvable customer, an internal error on a genuinely broken event
  // — must still look like success to Stripe. Retrying a no-op wouldn't fix
  // it anyway; it would just repeat the same outcome forever.
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET.value());
  } catch (err) {
    console.error('stripeWebhook: signature verification failed:', err.message);
    res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    return;
  }

  // Idempotency: Stripe redelivers events (its own retries, or plain
  // duplicate sends). create() throws if this event id was already
  // recorded, so a redelivery lands here and exits as a safe no-op.
  const eventRef = db.collection('stripe_webhook_events').doc(event.id);
  try {
    await eventRef.create({ type: event.type, receivedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    res.status(200).send('Already processed');
    return;
  }

  try {
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const memberId = await findMemberIdByStripeCustomerId(stripe, invoice.customer);
      if (!memberId) {
        console.warn(`stripeWebhook: invoice.payment_failed for unresolvable customer ${invoice.customer} (event ${event.id})`);
      } else {
        // needsReview (not just billingStatus) is what onBillingNeedsReview
        // actually watches — without it this flag was invisible to admin
        // outside of manually opening the member's row in the dashboard.
        await billingRef(memberId).set({
          billingStatus: 'past_due',
          needsReview: true,
          needsReviewReason: 'renewal_payment_failed',
        }, { merge: true });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const memberId = await findMemberIdByStripeCustomerId(stripe, subscription.customer);
      if (!memberId) {
        console.warn(`stripeWebhook: customer.subscription.deleted for unresolvable customer ${subscription.customer} (event ${event.id})`);
      } else {
        const batch = db.batch();
        batch.set(db.collection('members').doc(memberId), { hasActiveSubscription: false }, { merge: true });
        batch.set(billingRef(memberId), { billingStatus: 'canceled' }, { merge: true });
        await batch.commit();
      }
    } else if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const memberId = await findMemberIdByStripeCustomerId(stripe, invoice.customer);
      if (!memberId) {
        console.warn(`stripeWebhook: invoice.paid for unresolvable customer ${invoice.customer} (event ${event.id})`);
      } else {
        // Never throws — see runFirstPaymentReferralCredit. A referral-credit
        // bug must never turn a real, successful payment event into a
        // non-200 response (Stripe would just retry it forever).
        // amount_paid, not total/subtotal — the actual amount this invoice
        // charged, which is what the 50%-of-first-charge cap has to apply
        // against for this to match the other two paths' rule exactly.
        await runFirstPaymentReferralCredit(stripe, memberId, invoice.amount_paid);
      }
    }
    // Any other event type: the Stripe Dashboard endpoint is only configured
    // to send these three (see setup notes above), but ignore anything else
    // defensively rather than erroring.
  } catch (e) {
    // A genuine bug processing an already-recorded event. Logged for
    // investigation, but still 200 — see the comment above on why.
    console.error(`stripeWebhook: failed processing ${event.type} (${event.id}):`, e.message);
  }

  res.status(200).send('ok');
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGING SYSTEM — unified member communication, July 2026
//
// Design (per business decision):
//   - Members never see any of this in the member portal — no in-app inbox.
//     They just get real emails and real texts, like they would from any
//     small business.
//   - Email: sent AND received through Alison's actual Google Workspace
//     inbox (not a separate transactional email service). The admin portal
//     reads/writes via the Gmail API, so replying in the portal sends from
//     her real address and shows up in her own Gmail normally too.
//   - SMS/MMS: one Twilio phone number, two jobs —
//       1. Automated walk-completion texts (photo + note), fully hands-off.
//       2. Two-way texting with members, visible in the admin portal.
//   - Everything — regardless of channel — lands in ONE unified thread per
//     member (`conversations/{memberId}/messages`), so admin has a single
//     place to see the whole relationship. This mirrors how purpose-built
//     boutique pet-sitting software (Time To Pet, Pet Sitter Plus) handles
//     client communication — not a custom invention.
//
// SETUP REQUIRED before any of this actually sends/receives anything —
// see TODO.md for the full checklist. Until secrets are configured, the
// functions below degrade gracefully: manual sends throw a clear error,
// and the automated walk-completion text logs what *would* have been sent
// (status: 'pending_credentials') instead of silently doing nothing.
// ═══════════════════════════════════════════════════════════════════════════

const { onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');

// Set via:
//   firebase functions:secrets:set TWILIO_ACCOUNT_SID
//   firebase functions:secrets:set TWILIO_AUTH_TOKEN
//   firebase functions:secrets:set TWILIO_PHONE_NUMBER
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');

// Set via:
//   firebase functions:secrets:set GOOGLE_CLIENT_ID
//   firebase functions:secrets:set GOOGLE_CLIENT_SECRET
// These come from the OAuth Client you create in Google Cloud Console
// (Internal user type, since this is Workspace-only — see TODO.md).
const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');

// Update the project region/ID here if either ever changes — these two
// URLs have to match EXACTLY what's configured in the Twilio phone number
// settings and the Google OAuth Client's "Authorized redirect URIs".
const FUNCTIONS_BASE_URL = 'https://us-central1-port-city-leash-club-827ab.cloudfunctions.net';
const GMAIL_REDIRECT_URI = `${FUNCTIONS_BASE_URL}/gmailAuthCallback`;
const TWILIO_WEBHOOK_URL = `${FUNCTIONS_BASE_URL}/twilioInboundWebhook`;

// The address members will see mail arrive from. Update if the real
// Workspace address ends up being something other than hello@.
const BUSINESS_EMAIL_ADDRESS = 'hello@portcityleashclub.com';
const BUSINESS_EMAIL_DISPLAY = `Port City Leash Club <${BUSINESS_EMAIL_ADDRESS}>`;
const BUSINESS_EMAIL_DOMAIN = 'portcityleashclub.com';

// ── Matching helpers ────────────────────────────────────────────────────
// Full-collection scans are intentional here, not an oversight — at
// dozens of members this costs nothing and needs no maintenance. If the
// business grows into the hundreds of members, switch these to indexed
// queries on `emailNormalized` / `phoneDigits` instead.

function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}
function normalizePhoneDigits(phone) {
  return (phone || '').replace(/\D/g, '').replace(/^1/, '');
}
// Pulls the display name out of a raw "From" header, e.g. 'Jane Doe
// <jane@example.com>' -> 'Jane Doe'. Returns null for headers with no name
// portion (just a bare address). This is attacker-controlled input (it's
// whatever a stranger's email client put in From) — never render it
// unescaped.
function parseFromDisplayName(fromHeader) {
  const match = (fromHeader || '').match(/^"?([^"<]+)"?\s*<[^>]+>$/);
  return match ? match[1].trim() : null;
}
// Firestore doc IDs can't contain '/' and have to be non-empty — this
// gives every unrecognized email sender a stable, collision-safe pseudo-ID
// in the same `conversations` collection real members use, mirroring the
// unmatched_<digits> pattern twilioInboundWebhook already uses for texts.
function pseudoIdForEmail(email) {
  return `unmatched_${(email || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

async function findMemberByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const snap = await db.collection('members').get();
  const match = snap.docs.find(d => {
    const data = d.data();
    return (data.emailNormalized || normalizeEmail(data.email)) === target;
  });
  return match ? { id: match.id, ...match.data() } : null;
}

async function findMemberByPhone(phone) {
  const target = normalizePhoneDigits(phone);
  if (!target) return null;
  const snap = await db.collection('members').get();
  const match = snap.docs.find(d => {
    const data = d.data();
    return (data.phoneDigits || normalizePhoneDigits(data.phone)) === target;
  });
  return match ? { id: match.id, ...match.data() } : null;
}

// ── Unified conversation log ────────────────────────────────────────────
// `conversations/{memberId}` — one doc per member, holds the summary used
//   by the admin inbox list (last message preview, unread flag, etc).
// `conversations/{memberId}/messages/{messageId}` — every individual
//   message, either channel, either direction.
async function logConversationMessage(memberId, msg, displayOverride) {
  const memberSnap = await db.collection('members').doc(memberId).get();
  const member = memberSnap.exists ? memberSnap.data() : (displayOverride || {});

  const convoRef = db.collection('conversations').doc(memberId);
  const msgRef = convoRef.collection('messages').doc();

  await msgRef.set({
    channel: msg.channel,               // 'email' | 'sms'
    direction: msg.direction,           // 'inbound' | 'outbound'
    body: msg.body || '',
    subject: msg.subject || null,       // email only
    mediaUrl: msg.mediaUrl || null,     // sms/mms photo, or a walk photo
    sentBy: msg.sentBy || 'system',     // admin uid, 'system', 'member', or a raw phone/email for unmatched senders
    status: msg.status || 'sent',       // 'sent' | 'received' | 'failed' | 'pending_credentials' | 'unmatched'
    externalId: msg.externalId || null, // Gmail message id / Twilio SID — used to dedupe
    automated: !!msg.automated,
    createdAt: FieldValue.serverTimestamp(),
  });

  const convoUpdate = {
    memberId,
    memberName: member.name || null,
    memberEmail: member.email || null,
    memberPhone: member.phone || null,
    // True whenever `memberId` isn't a real members/{id} doc — covers both
    // the SMS unknown-number path and the email unmatched-sender path.
    // Self-correcting on every write, so linking (which deletes this doc
    // entirely) or a real member's own messages never need this touched
    // manually.
    unlinked: !memberSnap.exists,
    lastMessageAt: FieldValue.serverTimestamp(),
    lastMessagePreview: (msg.body || (msg.mediaUrl ? '📷 Photo' : '')).slice(0, 140),
    lastMessageChannel: msg.channel,
  };
  // A real inbound message needs attention; an outbound one from a human
  // (not the automated walk-update system) means admin has already seen
  // the thread. Leave the flag untouched for automated system sends.
  if (msg.direction === 'inbound') convoUpdate.unreadByAdmin = true;
  else if (msg.sentBy && msg.sentBy !== 'system') convoUpdate.unreadByAdmin = false;

  await convoRef.set(convoUpdate, { merge: true });
  return msgRef.id;
}

// ── Twilio (SMS/MMS) ─────────────────────────────────────────────────────
function twilioConfigured() {
  const sid = TWILIO_ACCOUNT_SID.value();
  return !!(sid && sid.startsWith('AC')); // real Twilio Account SIDs always start with AC
}
function twilioClient() {
  return require('twilio')(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
}

// A pet's name is free text (member/admin-entered) with no length limit
// enforced anywhere upstream — truncated defensively wherever it's
// interpolated into an SMS body next to a portal link, so an unusually
// long name can never push the message past the 160-character single-
// segment limit. Twilio silently bills a second segment for anything past
// that, on every send, forever — this is cheap insurance against that, not
// a cosmetic nicety.
function truncateForSms(name, maxLen) {
  if (!name || name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + '…';
}

// ── Gmail (email) ────────────────────────────────────────────────────────
function gmailOAuthClient() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID.value(), GOOGLE_CLIENT_SECRET.value(), GMAIL_REDIRECT_URI);
}

async function getGmailClient() {
  const authDoc = await db.collection('system').doc('gmailAuth').get();
  if (!authDoc.exists || !authDoc.data().refreshToken) return null;
  const { google } = require('googleapis');
  const oauth2Client = gmailOAuthClient();
  oauth2Client.setCredentials({ refresh_token: authDoc.data().refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function extractPlainTextBody(message) {
  function walk(part) {
    if (!part) return null;
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.parts) {
      for (const p of part.parts) {
        const found = walk(p);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(message.payload);
}

// RFC 2047 encoded-words for a header value.
//
// `Content-Type: charset="UTF-8"` below declares the encoding of the BODY
// only — RFC 5322 headers must be pure ASCII. Non-ASCII characters written
// straight into a header go out as raw UTF-8 bytes, which mail clients then
// read as Latin-1: an em dash arrives as "Ã¢Â€Â". Anything outside printable
// ASCII therefore has to be encoded here.
//
// Split into multiple encoded-words so no single one exceeds RFC 2047's
// 75-character limit, chunking by code point so a multi-byte character is
// never cut in half.
function encodeEmailHeader(value) {
  const v = String(value == null ? '' : value);
  if (/^[\x20-\x7E]*$/.test(v)) return v; // already safe, leave it readable
  const words = [];
  let buf = '';
  for (const ch of Array.from(v)) {
    const next = buf + ch;
    if (Buffer.from(next, 'utf8').toString('base64').length > 45 && buf) {
      words.push(buf);
      buf = ch;
    } else {
      buf = next;
    }
  }
  if (buf) words.push(buf);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

async function sendGmailMessage({ to, subject, body, threadId, inReplyTo, references, from }) {
  const gmail = await getGmailClient();
  if (!gmail) {
    throw new HttpsError('failed-precondition', 'Gmail isn\'t connected yet — connect it from the admin portal first.');
  }
  const headers = [
    `To: ${to}`,
    // From is deliberately NOT passed through encodeEmailHeader: it carries an
    // address, and only the display-name part may be encoded. Both values used
    // today (BUSINESS_EMAIL_DISPLAY and the connected Gmail address) are ASCII.
    `From: ${from || BUSINESS_EMAIL_DISPLAY}`,
    `Subject: ${encodeEmailHeader(subject || '(no subject)')}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const rawMessage = headers.join('\r\n') + '\r\n\r\n' + body;
  const encoded = Buffer.from(rawMessage).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded, threadId: threadId || undefined },
  });
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Generate the Google OAuth consent URL for connecting Gmail. Called
//    from the admin portal's "Connect Gmail" button.
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// Onboarding email. Fires after a member is created (saveMember) or a
// one-time service is confirmed for a new customer (confirmServiceRequest).
// It welcomes them, confirms what they signed up for, and carries a
// set-password link so they can reach the portal — no temp password is ever
// relayed. The link is a Firebase password-reset link, which doubles as
// first-time password setup; it lands on Firebase's hosted action page (the
// Console Action URL isn't customized yet) and continues to the portal login.
//
// Defined here, after GOOGLE_CLIENT_ID/SECRET and BUSINESS_EMAIL_ADDRESS: the
// secrets array in the options object is read at module load, not call time,
// so this must sit below those definitions.
//
// Callers treat a failure here as a warning, never a rollback — a member or a
// paid booking must not be undone because an email didn't send.
// ─────────────────────────────────────────────────────────────────────────
const BUSINESS_PORTAL_ORIGIN = 'https://www.portcityleashclub.com';

// kind:'service' used to live here too (a plain-text Gmail send for a new
// one-time customer) — retired now that confirmServiceRequest calls
// sendBookingConfirmedEmail (below) for every confirmation, new account or
// not, via the portal-service-confirmed/walk-confirmed Resend templates.
exports.sendOnboardingEmail = onCall({
  secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, RESEND_API_KEY],
}, async (request) => {
  await assertIsAdmin(request.auth);
  const { memberId, walkerUid, kind } = request.data || {};
  if (!['member', 'walker'].includes(kind)) {
    throw new HttpsError('invalid-argument', "kind must be 'member' or 'walker'.");
  }

  if (kind === 'walker') {
    if (!walkerUid) throw new HttpsError('invalid-argument', 'walkerUid is required for a walker email.');
    const wSnap = await db.collection('walkers').doc(walkerUid).get();
    const walker = wSnap.data();
    if (!walker) throw new HttpsError('not-found', 'Walker record not found.');
    const email = walker.email;
    if (!email) throw new HttpsError('failed-precondition', 'This recipient has no email on file.');
    const firstName = (walker.name || '').trim().split(/\s+/)[0] || 'there';
    const portalUrl = `${BUSINESS_PORTAL_ORIGIN}/walker`;

    // generatePasswordResetLink generates the link without sending it, so
    // the welcome text is ours (via Gmail) rather than Firebase's default
    // template. Walker onboarding stays on this Gmail path for now — see
    // the Phase 1 Resend build notes for why.
    //
    // ?welcome=1 rides along as part of continueUrl (Firebase forwards the
    // whole `url` value verbatim) so portal-password-reset.html — the
    // page every emailed action link lands on, Action URL being
    // project-wide — can tell a first-time link from a genuine reset and
    // show "set your password" copy instead of "reset password" copy.
    const { getAuth } = require('firebase-admin/auth');
    const link = await getAuth().generatePasswordResetLink(email, { url: `${portalUrl}?welcome=1` });

    const subject = `Welcome to the team, ${firstName}`;
    const lines = [
      `Hi ${firstName},`, '',
      `Welcome to the Port City Leash Club team. Your walker account is all set up, and we're glad to have you.`, '',
      `Your account is ready in the walker portal. Log in to find:`, '',
      `  - Your upcoming walks`,
      `  - Your weekly schedule`,
      `  - Your earnings`, '',
      `Set your password to get in:`, '',
      link, '',
      `Link expired? Head to ${portalUrl} and choose "Forgot password?" for a new one.`, '',
      `Questions? Just reply to this email or reach us at ${BUSINESS_EMAIL_ADDRESS}.`, '',
      `The Port City Leash Club team`,
    ];
    await sendGmailMessage({ to: email, subject, body: lines.join('\n') });
    return { success: true, sentTo: email };
  }

  // kind === 'member'
  if (!memberId) throw new HttpsError('invalid-argument', 'memberId is required.');
  const memberSnap = await db.collection('members').doc(memberId).get();
  const member = memberSnap.data();
  if (!member) throw new HttpsError('not-found', 'Member record not found.');
  const email = member.email;
  if (!email) throw new HttpsError('failed-precondition', 'This recipient has no email on file.');

  const firstName = (member.name || '').trim().split(/\s+/)[0] || 'there';
  const dogNames = (Array.isArray(member.dogs) ? member.dogs.map((d) => d && d.name).filter(Boolean) : []);

  // Same weekday order updateWalkSchedule already canonicalizes
  // defaultWalkDays into — sorted again here defensively rather than
  // trusted, since this reads whatever the Convert-to-Member form wrote.
  const orderedDays = VALID_WALK_DAYS.filter((d) => (member.defaultWalkDays || []).includes(d));
  const frequency = orderedDays.length
    ? orderedDays.map((d) => d[0].toUpperCase() + d.slice(1)).join(', ')
    : null;

  // Earliest scheduled walk, if any exist yet. Single equality query +
  // in-memory min, same pattern as updateWalkSchedule/submitVacationHold —
  // deliberately not an orderBy() query, which would need a composite index
  // this collection doesn't have.
  let firstWalkDateStr = null;
  try {
    const walksSnap = await db.collection('walks').where('memberId', '==', memberId).get();
    let earliest = null;
    walksSnap.forEach((snap) => {
      const d = snap.data().date?.toDate?.();
      if (d && (!earliest || d < earliest)) earliest = d;
    });
    if (earliest) firstWalkDateStr = isoDateStr(earliest);
  } catch (e) {
    console.error(`sendOnboardingEmail: failed to look up first walk date for member ${memberId}:`, e.message);
  }

  const portalUrl = `${BUSINESS_PORTAL_ORIGIN}/portal-login`;
  const { getAuth } = require('firebase-admin/auth');
  // ?welcome=1 — see the matching comment on the walker branch above.
  const portalSetupLink = await getAuth().generatePasswordResetLink(email, { url: `${portalUrl}?welcome=1` });

  const result = await sendEmail({
    to: email,
    template: 'member-welcome',
    data: {
      firstName,
      dogNames,
      tier: member.tier || null,
      frequency,
      firstWalkDateStr,
      portalSetupLink,
    },
    idempotencyKey: `member-welcome:${memberId}`,
  });
  if (!result.ok) {
    throw new HttpsError('internal', `Welcome email failed to send: ${result.error}`);
  }
  return { success: true, sentTo: email };
});

// ─────────────────────────────────────────────────────────────────────────
// Meet & greet gate + account creation, server-enforced. Replaces the
// account-creation portions of saveMember() (admin/dashboard.html, for
// membership_request) and of confirmServiceRequest()'s new-account branch
// (for a net-new, public-form service_request) — the only two submission
// types that can still be missing a memberId at this point:
//
//   - overnight_request is rejected outright. There is no public form for
//     it; every overnight_request is created by an already-authenticated
//     existing member (portal-request-extras.html sets memberId at create
//     time), so there is never an account to create for one.
//   - A service_request that already carries a memberId (same reason: the
//     authenticated portal path sets it at create time) is rejected too —
//     that submitter already has an account and portal access.
//
// meetGreetCompleted is a required boolean, not an assumption — the same
// affirmative gate the old client-side checkbox provided, now checked here
// instead of only in the admin's browser. Combined with members/{id}'s
// create rule denying direct client writes (firestore.rules), this
// function becomes the ONLY path that can create a member account, and it
// refuses to run it without that flag. meetGreetCompletedAt is stamped in
// this same call, not read back from an earlier write — there is no
// separate "mark meet & greet complete" step for these two types.
//
// Deliberately does nothing beyond account creation: no Stripe
// subscription, no walk generation, no charge. Those now wait for a card
// on file, added later in the portal — see the payment model note at the
// top of this file, due for a rewrite once that lands.
//
// status: 'account_created' is a new, earlier state than 'confirmed' —
// 'confirmed' now means "card on file AND dates confirmed", set by the
// still-to-build finalize step, not by this function. Dashboard queries
// that currently treat "no memberId and not declined" as the unresolved
// queue will need a matching update when that lands; not done here.
// ─────────────────────────────────────────────────────────────────────────
exports.completeMeetGreetAndCreateAccount = onCall({
  secrets: [RESEND_API_KEY],
}, async (request) => {
  await assertIsAdmin(request.auth);
  const { submissionId, meetGreetCompleted, overrides } = request.data || {};
  if (!submissionId) throw new HttpsError('invalid-argument', 'submissionId is required.');
  if (meetGreetCompleted !== true) {
    throw new HttpsError('failed-precondition', 'Confirm the meet & greet happened before creating the account.');
  }

  const subRef = db.collection('submissions').doc(submissionId);
  const subSnap = await subRef.get();
  const sub = subSnap.data();
  if (!sub) throw new HttpsError('not-found', 'Submission not found.');
  if (sub.type === 'overnight_request') {
    throw new HttpsError('failed-precondition', 'overnight_request only ever comes from an existing member — there is no account to create.');
  }
  if (!['membership_request', 'service_request'].includes(sub.type)) {
    throw new HttpsError('failed-precondition', `Meet & greet account creation doesn't apply to type "${sub.type}".`);
  }
  if (sub.memberId) {
    throw new HttpsError('failed-precondition', 'This submission already has an account.');
  }
  if (sub.status === 'declined') {
    throw new HttpsError('failed-precondition', 'This request was declined.');
  }
  if (!sub.email) {
    throw new HttpsError('failed-precondition', 'This submission has no email on file.');
  }

  const isMembership = sub.type === 'membership_request';
  const ov = overrides || {};
  if (isMembership && !ov.tier) {
    throw new HttpsError('invalid-argument', 'overrides.tier is required for a membership account.');
  }

  const { getAuth } = require('firebase-admin/auth');
  const authAdmin = getAuth();

  // Never shown or typed anywhere — the portal-access email below is the
  // only way in, via a set-password link. Same posture as saveMember()'s
  // randomAccountPassword() and confirmServiceRequest's randomPw.
  let uid;
  try {
    const userRecord = await authAdmin.createUser({
      email: sub.email,
      emailVerified: false,
      password: 'PCLC-' + crypto.randomUUID(),
    });
    uid = userRecord.uid;
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'An account with this email already exists.');
    }
    throw new HttpsError('internal', `Couldn't create the account: ${e.message}`);
  }

  const emailNormalized = sub.email.toLowerCase();
  const phoneDigits = (ov.phone || sub.phone || '').replace(/\D/g, '').replace(/^1/, '');

  // Membership: admin-editable at this step, same fields saveMember()'s
  // modal collects today (tier/zone/walker/schedule aren't on the
  // submission at all — the public form never asks for them). Service:
  // pass-through from the submission, same as confirmServiceRequest's
  // new-account branch — Travel tier, no recurring schedule.
  const memberDoc = isMembership
    ? {
        name: ov.name || sub.ownerName || '',
        email: sub.email,
        phone: ov.phone || sub.phone || '',
        tier: ov.tier,
        address: ov.address || sub.address || '',
        accessNotes: ov.accessNotes || '',
        zone: ov.zone || '',
        defaultWalkDays: Array.isArray(ov.defaultWalkDays) ? ov.defaultWalkDays.map((d) => String(d).toLowerCase()) : [],
        defaultTimeSlot: ov.defaultTimeSlot || null,
        dogs: ov.dogs || sub.dogs || [],
        assignedWalkerId: ov.assignedWalkerId || '',
        walksThisMonth: 0,
        status: 'active',
        attribution: sub.attribution || null,
        // ownerNotes: membership-request.html has no general free-text field
        // (unlike service-request.html's Care Notes), so there's nothing to
        // seed here — stays blank until the member or admin writes one.
        // internalNotes: always starts blank; staff-authored only, never
        // seeded from anything the customer submitted.
        ownerNotes: '',
        internalNotes: '',
      }
    : {
        name: sub.ownerName || '',
        email: sub.email,
        phone: sub.phone || '',
        tier: 'Travel',
        dogs: sub.dogs || [],
        walksThisMonth: 0,
        status: 'active',
        attribution: sub.attribution || null,
        // The general Care Notes box on service-request.html — account-level,
        // deliberately separate from each dog's own per-pet notes field
        // (dogs[].notes, already carried through via sub.dogs above and
        // never touched here). Seeded once at creation, editable afterward
        // by the member or admin — not a frozen copy of the submission.
        ownerNotes: sub.notes || '',
        internalNotes: '',
      };

  await db.collection('members').doc(uid).set({
    ...memberDoc,
    uid,
    emailNormalized,
    phoneDigits,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Referral intake — the half of linkServiceRequestBilling's job that
  // isn't stripeCustomerId (that field no longer lives on submissions once
  // card capture moves to the portal, and this function never reads it).
  // merge:true so this never clobbers a billing doc that
  // createMembershipSubscription or issueReferralCredit populate later.
  // One code per member, structurally: uid was just created above, so this
  // read is almost always empty in practice, but the guard is here rather
  // than assumed so a second code can never silently overwrite a first.
  //
  // friends_family is the one source type that can't use this simple
  // unconditional attach — see claimFriendsFamilyRedemption. This is the
  // actual redemption moment (the account now exists; validateReferralCode's
  // earlier check at signup was only ever advisory, since it can't reserve a
  // slot), so it's the one place that atomically enforces maxRedemptions.
  let friendsFamilyRedemption = null;
  if (sub.referredByCode) {
    const codeSnapForType = await db.collection('referralCodes').doc(sub.referredByCode).get();
    if (codeSnapForType.exists && codeSnapForType.data().source === 'friends_family') {
      friendsFamilyRedemption = await claimFriendsFamilyRedemption(sub.referredByCode, uid, { redeemedVia: 'self_service', submissionId });
    } else {
      const billingSnapForReferral = await billingRef(uid).get();
      if (!billingSnapForReferral.data()?.referredByCode) {
        await billingRef(uid).set({
          referredByCode: sub.referredByCode,
          referralSubmissionId: submissionId,
        }, { merge: true });
      }
    }
  }

  await subRef.set({
    memberId: uid,
    status: 'account_created',
    read: true,
    meetGreetCompletedAt: FieldValue.serverTimestamp(),
    accountCreatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Portal-access email — the entire point of this moment for the
  // recipient: the meet & greet is done, here's how to get in and add a
  // card. A thrown failure here is a real problem (the account exists with
  // no way for its owner to discover it yet) but never unwinds the account
  // itself — same "warn, don't roll back" contract as sendOnboardingEmail.
  const portalUrl = `${BUSINESS_PORTAL_ORIGIN}/portal-login`;
  const portalSetupLink = await authAdmin.generatePasswordResetLink(sub.email, { url: `${portalUrl}?welcome=1` });
  const petNames = (memberDoc.dogs || []).map((d) => d && d.name).filter(Boolean);
  const firstName = (memberDoc.name || '').trim().split(/\s+/)[0] || 'there';

  let emailData;
  if (isMembership) {
    const orderedDays = VALID_WALK_DAYS.filter((d) => memberDoc.defaultWalkDays.includes(d));
    emailData = {
      firstName,
      petNames,
      kind: 'membership',
      tier: memberDoc.tier,
      frequency: orderedDays.length ? orderedDays.map((d) => d[0].toUpperCase() + d.slice(1)).join(', ') : null,
      portalSetupLink,
    };
  } else {
    const { SERVICE_PRICES, resolveServiceKey } = await import('./pricing.js');
    const { formatDateRange } = require('./templates/_layout');
    const serviceLabel = SERVICE_PRICES[resolveServiceKey(sub.service)]?.name || null;
    const startStr = sub.startDate?.toDate ? isoDateStr(sub.startDate.toDate()) : null;
    const endStr = sub.endDate?.toDate ? isoDateStr(sub.endDate.toDate()) : null;
    const requestedDatesStr = startStr ? formatDateRange(startStr, endStr) : null;
    emailData = {
      firstName,
      petNames,
      kind: 'service',
      serviceLabel,
      requestedDatesStr,
      portalSetupLink,
    };
  }

  const emailResult = await sendEmail({
    to: sub.email,
    template: 'portal-access',
    data: emailData,
    idempotencyKey: `portal-access:${uid}`,
  });

  return {
    success: true,
    memberId: uid,
    emailSent: emailResult.ok,
    emailError: emailResult.error || null,
    ...(friendsFamilyRedemption ? { friendsFamilyRedemption } : {}),
  };
});

// Atomic "reject, not flag" redemption gate for a friends_family code — the
// one code type where going over the admin-set cap must never silently
// grant the discount anyway (contrast resolveNewMemberReferralDiscount's
// single-use-code handling, which lets the signup proceed and just flags it
// for review — every OTHER code type still gets that treatment; this one
// deliberately doesn't).
//
// A Firestore transaction, not a bare FieldValue.increment: incrementing
// unconditionally would apply the +1 even at/past the cap — only a
// read-then-conditionally-write can actually ENFORCE maxRedemptions as a
// real ceiling rather than just a display number that drifts past its own
// limit. Same reasoning as every other "claim once" transaction already in
// this file (getOrCreateMemberReferralCode, finalizeNewMemberReferralDiscount,
// runFirstPaymentReferralCredit).
//
// Never throws — called from completeMeetGreetAndCreateAccount AFTER the
// Auth user already exists, so a hard failure here can't unwind account
// creation without leaving an orphaned Auth user with no member doc (the
// exact class of stuck state runDeclineRequestOrphanCleanup exists to avoid
// elsewhere). validateReferralCode's earlier signup-time check already
// rejects an exhausted code in the common case; this transaction exists for
// the narrow remaining race — the code was still under cap when the visitor
// submitted, but ran out before admin got to this meet & greet, hours or
// days later. In that rare case the member is still created normally, just
// without the Friends & Family rate — logged clearly and returned to the
// caller (not silently dropped, but also not a needsReview flag, since
// there is nothing here for an admin to reconcile: no discount was ever
// granted, so there's nothing to undo).
// meta.redeemedVia distinguishes a self-service claim (signup-time, via
// completeMeetGreetAndCreateAccount) from an admin-applied one
// (applyReferralCodeToMember) in the redemptions subcollection below —
// nothing about the validation/atomicity above changes based on which
// caller this is; it's purely a record-keeping tag for whoever reads the
// redemption doc later. submissionId is only ever set on the self-service
// path (there's no submission behind an admin-applied redemption);
// adminUid is only ever set on the admin path.
async function claimFriendsFamilyRedemption(codeId, memberId, meta = {}) {
  const { redeemedVia = 'self_service', submissionId = null, adminUid = null } = meta;
  const codeRef = db.collection('referralCodes').doc(codeId);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(codeRef);
      const data = snap.data();
      if (!data || data.status !== 'active' || isReferralCodeExpired(data)) {
        return { claimed: false, reason: 'code_inactive' };
      }
      const max = Number.isInteger(data.maxRedemptions) ? data.maxRedemptions : 0;
      const count = Number.isInteger(data.redemptionCount) ? data.redemptionCount : 0;
      if (count >= max) {
        return { claimed: false, reason: 'redemption_limit_reached' };
      }
      tx.set(codeRef, { redemptionCount: count + 1 }, { merge: true });
      tx.set(billingRef(memberId), {
        referredByCode: codeId,
        referralSubmissionId: submissionId,
        travelDiscountPercent: data.discountPercent,
        // Explicit on-switch at claim time — see chargeCustomerCard's guard
        // for why this can't be left implicit: every read site treats a
        // missing travelDiscountActive as OFF, so a freshly claimed code
        // must set it to true here or the discount would never apply to
        // anyone. setFriendsFamilyDiscountActive is the only other writer.
        travelDiscountActive: true,
      }, { merge: true });
      // One redemption doc per member (keyed by memberId, not an auto-id) —
      // matches the "one code per person" model this code type already
      // enforces via maxRedemptions; a member can't redeem the same code
      // twice anyway, so there's nothing a second doc would ever need to
      // capture.
      tx.set(codeRef.collection('redemptions').doc(memberId), {
        memberId, redeemedVia, submissionId, adminUid,
        redeemedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { claimed: true, discountPercent: data.discountPercent };
    });
  } catch (e) {
    console.error(`claimFriendsFamilyRedemption: transaction failed for code ${codeId}, member ${memberId}:`, e.message);
    return { claimed: false, reason: 'error' };
  }
}

// Admin-side counterpart to the self-service claim above — for a member who
// qualifies for a Friends & Family (or, later, a member/partner referral)
// discount but never entered a code at signup. Currently only handles
// friends_family; any other code source is refused with a clear message
// rather than silently mis-applying claimFriendsFamilyRedemption's
// friends_family-shaped write to a code that isn't one (a member_referral/
// apartment/agent code has no discountPercent, so that write would silently
// set travelDiscountPercent: undefined).
//
// The double-redemption guard below is deliberately checked here, before
// ever reaching claimFriendsFamilyRedemption — that function only guards
// the CODE side (maxRedemptions); it has no concept of "this member already
// has a different discount/credit on file" since its only other caller
// (completeMeetGreetAndCreateAccount) always runs against a brand-new
// member with an empty billing doc.
exports.applyReferralCodeToMember = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);
  const { memberId, code } = request.data || {};
  if (!memberId || typeof code !== 'string' || !code.trim()) {
    throw new HttpsError('invalid-argument', 'memberId and code are required.');
  }
  const codeId = code.trim();

  const memberSnap = await db.collection('members').doc(memberId).get();
  if (!memberSnap.exists) throw new HttpsError('not-found', 'Member not found.');

  const billingSnap = await billingRef(memberId).get();
  const billingData = billingSnap.data() || {};
  if (billingData.travelDiscountPercent > 0) {
    throw new HttpsError('failed-precondition', 'This member already has a Friends & Family discount on file — refusing to stack a second one.');
  }
  if (billingData.pendingReferralCredit > 0) {
    throw new HttpsError('failed-precondition', 'This member already has an unconsumed referral credit on file — refusing to stack a second one.');
  }

  const codeSnap = await db.collection('referralCodes').doc(codeId).get();
  if (!codeSnap.exists || codeSnap.data().status !== 'active') {
    throw new HttpsError('failed-precondition', 'This code is not active.');
  }
  const codeData = codeSnap.data();
  if (isReferralCodeExpired(codeData)) {
    throw new HttpsError('failed-precondition', 'This code has expired.');
  }
  if (codeData.source !== 'friends_family') {
    throw new HttpsError('failed-precondition', `Applying a "${codeData.source}" code isn't supported by this tool yet — only Friends & Family codes can be admin-applied right now.`);
  }

  const result = await claimFriendsFamilyRedemption(codeId, memberId, { redeemedVia: 'admin', adminUid: request.auth.uid });
  if (!result.claimed) {
    throw new HttpsError('failed-precondition', `Couldn't apply this code: ${result.reason}.`);
  }
  return { success: true, discountPercent: result.discountPercent };
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1 — structure only. runServiceOrOvernightBookingDoc and
// runServiceOrOvernightCharge implement the four charge branches ported
// from confirmServiceRequest/confirmOvernight (admin/dashboard.html):
//   (a) service_request, walk            -> walks/{id} doc, charged immediately
//   (b) service_request, drop-in-visit   -> overnights/{id} doc, charge deferred 24h (cron)
//   (c) service_request, anything else   -> no doc, charged immediately
//       (overnight-stay booked via the public form — an EXISTING asymmetry
//       with drop-in-visit, not something introduced here; see the comment
//       inside runServiceOrOvernightBookingDoc)
//   (d) overnight_request (any service)  -> overnights/{id} doc, charge deferred 24h (cron)
// Pricing itself is NOT re-derived here — amountInDollars/visitSchedule
// arrive via `reviewed`, already computed client-side by the admin's
// review UI (calculateServiceTotal/computeDropInVisitTotal in pricing.js),
// exactly as confirmServiceRequest/confirmOvernight already trust today.
// This is the same trust boundary chargeSavedCard already has (admin-
// supplied amountInDollars), not a new one.
// ─────────────────────────────────────────────────────────────────────────

// Server port of admin/dashboard.html's serviceChargeDescription — same
// receipt-text logic (display name + dog name(s) when known), needed here
// because the immediate-charge branches below build the Stripe description
// themselves now, instead of the client doing it before calling
// chargeSavedCard.
function serviceChargeDescription(serviceKeyRaw, sub, servicePrices, resolveKey) {
  const info = servicePrices[resolveKey(serviceKeyRaw)];
  const label = info ? info.name : 'Service';
  const dogs = (Array.isArray(sub?.dogs) ? sub.dogs.map((d) => d && d.name).filter(Boolean) : [])
    .concat(sub?.dogName ? [sub.dogName] : [])
    .filter((n, i, a) => a.indexOf(n) === i);
  const who = dogs.length ? ` (${dogs.join(', ')})` : '';
  return `Port City Leash Club - ${label}${who}`;
}

// Builds the per-visit tracking array written onto a new overnights doc —
// one entry per individually-completable visit, so a 3-day/3-visit
// reservation produces 9 trackable entries instead of one reservation-wide
// completion. `id` is a real Firestore auto-ID (minted via .doc().id, never
// written) rather than an array index, since index-based identity breaks
// the moment any visit is ever removed/reordered and a read-modify-write
// (see completeVisit in walker/dashboard.html) needs a stable key to find
// the right entry again.
//
// Deliberately does NOT touch payout: this array is walker-facing
// scheduling/completion state, entirely separate from
// calculateOvernightPayout (walker-pricing.js), which keeps reading
// visitSchedule's `visits` counts and the reservation-level `payout` stamp
// exactly as it always has. See isCheckin's own comment above for why
// visitSchedule itself now reaches this function for BOTH submission types.
function generateOvernightVisits(reviewed, isCheckin) {
  const mintVisitId = () => db.collection('overnights').doc().id;

  if (isCheckin) {
    const schedule = Array.isArray(reviewed.visitSchedule) ? reviewed.visitSchedule : [];
    return schedule.flatMap((day) => {
      const count = day.visits || 0;
      // slots always arrives with length === visits from the admin editor
      // (updateVisitScheduleCount keeps them in lockstep) — this fallback is
      // defense against a malformed/missing slots array only, not an
      // expected path.
      const slots = Array.isArray(day.slots) && day.slots.length === count
        ? day.slots
        : Array(count).fill('midday');
      return slots.map((slot) => ({
        id: mintVisitId(),
        date: day.date,
        slot,
        status: 'expected',
        completedAt: null,
        note: '',
        photoUrl: null,
        walkerId: '',
        walkerName: '',
      }));
    });
  }

  // True overnight stay — flat $115/night to the member, $65/night to the
  // walker (a composite that already bakes in a mid-day check-in — see
  // WALKER_RATES.overnight's own comment in walker-pricing.js). Visits here
  // are OPERATIONAL TRACKING ONLY: they never feed calculateServiceTotal
  // (member price) or calculateOvernightPayout (walker pay), which is why
  // this branch reads reviewed.overnightVisitPlan — separate from
  // reviewed.visitSchedule, the field isCheckin's branch above uses and
  // that payout actually keys off. Writing that field here, even just to
  // reuse it, would flip this reservation's payout to per-visit — exactly
  // the thing this separate field name exists to prevent.
  //
  // Prefers the admin's edited per-night plan (built by the Visit Schedule
  // grid in renderOvernightReview, admin/dashboard.html) when present —
  // that's where a walker's "the member gets back at 2pm, add a morning
  // visit on the return day" case gets captured. Falls back to one visit
  // per NIGHT (fixed at 'midday', the composite's baked-in check-in) only
  // if no plan was supplied at all (e.g. older/malformed data) — nights are
  // EXCLUSIVE of the return date, matching getDaysBetween's own convention:
  // a Friday-to-Monday stay is 3 nights (Fri, Sat, Sun), not 4.
  if (Array.isArray(reviewed.overnightVisitPlan) && reviewed.overnightVisitPlan.length) {
    return reviewed.overnightVisitPlan.flatMap((day) => {
      const slots = Array.isArray(day.slots) ? day.slots : [];
      return slots.map((slot) => ({
        id: mintVisitId(),
        date: day.date,
        slot,
        status: 'expected',
        completedAt: null,
        note: '',
        photoUrl: null,
        walkerId: '',
        walkerName: '',
      }));
    });
  }

  if (!reviewed.startDate || !reviewed.endDate) return [];
  const dates = [];
  const cursor = new Date(reviewed.startDate.toDate());
  const end = new Date(reviewed.endDate.toDate());
  while (cursor < end) { // exclusive of the return date — nights only
    dates.push(isoDateStr(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates.map((date) => ({
    id: mintVisitId(),
    date,
    slot: 'midday',
    status: 'expected',
    completedAt: null,
    note: '',
    photoUrl: null,
    walkerId: '',
    walkerName: '',
  }));
}

async function runServiceOrOvernightBookingDoc(sub, submissionId, memberId, reviewed) {
  const { SERVICE_PRICES, resolveServiceKey } = await import('./pricing.js');
  const isOvernightRequest = sub.type === 'overnight_request';
  const serviceKey = resolveServiceKey(reviewed.service);
  const serviceInfo = SERVICE_PRICES[serviceKey];
  const isWalk = !isOvernightRequest && serviceInfo?.unit === 'walk';
  // Keyed on serviceKey alone, NOT also gated on !isOvernightRequest — a
  // check-in visit booked through the overnight_request form (member picks
  // "Drop-In Visit" in portal-request-extras.html) is exactly as much a
  // per-visit-schedule booking as one booked through service_request. The
  // old `!isOvernightRequest &&` guard here meant that path never got a
  // visitSchedule at all and was always priced as a flat estimate — see
  // renderOvernightReview/reviewRecalcOvernight in admin/dashboard.html for
  // the review-UI half of this fix.
  const isCheckin = serviceKey === 'drop-in-visit';

  // Live member doc, not the submission's own ownerName/memberName snapshot
  // — same reasoning confirmOvernight's comment already gives ("the
  // submission's own memberName/dogName are a snapshot from whenever the
  // member submitted the request, which can already be stale by
  // confirmation time"). confirmServiceRequest instead preferred
  // item.ownerName first, but only because ITS memberId could have been
  // created in the very same client call, before the client's own cached
  // member list included it — a client-side caching artifact that doesn't
  // exist here, since this always reads memberId's doc fresh from
  // Firestore. Preferring the live doc uniformly is a deliberate, small
  // behavior change: more correct, not a regression.
  const memberSnap = await db.collection('members').doc(memberId).get();
  const member = memberSnap.data();
  const memberName = member?.name || sub.ownerName || sub.memberName || '';
  const dogs = sub.dogs || [];
  const dogName = dogs[0]?.name || sub.dogName || '';

  if (isWalk) {
    if (!reviewed.startDate) {
      throw new HttpsError('invalid-argument', 'A start date is required to schedule a walk.');
    }
    // Same deterministic ${memberId}_${dateStr} key and instant-construction
    // convention as generateWalksForMember, so a walk written from either
    // call site for the same member/date is the same doc, never a duplicate.
    const startStr = isoDateStr(reviewed.startDate.toDate());
    const walkRef = db.collection('walks').doc(`${memberId}_${startStr}`);
    try {
      await db.runTransaction(async (tx) => {
        const walkSnap = await tx.get(walkRef);
        if (walkSnap.exists) {
          const err = new Error('Walk already exists');
          err.code = 'already-exists';
          throw err;
        }
        tx.set(walkRef, {
          memberId,
          date: reviewed.startDate,
          timeSlot: reviewed.timeSlot,
          walkerId: null,
          notes: '',
          status: 'scheduled',
          createdAt: FieldValue.serverTimestamp(),
          ...(serviceKey === 'extended-walk' ? {
            extended: true, extendedStatus: 'confirmed', duration: '45-minute walk',
          } : {}),
        });
      });
    } catch (e) {
      // Hitting the existing doc IS success here (a retry of an
      // already-created walk), same as confirmServiceRequest's own guard.
      if (e.code !== 'already-exists') {
        throw new HttpsError('internal', `The walk wasn't added to the schedule: ${e.message}`);
      }
    }
    return { docType: 'walk', docId: walkRef.id };
  }

  if (isCheckin || isOvernightRequest) {
    // 24-hour window before the card is touched, same as today — the
    // member has a real chance to change plans. chargeScheduledReservations
    // (unchanged) is what actually charges this once chargeScheduledFor
    // passes; runServiceOrOvernightCharge below does nothing for this case
    // beyond recording paymentStatus: 'scheduled'.
    const chargeScheduledFor = Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const overnightRef = await db.collection('overnights').add({
      memberId,
      memberName,
      dogName,
      startDate: reviewed.startDate,
      endDate: reviewed.endDate,
      serviceType: isOvernightRequest ? (reviewed.service || sub.serviceType || 'overnight') : serviceKey,
      notes: sub.notes || '',
      status: 'confirmed',
      confirmedAt: FieldValue.serverTimestamp(),
      submissionId,
      walkerId: '',
      extraPet: reviewed.extraPet,
      medication: reviewed.medication,
      // visitSchedule for any check-in visit booking, whichever form it was
      // submitted through (service_request or overnight_request) — a true
      // overnight-stay keeps the exclusive-nights model and never sets this.
      ...(isCheckin ? { visitSchedule: reviewed.visitSchedule } : {}),
      // Per-visit tracking — see generateOvernightVisits' own comment for
      // why this is safe to write in the same create call rather than a
      // follow-up update (no payout/pricing field above depends on it).
      visits: generateOvernightVisits(reviewed, isCheckin),
      confirmedTotalCents: Math.round(reviewed.amountInDollars * 100),
      // See markDatesConfirmed — chargeCustomerCard's Friends & Family guard
      // reads this off whichever doc it's handed, and chargeScheduledReservations
      // hands it this overnights doc, not the submission `reviewed` came from.
      travelDiscountApplied: !!reviewed.travelDiscountApplied,
      chargeScheduledFor,
      chargePending: true,
    });
    return { docType: 'overnight', docId: overnightRef.id, chargeScheduledFor };
  }

  // Neither walk, check-in, nor overnight_request — e.g. an overnight-stay
  // booked through the public service_request form. No supplementary doc
  // is written, matching confirmServiceRequest's existing behavior exactly:
  // only its isWalk and isCheckin branches ever write one; this third case
  // gets neither a walks nor an overnights record, and is charged
  // immediately below like a walk.
  return { docType: 'none' };
}

async function runServiceOrOvernightCharge(sub, submissionId, memberId, reviewed) {
  const { SERVICE_PRICES, resolveServiceKey } = await import('./pricing.js');
  const isOvernightRequest = sub.type === 'overnight_request';
  const serviceKey = resolveServiceKey(reviewed.service);
  const isCheckin = serviceKey === 'drop-in-visit';
  const subRef = db.collection('submissions').doc(submissionId);

  if (isCheckin || isOvernightRequest) {
    await subRef.set({ paymentStatus: 'scheduled' }, { merge: true });
    return { paymentStatus: 'scheduled', chargeScheduledFor: null };
  }

  // Immediate charge — walk, or overnight-stay via the public form.
  // amountInDollars <= 0 means nothing to charge (no card, or admin zeroed
  // it out) — chargeAndTrackPayment's exact contract, preserved here.
  let paymentStatus, chargeError = null;
  if (reviewed.amountInDollars > 0) {
    const stripe = stripeClient(STRIPE_SECRET_KEY.value());
    const description = serviceChargeDescription(reviewed.service, sub, SERVICE_PRICES, resolveServiceKey);
    try {
      await chargeCustomerCard(stripe, subRef, sub, {
        chargeKey: submissionId,
        amountInDollars: reviewed.amountInDollars,
        description,
      });
      paymentStatus = 'charged';
    } catch (e) {
      paymentStatus = 'failed';
      chargeError = e.message;
      console.error(`runServiceOrOvernightCharge: charge failed for ${submissionId}:`, e.message);
    }
  } else {
    paymentStatus = 'skipped';
  }
  await subRef.set({ paymentStatus }, { merge: true });
  // chargeError is returned, not just logged, so finalizeSubmissionIfReady
  // can surface it through recordFinalizeFailure — this catch never
  // rethrows (a failed charge must never block confirming the booking,
  // matching confirmServiceRequest/confirmOvernight's original posture),
  // so without returning it here, this failure mode would only ever show
  // via the older paymentStatus badge, never reach Needs Attention.
  return { paymentStatus, chargeScheduledFor: null, chargeError };
}

// Dispatches to whichever of the three existing sendBookingConfirmedEmail
// templates matches this booking — same selection logic confirmService-
// Request/confirmOvernight use today (isCheckin/overnight_request ->
// portal-reservation-confirmed, isWalk -> walk-confirmed, else ->
// portal-service-confirmed). Calls sendEmail directly rather than going
// through the sendBookingConfirmedEmail onCall export — that export's only
// real job beyond resolving the member's email is the isNewAccount portal-
// link branch, and isNewAccount is always false from this call site (see
// below), so there's nothing left worth wrapping. sendBookingConfirmedEmail
// itself is untouched, still used by confirmWalkExtension (unrelated to
// this migration) and by the still-live old confirmServiceRequest/
// confirmOvernight during this build.
async function sendServiceOrOvernightConfirmationEmail(sub, submissionId, memberId, reviewed, chargeResult, cardOnFile = true) {
  const { SERVICE_PRICES, resolveServiceKey } = await import('./pricing.js');
  const isOvernightRequest = sub.type === 'overnight_request';
  const serviceKey = resolveServiceKey(reviewed.service);
  const serviceInfo = SERVICE_PRICES[serviceKey];
  const isWalk = !isOvernightRequest && serviceInfo?.unit === 'walk';
  const isCheckin = serviceKey === 'drop-in-visit';

  const memberSnap = await db.collection('members').doc(memberId).get();
  const member = memberSnap.data();
  if (!member || !member.email) {
    console.error(`sendServiceOrOvernightConfirmationEmail: member ${memberId} has no email on file.`);
    return { ok: false, error: 'no-email' };
  }
  const firstName = (member.name || sub.ownerName || '').trim().split(/\s+/)[0] || 'there';
  const petNames = (sub.dogs && sub.dogs.length ? sub.dogs : (member.dogs || [])).map((d) => d && d.name).filter(Boolean);
  const startDateStr = reviewed.startDate?.toDate ? isoDateStr(reviewed.startDate.toDate()) : null;
  const endDateStr = reviewed.endDate?.toDate ? isoDateStr(reviewed.endDate.toDate()) : null;
  // Confirming no longer waits on a card (finalizeSubmissionIfReady) — every
  // template below needs to say so instead of stating a charge date/amount
  // that isn't actually scheduled yet. addCardUrl always points at the same
  // portal-account.html flag portal-dashboard.html's own no-card banner
  // already uses to jump straight into "Update Payment Method".
  const needsCard = !cardOnFile;
  const addCardUrl = `${BUSINESS_PORTAL_ORIGIN}/portal-account?addCard=1`;

  let template, data;
  if (isOvernightRequest || isCheckin) {
    template = 'portal-reservation-confirmed';
    data = {
      firstName, petNames,
      serviceLabel: serviceInfo?.name || reviewed.service,
      startDateStr, endDateStr,
      totalDollars: reviewed.amountInDollars,
      chargeDateStr: chargeResult.chargeScheduledFor?.toDate ? isoDateStr(chargeResult.chargeScheduledFor.toDate()) : null,
      visitSchedule: isCheckin ? reviewed.visitSchedule : null,
      needsCard, addCardUrl,
    };
  } else if (isWalk) {
    template = 'walk-confirmed';
    data = {
      firstName, dogNames: petNames,
      walkTypeLabel: serviceInfo?.name || 'Walk',
      durationMinutes: serviceKey === 'extended-walk' ? 45 : 30,
      walks: [{ dateStr: startDateStr, slot: reviewed.timeSlot }],
      needsCard, addCardUrl,
    };
  } else {
    // overnight-stay via the public service_request form — the third,
    // no-doc, immediate-charge branch from section 2.
    template = 'portal-service-confirmed';
    data = {
      firstName, petNames,
      serviceLabel: serviceInfo?.name || reviewed.service,
      startDateStr, endDateStr,
      unitCount: Math.max(reviewed.unitCount || 1, 1),
      unitNoun: 'night',
      needsCard, addCardUrl,
    };
  }

  // isNewAccount is always false here — unlike confirmServiceRequest/
  // confirmOvernight, which could still be confirming a brand-new
  // customer's very first booking in the same client action, account
  // creation under the new flow always already happened earlier, at meet-
  // greet completion (completeMeetGreetAndCreateAccount), with its own
  // dedicated portal-access email. A second portal-setup link here would
  // be redundant. Flagged in section 1 — the isNewAccount:true branch in
  // all three templates below is now unreachable from this call site.
  return sendEmail({
    to: member.email,
    template,
    data: { ...data, isNewAccount: false, portalSetupLink: null },
    idempotencyKey: `booking-confirmed:${submissionId}`,
  });
}

// portal-membership-confirmed: new template. Membership has no equivalent of sendBookingConfirmedEmail's
// three templates — nothing today announces "your membership is starting"
// as its own moment. member-welcome used to fire here, before it was
// retargeted to portal-access (account creation, before any card exists)
// earlier in this build; this is the other half of what member-welcome
// used to say in one email, now said once billing has actually started —
// by this point createMembershipSubscription and generateInitialWalks have
// already run, so, unlike portal-access, this can reliably say the walks
// are on the calendar rather than "to be confirmed."
async function sendMembershipConfirmationEmail(memberId, submissionId) {
  const memberSnap = await db.collection('members').doc(memberId).get();
  const member = memberSnap.data();
  if (!member || !member.email) {
    console.error(`sendMembershipConfirmationEmail: member ${memberId} has no email on file.`);
    return { ok: false, error: 'no-email' };
  }
  const firstName = (member.name || '').trim().split(/\s+/)[0] || 'there';
  const dogNames = (Array.isArray(member.dogs) ? member.dogs.map((d) => d && d.name).filter(Boolean) : []);
  const orderedDays = VALID_WALK_DAYS.filter((d) => (member.defaultWalkDays || []).includes(d));
  const frequency = orderedDays.length ? orderedDays.map((d) => d[0].toUpperCase() + d.slice(1)).join(', ') : null;

  // Earliest scheduled walk, same lookup the old member-welcome trigger
  // used (functions/index.js's retired sendOnboardingEmail kind:'member'
  // branch) — reliable now, since generateInitialWalks already ran in
  // finalizeSubmissionIfReady before this is called.
  let firstWalkDateStr = null;
  try {
    const walksSnap = await db.collection('walks').where('memberId', '==', memberId).get();
    let earliest = null;
    walksSnap.forEach((snap) => {
      const d = snap.data().date?.toDate?.();
      if (d && (!earliest || d < earliest)) earliest = d;
    });
    if (earliest) firstWalkDateStr = isoDateStr(earliest);
  } catch (e) {
    console.error(`sendMembershipConfirmationEmail: failed to look up first walk date for member ${memberId}:`, e.message);
  }

  return sendEmail({
    to: member.email,
    template: 'portal-membership-confirmed',
    data: { firstName, dogNames, tier: member.tier || null, frequency, firstWalkDateStr },
    idempotencyKey: `portal-membership-confirmed:${memberId}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Shared finalize step. Fires once a submission is billable: for
// membership_request that's cardOnFile alone (no per-booking dates to
// confirm — a recurring schedule, not a date range, per the decision not
// to invent a dates-confirmed step for it); for service_request/
// overnight_request that's cardOnFile AND datesConfirmedAt, whichever
// completes second. Two trigger points call this: confirmCardOnFile (after
// a card is confirmed — member-scoped, so it must check every one of that
// member's pending submissions, not just one) and markDatesConfirmed
// (below, submission-scoped).
//
// The idempotency flag (billingFinalized) lives on the SUBMISSION, not
// billing — a member can have multiple submissions over time, each needing
// its own independent claim, unlike referralCreditChecked (a true
// once-per-member flag). Same transaction-claim shape as
// finalizeNewMemberReferralDiscount otherwise: the flag is flipped INSIDE
// the transaction that reads it, before any side effect runs, so a
// mid-flight failure after the claim can't cause an automatic retry to
// double-charge — it's a durably recorded, manually-resolved problem
// instead (see the try/catch below), same posture as that existing pattern.
// ─────────────────────────────────────────────────────────────────────────
async function finalizeSubmissionIfReady(submissionId, { viaExplicitRetry = false } = {}) {
  const subRef = db.collection('submissions').doc(submissionId);
  const subSnap = await subRef.get();
  const sub = subSnap.data();
  if (!sub || !sub.memberId) return { ready: false };
  // Explicit type check, not incidental status-vocabulary safety. Once the
  // gate below also accepts 'pending' — a status value plenty of OTHER
  // submission types use for their own unrelated purposes — status alone
  // no longer implies "this is a request finalize should ever touch."
  if (!['membership_request', 'service_request', 'overnight_request'].includes(sub.type)) {
    return { ready: false };
  }
  // 'account_created' (net-new, went through completeMeetGreetAndCreateAccount)
  // and 'pending' (portal-submitted by an existing member — memberId is
  // already set at creation there, so it never passes through that
  // function, or through any status transition, before reaching here) are
  // both eligible for a normal, not-yet-finalized run.
  //
  // 'confirmed' is ALSO eligible, but only for a retry (retryFinalizeSubmission)
  // where the PRIOR attempt got all the way to confirming and only the
  // notification failed afterward (finalizeErrorKind === 'email_failed'), or
  // the SERVICE/OVERNIGHT immediate charge failed (finalizeErrorKind ===
  // 'charge_failed' AND type isn't membership_request — see
  // runServiceOrOvernightCharge, which never blocks 'confirmed' on a failed
  // charge). Every step below is safely re-runnable on a second pass — the
  // subscription-creation guard, chargeCustomerCard's own alreadyCharged
  // short-circuit (verified safe for the email_failed case: the prior
  // successful charge's lastChargeAttempt.status:'charged' is already
  // durable by the time a fresh invocation re-reads it, so this returns
  // cleanly rather than re-charging), sendEmail's own idempotencyKey — so
  // re-running the WHOLE pipeline is simpler and no less safe than a
  // narrower path would have been.
  //
  // A MEMBERSHIP charge_failed (runChargeCurrentMonthWalks throwing) is
  // different — that exception propagates, not swallowed, so it never
  // reaches 'confirmed' at all; it's already covered by the ordinary
  // 'pending'/'account_created' branch above, same as any other stuck
  // exception. Its finalizeErrorKind is still 'charge_failed' (marked by
  // runChargeCurrentMonthWalks itself, at the one point inside it where a
  // real Stripe charge attempt fails — see that function's own
  // paymentIntents.create catch), which matters to retryFinalizeSubmission's
  // 24-hour check below, just not to this gate.
  //
  // charge_failed's TIMING (as opposed to whether it's eligible at all) is
  // gated by retryFinalizeSubmission itself, not here — this function has
  // no way to distinguish "genuinely eligible" from "the Stripe idempotency
  // key hasn't expired yet" on its own, since that's a property of time
  // elapsed, not of anything in this doc's status. See
  // retryFinalizeSubmission for why: within 24h of the original failure,
  // Stripe's idempotencyKey either replays the cached failure or errors on
  // a parameter mismatch — never a genuine new charge attempt — so
  // retrying that soon would accomplish nothing. After 24h the key has
  // expired and a retry becomes a real new charge attempt against whatever
  // the member's CURRENT default payment method is.
  //
  // viaExplicitRetry gates every charge_failed path here, regardless of
  // status — passed only by retryFinalizeSubmission, after ITS OWN 24h
  // check and the dashboard's confirm() dialog naming the amount. Every
  // OTHER caller (confirmCardOnFile, markDatesConfirmed) omits it, so it
  // defaults to false. This matters specifically for MEMBERSHIP: a
  // membership charge_failed propagates, not swallowed, so it never reaches
  // 'confirmed' — it sits at 'pending'/'account_created', indistinguishable
  // by status alone
  // from a submission that's never been attempted at all. Without this
  // check, confirmCardOnFile's card-on-file trigger — which has no confirm()
  // dialog and no 24h/manual-charge check of its own — would silently
  // re-attempt the SAME charge the instant the member updates their card,
  // with nothing standing between that and a double charge if an admin had
  // already resolved it manually in Stripe and forgotten to Dismiss. A
  // SERVICE/OVERNIGHT charge_failed can't hit this same gap today (it only
  // ever sits at 'confirmed', which confirmCardOnFile's pending/
  // account_created query never returns, and markDatesConfirmed refuses to
  // run twice via its own datesConfirmedAt check) — but gating it here too,
  // not just in the 'confirmed' branch below, keeps this function correct
  // on its own rather than depending on both of those callers' incidental
  // shapes to stay safe.
  const hasUnresolvedChargeFailed = sub.finalizeErrorKind === 'charge_failed';
  const statusEligible =
    (['pending', 'account_created'].includes(sub.status) && (!hasUnresolvedChargeFailed || viaExplicitRetry))
    || (sub.status === 'confirmed' && sub.finalizeErrorKind === 'email_failed')
    || (sub.status === 'confirmed' && hasUnresolvedChargeFailed && viaExplicitRetry);
  if (!statusEligible) return { ready: false };

  const billingSnap = await billingRef(sub.memberId).get();
  const billingData = billingSnap.data() || {};
  const cardOnFile = billingData.cardOnFile === true;
  const isMembership = sub.type === 'membership_request';
  const datesReady = isMembership || !!sub.datesConfirmedAt;
  // Membership genuinely cannot proceed without a card — Stripe subscription
  // creation requires a payment method attached, so this stays a hard,
  // silent wait (portal-account.html's own "waiting on a card" notice covers
  // that case). A one-time service/overnight booking has no such technical
  // requirement: the charge (immediate, via runServiceOrOvernightCharge, or
  // scheduled 24h out) already tolerates failing without undoing the
  // booking. A missing card here used to block the ENTIRE confirmation —
  // no reservation, no email, no way to notice or retry — rather than just
  // the eventual charge. It no longer blocks anything; the missing card is
  // flagged for admin instead (see the needsReview write below), and the
  // confirmation email says a card is still needed.
  if (isMembership && !cardOnFile) return { ready: false };
  if (!datesReady) return { ready: false };

  const claimed = await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(subRef);
    const fresh = freshSnap.data();
    if (!fresh || fresh.billingFinalized) return false;
    tx.set(subRef, { billingFinalized: true }, { merge: true });
    return true;
  });
  if (!claimed) return { ready: false, alreadyClaimed: true };

  // From here on: run the existing charge logic, then send the
  // confirmation email, then mark 'confirmed'. Errors are recorded, not
  // thrown back to the caller — confirmCardOnFile and markDatesConfirmed
  // must still report success for the write THEY made; a downstream charge
  // failure is a distinct, separately-surfaced problem. Recorded in TWO
  // places, same as every other needsReview-worthy failure in this file
  // (createMembershipSubscription, chargeScheduledReservations): on the
  // submission itself (finalizeError — request-scoped detail, which
  // booking/what failed) AND on the member's billing doc (needsReview —
  // so this ALSO surfaces on the existing Members-table badge, not just
  // wherever the Requests view chooses to show finalizeError).
  try {
    let emailResult;
    // Populated two ways: directly, for the service/overnight branch, on a
    // failed immediate charge (runServiceOrOvernightCharge's own catch
    // never rethrows — a failed charge must never block confirming the
    // booking, matching confirmServiceRequest/confirmOvernight's original
    // posture); or via the outer catch below, for a membership charge
    // failure — runChargeCurrentMonthWalks's own throw DOES still propagate
    // out of this try block (unlike the service/overnight case), so it's
    // this function's outer catch, not this variable, that ends up
    // recording it — see that catch's own comment.
    let chargeFailedMessage = null;
    if (isMembership) {
      const subResult = await runCreateMembershipSubscription(submissionId, sub.memberId);
      if (!subResult.skipped) {
        await runGenerateInitialWalks(submissionId, sub.memberId);
        // Not locally wrapped — runChargeCurrentMonthWalks marks
        // e.isChargeFailure itself now, at the one point inside it where a
        // real Stripe charge attempt fails (see its own paymentIntents.create
        // catch), so whatever it throws already carries the right
        // classification by the time it reaches the outer catch below. A
        // brand-new membership's first charge failing still leaves the
        // WHOLE finalize stuck (subscription + walks + this charge, as one
        // unit, never reaching 'confirmed') rather than letting it through
        // as "confirmed but unpaid" the way service/overnight can — that's
        // a bigger, deliberate-if-wanted behavior change this isn't making,
        // unaffected by where the marker gets set.
        await runChargeCurrentMonthWalks(sub.memberId);
      }
      emailResult = await sendMembershipConfirmationEmail(sub.memberId, submissionId);
    } else {
      // Flagged immediately, not left to surface only when the eventual
      // charge attempt fails — a scheduled reservation (check-in/overnight)
      // doesn't even ATTEMPT a charge for another 24 hours, so without this,
      // admin would have no way to know a card is needed until then. Never
      // overwrites an existing, still-unresolved needsReview reason, same
      // posture as recordFinalizeFailure's own write.
      if (!cardOnFile) {
        try {
          const billingSnapNow = await billingRef(sub.memberId).get();
          if (!billingSnapNow.data()?.needsReview) {
            await billingRef(sub.memberId).set({
              needsReview: true, needsReviewReason: 'no_card_on_file',
            }, { merge: true });
          }
        } catch (e) {
          console.error(`finalizeSubmissionIfReady: failed to flag no_card_on_file for ${sub.memberId}:`, e.message);
        }
      }
      const chargeResult = await runServiceOrOvernightCharge(sub, submissionId, sub.memberId, sub);
      emailResult = await sendServiceOrOvernightConfirmationEmail(sub, submissionId, sub.memberId, sub, chargeResult, cardOnFile);
      if (chargeResult.paymentStatus === 'failed') {
        chargeFailedMessage = `Charge failed: ${chargeResult.chargeError || 'unknown error'}`;
      }
    }
    // Clears any PRIOR finalizeError/finalizeErrorAt/finalizeErrorKind —
    // this path is also what a successful retry after a fixed failure runs
    // through (see finalizeSubmissionIfReady's status gate below, which
    // specifically allows a 'confirmed' + kind:'email_failed' submission
    // back in here), and a stale error left on an otherwise-resolved
    // request would keep showing in Needs Attention forever with nothing
    // left to actually fix.
    await subRef.set({
      status: 'confirmed', confirmedAt: FieldValue.serverTimestamp(),
      finalizeError: null, finalizeErrorAt: null, finalizeErrorKind: null,
    }, { merge: true });

    // Both checked AFTER the write above, not before — recordFinalizeFailure
    // sets finalizeError, and that write unconditionally clears it (the
    // clear is what lets a successful retry resolve its OWN prior error).
    // Setting it first would just have it wiped out by the very next line.
    // Neither ever blocks 'confirmed' from being set: a failed charge or a
    // failed confirmation email are both real problems worth a human
    // noticing, but neither undoes a booking that otherwise went through —
    // same posture confirmServiceRequest/confirmOvernight always had (an
    // alert(), never a rollback). sendEmail specifically never throws on
    // its own (every caller treats a failed send as a warning — see
    // functions/lib/email.js), so without this check a failed confirmation
    // email would pass through this try block completely silently.
    //
    // kind: charge_failed takes priority over email_failed when (rarely)
    // both happen in the same run — it's the more consequential of the two
    // (real money didn't move, vs. it did and only the notification
    // didn't), and it's the one with the 24-hour retry restriction
    // (retryFinalizeSubmission), so it shouldn't lose out to email_failed
    // (no such restriction) if a caller only checked the stored kind
    // without also checking the message text.
    const finalizeWarnings = [];
    let finalizeErrorKind = null;
    if (chargeFailedMessage) {
      finalizeWarnings.push(chargeFailedMessage);
      finalizeErrorKind = 'charge_failed';
    }
    if (emailResult && emailResult.ok === false) {
      finalizeWarnings.push(`Confirmation email failed to send: ${emailResult.error}`);
      if (!finalizeErrorKind) finalizeErrorKind = 'email_failed';
    }
    if (finalizeWarnings.length) {
      await recordFinalizeFailure(subRef, sub.memberId, finalizeWarnings.join(' '), finalizeErrorKind);
    }
  } catch (e) {
    // e.isChargeFailure is set only inside runChargeCurrentMonthWalks's own
    // paymentIntents.create() catch, at the exact point a real Stripe charge
    // attempt just failed (and currentMonthCharge.amount/failedAt were just
    // written there too, in that same catch — so kind:'charge_failed' below
    // always has both). That function's five PRE-charge throws (no time
    // slot, walk generation failed, no Stripe customer, no payment method,
    // no unit_amount) never reach that catch and carry no marker, so they
    // fall through to 'exception' here same as subscription creation, walk
    // generation, or anything else reaching this catch (the service/
    // overnight branch doesn't reach this catch for a charge failure at
    // all — see runServiceOrOvernightCharge) — none of those ever attempted
    // to move money, so none of them carry the same-key-retry risk a real
    // charge_failed does.
    await recordFinalizeFailure(subRef, sub.memberId, e.message, e.isChargeFailure ? 'charge_failed' : 'exception');
  }

  return { ready: true };
}

// Records a finalize-step failure durably in the two places an admin might
// look: finalizeError on the submission itself (request-scoped — which
// booking, what failed), and needsReview on the member's billing doc (so
// it also surfaces on the existing Members-table badge — renderBillingBadge,
// admin/dashboard.html). Never overwrites an existing, still-unresolved
// needsReview reason — an admin already looking at one flagged problem for
// this member shouldn't have it silently swapped for a different one.
// kind: 'exception' | 'charge_failed' | 'email_failed' — always written in
// the SAME set() call as finalizeError, never as a follow-up write, so a
// doc can never carry an error with no kind (the dashboard branches its
// entire Retry-vs-Dismiss-only treatment on this field). Callers must pass
// one; there is no default.
async function recordFinalizeFailure(subRef, memberId, message, kind) {
  console.error(`finalizeSubmissionIfReady (${kind}): ${message}`);
  await subRef.set({
    finalizeError: message, finalizeErrorAt: FieldValue.serverTimestamp(),
    finalizeErrorKind: kind,
    // Clears the claim so a retry (retryFinalizeSubmission, or the next
    // organic confirmCardOnFile/markDatesConfirmed trigger) can actually
    // run finalizeSubmissionIfReady's body again — see that function's own
    // transaction-claim comment. Safe now that runCreateMembershipSubscription
    // has its own idempotency guard (the one Stripe call in the finalize
    // path that didn't already have one); every other step here
    // (chargeCustomerCard, runChargeCurrentMonthWalks, walk-doc creation,
    // sendEmail) was already retry-safe on its own.
    //
    // Clearing this is harmless even for kind:'charge_failed', which never
    // becomes retryable regardless (see finalizeSubmissionIfReady's status
    // gate and retryFinalizeSubmission's own explicit rejection of that
    // kind) — an unclaimed flag on a submission nothing will re-enter
    // through isn't a hazard, just an unused door.
    billingFinalized: false,
  }, { merge: true }).catch(() => {});
  try {
    const billingSnap = await billingRef(memberId).get();
    if (!billingSnap.data()?.needsReview) {
      await billingRef(memberId).set({
        needsReview: true, needsReviewReason: 'finalize_charge_failed',
      }, { merge: true });
    }
  } catch (writeErr) {
    console.error(`finalizeSubmissionIfReady: failed to write needsReview for ${memberId}:`, writeErr.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Admin-triggered retry for a request stuck with a recorded finalizeError.
// Distinct from dismissing a needsReview/finalizeError flag: dismiss means
// "I fixed this manually, stop flagging it" (a plain field clear, no code
// runs); this means "run finalize again and see if it goes through now."
// Requires an existing finalizeError so it can't be used to force-finalize
// something that was never actually attempted or flagged — same
// precondition-gating posture as every other admin action in this file.
// Gated on STILL having finalizeError rather than just existing, since a
// stale/dismissed one shouldn't be retryable.
//
// kind: 'charge_failed' gets an EXTRA check, HERE, not just left to
// finalizeSubmissionIfReady's own status gate — this function is directly
// callable, so the dashboard's own gating is not a security or correctness
// boundary on its own. Covers TWO distinct Stripe idempotency keys, one per
// type: service/overnight's charge (chargeCustomerCard) uses
// `charge-saved-card:${submissionId}`; membership's monthly charge
// (runChargeCurrentMonthWalks) uses `current-month-walks:${memberId}:${periodKey}`
// — unrelated to any submissionId, since it bills the member's whole month,
// not one request. Both expire ~24 hours after the failed attempt; before
// that, a same-key retry can't do anything useful (replays the cached
// failure, or errors on a parameter mismatch if the payment method
// changed) — the check below rejects anything sooner, which is purely an
// efficiency/clarity thing (no point letting an admin "retry" into a
// guaranteed no-op).
//
// It is NOT what prevents a double-charge once 24h has passed — this
// function has no way to know whether the admin already charged the
// booking manually in Stripe in the meantime (that happens entirely
// outside this codebase; nothing here observes it). That protection is the
// dashboard's confirm() dialog, shown before this is ever called, asking
// the admin to actively confirm they haven't already charged manually.
// See chargeCustomerCard's idempotencyKey comment for the underlying
// mechanism this is all working around.
// ─────────────────────────────────────────────────────────────────────────
exports.retryFinalizeSubmission = onCall({
  secrets: [STRIPE_SECRET_KEY, RESEND_API_KEY],
}, async (request) => {
  await assertIsAdmin(request.auth);
  const { submissionId } = request.data || {};
  if (!submissionId) throw new HttpsError('invalid-argument', 'submissionId is required.');

  const subSnap = await db.collection('submissions').doc(submissionId).get();
  const sub = subSnap.data();
  if (!sub) throw new HttpsError('not-found', 'Submission not found.');
  // Also allowed with no recorded finalizeError at all: a request whose
  // dates were confirmed (or, for membership, whose account was created)
  // but that never actually reached 'confirmed' — the silent cardOnFile
  // gate finalizeSubmissionIfReady used to have (before service/overnight
  // bookings could confirm without a card) left exactly this state with
  // NOTHING recorded to retry, on top of the ordinary recorded-failure
  // case below. Scoped narrowly (still-pending/account_created, one of the
  // three types finalize ever handles) so this can't be used to re-run an
  // already-confirmed or declined request.
  const neverFinalized = ['membership_request', 'service_request', 'overnight_request'].includes(sub.type)
    && ['pending', 'account_created'].includes(sub.status);
  if (!sub.finalizeError && !neverFinalized) {
    throw new HttpsError('failed-precondition', 'This request has no recorded finalize failure to retry.');
  }
  if (sub.finalizeErrorKind === 'charge_failed') {
    // Gated on kind alone, not also on status === 'confirmed' — a
    // membership charge failure (runChargeCurrentMonthWalks throwing,
    // caught and re-marked above) never reaches 'confirmed' at all, it
    // stays at 'pending'/'account_created' the same as any other stuck
    // exception. The 24h risk this check exists for doesn't care what
    // status the doc is sitting at; it cares how long ago Stripe actually
    // processed the failed charge attempt.
    //
    // The failure timestamp lives in a different place depending on type:
    // service/overnight's charge (chargeCustomerCard) writes lastChargeAttempt
    // onto the SUBMISSION; membership's (runChargeCurrentMonthWalks) writes
    // currentMonthCharge onto the MEMBER's billing subdoc — that one charges
    // a member's monthly total, not any single submission, so it was never
    // going to live on this doc. No timestamp at all shouldn't happen —
    // finalizeErrorKind only ever becomes 'charge_failed' at the exact spot
    // each side writes its own failedAt in the same breath (chargeCustomerCard,
    // runChargeCurrentMonthWalks's paymentIntents.create catch) — but if it's
    // somehow missing, reject — the risk here is a double-charge, so "can't
    // verify 24h have passed" defaults to the same outcome as "24h haven't
    // passed."
    const isMembership = sub.type === 'membership_request';
    let failedAtRaw = null;
    if (isMembership) {
      const billingSnap = await billingRef(sub.memberId).get();
      failedAtRaw = billingSnap.data()?.currentMonthCharge?.failedAt || null;
    } else {
      failedAtRaw = sub.lastChargeAttempt?.failedAt || null;
    }
    const failedAt = failedAtRaw?.toDate ? failedAtRaw.toDate() : null;
    const hoursSinceFailure = failedAt ? (Date.now() - failedAt.getTime()) / (60 * 60 * 1000) : null;
    if (hoursSinceFailure === null || hoursSinceFailure < 24) {
      throw new HttpsError('failed-precondition', "This charge failed less than 24 hours ago — Stripe's idempotency key for it is still active, so retrying now would just replay the same failure, not a genuine new attempt. Charge manually in Stripe and dismiss, or wait until 24 hours have passed and retry here.");
    }
  }

  // viaExplicitRetry: true — this IS the explicit-retry path
  // finalizeSubmissionIfReady's own gate requires for a charge_failed doc,
  // on top of (not instead of) the 24h check just above and the dashboard's
  // confirm() dialog before this was ever called.
  const result = await finalizeSubmissionIfReady(submissionId, { viaExplicitRetry: true });
  if (!result.ready) {
    throw new HttpsError('failed-precondition', "This request isn't currently eligible to finalize — card and dates may no longer both be ready, or it may already be finalized.");
  }
  return result;
});

// ─────────────────────────────────────────────────────────────────────────
// Splits "dates confirmed" from "charged" for service_request/
// overnight_request. Previously one client-side action
// (confirmServiceRequest/confirmOvernight) reviewed dates, wrote the
// walk/overnights doc, AND charged, all together. Under the new flow a
// net-new service_request client has no card on file yet at this point —
// so "dates locked in" and "billable" are no longer always the same
// moment. This writes the reviewed values and creates the walk/overnights
// doc (same as before, see runServiceOrOvernightBookingDoc), but the
// charge itself is deferred to finalizeSubmissionIfReady, which only fires
// once a card is confirmed too.
//
// For a RETURNING member (portal-submitted service_request, or any
// overnight_request — both always have an existing card in billing
// already), finalize fires in this same call, so the end result is
// unchanged in practice from today — just routed through the shared
// finalize path instead of charging inline.
//
// `reviewed` values are admin-reviewed and passed in exactly as
// confirmServiceRequest/confirmOvernight's own review UI computes them
// today (rev-service, rev-start, rev-end, rev-total-override, visit-
// schedule review) — this function doesn't re-derive pricing or re-run the
// review logic, it commits what the admin already reviewed. Same division
// of responsibility as completeMeetGreetAndCreateAccount's `overrides`.
//
// DIFFERENCE FROM TODAY: startDate/endDate are built as noon UTC
// (`${dateStr}T12:00:00Z`), not noon in the admin's browser timezone like
// confirmServiceRequest/confirmOvernight's own startDate/endDate fields
// currently are. Same calendar date either way; only the exact stored
// instant changes. This matches the convention the walk-doc write already
// uses elsewhere (generateWalksForMember, and confirmServiceRequest's OWN
// walk-doc block, per its comment: "NOT startDate ... which is noon in the
// admin's OWN browser timezone, not UTC") — a real, deliberate fix to an
// existing inconsistency, not an accidental one.
// ─────────────────────────────────────────────────────────────────────────
exports.markDatesConfirmed = onCall({ secrets: [STRIPE_SECRET_KEY, RESEND_API_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);
  const {
    submissionId, service, startDate: startDateStr, endDate: endDateStr,
    timeSlot, extraPet, medication, visitSchedule, overnightVisitPlan, amountInDollars, unitCount,
    travelDiscountApplied, travelDiscountPercent,
  } = request.data || {};
  if (!submissionId) throw new HttpsError('invalid-argument', 'submissionId is required.');
  if (typeof amountInDollars !== 'number' || amountInDollars < 0) {
    throw new HttpsError('invalid-argument', 'amountInDollars must be a non-negative number.');
  }

  const subRef = db.collection('submissions').doc(submissionId);
  const subSnap = await subRef.get();
  const sub = subSnap.data();
  if (!sub) throw new HttpsError('not-found', 'Submission not found.');
  if (!['service_request', 'overnight_request'].includes(sub.type)) {
    throw new HttpsError('failed-precondition', `markDatesConfirmed doesn't apply to type "${sub.type}".`);
  }
  if (!sub.memberId) {
    throw new HttpsError('failed-precondition', 'This request has no linked account.');
  }
  if (sub.status === 'declined') {
    throw new HttpsError('failed-precondition', 'This request was declined.');
  }
  if (sub.datesConfirmedAt) {
    throw new HttpsError('failed-precondition', 'Dates were already confirmed for this request.');
  }

  const startDate = startDateStr ? Timestamp.fromDate(new Date(`${startDateStr}T12:00:00Z`)) : (sub.startDate || null);
  const endDate = endDateStr ? Timestamp.fromDate(new Date(`${endDateStr}T12:00:00Z`)) : (sub.endDate || null);
  const reviewed = {
    service: service || sub.service,
    startDate, endDate,
    timeSlot: timeSlot ?? sub.timeSlot ?? null,
    extraPet: !!extraPet, medication: !!medication,
    visitSchedule: visitSchedule || null,
    // Overnight-stay-only, and NEVER persisted onto the overnights doc
    // itself (see generateOvernightVisits) — a separate field from
    // visitSchedule specifically so it can never be mistaken for the field
    // calculateOvernightPayout keys off. Only used, transiently, to seed
    // that reservation's `visits` array at creation time.
    overnightVisitPlan: overnightVisitPlan || null,
    amountInDollars,
    // Carried through to whichever doc chargeCustomerCard eventually reads
    // (submission, directly via the {...reviewed} merge below, or the
    // overnights doc — see runServiceOrOvernightBookingDoc) — the marker
    // chargeCustomerCard's Friends & Family guard checks. Not re-derived or
    // validated here: the client already decided this when it computed
    // amountInDollars, and this function has never re-derived that number
    // either (see this function's own top-level comment).
    travelDiscountApplied: !!travelDiscountApplied,
    travelDiscountPercent: typeof travelDiscountPercent === 'number' ? travelDiscountPercent : 0,
    // Only meaningful for the "overnight-stay via service_request" charge
    // branch's confirmation email (portal-service-confirmed's unitCount —
    // nights stayed). Passed through from the client's own
    // calculateServiceTotal() call rather than re-derived here: pricing.js's
    // day-counting formula for that template isn't duplicated server-side,
    // so re-deriving it here risks silently disagreeing with the number the
    // client actually priced the charge on. Defaults to 1 wherever it
    // doesn't apply (walk, drop-in, overnight_request all ignore it).
    unitCount: typeof unitCount === 'number' && unitCount > 0 ? unitCount : 1,
  };

  await runServiceOrOvernightBookingDoc(sub, submissionId, sub.memberId, reviewed);

  await subRef.set({
    ...reviewed,
    // Legacy field-name mirrors, written alongside the canonical ones
    // above — admin/dashboard.html's read-only post-confirmation display
    // (the static field list shown once status is 'confirmed'/'declined',
    // NOT the review UI, which already reads the canonical names) still
    // reads estimatedTotal for both types, and addonExtraPet/addonMedication
    // for overnight_request specifically. Each type's own original public/
    // portal form used a different name for the same value at creation
    // time (service-request.html: extraPet/medication/estimatedTotal;
    // portal-request-extras.html: addonExtraPet/addonMedication/
    // estimatedTotal) — that display code reads whichever name its type
    // originally used and was never updated for what this function
    // introduced. Writing both here is simpler and less error-prone than
    // hunting down and changing every reader; `reviewed` above stays the
    // single internal contract everywhere else (runServiceOrOvernightBookingDoc,
    // runServiceOrOvernightCharge, the confirmation email) — only this
    // Firestore write also mirrors the legacy names.
    estimatedTotal: amountInDollars,
    ...(sub.type === 'overnight_request' ? { addonExtraPet: reviewed.extraPet, addonMedication: reviewed.medication } : {}),
    datesConfirmedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const finalizeResult = await finalizeSubmissionIfReady(submissionId);
  return { success: true, ...finalizeResult };
});

// ─────────────────────────────────────────────────────────────────────────
// Re-sends a booking confirmation for an ALREADY-confirmed walk or overnight/
// check-in reservation — e.g. the member says they never got it, or admin
// wants to nudge someone who still hasn't added a card. Unlike the original
// send (sendServiceOrOvernightConfirmationEmail), which runs at confirm time
// with the `reviewed` review-screen data already in scope, this rebuilds the
// template data entirely from the persisted walks/{id} or overnights/{id}
// doc — everything either template needs is already stored there, so there's
// nothing for the admin caller to re-supply beyond which record. needsCard
// is read live off billing rather than reused from the original send, so a
// member who's added a card since then correctly stops seeing that button.
// Always a genuinely new send: the idempotencyKey is unique per call (not
// reused from the original booking-confirmed:${submissionId} key), since the
// whole point is to send again, not to hit sendEmail's own dedupe guard.
exports.resendBookingConfirmationEmail = onCall({
  secrets: [RESEND_API_KEY],
}, async (request) => {
  await assertIsAdmin(request.auth);
  const { recordType, id } = request.data || {};
  if (recordType !== 'walk' && recordType !== 'overnight') {
    throw new HttpsError('invalid-argument', 'recordType must be "walk" or "overnight".');
  }
  if (!id) throw new HttpsError('invalid-argument', 'id is required.');

  const { SERVICE_PRICES } = await import('./pricing.js');
  const recordRef = db.collection(recordType === 'walk' ? 'walks' : 'overnights').doc(id);
  const recordSnap = await recordRef.get();
  const record = recordSnap.data();
  if (!record) throw new HttpsError('not-found', `${recordType === 'walk' ? 'Walk' : 'Reservation'} not found.`);
  if (!record.memberId) throw new HttpsError('failed-precondition', 'This record has no member attached.');

  const memberSnap = await db.collection('members').doc(record.memberId).get();
  const member = memberSnap.data();
  if (!member || !member.email) {
    throw new HttpsError('failed-precondition', 'This member has no email on file.');
  }
  const firstName = (member.name || '').trim().split(/\s+/)[0] || 'there';
  const petNames = (Array.isArray(member.dogs) ? member.dogs : []).map((d) => d && d.name).filter(Boolean);

  const billingSnap = await billingRef(record.memberId).get();
  const needsCard = !billingSnap.data()?.stripeCustomerId;
  const addCardUrl = `${BUSINESS_PORTAL_ORIGIN}/portal-account?addCard=1`;

  let template, data;
  if (recordType === 'walk') {
    template = 'walk-confirmed';
    data = {
      firstName, dogNames: petNames,
      walkTypeLabel: record.extended ? 'Extended Walk' : 'Standard Walk',
      durationMinutes: record.extended ? 45 : 30,
      walks: [{ dateStr: record.date?.toDate ? isoDateStr(record.date.toDate()) : null, slot: record.timeSlot || null }],
      needsCard, addCardUrl,
    };
  } else {
    // Both overnight-stay and drop-in-visit reservations live in the same
    // overnights collection with the same shape (see the unified booking
    // flow this file's top-of-file comment describes) and both use this one
    // template — see sendServiceOrOvernightConfirmationEmail's identical
    // isOvernightRequest-or-isCheckin branch above.
    const isCheckin = record.serviceType === 'drop-in-visit' || record.serviceType === 'checkin';
    template = 'portal-reservation-confirmed';
    data = {
      firstName, petNames,
      serviceLabel: SERVICE_PRICES[record.serviceType]?.name || record.serviceType,
      startDateStr: record.startDate?.toDate ? isoDateStr(record.startDate.toDate()) : null,
      endDateStr: record.endDate?.toDate ? isoDateStr(record.endDate.toDate()) : null,
      totalDollars: typeof record.confirmedTotalCents === 'number' ? record.confirmedTotalCents / 100 : null,
      chargeDateStr: record.chargeScheduledFor?.toDate ? isoDateStr(record.chargeScheduledFor.toDate()) : null,
      visitSchedule: isCheckin ? record.visitSchedule || null : null,
      needsCard, addCardUrl,
    };
  }

  const result = await sendEmail({
    to: member.email,
    template,
    data: { ...data, isNewAccount: false, portalSetupLink: null },
    idempotencyKey: `booking-confirmed:resend:${recordType}:${id}:${Date.now()}`,
  });
  if (!result.ok) {
    throw new HttpsError('internal', `Confirmation email failed to send: ${result.error}`);
  }
  return { success: true, sentTo: member.email, template };
});

// ─────────────────────────────────────────────────────────────────────────
// Booking-confirmed email — portal-service-confirmed or walk-confirmed,
// fired from confirmServiceRequest / confirmOvernight / confirmWalkExtension
// in admin/dashboard.html, for EVERY confirmation (new account or existing
// member alike), unlike the old sendOnboardingEmail(kind:'service') it
// replaces, which only ever fired for a freshly created account.
//
// The admin client shapes `data` to match whichever template it's calling
// (it already has service/dates/dogs/walks in scope at the exact point it
// charges the booking) — this callable's job is narrowly the parts only the
// Admin SDK can do: resolving the member's email and, for a new account,
// generating the portal-access link. Same "throw on failure, caller warns
// without undoing the booking" contract as sendOnboardingEmail.
// ─────────────────────────────────────────────────────────────────────────
exports.sendBookingConfirmedEmail = onCall({
  secrets: [RESEND_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET],
}, async (request) => {
  await assertIsAdmin(request.auth);
  const { memberId, template, data, isNewAccount, idempotencyKey } = request.data || {};
  if (!['portal-service-confirmed', 'walk-confirmed', 'portal-reservation-confirmed'].includes(template)) {
    throw new HttpsError('invalid-argument', 'template must be "portal-service-confirmed", "walk-confirmed", or "portal-reservation-confirmed".');
  }
  if (!memberId) throw new HttpsError('invalid-argument', 'memberId is required.');
  if (!idempotencyKey) throw new HttpsError('invalid-argument', 'idempotencyKey is required.');

  const memberSnap = await db.collection('members').doc(memberId).get();
  const member = memberSnap.data();
  if (!member || !member.email) {
    throw new HttpsError('failed-precondition', 'This member has no email on file.');
  }

  const finalData = { ...(data || {}) };
  if (isNewAccount) {
    const { getAuth } = require('firebase-admin/auth');
    finalData.isNewAccount = true;
    // ?welcome=1 — see the matching comment on sendOnboardingEmail's walker branch.
    finalData.portalSetupLink = await getAuth().generatePasswordResetLink(member.email, { url: `${BUSINESS_PORTAL_ORIGIN}/portal-login?welcome=1` });
  } else {
    finalData.isNewAccount = false;
    finalData.portalSetupLink = null;
  }

  const result = await sendEmail({ to: member.email, template, data: finalData, idempotencyKey });
  if (!result.ok) {
    throw new HttpsError('internal', `Booking confirmation email failed to send: ${result.error}`);
  }
  return { success: true, sentTo: member.email };
});

exports.gmailAuthUrl = onCall({ secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] }, async (request) => {
  await assertIsAdmin(request.auth);
  const oauth2Client = gmailOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh token, not just a short-lived access token
    prompt: 'consent',      // force the consent screen every time so a refresh token always comes back, even on reconnect
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  });
  return { url };
});

// ─────────────────────────────────────────────────────────────────────────
// 5. OAuth redirect target — Google sends the admin back here after they
//    approve access. Exchanges the code for tokens and stores the refresh
//    token (admin-only Firestore doc — see TODO.md for the security rule).
// ─────────────────────────────────────────────────────────────────────────
exports.gmailAuthCallback = onRequest({ secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] }, async (req, res) => {
  const code = req.query.code;
  if (!code) { res.status(400).send('Missing authorization code.'); return; }
  try {
    const oauth2Client = gmailOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      res.status(200).send(
        'Connected, but Google didn\'t send a refresh token — this usually happens if Gmail was ' +
        'already authorized once before. Go to your Google Account > Security > Third-party access, ' +
        'remove "Port City Leash Club Admin", then try Connect Gmail again.'
      );
      return;
    }
    await db.collection('system').doc('gmailAuth').set({
      refreshToken: tokens.refresh_token,
      connectedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    res.status(200).send(
      '<html><body style="font-family:sans-serif;padding:40px;text-align:center;">' +
      '<h2>Gmail connected ✓</h2><p>You can close this tab and go back to the admin portal.</p>' +
      '</body></html>'
    );
  } catch (e) {
    // Log the real error server-side for debugging; return a generic message
    // to the browser so raw error text isn't reflected back (L-2).
    console.error('Gmail OAuth callback failed:', e);
    res.status(500).send('Authorization failed. Please try again or check the logs.');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5b. Connection status for the admin portal's "Connect Gmail" button.
//     Deliberately returns only a boolean + timestamps, never the refresh
//     token — system/gmailAuth has no client-readable Firestore rule on
//     purpose, so the token never leaves the server.
// ─────────────────────────────────────────────────────────────────────────
exports.getGmailStatus = onCall(async (request) => {
  await assertIsAdmin(request.auth);
  const authDoc = await db.collection('system').doc('gmailAuth').get();
  const data = authDoc.data();
  return {
    connected: !!data?.refreshToken,
    connectedAt: data?.connectedAt?.toDate?.().toISOString() || null,
    lastSyncedAt: data?.lastSyncedAt?.toDate?.().toISOString() || null,
  };
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Poll Gmail for anything new since the last check — both the inbox
//    (member replies) and Sent (catches replies typed directly in Gmail,
//    not just ones sent through the portal). Runs every 5 minutes.
//    Scoped to mail involving hello@ specifically — the connected mailbox
//    is alison@ with hello@ as a "send mail as" alias, and alison@ likely
//    has other business-admin traffic (vendors, filings, etc.) that has no
//    business landing in a shared admin tool. Messages that don't match a
//    known member's email still get logged (not dropped) as an unlinked
//    conversation — an admin can identify and link it to a real member
//    from the inbox.
// ─────────────────────────────────────────────────────────────────────────
exports.gmailSyncPoll = onSchedule({ schedule: 'every 5 minutes', secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] }, async () => {
  const gmail = await getGmailClient();
  if (!gmail) return; // not connected yet

  const authDoc = await db.collection('system').doc('gmailAuth').get();
  const lastSyncedAt = authDoc.data()?.lastSyncedAt?.toDate?.() || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const afterUnix = Math.floor(lastSyncedAt.getTime() / 1000);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${afterUnix} (in:inbox OR in:sent) (to:${BUSINESS_EMAIL_ADDRESS} OR from:${BUSINESS_EMAIL_ADDRESS})`,
    maxResults: 50,
  });
  const messages = listRes.data.messages || [];

  for (const m of messages) {
    const metaRes = await gmail.users.messages.get({
      userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject'],
    });
    const headers = {};
    (metaRes.data.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

    const isFromMe = (headers.from || '').toLowerCase().includes(`@${BUSINESS_EMAIL_DOMAIN}`);
    const counterpartRaw = isFromMe ? headers.to : headers.from;
    const counterpartEmail = (counterpartRaw || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];

    const member = await findMemberByEmail(counterpartEmail);
    const targetId = member ? member.id : pseudoIdForEmail(counterpartEmail);

    const alreadyLogged = await db.collection('conversations').doc(targetId)
      .collection('messages').where('externalId', '==', m.id).limit(1).get();
    if (!alreadyLogged.empty) continue; // already have this one (e.g. sent through the portal)

    let body = headers.subject || '(no subject)';
    if (!isFromMe) {
      const fullRes = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      body = extractPlainTextBody(fullRes.data) || body;
    }

    await logConversationMessage(targetId, {
      channel: 'email',
      direction: isFromMe ? 'outbound' : 'inbound',
      body,
      subject: headers.subject || null,
      sentBy: isFromMe ? 'admin_via_gmail' : (member ? 'member' : counterpartEmail),
      // 'unmatched' mirrors the SMS unknown-number status — reserved for a
      // genuinely unrecognized inbound sender, not for admin proactively
      // emailing someone new via hello@ (that's a normal 'sent').
      status: (!isFromMe && !member) ? 'unmatched' : 'sent',
      externalId: m.id,
    }, member ? undefined : { name: parseFromDisplayName(headers.from), email: counterpartEmail });
  }

  await db.collection('system').doc('gmailAuth').set({ lastSyncedAt: FieldValue.serverTimestamp() }, { merge: true });
});

// ─────────────────────────────────────────────────────────────────────────
// 6b. Link an unlinked conversation (unrecognized email sender or SMS
//     number) to a real member — merges its message history into
//     conversations/{memberId} and deletes the pseudo-ID conversation, so
//     it doesn't sit permanently miscategorized just because someone
//     texted or emailed from an address that isn't on file.
// ─────────────────────────────────────────────────────────────────────────
exports.linkInquiryToMember = onCall(async (request) => {
  await assertIsAdmin(request.auth);
  const { inquiryId, memberId } = request.data || {};
  if (!inquiryId || !memberId) {
    throw new HttpsError('invalid-argument', 'inquiryId and memberId are required.');
  }
  if (inquiryId === memberId) {
    throw new HttpsError('invalid-argument', 'That conversation is already linked to this member.');
  }

  const memberSnap = await db.collection('members').doc(memberId).get();
  if (!memberSnap.exists) throw new HttpsError('not-found', 'Member not found.');
  const member = memberSnap.data();

  const inquiryRef = db.collection('conversations').doc(inquiryId);
  const inquirySnap = await inquiryRef.get();
  if (!inquirySnap.exists) throw new HttpsError('not-found', 'Conversation not found.');

  const messagesSnap = await inquiryRef.collection('messages').orderBy('createdAt', 'asc').get();
  if (messagesSnap.empty) throw new HttpsError('failed-precondition', 'Nothing to link — this conversation has no messages.');

  const targetRef = db.collection('conversations').doc(memberId);
  const targetSnap = await targetRef.get();
  const inquiryData = inquirySnap.data();
  const targetData = targetSnap.exists ? targetSnap.data() : {};

  // Move every message across. Batched at 450 ops (well under Firestore's
  // 500-per-batch cap) even though a real thread here is realistically a
  // handful of messages, not hundreds.
  let batch = db.batch();
  let opCount = 0;
  for (const msgDoc of messagesSnap.docs) {
    batch.set(targetRef.collection('messages').doc(), msgDoc.data());
    batch.delete(msgDoc.ref);
    opCount += 2;
    if (opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
  }

  // Recompute the target's summary from whichever thread has the more
  // recent activity — the inquiry's messages might be older or newer than
  // whatever's already in the target member's own conversation.
  const inquiryLastAt = inquiryData.lastMessageAt?.toMillis?.() || 0;
  const targetLastAt = targetData.lastMessageAt?.toMillis?.() || 0;
  const inquiryIsNewer = inquiryLastAt > targetLastAt;

  batch.set(targetRef, {
    memberId,
    memberName: member.name || null,
    memberEmail: member.email || null,
    memberPhone: member.phone || null,
    unlinked: false,
    lastMessageAt: inquiryIsNewer ? inquiryData.lastMessageAt : (targetData.lastMessageAt || inquiryData.lastMessageAt),
    lastMessagePreview: inquiryIsNewer ? inquiryData.lastMessagePreview : (targetData.lastMessagePreview || inquiryData.lastMessagePreview),
    lastMessageChannel: inquiryIsNewer ? inquiryData.lastMessageChannel : (targetData.lastMessageChannel || inquiryData.lastMessageChannel),
    unreadByAdmin: !!(inquiryData.unreadByAdmin || targetData.unreadByAdmin),
  }, { merge: true });

  batch.delete(inquiryRef);
  await batch.commit();

  return { success: true, movedCount: messagesSnap.size };
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Unified send — called from the admin portal's message composer.
//    Picks email (via Gmail) or sms (via Twilio) based on `channel`.
// ─────────────────────────────────────────────────────────────────────────
exports.sendMemberMessage = onCall({
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET],
}, async (request) => {
  await assertIsAdmin(request.auth);
  const { memberId, channel, body, subject } = request.data || {};
  if (!memberId || !channel || !body) {
    throw new HttpsError('invalid-argument', 'memberId, channel, and body are required.');
  }

  const memberSnap = await db.collection('members').doc(memberId).get();
  if (!memberSnap.exists) throw new HttpsError('not-found', 'Member not found.');
  const member = memberSnap.data();

  if (channel === 'email') {
    if (!member.email) throw new HttpsError('failed-precondition', 'This member has no email on file.');
    const sent = await sendGmailMessage({ to: member.email, subject: subject || 'Port City Leash Club', body });
    const messageId = await logConversationMessage(memberId, {
      channel: 'email', direction: 'outbound', body, subject,
      sentBy: request.auth.uid, status: 'sent', externalId: sent.id,
    });
    return { success: true, messageId };
  }

  if (channel === 'sms') {
    if (!member.phone) throw new HttpsError('failed-precondition', 'This member has no phone number on file.');
    if (!twilioConfigured()) throw new HttpsError('failed-precondition', 'Texting isn\'t set up yet — Twilio credentials haven\'t been added.');
    const client = twilioClient();
    const twilioMsg = await client.messages.create({ to: member.phone, from: TWILIO_PHONE_NUMBER.value(), body });
    const messageId = await logConversationMessage(memberId, {
      channel: 'sms', direction: 'outbound', body,
      sentBy: request.auth.uid, status: 'sent', externalId: twilioMsg.sid,
    });
    return { success: true, messageId };
  }

  throw new HttpsError('invalid-argument', 'channel must be "email" or "sms".');
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Inbound texts from members. This URL is configured in the Twilio
//    phone number's messaging settings ("A message comes in" webhook) —
//    see TODO.md for the exact URL and setup steps.
// ─────────────────────────────────────────────────────────────────────────
exports.twilioInboundWebhook = onRequest({ secrets: [TWILIO_AUTH_TOKEN] }, async (req, res) => {
  const twilioLib = require('twilio');

  // This endpoint has to be public (Twilio needs to reach it), so verify
  // the request is genuinely from Twilio before trusting anything in it.
  const signature = req.get('X-Twilio-Signature');
  const validRequest = twilioLib.validateRequest(TWILIO_AUTH_TOKEN.value(), signature, TWILIO_WEBHOOK_URL, req.body);
  if (!validRequest) {
    res.status(403).send('Invalid signature');
    return;
  }

  const from = req.body.From || '';
  const body = req.body.Body || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = numMedia > 0 ? req.body.MediaUrl0 : null;

  const member = await findMemberByPhone(from);
  if (member) {
    await logConversationMessage(member.id, {
      channel: 'sms', direction: 'inbound', body, mediaUrl,
      sentBy: 'member', status: 'received',
    });
  } else {
    // Doesn't match any member on file — log it under a per-number
    // placeholder thread rather than dropping it, so nothing is lost.
    // Admin can identify and link it to a real member from the inbox.
    const pseudoId = `unmatched_${from.replace(/[^0-9]/g, '')}`;
    await logConversationMessage(pseudoId, {
      channel: 'sms', direction: 'inbound', body, mediaUrl,
      sentBy: from, status: 'unmatched',
    }, { name: `Unknown number (${from})`, phone: from });
  }

  // Twilio expects a TwiML response even when empty — this means
  // "received, don't auto-reply."
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Automated walk-completion text — fires the moment a walker marks a
//    walk complete with a photo/note. No admin involvement, by design
//    (see business decision: routine walk updates bypass the inbox
//    entirely; only non-routine communication goes through admin).
//
//    ALSO rate-stamps the walk's payout here (same trigger, same guard) —
//    see the payout-stamping block below for why.
// ─────────────────────────────────────────────────────────────────────────
exports.onWalkCompleted = onDocumentUpdated({
  document: 'walks/{walkId}',
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, RESEND_API_KEY],
}, async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};

  // Only fire on the actual scheduled -> completed transition, not on
  // every subsequent edit to an already-completed walk.
  if (before.status === 'completed' || after.status !== 'completed') return;

  // ── PAYOUT RATE-STAMPING ──────────────────────────────────────────────
  // Fixes what this walk is worth AT COMPLETION TIME, immune to
  // WALKER_RATES changing later (the 45 -> 65 overnight change is why this
  // exists: without a stamp, a walk's payout retroactively shifts to
  // whatever WALKER_RATES says whenever it's later read, even long after
  // completion). walker-pricing.js is dynamically imported because it's an
  // ES module and this file is CommonJS — see the note at the top of that
  // file for how it gets deployed alongside this function.
  //
  // Runs unconditionally on a genuine completion, independent of the
  // member/phone/SMS logic below. The `after.payout` check is
  // defense-in-depth on top of the status-transition guard above: writing
  // `payout` back onto this same doc re-triggers this function, but that
  // re-invocation sees before.status already 'completed' and returns at
  // the guard above before ever reaching here — this check just makes that
  // explicit rather than relying solely on the guard's timing.
  if (!after.payout) {
    const { calculateWalkPayout } = await import('./walker-pricing.js');
    await event.data.after.ref.update({
      payout: {
        rateKey: after.extended ? 'extended' : 'standard',
        amount: calculateWalkPayout(after),
        stampedAt: FieldValue.serverTimestamp(),
      },
    });
  }

  if (!after.memberId) return;

  const memberSnap = await db.collection('members').doc(after.memberId).get();
  if (!memberSnap.exists) return;
  const member = memberSnap.data();

  const dogName = member.dogName || (Array.isArray(member.dogs) && member.dogs[0]?.name) || 'Your dog';
  const walkLink = `${BUSINESS_PORTAL_ORIGIN}/portal-walk-history?walk=${event.params.walkId}`;

  // ── SMS — no-ops (member.phone check) if there's nothing to text. Left
  // exactly as it was: still the only channel that stays silent while
  // Twilio is unconfigured (pending_credentials log, no throw).
  if (member.phone) {
    // Links out to the walk's card in the portal (Care History) instead of
    // attaching the photo as MMS media — one message works whether or not
    // there's a photo, notes of any length are readable in full at the link
    // rather than being crammed into the SMS itself, and the member can
    // revisit it later instead of only seeing the photo once in a text
    // thread. capped at 18 chars (see truncateForSms) so a long dog name can
    // never push this over one SMS segment (160 chars) — verified against
    // the actual link length below: fixed text + a worst-case-length walk id
    // is 139 chars, +18 for name = 157, comfortably under the limit.
    const body = `${truncateForSms(dogName, 18)} had a great walk! See notes and photos: ${walkLink}`;

    if (!twilioConfigured()) {
      await logConversationMessage(after.memberId, {
        channel: 'sms', direction: 'outbound', body, mediaUrl: after.photoUrl || null,
        sentBy: 'system', automated: true, status: 'pending_credentials',
      });
    } else {
      try {
        const client = twilioClient();
        const twilioMsg = await client.messages.create({
          to: member.phone,
          from: TWILIO_PHONE_NUMBER.value(),
          body,
        });
        await logConversationMessage(after.memberId, {
          channel: 'sms', direction: 'outbound', body, mediaUrl: after.photoUrl || null,
          sentBy: 'system', automated: true, status: 'sent', externalId: twilioMsg.sid,
        });
      } catch (e) {
        await logConversationMessage(after.memberId, {
          channel: 'sms', direction: 'outbound', body, mediaUrl: after.photoUrl || null,
          sentBy: 'system', automated: true, status: 'failed',
        });
        console.error('Walk-update text failed:', e.message);
      }
    }
  }

  // ── Email — sent regardless of phone presence or Twilio configuration,
  // same posture as onOvernightVisitCompleted's own email branch. Recurring
  // walks previously had NO working notification channel at all (SMS
  // silently no-ops without live Twilio credentials, and there was no
  // email equivalent) — this closes that gap.
  //
  // Gated on the walker actually having left a note or photo — a plain
  // "mark complete" with neither has nothing worth emailing about, and
  // would otherwise send an empty "here's an update" for every single walk.
  const hasUpdate = !!(after.notes || after.photoUrl);
  if (member.email && hasUpdate) {
    try {
      const { WALK_TIME_SLOT_LABELS } = await import('./time-slots.js');
      const petNames = Array.isArray(member.dogs) ? member.dogs.map((d) => d && d.name).filter(Boolean) : (member.dogName ? [member.dogName] : []);
      await sendEmail({
        to: member.email,
        template: 'walk-completed',
        data: {
          firstName: (member.name || '').trim().split(/\s+/)[0] || 'there',
          petNames,
          dateStr: isoDateStr(after.date.toDate()),
          slotLabel: WALK_TIME_SLOT_LABELS[after.timeSlot] || after.timeSlot || '',
          note: after.notes || '',
          photoUrl: after.photoUrl || null,
          portalUrl: walkLink,
        },
        idempotencyKey: `walk-completed:${event.params.walkId}`,
      });
    } catch (e) {
      // sendEmail's own contract is "never throws" — this catch exists only
      // as defense-in-depth so a future change to that contract can't
      // silently take this whole trigger (and the payout stamping above it)
      // down with it.
      console.error('onWalkCompleted: email threw unexpectedly:', e.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 9b. Overnight/check-in payout rate-stamping — fires once this doc's own
//    `status` reaches 'completed', which now only ever happens as a side
//    effect of completeVisit() (walker/dashboard.html) finishing the last
//    outstanding visit on the reservation, a plain client write with no
//    prior server-side hook (unlike walks, which already had
//    onWalkCompleted for SMS). Same guard pattern as onWalkCompleted, same
//    reasoning: fixes what a completed overnight is worth at the moment
//    it's marked done, immune to WALKER_RATES changing later. No SMS/
//    member-notification counterpart exists for overnights at the
//    reservation level (per-visit notifications are onOvernightVisitCompleted's
//    job instead), so this trigger only does the rate stamp.
// ─────────────────────────────────────────────────────────────────────────
exports.onOvernightCompleted = onDocumentUpdated({
  document: 'overnights/{overnightId}',
}, async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};

  // Only fire on the actual confirmed -> completed transition, not on every
  // subsequent edit to an already-completed overnight — identical guard to
  // onWalkCompleted, for the identical reason: this write re-triggers
  // itself (see below), and this is what stops that from looping or
  // double-stamping.
  if (before.status === 'completed' || after.status !== 'completed') return;
  if (after.payout) return; // defense-in-depth, see onWalkCompleted's note on the equivalent check

  const overnightId = event.params.overnightId;
  try {
    const { calculateOvernightPayout, WALKER_RATES } = await import('./walker-pricing.js');
    const payout = calculateOvernightPayout(after);

    await event.data.after.ref.update({
      payout: {
        rateKey: payout.key,
        rate: WALKER_RATES[payout.key],
        days: payout.days,
        // For a check-in paid per visit, baseTotal is rate * units (total
        // visits), not rate * days — units is stamped alongside days so the
        // record stays self-consistent instead of implying baseTotal ==
        // rate * days the way it always used to.
        units: payout.units,
        baseTotal: payout.base,
        extraPetTotal: payout.extraPetTotal,
        medicationTotal: payout.medicationTotal,
        amount: payout.total,
        stampedAt: FieldValue.serverTimestamp(),
      },
    });
  } catch (e) {
    // A failed calc must never fail silently — with no payout stamped and no
    // flag raised, a walker just doesn't get paid until they notice and ask.
    // Log everything needed to find and fix the record by hand, then flag it
    // the same way createMembershipSubscription/updateWalkSchedule already
    // flag other silent-failure-prone billing paths: needsReview on the
    // member's billing subdoc, surfaced by the existing badge in the admin
    // Members table (renderBillingBadge) — no new UI, reusing what's already
    // there and already checked. See dismissBillingReview for the clear side.
    console.error(
      `onOvernightCompleted: payout calculation failed for overnights/${overnightId} `
      + `(memberId=${after.memberId || 'unknown'}, walkerId=${after.walkerId || 'unknown'}, `
      + `startDate=${after.startDate?.toDate?.().toISOString() || after.startDate}, `
      + `endDate=${after.endDate?.toDate?.().toISOString() || after.endDate}):`,
      e.message
    );
    if (after.memberId) {
      await billingRef(after.memberId).set({
        needsReview: true, needsReviewReason: 'overnight_payout_calc_failed',
      }, { merge: true }).catch(writeErr => {
        console.error(`onOvernightCompleted: failed to write needsReview for ${after.memberId}:`, writeErr.message);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 9c. Automated per-visit completion notice — fires the moment a walker
//    marks an individual overnight/check-in VISIT complete (completeVisit(),
//    walker/dashboard.html), same "no admin involvement" posture as
//    onWalkCompleted above. `visits` is a plain array field on the
//    overnights doc (see generateOvernightVisits), not a subcollection, so
//    there's no per-visit document to trigger on — this diffs before/after
//    to find which specific visit(s) actually flipped
//    expected -> completed in THIS write, and notifies once per visit.
//
//    Unlike onWalkCompleted/onOvernightCompleted, this trigger never writes
//    back to the doc it's triggered by (no payout stamping happens here —
//    that's still entirely calculateOvernightPayout's job, untouched), so
//    there's no self-retrigger loop to guard against. The guard below only
//    has to rule out a write that leaves an already-completed visit's
//    status untouched (e.g. a later, unrelated edit to the same doc).
//
//    SMS and email are independent sends: each is fully contained in its
//    own try/catch (sendEmail also never throws by its own contract — see
//    functions/lib/email.js), so a Twilio failure can never prevent the
//    email from going out, or vice versa.
// ─────────────────────────────────────────────────────────────────────────
exports.onOvernightVisitCompleted = onDocumentUpdated({
  document: 'overnights/{overnightId}',
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, RESEND_API_KEY],
}, async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const overnightId = event.params.overnightId;

  const afterVisits = Array.isArray(after.visits) ? after.visits : [];
  if (!afterVisits.length) return;

  const beforeById = new Map((Array.isArray(before.visits) ? before.visits : []).map(v => [v.id, v]));
  const newlyCompleted = afterVisits.filter(v => v.status === 'completed' && beforeById.get(v.id)?.status !== 'completed');
  if (!newlyCompleted.length) return;

  if (!after.memberId) return;
  const memberSnap = await db.collection('members').doc(after.memberId).get();
  if (!memberSnap.exists) return;
  const member = memberSnap.data();

  const { VISIT_SLOT_LABELS } = await import('./visit-slots.js');
  const isCheckin = after.serviceType === 'drop-in-visit' || after.serviceType === 'checkin';
  const serviceLabel = isCheckin ? 'Drop-In Visit' : 'Overnight Stay';
  const petNames = Array.isArray(member.dogs) ? member.dogs.map((d) => d && d.name).filter(Boolean) : (member.dogName ? [member.dogName] : []);

  for (const visit of newlyCompleted) {
    const portalUrl = `${BUSINESS_PORTAL_ORIGIN}/portal-walk-history?overnight=${overnightId}&visit=${visit.id}`;

    // ── SMS — mirrors onWalkCompleted's structure exactly: member-phone
    // guard, twilioConfigured() check, pending_credentials fallback,
    // conversations log write on every outcome. Generic body text (no pet
    // name interpolated) so the 160-char budget is fixed and provably safe
    // regardless of pet name length — unlike the walk link, an
    // ?overnight=&visit= link alone leaves very little room (see this
    // trigger's own char-count note in the commit report).
    if (member.phone) {
      const body = `Today's visit is complete. Notes and photos: ${portalUrl}`;
      if (!twilioConfigured()) {
        await logConversationMessage(after.memberId, {
          channel: 'sms', direction: 'outbound', body, mediaUrl: visit.photoUrl || null,
          sentBy: 'system', automated: true, status: 'pending_credentials',
        }).catch((e) => console.error(`onOvernightVisitCompleted: pending_credentials log failed for visit ${visit.id}:`, e.message));
      } else {
        try {
          const client = twilioClient();
          const twilioMsg = await client.messages.create({ to: member.phone, from: TWILIO_PHONE_NUMBER.value(), body });
          await logConversationMessage(after.memberId, {
            channel: 'sms', direction: 'outbound', body, mediaUrl: visit.photoUrl || null,
            sentBy: 'system', automated: true, status: 'sent', externalId: twilioMsg.sid,
          });
        } catch (e) {
          console.error(`onOvernightVisitCompleted: SMS failed for visit ${visit.id}:`, e.message);
          await logConversationMessage(after.memberId, {
            channel: 'sms', direction: 'outbound', body, mediaUrl: visit.photoUrl || null,
            sentBy: 'system', automated: true, status: 'failed',
          }).catch((logErr) => console.error(`onOvernightVisitCompleted: failed-status log failed for visit ${visit.id}:`, logErr.message));
        }
      }
    }

    // ── Email — sent regardless of phone presence or Twilio configuration,
    // unlike SMS above. idempotencyKey is per-visit (overnightId + visitId),
    // not per-doc, so completing a second visit on the same reservation
    // later is a fresh send, not deduped against the first visit's email.
    // Gated on the walker actually having left a note or photo for THIS
    // visit — same rule and reasoning as onWalkCompleted's hasUpdate guard
    // above; a plain "mark complete" with neither has nothing worth
    // emailing about. Checked per-visit (not per-doc) since newlyCompleted
    // can contain several visits in one write, each with its own note/photo.
    const hasUpdate = !!(visit.note || visit.photoUrl);
    if (member.email && hasUpdate) {
      try {
        await sendEmail({
          to: member.email,
          template: 'visit-completed',
          data: {
            firstName: (member.name || '').trim().split(/\s+/)[0] || 'there',
            petNames,
            serviceLabel,
            dateStr: visit.date,
            slotLabel: VISIT_SLOT_LABELS[visit.slot] || visit.slot || '',
            note: visit.note || '',
            photoUrl: visit.photoUrl || null,
            portalUrl,
          },
          idempotencyKey: `visit-completed:${overnightId}:${visit.id}`,
        });
      } catch (e) {
        // sendEmail's own contract is "never throws" — this catch exists
        // only as defense-in-depth so a future change to that contract
        // can't silently take this whole trigger down with it.
        console.error(`onOvernightVisitCompleted: email threw unexpectedly for visit ${visit.id}:`, e.message);
      }
    }
  }
});

// Admin-facing notification for billing.needsReview — see
// functions/templates/billing-needs-review.js for the email itself and
// NEEDS_REVIEW_LABELS in admin/dashboard.html for the badge this mirrors.
// Deliberately a trigger on the billing doc's own state, not another write
// at each of the ~11 places that set needsReview:true (createMembershipSubscription,
// finalizeNewMemberReferralDiscount, runFirstPaymentReferralCredit,
// chargeScheduledReservations, updateWalkSchedule, onOvernightCompleted,
// confirmCardOnFile, getCardOnFile, finalizeSubmissionIfReady) — several of
// those have their own deliberate, comment-documented error-handling
// behavior, and reacting to the resulting document state instead of
// instrumenting every call site means none of them need to change.
//
// The before/after comparison IS the duplicate-email guard: only a
// false/undefined -> true transition fires. A write that sets needsReview:
// true while it's already true (a retried operation re-flagging the same
// unresolved incident) is a no-op transition and does not re-notify.
// dismissBillingReview sets needsReview back to false, so a genuinely new
// incident afterward is a fresh false -> true transition and fires again
// correctly — no separate "already notified" flag needed for that case.
//
// idempotencyKey is keyed on this specific trigger event (event.id), not
// just memberId/reason — guards only against Cloud Functions redelivering
// the SAME event (its documented at-least-once delivery guarantee), not
// against two different genuine incidents, which must each get their own
// email.
exports.onBillingNeedsReview = onDocumentUpdated({
  document: 'members/{memberId}/private/billing',
  secrets: [RESEND_API_KEY],
}, async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  if (before.needsReview || !after.needsReview) return;

  const memberId = event.params.memberId;
  const memberSnap = await db.collection('members').doc(memberId).get();
  const memberName = memberSnap.data()?.name || null;

  // sendEmail never throws (see functions/lib/email.js) and this trigger
  // only runs after the needsReview write has already committed, so a send
  // failure here can't affect that write or whatever operation caused it —
  // there's nothing left to roll back by the time this trigger even starts.
  await sendEmail({
    to: ADMIN_EMAIL,
    template: 'billing-needs-review',
    data: {
      memberName,
      memberId,
      reason: after.needsReviewReason || null,
      flaggedAt: event.time,
    },
    idempotencyKey: `billing-needs-review:${memberId}:${event.id}`,
  });
});

function isoDateStr(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// A claimed walks/{id} doc -> one walkerPayments.items[] entry. Reads
// entirely from the doc's already-stamped `payout` (see onWalkCompleted) —
// never recomputes from live WALKER_RATES, so a rate change after this
// walk was completed can't retroactively change what this payment record
// says it paid.
// tipAmount reads only chargeStatus: 'charged' tips — a failed or never-
// attempted tip contributes nothing, same posture as the payout amount
// itself never guessing at an uncertain number.
function chargedTipAmount(tip) {
  return tip?.chargeStatus === 'charged' ? tip.amountCents / 100 : 0;
}

function walkItemFromSnap(snap) {
  const w = snap.data();
  const tipAmount = chargedTipAmount(w.tip);
  return {
    type: 'walk', refCollection: 'walks', refId: snap.id, date: w.date,
    rateKey: w.payout.rateKey, rateApplied: w.payout.amount,
    extraPet: false, medication: false, amount: w.payout.amount + tipAmount, tipAmount,
  };
}

// Same, for a claimed overnights/{id} doc — reads entirely from the
// stamped `payout` (see onOvernightCompleted). payout is stamped ONCE for
// the whole reservation (this doc's own top-level status), but a tip is
// collected per completed VISIT inside it (portal-walk-history.html shows
// one Care History card per visit) — so this sums every visit's tip into
// the one payout item this reservation contributes. A tip added to a visit
// AFTER this reservation's payout has already been generated and claimed
// (payoutId set) is not retroactively picked up by a later payout run —
// same "claimed once" model every other item here already has.
function overnightItemFromSnap(snap) {
  const o = snap.data();
  const tipAmount = (Array.isArray(o.visits) ? o.visits : [])
    .reduce((sum, v) => sum + chargedTipAmount(v.tip), 0);
  return {
    type: o.payout.rateKey === 'checkin' ? 'checkin' : 'overnight',
    refCollection: 'overnights', refId: snap.id, date: o.startDate,
    rateKey: o.payout.rateKey, rateApplied: o.payout.rate,
    extraPet: !!o.extraPet, medication: !!o.medication, amount: o.payout.amount + tipAmount, tipAmount,
  };
}

// Per-category rollup, same shape as walker-pricing.js's calculateEarnings()
// breakdown — built from the same stamped payout data as the items above,
// not a separate recalculation.
function buildPayoutCounts(walkSnaps, overnightSnaps) {
  const counts = {
    standard: { count: 0, total: 0 }, extended: { count: 0, total: 0 },
    checkin: { count: 0, total: 0 }, overnight: { count: 0, total: 0 },
    extraPet: { count: 0, total: 0 }, medication: { count: 0, total: 0 },
    tips: { count: 0, total: 0 },
  };
  walkSnaps.forEach(snap => {
    const w = snap.data();
    counts[w.payout.rateKey].count++;
    counts[w.payout.rateKey].total += w.payout.amount;
    const tipAmount = chargedTipAmount(w.tip);
    if (tipAmount) { counts.tips.count++; counts.tips.total += tipAmount; }
  });
  overnightSnaps.forEach(snap => {
    const o = snap.data();
    counts[o.payout.rateKey].count++;
    counts[o.payout.rateKey].total += o.payout.baseTotal;
    if (o.payout.extraPetTotal) { counts.extraPet.count++; counts.extraPet.total += o.payout.extraPetTotal; }
    if (o.payout.medicationTotal) { counts.medication.count++; counts.medication.total += o.payout.medicationTotal; }
    const tipAmount = (Array.isArray(o.visits) ? o.visits : [])
      .reduce((sum, v) => sum + chargedTipAmount(v.tip), 0);
    if (tipAmount) { counts.tips.count++; counts.tips.total += tipAmount; }
  });
  return counts;
}

// Generates a walker's payout — admin-only, and the piece that decides
// what a contractor actually gets paid, so every guarantee below is
// deliberate, not incidental:
//
// - Claims every completed, non-demo, not-yet-claimed walk/overnight for
//   this walker. periodStart/periodEnd are a LABEL on the resulting
//   record (when this batch was cut), not a filter on which items are
//   eligible — deliberately unbounded by date. A walk completed after an
//   earlier period's payout already went out must still get paid
//   eventually, not silently vanish because its own `date` falls inside an
//   already-closed period; the payoutId==null claim state is the actual
//   source of truth for "what's still owed," not any date range. It simply
//   isn't claimed by anything until the NEXT time this runs for this
//   walker, whenever that is, and lands on THAT payment's period label.
// - demo/already-claimed filtering happens in application code, not a
//   Firestore query clause — Firestore's `!=` and `==null` operators both
//   SKIP documents where the field is simply absent (true of every
//   pre-existing walk/overnight, which never had `demo` or `payoutId` set),
//   which would silently exclude exactly the real work this needs to
//   include. A plain equality filter on walkerId/status avoids that trap;
//   everything else is filtered here, in code that's easy to read directly.
// - Every included item must already have a stamped `payout` (written by
//   onWalkCompleted/onOvernightCompleted at completion time). If any
//   claimed item lacks one — genuinely old data predating rate-stamping,
//   or this running in the few-second window before that trigger has
//   finished — this walker's ENTIRE payout is blocked rather than pricing
//   that item at $0 or guessing a rate. `total` is always the sum of
//   already-stamped item amounts, never a live WALKER_RATES recalculation.
// - Double-payment protection, two layers: the payment doc's ID is
//   deterministic (`{walkerId}_{periodStart}`) and written with tx.create()
//   inside a transaction that first checks it doesn't already exist — a
//   second generate() for the same walker+period fails loudly, no
//   duplicate record. Separately, every claimed walk/overnight is re-read
//   INSIDE that same transaction (not trusted from the query above) and
//   stamped with this payment's ID as part of the one atomic commit — if a
//   concurrent generate() call (same walker, any period) claims one of
//   these same items first, Firestore detects this transaction's reads
//   went stale and retries it, so the retry's re-read correctly excludes
//   whatever the other call already claimed. An item can only ever belong
//   to one payment record, regardless of how many calls race for it.
// Separated from the onCall wrapper below so the actual claiming logic is
// directly callable (and testable) without going through Cloud Functions'
// HTTPS/auth-token layer — adminUid is passed in explicitly rather than
// read from request.auth.
async function runGenerateWalkerPayout(adminUid, { walkerId, periodStart, periodEnd } = {}) {
  if (!walkerId) throw new HttpsError('invalid-argument', 'walkerId is required.');
  const periodStartDate = parseIsoDateStrict(periodStart);
  const periodEndDate = parseIsoDateStrict(periodEnd);
  if (!periodStartDate || !periodEndDate) {
    throw new HttpsError('invalid-argument', 'periodStart and periodEnd must be YYYY-MM-DD dates.');
  }
  if (periodEndDate <= periodStartDate) {
    throw new HttpsError('invalid-argument', 'periodEnd must be after periodStart.');
  }

  const walkerSnap = await db.collection('walkers').doc(walkerId).get();
  if (!walkerSnap.exists) throw new HttpsError('not-found', 'Walker not found.');
  const walker = walkerSnap.data();

  const paymentId = `${walkerId}_${isoDateStr(periodStartDate)}`;
  const paymentRef = db.collection('walkerPayments').doc(paymentId);

  // Checked here, before even looking at unclaimed work, so "this period
  // already has a payout" is ALWAYS a clear, immediate error — never masked
  // by a "nothing to pay" result just because everything from that period
  // happens to already be claimed (which would otherwise be indistinguishable
  // from a walker who genuinely has no outstanding work). Re-checked again
  // inside the transaction below for genuine concurrent-race protection —
  // this early check only exists to fail fast with a clean message in the
  // common, non-racing case.
  const existingCheck = await paymentRef.get();
  if (existingCheck.exists) {
    throw new HttpsError('already-exists', `A payout already exists for this walker and period: ${paymentId}.`);
  }

  const [walksSnap, overnightsSnap] = await Promise.all([
    db.collection('walks').where('walkerId', '==', walkerId).where('status', '==', 'completed').get(),
    db.collection('overnights').where('walkerId', '==', walkerId).where('status', '==', 'completed').get(),
  ]);

  const isUnclaimed = (doc) => {
    const d = doc.data();
    return d.demo !== true && !d.payoutId;
  };
  const unclaimedWalks = walksSnap.docs.filter(isUnclaimed);
  const unclaimedOvernights = overnightsSnap.docs.filter(isUnclaimed);

  if (!unclaimedWalks.length && !unclaimedOvernights.length) {
    return { status: 'no_unclaimed_work', walkerId, total: 0 };
  }

  const unstamped = [...unclaimedWalks, ...unclaimedOvernights].filter(d => !d.data().payout);
  if (unstamped.length) {
    throw new HttpsError(
      'failed-precondition',
      `${unstamped.length} completed item(s) for this walker have no stamped payout rate and cannot be priced ` +
      `automatically: ${unstamped.map(d => d.ref.path).join(', ')}. Stamp a payout on each (or wait a few seconds ` +
      `and retry, in case completion just happened) before generating this walker's payout.`
    );
  }

  return db.runTransaction(async (tx) => {
    const existingPayment = await tx.get(paymentRef);
    if (existingPayment.exists) {
      throw new HttpsError('already-exists', `A payout already exists for this walker and period: ${paymentId}.`);
    }

    const freshWalks = await Promise.all(unclaimedWalks.map(d => tx.get(d.ref)));
    const freshOvernights = await Promise.all(unclaimedOvernights.map(d => tx.get(d.ref)));
    const stillUnclaimedWalks = freshWalks.filter(s => s.exists && !s.data().payoutId);
    const stillUnclaimedOvernights = freshOvernights.filter(s => s.exists && !s.data().payoutId);

    if (!stillUnclaimedWalks.length && !stillUnclaimedOvernights.length) {
      // Everything this call found was claimed by a concurrent generate()
      // between the query above and this transaction committing.
      return { status: 'no_unclaimed_work', walkerId, total: 0 };
    }

    const items = [...stillUnclaimedWalks.map(walkItemFromSnap), ...stillUnclaimedOvernights.map(overnightItemFromSnap)];
    const counts = buildPayoutCounts(stillUnclaimedWalks, stillUnclaimedOvernights);
    const total = items.reduce((sum, i) => sum + i.amount, 0);

    tx.create(paymentRef, {
      walkerId,
      walkerName: walker.name || null,
      periodStart: Timestamp.fromDate(periodStartDate),
      periodEnd: Timestamp.fromDate(periodEndDate),
      status: 'pending',
      items,
      counts,
      total,
      generatedAt: FieldValue.serverTimestamp(),
      generatedBy: adminUid,
      paidAt: null,
      paidBy: null,
      quickbooksReference: null,
    });

    stillUnclaimedWalks.forEach(s => tx.update(s.ref, { payoutId: paymentId }));
    stillUnclaimedOvernights.forEach(s => tx.update(s.ref, { payoutId: paymentId }));

    return { status: 'generated', walkerId, paymentId, total, itemCount: items.length };
  });
}

exports.generateWalkerPayout = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);
  return runGenerateWalkerPayout(request.auth.uid, request.data || {});
});
// Exposed directly (not just via the onCall wrapper above) so this
// money-critical logic can be exercised and verified without needing a
// real ID token / HTTPS round trip for every check.
exports.runGenerateWalkerPayout = runGenerateWalkerPayout;

// Marks a walkerPayments record paid — admin-only, and only pending -> paid.
// Transactional for the same reason issueRefund's status-flip is: if "Mark
// Paid" is clicked twice (double-click, two admin tabs), only one call ever
// observes status === 'pending' — the other's re-read after the first
// commits sees 'paid' and throws, rather than silently re-stamping paidAt/
// paidBy a second time.
async function runMarkPaid(adminUid, { paymentId, quickbooksReference } = {}) {
  if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId is required.');
  if (quickbooksReference != null && (typeof quickbooksReference !== 'string' || quickbooksReference.length > 200)) {
    throw new HttpsError('invalid-argument', 'quickbooksReference must be a string of 200 characters or fewer.');
  }

  const paymentRef = db.collection('walkerPayments').doc(paymentId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(paymentRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Payment record not found.');
    const payment = snap.data();
    if (payment.status !== 'pending') {
      throw new HttpsError('failed-precondition', `This payment is already '${payment.status}' — cannot mark paid again.`);
    }
    tx.update(paymentRef, {
      status: 'paid',
      paidAt: FieldValue.serverTimestamp(),
      paidBy: adminUid,
      quickbooksReference: quickbooksReference || null,
    });
    return { status: 'paid', paymentId };
  });
}

exports.markPaid = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);
  return runMarkPaid(request.auth.uid, request.data || {});
});
exports.runMarkPaid = runMarkPaid;

// ─────────────────────────────────────────────────────────────────────────
// 10. Email notification for every new request (membership request, service
//    request, application, contact form, reschedule, pause, tier change,
//    dog roster update — everything that lands in the admin "Requests"
//    tab). Sends TO and FROM whichever address authorized the Gmail
//    connection, so there's no separate "notification email" setting to
//    keep in sync — it just goes to whoever connected Gmail.
// ─────────────────────────────────────────────────────────────────────────
const REQUEST_TYPE_LABELS = {
  membership_request: 'New membership request',
  service_request: 'New service request',
  application: 'New walker application',
  contact: 'New contact form message',
  reschedule: 'Walk reschedule request',
  pause_membership: 'Membership pause request',
  vacation_hold_refund: 'Vacation hold refund request',
  tier_change: 'Membership tier change request',
  dog_update: 'Dog roster update',
  overnight_request: 'Overnight / drop-in request',
  walker_incident: 'Walker incident report',
  walker_schedule_request: 'Walker schedule request',
};

// Meet & greet slots are stored as one string on the submission, e.g.
// "2026-08-14 5:30pm" — there is no separate meet-and-greet collection or
// submission type. Returns null for anything unparseable; dateStr is used as
// a Firestore document ID below, so the format is validated rather than
// trusted.
function parseMeetGreetDateTime(value) {
  if (typeof value !== 'string') return null;
  const [dateStr, ...rest] = value.trim().split(' ');
  const slot = rest.join(' ').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !slot) return null;
  return { dateStr, slot };
}

// ── onNewSubmission's per-type email senders ────────────────────────────
// Each resolves its own recipient and builds its own data. Unlike
// sendEmail() itself, these DO throw — a dynamic import() failing, a
// members/{id}.get() rejecting, or a Promise.all() over walk lookups
// throwing all propagate straight out. That's why the switch below wraps
// the whole dispatch in one try/catch: an uncaught throw here would abort
// onNewSubmission before it ever reaches the meet & greet mirror/Gmail
// alert further down, and Firestore's retry of the trigger would then
// re-run that alert send too — which has no idempotency key of its own, so
// a retry means a duplicate admin alert, and a persistent failure means no
// alert at all for a booked meet & greet. The requester-facing emails
// above are idempotency-keyed and safe to retry; the meet & greet mirror
// isn't optional, so this failure must never take it down too.

async function dispatchSubmissionEmail(sub, submissionId) {
  switch (sub.type) {
    case 'membership_request':
      await sendMembershipRequestReceivedEmail(sub, submissionId);
      break;
    case 'service_request':
      if (sub.memberId) {
        await sendPortalServiceRequestReceivedEmail(sub, submissionId);
      } else {
        await sendServiceRequestReceivedEmail(sub, submissionId);
      }
      break;
    case 'overnight_request':
      await sendPortalServiceRequestReceivedEmail(sub, submissionId);
      break;
    case 'walk_extension':
      await sendPortalWalkRequestReceivedEmail(sub, submissionId);
      break;
    default:
      // No automated email for this type — reviewed in the admin Requests
      // tab instead (contact, dog_update, reschedule, pause_membership,
      // vacation_hold_refund, tier_change, application, walker_screening,
      // walker_incident, walker_schedule_request, waitlist).
      break;
  }
}

async function sendMembershipRequestReceivedEmail(sub, submissionId) {
  if (!sub.email) return;
  const meetGreet = parseMeetGreetDateTime(sub.meetGreetDateTime);
  const result = await sendEmail({
    to: sub.email,
    template: 'membership-request-received',
    data: {
      firstName: (sub.ownerName || '').trim().split(/\s+/)[0] || 'there',
      dogNames: Array.isArray(sub.dogs) ? sub.dogs.map((d) => d && d.name).filter(Boolean) : [],
      tier: sub.plan || null,
      meetGreetDateStr: meetGreet?.dateStr || null,
      meetGreetSlot: meetGreet?.slot || null,
      address: sub.address || null,
    },
    idempotencyKey: `membership-request-received:${submissionId}`,
  });
  if (!result.ok) console.error(`onNewSubmission: membership-request-received failed for ${submissionId}:`, result.error);
}

// New (public-form, no account yet) service_request — pet sitting or a
// one-time walk, disambiguated via pricing.js's SERVICE_PRICES[key].unit,
// the same source of truth the charge calculations already use. Dynamic
// import: pricing.js is an ES module (shared with the browser-side forms),
// this file is CommonJS, same pattern walker-pricing.js already uses from
// onWalkCompleted.
async function sendServiceRequestReceivedEmail(sub, submissionId) {
  if (!sub.email) return;
  const { SERVICE_PRICES, resolveServiceKey } = await import('./pricing.js');
  const info = SERVICE_PRICES[resolveServiceKey(sub.service)];
  const serviceFamily = info?.unit === 'walk' ? 'walk' : 'pet-sitting';
  const meetGreet = parseMeetGreetDateTime(sub.meetGreetDateTime);
  const result = await sendEmail({
    to: sub.email,
    template: 'service-request-received',
    data: {
      firstName: (sub.ownerName || '').trim().split(/\s+/)[0] || 'there',
      petNames: Array.isArray(sub.dogs) ? sub.dogs.map((d) => d && d.name).filter(Boolean) : [],
      serviceFamily,
      meetGreetDateStr: meetGreet?.dateStr || null,
      meetGreetSlot: meetGreet?.slot || null,
      address: sub.address || null,
    },
    idempotencyKey: `service-request-received:${submissionId}`,
  });
  if (!result.ok) console.error(`onNewSubmission: service-request-received failed for ${submissionId}:`, result.error);
}

// Existing member's portal pet-sitting request (overnight_request, or a
// service_request that already carries memberId). portal-request-extras.html
// only ever offers Overnight Stay / Drop-In Visit — always pet sitting,
// never a walk (portal walk requests are a separate submission type,
// walk_extension, handled by sendPortalWalkRequestReceivedEmail). Neither
// submission shape carries dogs[] or a name — both are resolved from the
// member doc, which portal-request-extras.html doesn't duplicate onto the
// submission itself.
async function sendPortalServiceRequestReceivedEmail(sub, submissionId) {
  if (!sub.memberId) return;
  const memberSnap = await db.collection('members').doc(sub.memberId).get();
  const member = memberSnap.data();
  if (!member || !member.email) return;

  const { SERVICE_PRICES, resolveServiceKey, getDaysBetween } = await import('./pricing.js');
  const key = resolveServiceKey(sub.service);
  const info = SERVICE_PRICES[key];
  const startDate = sub.startDate?.toDate?.();
  const endDate = sub.endDate?.toDate?.();
  const isDropIn = key === 'drop-in-visit';
  // Nights (overnight-stay) are exactly the date range — no approximation.
  // Visits (drop-in) are NOT: portal-request-extras.html never collects
  // visitsPerDay, so days-between would silently understate however many
  // visits per day the member actually wants. Omitted rather than guessed —
  // the template drops the Length row entirely when this is null.
  const unitCount = (!isDropIn && startDate && endDate) ? Math.max(getDaysBetween(startDate, endDate), 1) : null;

  const result = await sendEmail({
    to: member.email,
    template: 'portal-service-request-received',
    data: {
      firstName: (member.name || '').trim().split(/\s+/)[0] || 'there',
      petNames: Array.isArray(member.dogs) ? member.dogs.map((d) => d && d.name).filter(Boolean) : [],
      serviceLabel: info?.name || sub.service || 'Service',
      startDateStr: startDate ? isoDateStr(startDate) : '',
      endDateStr: endDate ? isoDateStr(endDate) : '',
      unitCount,
      unitNoun: isDropIn ? 'visit' : 'night',
    },
    idempotencyKey: `portal-service-request-received:${submissionId}`,
  });
  if (!result.ok) console.error(`onNewSubmission: portal-service-request-received failed for ${submissionId}:`, result.error);
}

// Existing member's extra/extended walk request (walk_extension,
// portal-extend-walk.html). The submission carries only walkIds, no dates —
// the actual date/timeSlot for each lives on the referenced walks/{id}
// docs, so those are fetched individually (walkIds is always a small
// handful, never worth a batched query).
async function sendPortalWalkRequestReceivedEmail(sub, submissionId) {
  if (!sub.memberId) return;
  const memberSnap = await db.collection('members').doc(sub.memberId).get();
  const member = memberSnap.data();
  if (!member || !member.email) return;

  const walkIds = Array.isArray(sub.walkIds) ? sub.walkIds : [];
  const walkSnaps = await Promise.all(walkIds.map((id) => db.collection('walks').doc(id).get()));
  const walks = walkSnaps
    .filter((s) => s.exists)
    .map((s) => {
      const w = s.data();
      const d = w.date?.toDate?.();
      return d ? { dateStr: isoDateStr(d), slot: w.timeSlot || null } : null;
    })
    .filter(Boolean);

  const result = await sendEmail({
    to: member.email,
    template: 'portal-walk-request-received',
    data: {
      firstName: (member.name || '').trim().split(/\s+/)[0] || 'there',
      dogNames: Array.isArray(member.dogs) ? member.dogs.map((d) => d && d.name).filter(Boolean) : [],
      walkTypeLabel: 'Extended walk',
      durationMinutes: 45,
      walks,
    },
    idempotencyKey: `portal-walk-request-received:${submissionId}`,
  });
  if (!result.ok) console.error(`onNewSubmission: portal-walk-request-received failed for ${submissionId}:`, result.error);
}

exports.onNewSubmission = onDocumentCreated({
  document: 'submissions/{submissionId}',
  secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, RESEND_API_KEY],
}, async (event) => {
  const sub = event.data?.data();
  if (!sub) return;

  // Member-referral tracking: if this submission entered a valid
  // member-referral code, record a lightweight redemption under that code so
  // the referring member's portal tab has something to show. Tracking only —
  // it never issues credit (a separate, future build) and never blocks or
  // alters the signup if the code is missing, stale, or was never valid;
  // validateReferralCode already screened it client-side, but this is the
  // actual trust boundary since a client claim can't be trusted. Runs before
  // the meet-greet early-return below since membership/service requests
  // without a booked slot still need their referral recorded. The redemption
  // doc ID is the submission's own ID, so a retried trigger delivery
  // overwrites the same doc instead of creating a duplicate.
  if (sub.referredByCode) {
    try {
      const codeRef = db.collection('referralCodes').doc(sub.referredByCode);
      const codeSnap = await codeRef.get();
      if (codeSnap.exists && codeSnap.data().status === 'active') {
        await codeRef.collection('redemptions').doc(event.params.submissionId).set({
          name: sub.ownerName || sub.name || null,
          submissionType: sub.type,
          status: 'invited',
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    } catch (e) {
      console.error(`Referral redemption tracking failed for code ${sub.referredByCode}:`, e.message);
    }
  }

  // Requester-facing "we got your request" email, routed by submission
  // type — dispatchSubmissionEmail's explicit switch with a logged default,
  // rather than the old catch-all early return below (that pattern — a
  // hardcoded list some types match and everything else silently falls
  // through — is exactly what's bitten this project before, in
  // careers.html's time slots and the admin dashboard's two out-of-sync
  // typeLabels maps). Wrapped here, not left to propagate: a throw from any
  // sender (pricing.js failing to import, a members/{id}.get() rejecting, a
  // walk-lookup Promise.all() throwing) must not abort this trigger before
  // it reaches the meet & greet mirror/Gmail alert below — that alert has
  // no idempotency key of its own, so letting this take the whole trigger
  // down would mean either a duplicate alert (on Firestore's retry) or,
  // if the failure persists, no alert at all for a booked meet & greet.
  try {
    await dispatchSubmissionEmail(sub, event.params.submissionId);
  } catch (e) {
    console.error(`onNewSubmission: email dispatch failed for ${event.params.submissionId} (type ${sub.type}):`, e.message);
  }

  // Only meet & greet bookings page admin. Everything else (membership
  // requests without a booked slot, service requests, contact forms,
  // portal-generated requests) is reviewed in the admin portal instead —
  // unchanged by the requester-facing emails above, which fire regardless
  // of whether a meet & greet was booked.
  const meetGreet = parseMeetGreetDateTime(sub.meetGreetDateTime);
  if (!meetGreet) return;

  // Mirror the booked slot into meet_greet_availability BEFORE any email work.
  // The public booking calendars can't read `submissions` (rules restrict it to
  // admins and the owning member), so that collection — which is public-read —
  // is the only place they can learn a slot is taken. Doing this first means a
  // Gmail outage can't cost us the double-booking guard.
  //
  // arrayUnion is idempotent, so a retried trigger delivery can't double-add.
  try {
    await db.collection('meet_greet_availability').doc(meetGreet.dateStr).set(
      { bookings: FieldValue.arrayUnion(meetGreet.slot) },
      { merge: true }
    );
  } catch (e) {
    console.error(`Failed to record meet & greet booking ${meetGreet.dateStr} ${meetGreet.slot}:`, e.message);
  }

  const gmail = await getGmailClient();
  if (!gmail) return; // Gmail not connected yet — nothing to notify with, and nothing lost: it's still sitting in the Requests tab either way

  let notifyEmail;
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    notifyEmail = profile.data.emailAddress;
  } catch (e) {
    console.error('Could not look up connected Gmail address for notification:', e.message);
    return;
  }
  if (!notifyEmail) return;

  const label = REQUEST_TYPE_LABELS[sub.type] || `New ${sub.type || 'request'}`;
  const name = sub.name || sub.ownerName || sub.walkerName || 'Unknown';
  const emailAddr = sub.email || '';
  const dogName = sub.dogName || (Array.isArray(sub.dogs) && sub.dogs[0]?.name) || '';
  const when = `${meetGreet.dateStr} at ${meetGreet.slot}`;

  const bodyLines = [
    `Meet & greet booked for ${when}.`,
    '',
    `${label} from ${name}${emailAddr ? ` (${emailAddr})` : ''}.`,
    sub.phone ? `Phone: ${sub.phone}` : null,
    dogName ? `Dog: ${dogName}` : null,
    sub.address ? `Address: ${sub.address}` : null,
    sub.message ? `Message: ${sub.message}` : null,
    '',
    'Review and act on it in the admin portal — Requests tab.',
  ].filter(Boolean);

  try {
    // Self-notification: sent to and from the same address so there's no
    // "From" alias mismatch to worry about.
    await sendGmailMessage({
      to: notifyEmail,
      from: notifyEmail,
      subject: `Meet & greet ${when} — ${name}`,
      body: bodyLines.join('\n'),
    });
  } catch (e) {
    console.error('Request notification email failed:', e.message);
  }
});

// Referral code format: PCLC-XXXXXX, six characters drawn from an alphabet
// that excludes visually ambiguous characters (0/O, 1/I/L) so a code is easy
// to read and type correctly off a printed card or over the phone.
// Deliberately random, not sequential — a sequential PCLC-REF-0001-style
// counter (the original format) leaks the total number of codes ever issued
// to anyone who collects a few. 31^6 (~887M) possible codes makes collisions
// rare enough that a short create-and-retry loop is sufficient; no shared
// counter document is needed for uniqueness anymore. Pre-existing
// PCLC-REF-NNNN codes are untouched and keep working — this only changes
// what NEW codes look like.
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 6;
const REFERRAL_CODE_MAX_ATTEMPTS = 5;

function randomReferralCode() {
  let suffix = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    suffix += REFERRAL_CODE_ALPHABET[crypto.randomInt(REFERRAL_CODE_ALPHABET.length)];
  }
  return `PCLC-${suffix}`;
}

// Generates a random code and creates its referralCodes/{code} doc, retrying
// on the rare chance of a collision. doc.create() is itself atomic (it
// throws if the doc already exists), so — unlike the old counter-based
// scheme — no Firestore transaction is needed purely for uniqueness: each
// candidate is independent, so a plain retry loop is the simpler fit here.
// Returns the code that was actually created.
async function createReferralCodeDoc(fields) {
  for (let attempt = 1; attempt <= REFERRAL_CODE_MAX_ATTEMPTS; attempt++) {
    const code = randomReferralCode();
    try {
      await db.collection('referralCodes').doc(code).create({ code, ...fields });
      return code;
    } catch (e) {
      if (attempt === REFERRAL_CODE_MAX_ATTEMPTS) {
        throw new HttpsError('internal', 'Could not generate a unique referral code. Please try again.');
      }
      console.warn(`Referral code collision on attempt ${attempt} (${code}), retrying:`, e.message);
    }
  }
}

// ── Anti-abuse helpers shared by every anonymous code-issuing callable ─────
// (runGenerateReferralCode's /welcomehome partner intake, and
// runGenerateEmailCaptureCode's homepage footer form) — the two paths that
// hand real dollar-value codes to anonymous visitors with no other abuse
// protection (no App Check, no rate limiting). Both checks below run BEFORE
// any Resend send or referralCodes doc is created in both callers: the real
// cost of bot traffic here is sending reputation (Resend flags going out to
// burner addresses en masse), not fraud, so the cheapest, earliest checks
// matter most.

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// A filled honeypot means a bot filled in a field real visitors never see
// (hidden off-screen, not display:none — see the form markup). Throws the
// same generic error a genuine validation failure would, rather than a
// distinct "we caught you" message that would just teach a bot to probe for
// the tell.
function assertHoneypotEmpty(payload) {
  if (payload && typeof payload.website === 'string' && payload.website.trim()) {
    throw new HttpsError('invalid-argument', 'Something went wrong submitting the form. Please try again.');
  }
}

// True if ANY referralCodes doc from one of `sources` already exists for
// this normalized email. A single-field query (submittedEmailNormalized —
// only ever set on apartment/agent/email_capture docs, never member_referral)
// filtered down to `sources` in memory afterward, rather than a compound
// `source in [...]` query — matches for one email are always a handful of
// docs at most, and this sidesteps any composite-index question entirely.
// Not a transaction: a benign race under adversarial double-submission
// timing could in principle let two through, an acceptable cost for a
// reputation guard, not a hard uniqueness constraint.
async function emailAlreadyIssuedCode(sources, normalizedEmail) {
  if (!normalizedEmail) return false;
  const snap = await db.collection('referralCodes')
    .where('submittedEmailNormalized', '==', normalizedEmail)
    .get();
  return snap.docs.some((d) => sources.includes(d.data().source));
}

// Mirrors js/attribution.js's SAFE_CHARS regex and firestore.rules'
// validAttrString() exactly (keep all three in lockstep if any changes) —
// needed here because generateReferralCode/generateEmailCaptureCode are
// onCall callables, not direct client Firestore writes, so
// firestore.rules' validAttrString() never runs against this payload; this
// function is the actual security boundary for it, same reasoning
// runGenerateReferralCode's own comment already gives for every other field.
const ATTR_SAFE_CHARS = /[^a-zA-Z0-9 _.:/?&=-]/g;
function cleanAttrString(v, maxLen) {
  if (typeof v !== 'string' || !v) return null;
  const cleaned = v.replace(ATTR_SAFE_CHARS, '').slice(0, maxLen);
  return cleaned || null;
}
function cleanAttribution(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const capturedAtMs = Number(raw.capturedAt);
  if (!Number.isFinite(capturedAtMs)) return null;
  return {
    utmSource: cleanAttrString(raw.utmSource, 200),
    utmMedium: cleanAttrString(raw.utmMedium, 200),
    utmCampaign: cleanAttrString(raw.utmCampaign, 200),
    utmContent: cleanAttrString(raw.utmContent, 200),
    referrer: cleanAttrString(raw.referrer, 500),
    landingPage: cleanAttrString(raw.landingPage, 300),
    capturedAt: Timestamp.fromMillis(capturedAtMs),
  };
}

// Partner referral intake (/welcomehome). Unlike every other public form,
// this doesn't write to `submissions` from the client — it's a code-issuing
// flow (the code is redeemed later for $50 credit), so it gets its own
// collection and lifecycle.
//
// No assertIsAdmin(): unauthenticated apartment/agent-referred visitors are
// the intended caller. That makes this function itself the security
// boundary (there is deliberately no public Firestore create rule for
// referralCodes — see firestore.rules) — every field is validated and
// length-capped here rather than trusted from the client payload.
async function runGenerateReferralCode(payload = {}) {
  assertHoneypotEmpty(payload);

  const source = payload.source;
  if (source !== 'apartment' && source !== 'agent') {
    throw new HttpsError('invalid-argument', 'source must be "apartment" or "agent".');
  }

  const clean = (v, max) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : '';
  };

  const submittedName = clean(payload.submittedName, 200);
  const submittedPhone = clean(payload.submittedPhone, 40);
  const submittedEmail = clean(payload.submittedEmail, 320);
  const notes = clean(payload.notes, 2000) || null;
  if (!submittedName || !submittedPhone || !submittedEmail) {
    throw new HttpsError('invalid-argument', 'Name, phone, and email are required.');
  }

  let building = null, agent = null, brokerage = null;
  if (source === 'apartment') {
    building = clean(payload.building, 200);
    if (!building) throw new HttpsError('invalid-argument', 'Building name is required.');
  } else {
    agent = clean(payload.agent, 200);
    brokerage = clean(payload.brokerage, 200);
    if (!agent || !brokerage) throw new HttpsError('invalid-argument', 'Agent name and brokerage are required.');
  }

  const submittedEmailNormalized = normalizeEmail(submittedEmail);
  // Dedup before creating anything or sending anything — see the shared
  // helpers' comment above. Scoped to the partner sources only (apartment +
  // agent, this form's own channel) — the homepage email-capture offer and
  // a member's own evergreen code are separate channels with their own
  // dedup, not this one.
  if (await emailAlreadyIssuedCode(['apartment', 'agent'], submittedEmailNormalized)) {
    throw new HttpsError('already-exists', 'A referral code has already been sent to this email address.');
  }

  const attribution = cleanAttribution(payload.attribution);

  const code = await createReferralCodeDoc({
    source,
    building,
    agent,
    brokerage,
    submittedName,
    submittedPhone,
    submittedEmail,
    submittedEmailNormalized,
    notes,
    // referrerId/referrerName are null here (only member_referral docs,
    // written by getOrCreateMemberReferralCode, set them) — explicit null
    // rather than an absent field so referralCodes' member-scoped read rule
    // (resource.data.referrerId == request.auth.uid) has a consistent field
    // to compare against on every doc, partner or member.
    referrerId: null,
    referrerName: null,
    attribution,
    createdAt: FieldValue.serverTimestamp(),
    status: 'active',
    creditIssued: false,
  });

  // Fire-and-forget, same contract as every other sendEmail() caller: never
  // throws, never blocks the code (already created above) from being
  // returned to the client. idempotencyKey is the code itself — it's unique
  // per created doc (createReferralCodeDoc uses .create(), which throws on
  // collision), so it's already a clean dedupe key with nothing extra to
  // compose it from.
  const emailResult = await sendEmail({
    to: submittedEmail,
    template: 'referral-code-delivery',
    data: {
      firstName: submittedName.split(/\s+/)[0] || 'there',
      code,
      // Partner codes never store amountCents on the doc (see
      // resolveNewMemberReferralDiscount's `?? 5000` fallback) — 5000 here
      // mirrors that same default explicitly, for copy purposes only.
      amountCents: 5000,
      expiresAt: null,
    },
    idempotencyKey: `referral-code-delivery:${code}`,
  });
  if (!emailResult.ok) console.error(`runGenerateReferralCode: referral-code-delivery failed for ${code}:`, emailResult.error);

  return { code };
}

exports.generateReferralCode = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  return runGenerateReferralCode(request.data || {});
});
// Exposed directly, same reasoning as runGenerateWalkerPayout — testable
// without a real HTTPS/auth round trip.
exports.runGenerateReferralCode = runGenerateReferralCode;

const EMAIL_CAPTURE_AMOUNT_CENTS = 2000; // $20
const EMAIL_CAPTURE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Homepage footer "Stay in Touch" email-capture intake. Deliberately modeled
// on runGenerateReferralCode immediately above — same anonymous-caller
// posture (no assertIsAdmin(), this function itself is the trust boundary,
// no public Firestore create rule for referralCodes — see firestore.rules),
// same anti-abuse helpers, same createReferralCodeDoc/sendEmail path — one
// referralCodes lifecycle, not a parallel credit system. Two real
// differences from the partner flow: (1) this is a flat, no-questions-asked
// $20 offer to anyone who submits an email, not a partner lead, so there's
// no name/phone/building/agent to collect or validate; (2) the code is
// never shown on-page (the homepage copy promises "code arrives by email"),
// so a dedup hit here returns a generic success rather than an error —
// nothing on the page needs to change either way, and a prober learns
// nothing from the response shape.
async function runGenerateEmailCaptureCode(payload = {}) {
  assertHoneypotEmpty(payload);

  const email = typeof payload.email === 'string' ? payload.email.trim().slice(0, 320) : '';
  if (!email || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'A valid email address is required.');
  }
  const submittedEmailNormalized = normalizeEmail(email);

  // Dedup before creating anything or sending anything — see the shared
  // helpers' comment above runGenerateReferralCode. Scoped to this form's
  // own channel (email_capture) — a partner code or a member's own
  // evergreen code doesn't block someone from also getting this $20 offer.
  if (await emailAlreadyIssuedCode(['email_capture'], submittedEmailNormalized)) {
    return { ok: true };
  }

  const attribution = cleanAttribution(payload.attribution);
  const expiresAt = Timestamp.fromMillis(Date.now() + EMAIL_CAPTURE_EXPIRY_MS);

  const code = await createReferralCodeDoc({
    source: 'email_capture',
    building: null,
    agent: null,
    brokerage: null,
    submittedName: null,
    submittedPhone: null,
    submittedEmail: email,
    submittedEmailNormalized,
    notes: null,
    referrerId: null,
    referrerName: null,
    attribution,
    amountCents: EMAIL_CAPTURE_AMOUNT_CENTS,
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
    status: 'active',
    creditIssued: false,
  });

  // Fire-and-forget, same contract as every other sendEmail() caller — see
  // runGenerateReferralCode's own comment above.
  const emailResult = await sendEmail({
    to: email,
    template: 'referral-code-delivery',
    data: {
      // null, not 'there' — this form has no name field at all.
      // referral-code-delivery's greetingLine() renders "Thanks for signing
      // up!" for a falsy firstName rather than treating a filler word as a
      // literal name.
      firstName: null,
      code,
      amountCents: EMAIL_CAPTURE_AMOUNT_CENTS,
      expiresAt: expiresAt.toDate(),
    },
    idempotencyKey: `referral-code-delivery:${code}`,
  });
  if (!emailResult.ok) console.error(`runGenerateEmailCaptureCode: referral-code-delivery failed for ${code}:`, emailResult.error);

  return { ok: true };
}

exports.generateEmailCaptureCode = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  return runGenerateEmailCaptureCode(request.data || {});
});
// Exposed directly, same reasoning as runGenerateReferralCode above.
exports.runGenerateEmailCaptureCode = runGenerateEmailCaptureCode;

const FRIENDS_FAMILY_DEFAULT_MAX_REDEMPTIONS = 1;
const FRIENDS_FAMILY_DISCOUNT_PERCENT = 40;

// Admin-only Friends & Family code generation — deliberately its own
// function, not folded into runGenerateReferralCode. That function's whole
// shape (anonymous caller, honeypot, email dedup, sends the code by email)
// is built for the /welcomehome public intake form; a Friends & Family code
// is created by admin, for a specific small group Alison is personally
// giving it to, and is never emailed by this system at all — she shares it
// herself. Overloading one function with a source-based branch here would
// mean every future change to the anonymous intake path has to reason about
// whether it also affects this admin-only, no-email, capped-redemption
// path — cheaper to keep them fully separate.
async function runGenerateFriendsFamilyCode(payload = {}) {
  const maxRedemptionsInput = payload.maxRedemptions;
  const maxRedemptions = Number.isInteger(maxRedemptionsInput) && maxRedemptionsInput > 0
    ? maxRedemptionsInput
    : FRIENDS_FAMILY_DEFAULT_MAX_REDEMPTIONS;
  const notes = typeof payload.notes === 'string' && payload.notes.trim()
    ? payload.notes.trim().slice(0, 500)
    : null;

  const code = await createReferralCodeDoc({
    source: 'friends_family',
    building: null,
    agent: null,
    brokerage: null,
    submittedName: null,
    submittedPhone: null,
    submittedEmail: null,
    notes,
    referrerId: null,
    referrerName: null,
    attribution: null,
    discountPercent: FRIENDS_FAMILY_DISCOUNT_PERCENT,
    maxRedemptions,
    redemptionCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    status: 'active',
    creditIssued: false,
  });

  return { code, maxRedemptions, discountPercent: FRIENDS_FAMILY_DISCOUNT_PERCENT };
}

exports.generateFriendsFamilyCode = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);
  return runGenerateFriendsFamilyCode(request.data || {});
});
// Exposed directly, same reasoning as runGenerateReferralCode above.
exports.runGenerateFriendsFamilyCode = runGenerateFriendsFamilyCode;

// Member portal "Refer a Friend" tab: an existing member's own evergreen
// referral code, generated once and reused thereafter. Unlike
// generateReferralCode (anonymous /welcomehome intake), this is auth-gated —
// request.auth.uid IS the referrer, so there's no client payload to spoof
// identity from, and no assertIsAdmin(): any signed-in member may fetch
// their own code, never anyone else's.
//
// Deliberately excluded from the honeypot/dedup work added for the two
// anonymous code-issuing callables above (runGenerateReferralCode,
// runGenerateEmailCaptureCode) — not an oversight. None of the three
// problems those exist for apply here: (1) no anonymous access at all, the
// unauthenticated throw below is the first line; (2) no email/contact input
// to farm — the code is keyed to request.auth.uid, not an arbitrary string
// the caller controls; (3) no repeated-send cost to protect (this function
// never calls sendEmail — the code is shown in-app only, see
// referral-code-delivery.js's own scope note), and the fast-path +
// transaction re-check below make repeated calls a pure no-op, never a
// second write.
exports.getOrCreateMemberReferralCode = onCall({}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const uid = request.auth.uid;
  const memberRef = db.collection('members').doc(uid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError('not-found', 'Member not found.');
  }

  // Fast path: most calls are a returning visit to the tab, and the code
  // never changes once set — no need to generate anything.
  const existing = memberSnap.data().referralCode;
  if (existing) return { code: existing };

  // Generate the candidate BEFORE opening the transaction below. A Firestore
  // transaction can't retry a doc-already-exists collision itself — that
  // precondition is only checked at commit time, which would abort the
  // whole transaction rather than let us try another candidate — so
  // collision retries (createReferralCodeDoc) have to happen outside it.
  // The transaction below decides only whether THIS candidate becomes the
  // member's code, not whether the code itself is unique.
  const candidateCode = await createReferralCodeDoc({
    source: 'member_referral',
    building: null,
    agent: null,
    brokerage: null,
    submittedName: null,
    submittedPhone: null,
    submittedEmail: null,
    notes: null,
    referrerId: uid,
    referrerName: memberSnap.data().name || null,
    createdAt: FieldValue.serverTimestamp(),
    status: 'active',
    creditIssued: false,
  });

  // Re-checks referralCode INSIDE the transaction (not just the fast-path
  // read above) so two concurrent calls for the same member — double-click,
  // two tabs — can't both "win": whichever transaction commits first claims
  // candidateCode on the member doc; the other sees referralCode already set
  // and discards its own candidate. That candidate is left as a harmless,
  // never-returned orphan doc in referralCodes — cheaper than the complexity
  // of deleting it, and referralCodes has no delete path from any client
  // anyway.
  return db.runTransaction(async (tx) => {
    const freshMemberSnap = await tx.get(memberRef);
    const freshExisting = freshMemberSnap.data()?.referralCode;
    if (freshExisting) return { code: freshExisting };

    tx.update(memberRef, { referralCode: candidateCode });
    return { code: candidateCode };
  });
});

// Member's own referral credit balance, as one combined number — see
// issueReferralCredit's tier split: membership-tier credit lives as a real
// Stripe customer-balance credit (negative balance = credit, per
// issueStripeBalanceCredit above), Travel-tier credit lives in
// pendingReferralCredit on the billing subdoc (no ongoing subscription for a
// Stripe balance to apply against). A member could in principle have a
// nonzero amount in either depending on tier history, so both are summed
// rather than branching on current tier. Reads Stripe live rather than
// mirroring a field into Firestore, so this can never drift from what
// Stripe actually has — one Stripe API call per page visit is an acceptable
// cost for a tab a member checks occasionally, not on every page load.
// Same auth-gated, no-client-payload pattern as getOrCreateMemberReferralCode
// above: request.auth.uid IS the member, never a client-supplied id.
// A Stripe error is allowed to propagate (not caught here) — the caller
// must see a load failure, never silently render $0.00 for a read that
// actually failed.
exports.getMemberCreditBalance = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const uid = request.auth.uid;
  const billingSnap = await billingRef(uid).get();
  const billingData = billingSnap.exists ? billingSnap.data() : {};

  const pendingCreditCents = Math.round((billingData.pendingReferralCredit || 0) * 100);

  let stripeCreditCents = 0;
  if (billingData.stripeCustomerId) {
    const stripe = stripeClient(STRIPE_SECRET_KEY.value());
    const customer = await stripe.customers.retrieve(billingData.stripeCustomerId);
    // A deleted customer resolves with { deleted: true } and no balance
    // field — treat as no Stripe-side credit rather than a crash.
    const balance = customer.deleted ? 0 : (customer.balance || 0);
    stripeCreditCents = Math.max(0, -balance);
  }

  return { creditCents: pendingCreditCents + stripeCreditCents };
});

// Signup-form code validation (membership-request.html / service-request.html).
// referralCodes has no public read rule (see firestore.rules), so the client
// can't check a code directly — this callable is the narrow, PII-free
// substitute: it looks the code up with the Admin SDK and returns only a
// boolean, never the referrer's identity. No assertIsAdmin(): the person
// entering a friend's code at signup isn't authenticated at all yet.
//
// reason distinguishes WHY a code is invalid, for the blur-time UI on both
// forms — 'not_found' (no such doc, or inactive — a would-be visitor can't
// tell "never existed" from "an admin deactivated it," and shouldn't need
// to), 'expired', or null when valid. Empty input gets reason: null too —
// not 'not_found' — an empty field isn't a code that wasn't found, it's no
// code at all; a future caller reading reason shouldn't be told otherwise.
// Deliberately does NOT check single-use-code reuse (redeemedByMemberId) —
// that check needs a memberId to exclude "redeemed by you," which doesn't
// exist yet for this unauthenticated caller. See resolveNewMemberReferralDiscount
// for the real reuse check, at charge time, where a memberId is in hand.
exports.validateReferralCode = onCall({}, async (request) => {
  const code = typeof request.data?.code === 'string' ? request.data.code.trim() : '';
  if (!code) return { valid: false, reason: null };
  const snap = await db.collection('referralCodes').doc(code).get();
  if (!snap.exists) return { valid: false, reason: 'not_found' };
  const codeData = snap.data();
  if (codeData.status !== 'active') return { valid: false, reason: 'inactive' };
  // Same isReferralCodeExpired check resolveNewMemberReferralDiscount uses
  // at charge time — a code must never validate here and then fail later.
  if (isReferralCodeExpired(codeData)) return { valid: false, reason: 'expired' };
  // friends_family is the one code type checked for reuse HERE, at
  // signup-validation time, rather than only at charge time — see
  // claimFriendsFamilyRedemption for why this check is advisory, not
  // authoritative (a read here can't reserve a slot; the real enforcement
  // is the transaction at account-creation time). This is still worth
  // doing: it stops the common case (someone entering an already-exhausted
  // code) from ever reaching a submission at all, matching "reject" rather
  // than the flag-after-the-fact behavior every other single-use code gets.
  // Two completely different discount mechanisms share this one callable,
  // so the response shape branches by code type rather than returning one
  // generic "amount" the client could apply either way:
  //  - flat-credit codes (member/partner/email_capture) return amountCents —
  //    a one-time dollar credit, capped at 50% of a single charge at charge
  //    time (resolveNewMemberReferralDiscount/chargeCustomerCard).
  //  - friends_family returns discountPercent — an ongoing per-booking
  //    percentage, applied only to travel-eligible services
  //    (applyTravelDiscount/isTravelDiscountService, pricing.js), never
  //    capped, never gated on first payment.
  // The client must never treat these two fields interchangeably (a percent
  // used as a cent amount, or vice versa, would silently mis-preview by
  // orders of magnitude) — each code type returns exactly one of them.
  if (codeData.source === 'friends_family') {
    const max = Number.isInteger(codeData.maxRedemptions) ? codeData.maxRedemptions : 0;
    const count = Number.isInteger(codeData.redemptionCount) ? codeData.redemptionCount : 0;
    if (count >= max) return { valid: false, reason: 'redemption_limit_reached' };
    // friends_family never carries amountCents and never receives the
    // one-time discount at charge time — resolveNewMemberReferralDiscount
    // excludes it before this fallback would ever apply (see there). Still
    // withholding amountCents here for exactly that reason. discountPercent
    // is read off the code doc, never hardcoded — codeData.discountPercent
    // is the same field claimFriendsFamilyRedemption copies onto the
    // member's billing doc as travelDiscountPercent at claim time, so this
    // preview can never disagree with what actually gets granted. Omitted
    // entirely (both fields) when missing or not a positive number, so an
    // unexpected code doc shape degrades the client to today's
    // status-line-only behavior rather than previewing a bogus 0%.
    if (Number.isInteger(codeData.discountPercent) && codeData.discountPercent > 0) {
      return { valid: true, reason: null, discountPercent: codeData.discountPercent, codeType: 'friends_family' };
    }
    return { valid: true, reason: null };
  }
  // Same codeData.amountCents ?? 5000 fallback resolveNewMemberReferralDiscount
  // uses at charge time (functions/index.js, that function's return statement)
  // — existing $50 partner/member-referral codes never wrote this field, so
  // this is a preview of the exact amount the charge-time cap will apply
  // against, not a separate number that could drift from it.
  return { valid: true, reason: null, amountCents: codeData.amountCents ?? 5000 };
});
