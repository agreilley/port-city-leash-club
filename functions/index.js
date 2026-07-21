// functions/index.js
//
// Port City Leash Club — Stripe payment backend.
//
// Payment model (per business decision, July 2026):
//   - Card is collected and saved (zero charge) at signup, on both the
//     membership request form and the one-time service request form.
//   - First-ever booking for a new client: charge happens AFTER the meet
//     & greet is confirmed by admin (not at signup, not at online submission).
//   - Returning clients booking additional one-time services: charge at
//     confirmation (admin approves the request in the inbox).
//   - Walk memberships: recurring monthly charge on the 1st of the month,
//     starting the month after the membership is confirmed.
//
// None of the charge functions below run automatically — they are all
// triggered by an admin action (approving a submission in the admin
// dashboard), which is the intended design: nothing gets charged without
// a human confirming the booking first.

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// Set this once via:
//   firebase functions:secrets:set STRIPE_SECRET_KEY
// Never hardcode the real key here or commit it to the repo.
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

function stripeClient(key) {
  // Lazy-require so the Stripe SDK is only loaded inside a function
  // invocation, once the secret is available.
  return require('stripe')(key);
}

// Per-walk Stripe Price IDs (LIVE mode) for the three billed membership
// tiers. Travel-tier clients are one-time/service-based and never get a
// subscription, so they're intentionally not in this map.
//
// These are per-unit recurring monthly prices: the subscription is created
// with an explicit quantity (walk days in the billed month) and
// syncMonthlyWalkQuantities updates that quantity on the 1st. A metered
// price would reject quantity and break both paths.
//
// This is the ONLY place Price IDs live. admin/dashboard.html used to keep a
// duplicate copy and pass priceId in with the call, which meant a tier missing
// or stale on the client silently skipped billing for that member. The client
// now sends nothing but the member, and the tier is resolved from the member
// document here. (A literal shared module isn't possible: Firebase uploads only
// the functions/ directory, and the browser can't import from it.)
const TIER_PRICE_IDS = {
  Essential: 'price_1TvJRSBYaaTA3vAvg7vjywOj',
  Standard: 'price_1TvJRPBYaaTA3vAvSePTuam0',
  Daily: 'price_1TvJRJBYaaTA3vAvEokY5XJw',
};

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

