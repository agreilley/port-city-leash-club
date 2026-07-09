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
const { onSchedule } = require('firebase-functions/v2/scheduler');

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
const BUSINESS_EMAIL_DISPLAY = 'Port City Leash Club <hello@portcityleashclub.com>';
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

async function sendGmailMessage({ to, subject, body, threadId, inReplyTo, references, from }) {
  const gmail = await getGmailClient();
  if (!gmail) {
    throw new HttpsError('failed-precondition', 'Gmail isn\'t connected yet — connect it from the admin portal first.');
  }
  const headers = [
    `To: ${to}`,
    `From: ${from || BUSINESS_EMAIL_DISPLAY}`,
    `Subject: ${subject || '(no subject)'}`,
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
// 6. Poll Gmail for anything new since the last check — both the inbox
//    (member replies) and Sent (catches replies typed directly in Gmail,
//    not just ones sent through the portal). Runs every 5 minutes.
//    Only messages matching a known member's email get logged — random
//    inbox traffic (newsletters, unrelated email) is ignored.
// ─────────────────────────────────────────────────────────────────────────
exports.gmailSyncPoll = onSchedule({ schedule: 'every 5 minutes', secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] }, async () => {
  const gmail = await getGmailClient();
  if (!gmail) return; // not connected yet

  const authDoc = await db.collection('system').doc('gmailAuth').get();
  const lastSyncedAt = authDoc.data()?.lastSyncedAt?.toDate?.() || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const afterUnix = Math.floor(lastSyncedAt.getTime() / 1000);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${afterUnix} (in:inbox OR in:sent)`,
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
    if (!member) continue; // not a recognized member — skip

    const alreadyLogged = await db.collection('conversations').doc(member.id)
      .collection('messages').where('externalId', '==', m.id).limit(1).get();
    if (!alreadyLogged.empty) continue; // already have this one (e.g. sent through the portal)

    let body = headers.subject || '(no subject)';
    if (!isFromMe) {
      const fullRes = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      body = extractPlainTextBody(fullRes.data) || body;
    }

    await logConversationMessage(member.id, {
      channel: 'email',
      direction: isFromMe ? 'outbound' : 'inbound',
      body,
      subject: headers.subject || null,
      sentBy: isFromMe ? 'admin_via_gmail' : 'member',
      status: 'sent',
      externalId: m.id,
    });
  }

  await db.collection('system').doc('gmailAuth').set({ lastSyncedAt: FieldValue.serverTimestamp() }, { merge: true });
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
  pause_request: 'Membership pause request',
  tier_change: 'Membership tier change request',
  dog_update: 'Dog roster update',
  overnight_request: 'Overnight / check-in request',
  walker_incident: 'Walker incident report',
  walker_schedule_request: 'Walker schedule request',
};

exports.onNewSubmission = onDocumentCreated({
  document: 'submissions/{submissionId}',
  secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET],
}, async (event) => {
  const sub = event.data?.data();
  if (!sub) return;

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

  const bodyLines = [
    `${label} from ${name}${emailAddr ? ` (${emailAddr})` : ''}.`,
    dogName ? `Dog: ${dogName}` : null,
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
      subject: `${label} — ${name}`,
      body: bodyLines.join('\n'),
    });
  } catch (e) {
    console.error('Request notification email failed:', e.message);
  }
});
