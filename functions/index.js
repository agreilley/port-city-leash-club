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

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { sendEmail, RESEND_API_KEY } = require('./lib/email');

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
  Essential: 'price_1TvJRSBYaaTA3vAvg7vjywOj', // $28 (amount edited in place, ID unchanged)
  Standard: 'price_1Tw2uxBYaaTA3vAvunoJ0NYv',  // $26 (new Price object, new ID)
  Daily: 'price_1TvJRJBYaaTA3vAvEokY5XJw',     // $24 (amount edited in place, ID unchanged)
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
// 1b. Decline a membership request. A membership_request saves a card at
//    signup (createSetupIntent above), so declining has to clean up the
//    Stripe customer too — deleting the submission alone would orphan a live
//    customer with a saved card. Runs server-side because it needs the Stripe
//    secret key, which never goes to the client.
//
//    The Stripe customer is deleted BEFORE the status is written: if the
//    delete fails, this throws and the request stays pending for a retry,
//    rather than being marked declined while the customer silently orphans.
//    An already-deleted customer (resource_missing) is treated as success so
//    a retry is safe.
// ─────────────────────────────────────────────────────────────────────────
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
  if (sub.memberId) {
    throw new HttpsError('failed-precondition', 'This request was already converted to a member — decline does not apply.');
  }

  let customerDeleted = false;
  if (sub.stripeCustomerId) {
    const stripe = stripeClient(STRIPE_SECRET_KEY.value());
    try {
      const res = await stripe.customers.del(sub.stripeCustomerId);
      customerDeleted = !!res.deleted;
    } catch (e) {
      // Already gone (from a prior partial decline) is fine — the goal is
      // "no live customer", which is satisfied. Anything else is a real
      // failure: do NOT mark declined, so no orphan is left behind silently.
      if (e.code === 'resource_missing') {
        customerDeleted = true;
      } else {
        throw new HttpsError('internal', `Could not delete the Stripe customer (${e.message}). The request was left pending — try again.`);
      }
    }
  }

  await subRef.set({
    status: 'declined',
    read: true,
    stripeCustomerDeleted: customerDeleted,
    declinedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { success: true, customerDeleted };
});

