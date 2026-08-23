// dev/emulator-seed.js
//
// Seeds and (where possible) directly exercises fabricated referral-credit
// states that no product flow can produce — Scenarios 7, 9, 10, 11 of the
// referral-credit test plan. Never deployed, never touches production: the
// four EMULATOR_HOST env vars below are set as the literal first lines of
// this file, before functions/index.js (required just after) gets a chance
// to call initializeApp()/getFirestore()/getAuth() — so there is no code
// path from this script to real Firestore/Auth, regardless of what's called
// below. Requiring functions/index.js is deliberate: it's already designed
// for exactly this (see runGenerateReferralCode/runFirstPaymentReferralCredit's
// own "exposed directly... testable" comments) — this script reuses that,
// rather than re-implementing the logic under test.
//
// Prereqs (see firebase.json's "emulators" block for ports):
//   0. cd functions && npm install — functions/node_modules is currently
//      missing stripe, twilio, and googleapis despite being declared in
//      functions/package.json (only firebase-admin/firebase-functions are
//      actually present as of this writing). Cloud Build reinstalls fresh
//      from package.json on every real deploy, so this gap hasn't broken
//      production — but it WILL break this script and the emulator's own
//      functions runtime locally until you run npm install once.
//   1. firebase emulators:start --only auth,firestore,functions
// Confirmed by running this script with no emulator up: it hangs rather
// than failing fast (the Firestore Admin SDK's gRPC client retries/backs
// off instead of an instant connection-refused) — if a run seems to just
// sit there, the emulator isn't actually up yet, not a code bug.
// On first run the CLI will report that STRIPE_SECRET_KEY / RESEND_API_KEY
// are declared secrets with no local value and tell you to create
// functions/.secret.local — give STRIPE_SECRET_KEY a real sk_test_... key
// (Stripe TEST mode — this never touches live Stripe) and RESEND_API_KEY
// any placeholder string (email sends will fail against a fake key; none of
// these scenarios depend on the email actually going out).
//
// Usage:
//   node dev/emulator-seed.js scenario7  <stripeCustomerId> <invoiceAmountDollars>
//   node dev/emulator-seed.js scenario9
//   node dev/emulator-seed.js scenario10 <stripeCustomerId>
//   node dev/emulator-seed.js scenario11
//
// scenario7's <invoiceAmountDollars> stands in for the Stripe invoice's own
// amount_paid, which stripeWebhook threads into runFirstPaymentReferralCredit
// in production — this script calls the function directly, so it has to
// supply that number itself rather than getting it from a real webhook
// event. runFirstPaymentReferralCredit now caps the credit it issues at
// Math.floor(invoiceAmountPaidCents / 2), same rule the two pre-charge paths
// apply — pass a small amount (e.g. 27, matching a 1-walk prorated month) to
// exercise the cap binding, or a large one (e.g. 500) to see it not bind.
//
// Stripe TEST-mode prerequisites per scenario (create with your own
// sk_test_... key, e.g. via `stripe` CLI or the Test Mode dashboard):
//   scenario7:  a test customer, no card needed (balance credit only).
//     stripe customers create --api-key sk_test_...
//   scenario10: a test customer WITH a card attached (needs a real charge).
//     stripe customers create --api-key sk_test_...
//     stripe payment_methods attach pm_card_visa --customer <id> --api-key sk_test_...
//   scenario9:  none — pure Firestore read, no Stripe, no auth.
//   scenario11: needs a TEST-mode Price matching MEMBER_PRICE_ID's $27/walk
//     terms, since createMembershipSubscription calls stripe.prices.retrieve
//     on the LIVE price id hardcoded in functions/index.js — that id doesn't
//     exist in test mode. functions/.env.local is the ONLY sanctioned way to
//     point a local/emulator run at a different price id — see the comment
//     inside scenario11() below for exactly what that currently requires.

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT = 'port-city-leash-club-827ab';

const PROJECT_ID = 'port-city-leash-club-827ab';
const REGION = 'us-central1';

