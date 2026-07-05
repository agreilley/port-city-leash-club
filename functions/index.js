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

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

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

  const { submissionId, memberId, priceId } = request.data || {};
  if (!submissionId || !memberId || !priceId) {
    throw new HttpsError('invalid-argument', 'submissionId, memberId, and priceId are required.');
  }
  // priceId = the Stripe Price ID for the chosen tier (Essential/Standard/Daily).
  // Create these once in the Stripe Dashboard (Products > Add Product,
  // one recurring monthly price per tier) and reference the IDs here —
  // see the checklist for exact steps.

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

  // Next 1st-of-month timestamp, in seconds (Stripe billing_cycle_anchor format).
  const now = new Date();
  const nextFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const billingCycleAnchor = Math.floor(nextFirst.getTime() / 1000);

  const subscription = await stripe.subscriptions.create({
    customer: sub.stripeCustomerId,
    items: [{ price: priceId }],
    billing_cycle_anchor: billingCycleAnchor,
    proration_behavior: 'none',
  });

  await db.collection('members').doc(memberId).set({
    stripeCustomerId: sub.stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    billingStatus: 'active',
  }, { merge: true });

  return { success: true, subscriptionId: subscription.id };
});