// ─────────────────────────────────────────────────────────────────────────
// 1b. Travel-tier billing link. Membership members get their billing subdoc
//    (stripeCustomerId + referral intake) written by createMembershipSubscription
//    above; Travel-tier / one-time clients never went through that function
//    (their tier has no subscription price), so confirmServiceRequest calls
//    this instead, right after resolving/creating their member doc. Fixes a
//    real pre-existing gap: without this, a Travel-tier member's
//    stripeCustomerId lived ONLY on the ephemeral submissions doc, which
//    means findMemberIdByStripeCustomerId (stripeWebhook's own customer→
//    member resolver) could never find them — invoice.payment_failed and
//    customer.subscription.deleted couldn't act on them either, not just the
//    new invoice.paid/referral-credit logic this now also enables.
// ─────────────────────────────────────────────────────────────────────────
exports.linkServiceRequestBilling = onCall({}, async (request) => {
  await assertIsAdmin(request.auth);

  const { submissionId, memberId } = request.data || {};
  if (!submissionId || !memberId) {
    throw new HttpsError('invalid-argument', 'submissionId and memberId are required.');
  }

  const subDoc = await db.collection('submissions').doc(submissionId).get();
  const sub = subDoc.data();
  if (!sub || !sub.stripeCustomerId) {
    // Not every service request has a saved card (e.g. one entered manually
    // by admin with no createSetupIntent call) — nothing to link in that
    // case, not an error.
    return { success: true, linked: false };
  }

  // merge: true — never touches stripeSubscriptionId/billingStatus/etc. if
  // this memberId already has a membership billing doc (e.g. an existing
  // Standard member who also books a one-time overnight).
  await billingRef(memberId).set({
    stripeCustomerId: sub.stripeCustomerId,
    referredByCode: sub.referredByCode || null,
    referralSubmissionId: submissionId,
  }, { merge: true });

  return { success: true, linked: true };
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Charge the saved card for a one-time service (drop-in visit,
//    overnight stay, standard/extended walk). Admin-triggered only —
//    call this from the admin dashboard's "Confirm" button, after the
//    meet & greet (first-time clients) or immediately (returning clients).
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
  const subDoc = await db.collection('submissions').doc(submissionId).get();
  const sub = subDoc.data();

  if (!sub || !sub.stripeCustomerId) {
    throw new HttpsError('failed-precondition', 'No saved card found for this submission.');
  }

  // Idempotency guard #1: never charge the same chargeKey twice, however
  // this call is retried (double-click, two admin tabs open on the same
  // request, a retried call after a network hiccup) — same pattern as
  // chargeCurrentMonthWalks' currentMonthCharge guard. Blocks ONLY on a
  // prior 'charged' outcome for this exact key — never on 'failed', so a
  // transient Stripe error can always be retried rather than permanently
  // wedging a legitimate charge.
  const priorAttempt = sub.lastChargeAttempt;
  if (priorAttempt && priorAttempt.chargeKey === chargeKey && priorAttempt.status === 'charged') {
    return {
      success: true, alreadyCharged: true,
      paymentIntentId: sub.lastChargeId || null,
      creditApplied: sub.referralCreditApplied || 0,
      referralDiscountApplied: sub.referralDiscountApplied || 0,
      referralCreditCarriedForward: sub.referralCreditCarriedForward || 0,
    };
  }

  // Travel-tier clients receive referral credit as a Firestore balance
  // (members/{id}/private/billing.pendingReferralCredit) instead of a Stripe
  // customer balance — see issueReferralCredit — since they have no ongoing
  // Stripe subscription for a balance credit to naturally apply against.
  // Whatever's pending gets applied here, on their next charge, capped at
  // this charge's own amount (never a negative charge, never over-applies).
  // Cents throughout to avoid floating-point drift on the subtraction.
  const memberId = sub.memberId || null;
  const amountInCentsRequested = Math.round(amountInDollars * 100);
  let creditAppliedCents = 0;
  let billingData = null;
  if (memberId) {
    const billingSnap = await billingRef(memberId).get();
    billingData = billingSnap.data() || {};
    const pendingCredit = billingData.pendingReferralCredit || 0;
    if (pendingCredit > 0) {
      creditAppliedCents = Math.min(Math.round(pendingCredit * 100), amountInCentsRequested);
    }
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
  // combine to charge less than $0. Whatever either cap leaves unused carries
  // forward — see finalizeNewMemberReferralDiscount — so the member still
  // gets the full $50 promised externally, just not always all in one charge.
  let referralDiscount = null;
  let discountCents = 0;
  let carryForwardCents = 0;
  if (memberId && billingData && !billingData.referralCreditChecked) {
    const memberSnap = await db.collection('members').doc(memberId).get();
    const memberData = memberSnap.data();
    if (memberData) {
      referralDiscount = await resolveNewMemberReferralDiscount(memberId, billingData, memberData);
      if (referralDiscount.decision === 'approved') {
        const cappedAtHalf = Math.floor(amountInCentsRequested / 2);
        const remainingAfterPendingCredit = Math.max(0, amountInCentsRequested - creditAppliedCents);
        discountCents = Math.min(referralDiscount.discountCents, cappedAtHalf, remainingAfterPendingCredit);
        carryForwardCents = referralDiscount.discountCents - discountCents;
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
    // they authorized this charge when they saved the card at signup.
    const customer = await stripe.customers.retrieve(sub.stripeCustomerId);
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
      await db.collection('submissions').doc(submissionId).set({
        lastChargeAttempt: {
          chargeKey, status: 'failed', amount: chargeAmountInDollars,
          reason: e.message, failedAt: FieldValue.serverTimestamp(),
        },
      }, { merge: true }).catch(() => {});
      throw new HttpsError('internal', `Card charge failed: ${e.message}`);
    }
  }
  // chargeAmountInCents === 0 means the referral credit fully covered this
  // charge — Stripe doesn't allow a $0 PaymentIntent, so it's skipped
  // entirely rather than attempted; paymentIntent stays null and the
  // submission is still marked charged, since nothing further is owed.

  await db.collection('submissions').doc(submissionId).set({
    paymentMethodStatus: 'charged',
    lastChargeId: paymentIntent ? paymentIntent.id : null,
    lastChargeAmount: chargeAmountInDollars,
    lastChargedAt: FieldValue.serverTimestamp(),
    lastChargeAttempt: {
      chargeKey, status: 'charged', amount: chargeAmountInDollars,
      paymentIntentId: paymentIntent ? paymentIntent.id : null,
      chargedAt: FieldValue.serverTimestamp(),
    },
    ...(creditApplied > 0 ? { referralCreditApplied: creditApplied } : {}),
    ...(referralDiscountApplied > 0 ? { referralDiscountApplied } : {}),
    ...(carryForwardCents > 0 ? { referralCreditCarriedForward: carryForwardCents / 100 } : {}),
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
    await finalizeNewMemberReferralDiscount(stripe, memberId, billingData.referralSubmissionId || null, referralDiscount, discountCents, carryForwardCents);
  }

  return {
    success: true, paymentIntentId: paymentIntent ? paymentIntent.id : null,
    creditApplied, referralDiscountApplied,
    referralCreditCarriedForward: carryForwardCents / 100,
  };
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

  // Everything below this point either succeeds with a real subscription or
  // throws — no more early "not an error" returns past this line. On any
  // throw, needsReview is set on the billing subdoc before rethrowing:
  // saveMember still creates the member on a failure here (see its own
  // subscriptionSkipped handling), so without this the member is left
  // active and unbilled with nothing durable pointing that out beyond a
  // one-time modal warning. See dismissBillingReview for how this clears.
  try {
    const subDoc = await db.collection('submissions').doc(submissionId).get();
    const sub = subDoc.data();

    if (!sub || !sub.stripeCustomerId) {
      throw new HttpsError('failed-precondition', 'No saved card found for this submission.');
    }

    const paymentMethods = await stripe.paymentMethods.list({ customer: sub.stripeCustomerId, type: 'card' });
    if (!paymentMethods.data.length) {
      throw new HttpsError('failed-precondition', 'Customer has no saved payment method.');
    }

    // Set as the default payment method for invoices on this customer, and tag
    // the customer with the Firestore memberId — stripeWebhook's Stripe-side
    // fallback lookup (see findMemberIdByStripeCustomerId) reads this back when
    // the Firestore-side lookup (billing.stripeCustomerId) can't resolve it.
    await stripe.customers.update(sub.stripeCustomerId, {
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
      stripeCustomerId: sub.stripeCustomerId,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionItemId: subscription.items.data[0].id,
      billingStatus: 'active',
      // Referral credit intake: carried over from the originating submission
      // so the first-payment credit logic (chargeCurrentMonthWalks /
      // stripeWebhook's invoice.paid handler) can find it without ever having
      // to read the submissions collection itself. referralSubmissionId is
      // this same submissionId — stashed here because credit issuance needs
      // it to address the matching referralCodes/{code}/redemptions/{id} doc,
      // and by then it only has memberId to start from, not this submission.
      referredByCode: sub.referredByCode || null,
      referralSubmissionId: submissionId,
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
});

// ─────────────────────────────────────────────────────────────────────────
// 3a-review. Clears billing.needsReview/needsReviewReason on a member's
// billing subdoc. Generic across every reason that flag gets set for
// (subscription_creation_failed here, plus runFirstPaymentReferralCredit's
// possible_self_referral/partner_code_already_redeemed and the walk
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
const VALID_WALK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const VALID_TIME_SLOTS = ['morning', 'early-afternoon', 'late-afternoon'];
// Allowed day-count per tier. Daily is fixed at the full weekday set.
const TIER_DAY_RULES = {
  Essential: { min: 1, max: 2, label: 'Essential tier is limited to 2 days per week' },
  Standard:  { min: 3, max: 4, label: 'Standard tier requires 3 to 4 days per week' },
  Daily:     { min: 5, max: 5, label: 'Daily members are scheduled every weekday and cannot change their days' },
};

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

  const rule = TIER_DAY_RULES[member.tier];
  if (!rule) {
    return { success: false, error: `Your account tier (${member.tier || 'none'}) does not support schedule changes here. Please contact us.` };
  }

  const { defaultWalkDays, defaultTimeSlot, resolutions } = request.data || {};

  // Normalize days: lowercase + trim, drop blanks, dedupe. Reject anything
  // that isn't a Monday–Friday name (weekends aren't part of any tier).
  if (!Array.isArray(defaultWalkDays)) {
    return { success: false, error: 'Please select your walk days.' };
  }
  const days = [...new Set(defaultWalkDays.map(d => String(d || '').toLowerCase().trim()).filter(Boolean))];
  const invalidDay = days.find(d => !VALID_WALK_DAYS.includes(d));
  if (invalidDay) {
    return { success: false, error: `"${invalidDay}" is not a valid walk day. Choose Monday through Friday.` };
  }

  // Time slot must be one of the canonical values the walk generator understands.
  if (!VALID_TIME_SLOTS.includes(defaultTimeSlot)) {
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
// ─────────────────────────────────────────────────────────────────────────
exports.chargeCurrentMonthWalks = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  await assertIsAdmin(request.auth);

  const { memberId } = request.data || {};
  if (!memberId) throw new HttpsError('invalid-argument', 'memberId is required.');

  const memberRef = db.collection('members').doc(memberId);
  const billing = billingRef(memberId);
  // Dual-read: member doc (tier, schedule, membershipStartDate) + billing
  // subdoc (currentMonthCharge idempotency guard, stripeCustomerId). Both are
  // needed before we can decide whether to charge.
  const [memberDoc, billingDoc] = await Promise.all([memberRef.get(), billing.get()]);
  const member = memberDoc.data();
  if (!member) throw new HttpsError('not-found', 'Member record not found.');
  const billingData = billingDoc.data() || {};

  const priceId = TIER_PRICE_IDS[member.tier];
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

  // New-member referral discount, decided fresh right here rather than after
  // the charge — see resolveNewMemberReferralDiscount. A pure read, nothing
  // committed yet, so a retried/failed charge safely re-evaluates instead of
  // trusting a stale decision. Gated on billingData.referralCreditChecked
  // (already in hand from the dual-read above): once a member's first-payment
  // outcome has ever been recorded — by this function or by
  // runFirstPaymentReferralCredit on a LATER month's regular subscription
  // invoice — every later chargeCurrentMonthWalks call must never re-discount
  // them again. Flat $50 entitlement, capped at 50% of THIS charge so a
  // small prorated first month is never more than half off (and never
  // reaches $0 — Stripe won't allow a $0 PaymentIntent). Whatever the cap
  // leaves unused carries forward — see finalizeNewMemberReferralDiscount —
  // so the member still gets the full $50 promised externally, just not
  // always all in this one charge.
  const referralDiscount = billingData.referralCreditChecked
    ? null
    : await resolveNewMemberReferralDiscount(memberId, billingData, member);
  const discountCents = (referralDiscount && referralDiscount.decision === 'approved')
    ? Math.min(referralDiscount.discountCents, Math.floor(amountInCents / 2))
    : 0;
  const carryForwardCents = (referralDiscount && referralDiscount.decision === 'approved')
    ? referralDiscount.discountCents - discountCents
    : 0;
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
    throw new HttpsError('internal', `Card charge for this month failed: ${e.message}`);
  }

  await billing.set({
    currentMonthCharge: {
      periodKey, walkCount: days.length, amount: chargeAmountInCents / 100,
      status: 'charged', paymentIntentId: paymentIntent.id,
      chargedAt: FieldValue.serverTimestamp(),
      ...(discountCents > 0 ? { referralDiscountApplied: discountCents / 100 } : {}),
      ...(carryForwardCents > 0 ? { referralCreditCarriedForward: carryForwardCents / 100 } : {}),
    },
  }, { merge: true });

  // Post-charge commit for the discount decided above — see
  // finalizeNewMemberReferralDiscount. For a brand-new membership member
  // this one-off charge (the prorated remainder of their signup month) is
  // almost always their REAL first payment — their subscription's own first
  // Stripe Invoice isn't until the 1st of next month (billing_cycle_anchor,
  // set in createMembershipSubscription). Only called when referralDiscount
  // was actually computed above (i.e. this genuinely might be the member's
  // first payment) — never throws, never re-decides eligibility, only
  // records what was already applied to the charge that just succeeded.
  if (referralDiscount) {
    await finalizeNewMemberReferralDiscount(stripe, memberId, billingData.referralSubmissionId || null, referralDiscount, discountCents, carryForwardCents);
  }

  return {
    success: true, periodKey, walkCount: days.length,
    amount: chargeAmountInCents / 100, fromDay, dates: days,
    paymentIntentId: paymentIntent.id,
    ...(discountCents > 0 ? { referralDiscountApplied: discountCents / 100 } : {}),
    ...(carryForwardCents > 0 ? { referralCreditCarriedForward: carryForwardCents / 100 } : {}),
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
//      - invoice.payment_failed: FLAG only (billingStatus: 'past_due') —
//        does NOT stop walk generation. Both monthly crons run once a
//        month, so the exposure window is already bounded by that cadence;
//        Stripe's own retry schedule is what actually decides whether a
//        decline resolves itself, and re-implementing that logic here would
//        be redundant at best. This just gives admin visibility to act
//        sooner than Stripe's own timeline if they choose to.
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
//        that member's $50 still arrives as old-style forward credit rather
//        than an upfront discount. referralCreditChecked (not which event
//        delivered it) is what actually decides "first" either way.
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
// written at signup by createSetupIntent long before any subscription
// exists, so querying it directly avoids a Stripe round-trip on every
// webhook delivery and doesn't depend on customer metadata being set. Falls
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
// versa. Defaults to the full $50 (5000 cents) — every existing caller
// issues the whole flat amount; finalizeNewMemberReferralDiscount's
// carry-forward step is the one caller that passes a partial amount.
// Throws on failure (never swallows) — the caller (runFirstPaymentReferralCredit
// for the invoice.paid fallback, finalizeNewMemberReferralDiscount for the
// pre-charge path's referrer-credit and carry-forward issuance) is what
// decides how a failure here affects creditIssued/redemption status.
async function issueReferralCredit(stripe, memberId, memberData, amountCents = 5000) {
  const isMembershipTier = !!TIER_PRICE_IDS[memberData.tier];
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
  const isMemberReferral = codeData.source === 'member_referral' && !!codeData.referrerId;
  const isPartnerCode = codeData.source === 'apartment' || codeData.source === 'agent';

  // Single-redemption enforcement: only meaningful for partner
  // (apartment/agent) codes — each one is generated for ONE specific lead
  // (generateReferralCode/runGenerateReferralCode), unlike a member's own
  // evergreen code, which is designed to be shared with and redeemed by
  // many different friends. redeemedByMemberId is set once a partner code's
  // first successful discount/credit lands; a SECOND, different member
  // reaching this point with the same code (photographed/shared physical
  // card, genuine duplicate entry, etc.) gets flagged instead of silently
  // benefiting a second time.
  if (isPartnerCode && codeData.creditIssued && codeData.redeemedByMemberId
      && codeData.redeemedByMemberId !== memberId) {
    console.warn(`resolveNewMemberReferralDiscount: partner code ${referredByCode} was already redeemed by member ${codeData.redeemedByMemberId} — member ${memberId} flagged, no discount.`);
    return { referredByCode, decision: 'flagged', flagReason: 'partner_code_already_redeemed', discountCents: 0, isMemberReferral, referrerId: null };
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
    // Flat $50 entitlement — callers cap this against their own charge
    // amount (currently: never more than 50% of that one charge).
    discountCents: 5000,
    isMemberReferral, referrerId: isMemberReferral ? codeData.referrerId : null,
  };
}

// Post-charge commit for the pre-charge discount path (chargeCurrentMonthWalks,
// chargeSavedCard). The discount itself was already decided by
// resolveNewMemberReferralDiscount and subtracted from the charge BEFORE this
// runs — nothing here can undo that — so this only ever records what already
// happened and issues the referrer's own credit (member_referral codes only;
// the new member's own $50 was already realized as the charge-time discount,
// not a separate issuance here). The claim transaction below mirrors
// runFirstPaymentReferralCredit's, but happens here, post-charge, rather than
// pre-decision — the discount decision itself has to stay a repeatable,
// non-committing read (see resolveNewMemberReferralDiscount), since claiming
// it before a charge that might then fail would permanently strand a
// legitimate retry with no discount and no way to reclaim it.
//
// referralSubmissionId may be null (a discount decision with no code, or no
// submission on file) — every write below is skipped in that case, same as
// the 'none' decision.
//
// carryForwardCents is the gap between the flat $50 entitlement and
// appliedDiscountCents (whatever the 50%-of-charge cap actually let through)
// — issued below via issueReferralCredit so the new member still gets the
// full $50 of value promised everywhere externally (gift cards, email,
// /welcomehome), just not always all at once. Goes through the SAME
// tier-branching issueReferralCredit already uses for referrer credit: a
// Stripe balance credit (auto-applies to the member's own next invoice) for
// a membership-tier new member, pendingReferralCredit (applied on their next
// chargeSavedCard) for Travel-tier — pendingReferralCredit alone would never
// actually be spent by a membership-tier member, since nothing in their
// billing path ever reads it back.
async function finalizeNewMemberReferralDiscount(stripe, memberId, referralSubmissionId, discount, appliedDiscountCents, carryForwardCents) {
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

    if (carryForwardCents > 0) {
      stage = 'carry-forward-credit';
      const memberSnap = await db.collection('members').doc(memberId).get();
      const memberData = memberSnap.data();
      if (!memberData) {
        // The charge-time discount already succeeded — this throw stops
        // short of implying the full $50 was honored when part of it
        // wasn't, same "stuck case, needs a human" reasoning as the missing-
        // referrer throw below.
        throw new Error(`Member ${memberId} not found — cannot carry forward the remaining $${(carryForwardCents / 100).toFixed(2)} referral credit.`);
      }
      await issueReferralCredit(stripe, memberId, memberData, carryForwardCents);
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
      await issueReferralCredit(stripe, discount.referrerId, referrerData);
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
// member's $50 still arrives as forward credit (a Stripe balance credit, or
// pendingReferralCredit for Travel-tier) rather than an upfront discount.
// Rare, and considered acceptable: see the design discussion this replaced.
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
// Never throws — the caller runs this after its own success and must
// never have a referral-credit bug make that success look like a failure.
async function runFirstPaymentReferralCredit(stripe, memberId) {
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

    stage = 'new-member-credit';
    await issueReferralCredit(stripe, memberId, memberData);

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
      await issueReferralCredit(stripe, discount.referrerId, referrerData);
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
        await billingRef(memberId).set({ billingStatus: 'past_due' }, { merge: true });
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
        await runFirstPaymentReferralCredit(stripe, memberId);
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
  if (!['portal-service-confirmed', 'walk-confirmed'].includes(template)) {
    throw new HttpsError('invalid-argument', 'template must be "portal-service-confirmed" or "walk-confirmed".');
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
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
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
// 9b. Overnight/check-in payout rate-stamping — completeOvernight() in
//    walker/dashboard.html is a plain client write with no prior server-side
//    hook (unlike walks, which already had onWalkCompleted for SMS). Same
//    guard pattern as onWalkCompleted, same reasoning: fixes what a
//    completed overnight is worth at the moment it's marked done, immune to
//    WALKER_RATES changing later. No SMS/member-notification counterpart
//    exists for overnights, so this trigger only does the rate stamp.
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

function isoDateStr(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// A claimed walks/{id} doc -> one walkerPayments.items[] entry. Reads
// entirely from the doc's already-stamped `payout` (see onWalkCompleted) —
// never recomputes from live WALKER_RATES, so a rate change after this
// walk was completed can't retroactively change what this payment record
// says it paid.
function walkItemFromSnap(snap) {
  const w = snap.data();
  return {
    type: 'walk', refCollection: 'walks', refId: snap.id, date: w.date,
    rateKey: w.payout.rateKey, rateApplied: w.payout.amount,
    extraPet: false, medication: false, amount: w.payout.amount,
  };
}

// Same, for a claimed overnights/{id} doc — reads entirely from the
// stamped `payout` (see onOvernightCompleted).
function overnightItemFromSnap(snap) {
  const o = snap.data();
  return {
    type: o.payout.rateKey === 'checkin' ? 'checkin' : 'overnight',
    refCollection: 'overnights', refId: snap.id, date: o.startDate,
    rateKey: o.payout.rateKey, rateApplied: o.payout.rate,
    extraPet: !!o.extraPet, medication: !!o.medication, amount: o.payout.amount,
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
  };
  walkSnaps.forEach(snap => {
    const w = snap.data();
    counts[w.payout.rateKey].count++;
    counts[w.payout.rateKey].total += w.payout.amount;
  });
  overnightSnaps.forEach(snap => {
    const o = snap.data();
    counts[o.payout.rateKey].count++;
    counts[o.payout.rateKey].total += o.payout.baseTotal;
    if (o.payout.extraPetTotal) { counts.extraPet.count++; counts.extraPet.total += o.payout.extraPetTotal; }
    if (o.payout.medicationTotal) { counts.medication.count++; counts.medication.total += o.payout.medicationTotal; }
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
// only ever offers Overnight Stay / Check-In Visit — always pet sitting,
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

  const code = await createReferralCodeDoc({
    source,
    building,
    agent,
    brokerage,
    submittedName,
    submittedPhone,
    submittedEmail,
    notes,
    // referrerId/referrerName are null here (only member_referral docs,
    // written by getOrCreateMemberReferralCode, set them) — explicit null
    // rather than an absent field so referralCodes' member-scoped read rule
    // (resource.data.referrerId == request.auth.uid) has a consistent field
    // to compare against on every doc, partner or member.
    referrerId: null,
    referrerName: null,
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
    data: { firstName: submittedName.split(/\s+/)[0] || 'there', code },
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

// Member portal "Refer a Friend" tab: an existing member's own evergreen
// referral code, generated once and reused thereafter. Unlike
// generateReferralCode (anonymous /welcomehome intake), this is auth-gated —
// request.auth.uid IS the referrer, so there's no client payload to spoof
// identity from, and no assertIsAdmin(): any signed-in member may fetch
// their own code, never anyone else's.
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

// Signup-form code validation (membership-request.html / service-request.html).
// referralCodes has no public read rule (see firestore.rules), so the client
// can't check a code directly — this callable is the narrow, PII-free
// substitute: it looks the code up with the Admin SDK and returns only a
// boolean, never the referrer's identity. No assertIsAdmin(): the person
// entering a friend's code at signup isn't authenticated at all yet.
exports.validateReferralCode = onCall({}, async (request) => {
  const code = typeof request.data?.code === 'string' ? request.data.code.trim() : '';
  if (!code) return { valid: false };
  const snap = await db.collection('referralCodes').doc(code).get();
  return { valid: snap.exists && snap.data().status === 'active' };
});