// This file lives in dev/, which has no node_modules of its own (no root
// package.json in this repo at all — only functions/ and dev/render-emails.js's
// sibling tools ever needed to require code, not npm packages, from
// functions/). firebase-admin and stripe are installed only in
// functions/node_modules, so a plain top-level require('firebase-admin/...')
// or require('stripe') from THIS file's own location would fail to resolve —
// Node's module lookup walks up from the requiring file's directory, and
// dev/ isn't a descendant of functions/'s node_modules. createRequire scoped
// to functions/index.js's own path borrows its resolution instead, which is
// the standard fix for exactly this cross-directory situation.
const { createRequire } = require('module');
const functionsRequire = createRequire(require.resolve('../functions/index.js'));

const { runFirstPaymentReferralCredit } = require('../functions/index.js');
const { getFirestore, FieldValue, Timestamp } = functionsRequire('firebase-admin/firestore');
const { getAuth } = functionsRequire('firebase-admin/auth');
const db = getFirestore();
const auth = getAuth();

function billingRef(memberId) {
  return db.collection('members').doc(memberId).collection('private').doc('billing');
}

async function seedReferralCode(codeId, fields = {}) {
  await db.collection('referralCodes').doc(codeId).set({
    code: codeId, source: 'apartment', status: 'active', creditIssued: false,
    building: 'Test Building', agent: null, brokerage: null,
    submittedName: 'Test Referrer', submittedPhone: '9105550099',
    submittedEmail: 'referrer@example.com', submittedEmailNormalized: 'referrer@example.com',
    notes: null, referrerId: null, referrerName: null,
    createdAt: FieldValue.serverTimestamp(),
    ...fields,
  });
}

async function seedMember(memberId, { tier = 'Member', defaultWalkDays = [] } = {}) {
  await db.collection('members').doc(memberId).set({
    name: 'Test Member', email: `${memberId}@example.com`, tier, status: 'active',
    defaultWalkDays, walksThisMonth: 0, createdAt: FieldValue.serverTimestamp(),
  });
}

async function makeAdmin() {
  const user = await auth.createUser({ email: `admin-${Date.now()}@test.local`, password: 'testpass123' });
  await db.collection('admins').doc(user.uid).set({ createdAt: FieldValue.serverTimestamp() });
  return user.uid;
}