// ─────────────────────────────────────────────────────────────────────────
// 1. Save a card on file with $0 charge (called from both public forms
//    at the point of initial submission — no login required yet, since
//    the person isn't a member/client until admin confirms).
// ─────────────────────────────────────────────────────────────────────────
exports.createSetupIntent = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  const { name, email, submissionId } = request.data || {};
  if (!name || !email || !submissionId) {
    throw new HttpsError('invalid-argument', 'name, email, and submissionId are required.');
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());

  // Reuse a Stripe Customer if this email already has one on file
  // (e.g. an existing member submitting a new one-time service request).
  const existing = await stripe.customers.list({ email, limit: 1 });
  const customer = existing.data[0] || await stripe.customers.create({ name, email });

  const setupIntent = await stripe.setupIntents.create({
    customer: customer.id,
    payment_method_types: ['card'],
  });

  // Link the Stripe customer to the Firestore submission so admin can
  // find it later when it's time to actually charge the card.
  await db.collection('submissions').doc(submissionId).set({
    stripeCustomerId: customer.id,
    paymentMethodStatus: 'card_saved_not_charged',
  }, { merge: true });

  return { clientSecret: setupIntent.client_secret };
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Charge the saved card for a one-time service (drop-in visit,
//    overnight stay, standard/extended walk). Admin-triggered only —
//    call this from the admin dashboard's "Confirm" button, after the
//    meet & greet (first-time clients) or immediately (returning clients).
// ─────────────────────────────────────────────────────────────────────────
exports.chargeSavedCard = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);

  const { submissionId, amountInDollars, description } = request.data || {};
  if (!submissionId || !amountInDollars) {
    throw new HttpsError('invalid-argument', 'submissionId and amountInDollars are required.');
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const subDoc = await db.collection('submissions').doc(submissionId).get();
  const sub = subDoc.data();

  if (!sub || !sub.stripeCustomerId) {
    throw new HttpsError('failed-precondition', 'No saved card found for this submission.');
  }

  // Off-session because the client isn't present re-entering their card —
  // they authorized this charge when they saved the card at signup.
  const customer = await stripe.customers.retrieve(sub.stripeCustomerId);
  const paymentMethods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card' });
  if (!paymentMethods.data.length) {
    throw new HttpsError('failed-precondition', 'Customer has no saved payment method.');
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amountInDollars * 100),
    currency: 'usd',
    customer: customer.id,
    payment_method: paymentMethods.data[0].id,
    off_session: true,
    confirm: true,
    description: description || 'Port City Leash Club service',
  });

  await db.collection('submissions').doc(submissionId).set({
    paymentMethodStatus: 'charged',
    lastChargeId: paymentIntent.id,
    lastChargeAmount: amountInDollars,
    lastChargedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { success: true, paymentIntentId: paymentIntent.id };
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Start a recurring monthly membership subscription (Essential /
//    Standard / Daily). Admin-triggered after confirming a new member.
//    Uses billing_cycle_anchor so the recurring charge lands on the 1st
//    of the month regardless of the day the membership actually starts.
// ─────────────────────────────────────────────────────────────────────────
exports.createMembershipSubscription = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);

  const { submissionId, memberId } = request.data || {};
  if (!submissionId || !memberId) {
    throw new HttpsError('invalid-argument', 'submissionId and memberId are required.');
  }

  // Resolve the member and their tier BEFORE touching the submission or
  // Stripe. Travel-tier (and any non-billed tier) has no subscription price,
  // and such a member may legitimately have no card on file — so that case
  // has to return before the card check below, not fall into it.
  const memberDoc = await db.collection('members').doc(memberId).get();
  const member = memberDoc.data();
  if (!member) {
    throw new HttpsError('not-found', 'Member record not found.');
  }

  const priceId = TIER_PRICE_IDS[member.tier];
  if (!priceId) {
    // Not an error: this is the normal path for Travel-tier members. The
    // caller uses `skipped` to decide whether to generate walks.
    return { success: true, skipped: true, tier: member.tier || null };
  }

  const stripe = stripeClient(STRIPE_SECRET_KEY.value());
  const subDoc = await db.collection('submissions').doc(submissionId).get();
  const sub = subDoc.data();

  if (!sub || !sub.stripeCustomerId) {
    throw new HttpsError('failed-precondition', 'No saved card found for this submission.');
  }

  const paymentMethods = await stripe.paymentMethods.list({ customer: sub.stripeCustomerId, type: 'card' });
  if (!paymentMethods.data.length) {
    throw new HttpsError('failed-precondition', 'Customer has no saved payment method.');
  }

  // Set as the default payment method for invoices on this customer.
  await stripe.customers.update(sub.stripeCustomerId, {
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
  const fromDay = firstBilledMonthFromDay(sub.startDate, nextFirst.getUTCFullYear(), nextFirst.getUTCMonth());
  const quantity = countWalkDaysInMonth(member.defaultWalkDays, nextFirst.getUTCFullYear(), nextFirst.getUTCMonth(), fromDay);

  if (!quantity) {
    throw new HttpsError('failed-precondition', 'This member has no scheduled walk days next month — set defaultWalkDays before starting billing.');
  }

  const subscription = await stripe.subscriptions.create({
    customer: sub.stripeCustomerId,
    items: [{ price: priceId, quantity }],
    billing_cycle_anchor: billingCycleAnchor,
    proration_behavior: 'none',
  });

  // membershipStartDate is copied onto the member so the scheduled jobs on
  // the 1st can honor a mid-month start. It lived only on the submission
  // before, which those jobs never read — which is exactly why they used to
  // revert the proration set here.
  const startDate = toDateOrNull(sub.startDate);
  await db.collection('members').doc(memberId).set({
    stripeCustomerId: sub.stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionItemId: subscription.items.data[0].id,
    billingStatus: 'active',
    ...(startDate ? { membershipStartDate: Timestamp.fromDate(startDate) } : {}),
  }, { merge: true });

  return { success: true, subscriptionId: subscription.id, quantity };
});

// ─────────────────────────────────────────────────────────────────────────
// 3b. Generate walk documents for a brand-new member's first (partial)
//    billed month. Called as a separate follow-up step right after
//    createMembershipSubscription succeeds — not folded into that
//    function's body — so a bug here can never affect the billing path
//    it's paired with. Records initialWalksGenerated on the member doc
//    (true/false) so a failure is durable, checkable state rather than
//    just a banner that disappears when the modal closes.
// ─────────────────────────────────────────────────────────────────────────
exports.generateInitialWalks = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);

  const { submissionId, memberId } = request.data || {};
  if (!submissionId || !memberId) {
    throw new HttpsError('invalid-argument', 'submissionId and memberId are required.');
  }

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
    const now = new Date();
    const nextFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
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
// ─────────────────────────────────────────────────────────────────────────
exports.chargeCurrentMonthWalks = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);

  const { memberId } = request.data || {};
  if (!memberId) throw new HttpsError('invalid-argument', 'memberId is required.');

  const memberRef = db.collection('members').doc(memberId);
  const memberDoc = await memberRef.get();
  const member = memberDoc.data();
  if (!member) throw new HttpsError('not-found', 'Member record not found.');

  const priceId = TIER_PRICE_IDS[member.tier];
  if (!priceId) {
    return { success: true, skipped: true, reason: 'no-subscription-tier', tier: member.tier || null };
  }

  const { year, monthIndex, day: todayDay } = easternTodayParts();
  const periodKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

  // Idempotency guard #1: never charge the same member twice for the same
  // month, however this call is retried (double-click, retry after a partial
  // failure, an admin re-running it).
  if (member.currentMonthCharge && member.currentMonthCharge.periodKey === periodKey
      && member.currentMonthCharge.status === 'charged') {
    return {
      success: true, alreadyCharged: true, periodKey,
      walkCount: member.currentMonthCharge.walkCount || 0,
      amount: member.currentMonthCharge.amount || 0,
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
    await memberRef.set({
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
  if (!member.stripeCustomerId) {
    throw new HttpsError('failed-precondition', 'No Stripe customer on this member — start the membership subscription first.');
  }
  const paymentMethods = await stripe.paymentMethods.list({ customer: member.stripeCustomerId, type: 'card' });
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

  const monthName = new Date(Date.UTC(year, monthIndex, 1))
    .toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const description = `Port City Leash Club - ${member.tier} Membership (${monthName} ${days[0]}-${days[days.length - 1]}, ${days.length} walk${days.length === 1 ? '' : 's'})`;

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: price.currency || 'usd',
      customer: member.stripeCustomerId,
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
    await memberRef.set({
      currentMonthCharge: {
        periodKey, walkCount: days.length, amount: amountInCents / 100,
        status: 'failed', reason: e.message, failedAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true }).catch(() => {});
    throw new HttpsError('internal', `Card charge for this month failed: ${e.message}`);
  }

  await memberRef.set({
    currentMonthCharge: {
      periodKey, walkCount: days.length, amount: amountInCents / 100,
      status: 'charged', paymentIntentId: paymentIntent.id,
      chargedAt: FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  return {
    success: true, periodKey, walkCount: days.length,
    amount: amountInCents / 100, fromDay, dates: days,
    paymentIntentId: paymentIntent.id,
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
    if (!member.stripeSubscriptionItemId) continue; // no active subscription (e.g. Travel-tier / one-time clients)

    // A member starting partway through THIS month is billed only from
    // their start date; every later month bills in full (membershipStartDate
    // is then in the past, so fromDay falls back to 1).
    const fromDay = firstBilledMonthFromDay(member.membershipStartDate, year, month);
    const quantity = countWalkDaysInMonth(member.defaultWalkDays, year, month, fromDay);
    try {
      await stripe.subscriptionItems.update(member.stripeSubscriptionItemId, {
        quantity,
        proration_behavior: 'none',
      });
    } catch (e) {
      console.error(`Failed to sync walk quantity for member ${memberDoc.id}:`, e.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3d. Generate next month's walk documents for every active member with a
//    subscription. Same schedule as syncMonthlyWalkQuantities, but a
//    separate function — a bug in walk generation can't take down the
//    Stripe quantity sync, or vice versa.
// ─────────────────────────────────────────────────────────────────────────
exports.generateMonthlyWalks = onSchedule({
  schedule: '5 0 1 * *',
  timeZone: 'America/New_York',
}, async () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const membersSnap = await db.collection('members').where('status', '==', 'active').get();

  for (const memberDoc of membersSnap.docs) {
    const member = memberDoc.data();
    if (!member.stripeSubscriptionItemId) continue; // no active subscription (e.g. Travel-tier / one-time clients)

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

    if (!member.stripeSubscriptionItemId) continue; // Travel-tier/no subscription — nothing to generate

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
exports.submitVacationHold = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
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
  if (currentPeriodCount > 0 && member.stripeSubscriptionItemId && member.stripeSubscriptionId) {
    const priceId = TIER_PRICE_IDS[member.tier];
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
        stripeCustomerId: member.stripeCustomerId || '',
        stripeSubscriptionId: member.stripeSubscriptionId || '',
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
    res.status(500).send('Something went wrong connecting Gmail: ' + e.message);
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
// ─────────────────────────────────────────────────────────────────────────
exports.onWalkCompleted = onDocumentUpdated({
  document: 'walks/{walkId}',
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
}, async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};

  // Only fire on the actual scheduled -> completed transition, not on
  // every subsequent edit to an already-completed walk.
  if (before.status === 'completed' || after.status !== 'completed') return;
  if (!after.memberId) return;

  const memberSnap = await db.collection('members').doc(after.memberId).get();
  if (!memberSnap.exists) return;
  const member = memberSnap.data();
  if (!member.phone) return; // nothing to text

  const dogName = member.dogName || (Array.isArray(member.dogs) && member.dogs[0]?.name) || 'Your dog';
  const body = after.notes
    ? `${dogName} had a great walk! "${after.notes}" — Port City Leash Club`
    : `${dogName} just finished their walk with Port City Leash Club! 🐾`;

  if (!twilioConfigured()) {
    await logConversationMessage(after.memberId, {
      channel: 'sms', direction: 'outbound', body, mediaUrl: after.photoUrl || null,
      sentBy: 'system', automated: true, status: 'pending_credentials',
    });
    return;
  }

  try {
    const client = twilioClient();
    const twilioMsg = await client.messages.create({
      to: member.phone,
      from: TWILIO_PHONE_NUMBER.value(),
      body,
      mediaUrl: after.photoUrl ? [after.photoUrl] : undefined,
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
});

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
  overnight_request: 'Overnight / check-in request',
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

exports.onNewSubmission = onDocumentCreated({
  document: 'submissions/{submissionId}',
  secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET],
}, async (event) => {
  const sub = event.data?.data();
  if (!sub) return;

  // Only meet & greet bookings notify. Everything else (membership requests
  // without a booked slot, service requests, contact forms, portal-generated
  // requests) is reviewed in the admin portal instead of paging anyone.
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