// Mints a real Firebase ID token for `uid` via the Auth emulator's own REST
// API — the same custom-token -> ID-token exchange every client SDK does,
// just scripted directly. 'fake-api-key' is the Auth emulator's own
// documented placeholder; it never talks to real Firebase.
async function mintIdToken(uid) {
  const customToken = await auth.createCustomToken(uid);
  const res = await fetch(
    'http://localhost:9099/identitytoolkit.google.com/v1/accounts:signInWithCustomToken?key=fake-api-key',
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const json = await res.json();
  if (!json.idToken) throw new Error('Failed to mint ID token: ' + JSON.stringify(json));
  return json.idToken;
}

// Calls an onCall function hosted by the Functions emulator — the same wire
// protocol httpsCallable uses. idToken omitted calls it unauthenticated
// (fine for the public callables: validateReferralCode, generateReferralCode,
// generateEmailCaptureCode). Response envelope is {result: ...} on success,
// {error: {status, message}} on a thrown HttpsError — check both.
async function callFunction(name, data, idToken) {
  const res = await fetch(`http://localhost:5001/${PROJECT_ID}/${REGION}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return res.json();
}

// ── Scenario 7 — zero-remaining-days fallback (runFirstPaymentReferralCredit) ──
// Called DIRECTLY (plain export, no HTTP round trip) — the whole point of
// exporting it. defaultWalkDays:[] guarantees zero remaining walk days
// unconditionally, sidestepping the real product's calendar-timing
// dependency entirely — a fabrication only possible because we're seeding
// Firestore directly instead of going through a real signup form.
async function scenario7() {
  const stripeCustomerId = process.argv[3];
  const invoiceAmountDollars = process.argv[4];
  if (!stripeCustomerId || !invoiceAmountDollars) {
    throw new Error('Usage: node dev/emulator-seed.js scenario7 <TEST-MODE stripe customer id> <invoiceAmountDollars>');
  }
  const invoiceAmountPaidCents = Math.round(parseFloat(invoiceAmountDollars) * 100);
  const expectedCapCents = Math.floor(invoiceAmountPaidCents / 2);

  const memberId = 'scen7-' + Date.now();
  const codeId = 'PCLC-SCEN7X';
  await seedReferralCode(codeId);
  await seedMember(memberId, { tier: 'Member', defaultWalkDays: [] });
  await billingRef(memberId).set({
    stripeCustomerId, referredByCode: codeId,
    currentMonthCharge: { periodKey: 'seed', walkCount: 0, amount: 0, status: 'skipped', reason: 'no-walks-remaining' },
  });

  console.log('Before:', (await billingRef(memberId).get()).data());
  console.log(`Invoice amount_paid: $${invoiceAmountDollars} (${invoiceAmountPaidCents}c) — expected cap: $${(expectedCapCents / 100).toFixed(2)} (${expectedCapCents}c). Code entitlement is $50 (5000c) — cap binds if expectedCapCents < 5000.`);

  const stripeKey = process.env.STRIPE_SECRET_KEY_TEST;
  if (!stripeKey) throw new Error('Set STRIPE_SECRET_KEY_TEST=sk_test_... in your shell before running scenario7 (this is the key runFirstPaymentReferralCredit actually calls Stripe with — kept separate from STRIPE_SECRET_KEY so it never collides with whatever the Functions emulator itself is configured with).');
  const stripe = functionsRequire('stripe')(stripeKey);
  await runFirstPaymentReferralCredit(stripe, memberId, invoiceAmountPaidCents);

  console.log('After:', (await billingRef(memberId).get()).data());
  console.log('Code doc:', (await db.collection('referralCodes').doc(codeId).get()).data());
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  console.log(`Stripe customer balance (cents, expect -${Math.min(5000, expectedCapCents)} from 0 — the smaller of the $50 entitlement and the cap):`, customer.balance);
}

// ── Scenario 9 — expired code rejected at signup (validateReferralCode) ────
// Public callable, no auth needed. Pure Firestore read — no Stripe involved
// at all.
async function scenario9() {
  const codeId = 'PCLC-SCEN09';
  await seedReferralCode(codeId, { expiresAt: Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000) });
  const result = await callFunction('validateReferralCode', { code: codeId }, null);
  console.log('validateReferralCode result:', JSON.stringify(result));
  console.log('Pass criterion: result.result.valid === false');
}

// ── Scenario 10 — expired code rejected at charge time (chargeSavedCard) ───
// Admin-gated onCall, invoked via a minted admin ID token. No subscription/
// Price lookup on this path — chargeCustomerCard just needs a customer with
// a card attached, so this needs no Stripe Price setup (unlike Scenario 11).
async function scenario10() {
  const stripeCustomerId = process.argv[3];
  if (!stripeCustomerId) throw new Error('Usage: node dev/emulator-seed.js scenario10 <TEST-MODE stripe customer id with a card attached>');

  const memberId = 'scen10-' + Date.now();
  const codeId = 'PCLC-SCEN10';
  const submissionId = 'scen10-sub-' + Date.now();

  await seedReferralCode(codeId); // starts VALID — the signup happens while it's still good
  await seedMember(memberId, { tier: 'Travel' });
  await billingRef(memberId).set({ stripeCustomerId, referredByCode: codeId });
  await db.collection('submissions').doc(submissionId).set({
    type: 'service_request', memberId, ownerName: 'Test Owner', email: `${memberId}@example.com`, status: 'confirmed',
  });

  // Simulate the code expiring in the gap between signup and charge — this
  // console/script edit stands in for real elapsed time.
  await db.collection('referralCodes').doc(codeId).set({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) }, { merge: true });

  const adminUid = await makeAdmin();
  const idToken = await mintIdToken(adminUid);
  const result = await callFunction('chargeSavedCard',
    { submissionId, amountInDollars: 30, description: 'Scenario 10 test charge' }, idToken);
  console.log('chargeSavedCard result:', JSON.stringify(result));
  console.log('Pass criterion: result.result.referralDiscountApplied is 0 or absent, no needsReview flag, and the PaymentIntent in the Stripe TEST dashboard is exactly $30.00.');
}

// ── Scenario 11 — one-code guard (createMembershipSubscription) ────────────
// Admin-gated onCall. Unlike 7/9/10, this path calls stripe.prices.retrieve
// on MEMBER_PRICE_ID, a LIVE-mode price id hardcoded in functions/index.js —
// it does not exist in Stripe TEST mode, so this call will fail with "No
// such price" UNLESS you first create a matching TEST-mode Price ($27/walk):
//   stripe prices create --api-key sk_test_... --currency usd --unit-amount 2700 \
//     --product-data.name="Test Membership (emulator only)"
// functions/.env.local (read automatically by the Functions emulator, never
// by a real deploy) is the ONLY sanctioned way to point a local run at that
// test price instead of the hardcoded live one — deliberately not a
// temporary hand-edit to MEMBER_PRICE_ID in functions/index.js, reverted
// before deploying, since that's a documented path for a test id to reach
// production the day someone forgets the revert.
//
// IMPORTANT: as of this writing, MEMBER_PRICE_ID is a hardcoded literal —
// functions/index.js does not yet read it from process.env at all, so
// functions/.env.local has nothing to override. Making it
// `process.env.MEMBER_PRICE_ID_TEST_OVERRIDE || 'price_1U3N...'` would be a
// one-line change to billing-critical pricing-resolution code, which this
// script deliberately has not made unprompted. Until that line exists,
// Scenario 11's Stripe call will fail with "No such price" regardless of
// any Stripe TEST-mode Price you create — say the word if you want that
// override line added; until then, the guard's correctness (read-before-
// write, only writes if nothing's already there) is confirmed by static
// code review at functions/index.js's two referredByCode write sites — this
// function still proves the pattern via the real deployed code path up to
// the point where the Stripe call fails.
async function scenario11() {
  const memberId = 'scen11-' + Date.now();
  const codeA = 'PCLC-SCEN11A';
  const codeB = 'PCLC-SCEN11B';
  const submissionId = 'scen11-sub-' + Date.now();

  await seedReferralCode(codeA);
  await seedReferralCode(codeB);
  await seedMember(memberId, { tier: 'Member' });
  // referredByCode already A, no stripeSubscriptionId — so
  // createMembershipSubscription's own idempotency guard (which checks
  // stripeSubscriptionId, not referredByCode) won't short-circuit before
  // reaching the referredByCode write this test is actually about.
  await billingRef(memberId).set({ referredByCode: codeA, stripeCustomerId: 'cus_test_placeholder' });
  await db.collection('submissions').doc(submissionId).set({
    type: 'membership_request', memberId, referredByCode: codeB, status: 'confirmed',
  });

  const adminUid = await makeAdmin();
  const idToken = await mintIdToken(adminUid);
  const result = await callFunction('createMembershipSubscription', { submissionId, memberId }, idToken);
  console.log('createMembershipSubscription result:', JSON.stringify(result));

  const billingAfter = (await billingRef(memberId).get()).data();
  console.log('billing.referredByCode after:', billingAfter.referredByCode, `(pass = still "${codeA}", not "${codeB}")`);
}

const SCENARIOS = { scenario7, scenario9, scenario10, scenario11 };
const name = process.argv[2];
if (!SCENARIOS[name]) {
  console.error(`Usage: node dev/emulator-seed.js <${Object.keys(SCENARIOS).join('|')}> [args]`);
  process.exit(1);
}
SCENARIOS[name]()
  .then(() => process.exit(0))
  .catch((e) => { console.error('Failed:', e); process.exit(1); });
