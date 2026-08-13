// functions/lib/email.js
//
// Shared send helper for automated, templated email via Resend — the
// launch-critical requester-facing emails (request received, welcome,
// booking confirmed). Deliberately NOT used for sendMemberMessage (the
// admin's free-text composer), logConversationMessage, gmailSyncPoll, or
// anything in the Gmail OAuth flow — those stay on Gmail exactly as they
// are so replies keep landing in the connected mailbox and the admin inbox.
//
// Node 20's built-in fetch talks to the Resend REST API directly rather
// than pulling in the `resend` npm package — this is a handful of plain
// HTTP calls with our own retry policy on top, not enough surface to
// justify a new dependency next to the existing lean stripe/twilio/
// googleapis set.

const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Set via: firebase functions:secrets:set RESEND_API_KEY
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

const FROM_ADDRESS = 'Port City Leash Club <hello@portcityleashclub.com>';
const DEFAULT_REPLY_TO = 'hello@portcityleashclub.com';

// Each module exports { subject(data), html(data), text(data) }.
const TEMPLATES = {
  'membership-request-received': require('../templates/membership-request-received'),
  'service-request-received': require('../templates/service-request-received'),
  'portal-service-request-received': require('../templates/portal-service-request-received'),
  'portal-service-confirmed': require('../templates/portal-service-confirmed'),
  'portal-reservation-confirmed': require('../templates/portal-reservation-confirmed'),
  'portal-membership-confirmed': require('../templates/portal-membership-confirmed'),
  'walk-confirmed': require('../templates/walk-confirmed'),
  'portal-walk-request-received': require('../templates/portal-walk-request-received'),
  // member-welcome: superseded by portal-access (fires earlier, at
  // meet-greet completion, for membership_request AND net-new
  // service_request). Still registered because sendOnboardingEmail's
  // kind:'member' branch and admin/dashboard.html's saveMember() still call
  // it — remove both this line and functions/templates/member-welcome.js
  // together, in the same change that cuts admin/dashboard.html over to
  // completeMeetGreetAndCreateAccount, not before.
  'member-welcome': require('../templates/member-welcome'),
  'portal-access': require('../templates/portal-access'),
  'referral-code-delivery': require('../templates/referral-code-delivery'),
};

const MAX_ATTEMPTS = 3;
// Delay before attempt 2 and attempt 3, respectively — exponential, capped
// well under any Cloud Functions timeout concern.
const RETRY_DELAY_MS = [500, 1000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls the Resend API, retrying on 5xx and 429 responses, AND on a
// network-level failure underneath the HTTP layer (DNS, timeout, connection
// reset) — that's exactly the transient case retry exists for, just not an
// HTTP status. A 4xx other than 429 means something about the request
// itself is wrong (bad address, bad payload) and will fail identically on
// retry, so that's still returned immediately instead of wasted.
async function sendToResendWithRetry(payload, apiKey) {
  let lastError = 'Unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastError = `Network error calling Resend: ${e.message}`;
      if (attempt === MAX_ATTEMPTS) {
        return { ok: false, error: lastError, attempts: attempt };
      }
      await sleep(RETRY_DELAY_MS[attempt - 1]);
      continue;
    }

    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      return { ok: true, id: json.id || null, attempts: attempt };
    }

    const bodyText = await res.text().catch(() => '');
    lastError = `Resend API ${res.status}: ${bodyText.slice(0, 500)}`;
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === MAX_ATTEMPTS) {
      return { ok: false, error: lastError, attempts: attempt };
    }
    await sleep(RETRY_DELAY_MS[attempt - 1]);
  }
  return { ok: false, error: lastError, attempts: MAX_ATTEMPTS };
}

// sendEmail({ to, template, data, replyTo, idempotencyKey })
//
// Renders `template` with `data` and sends it. Never throws — every caller
// treats a failed send as a warning, never a rollback of whatever real
// action (a new submission, a new member) triggered it, the same contract
// every existing sendGmailMessage caller already follows. Logs every send
// attempt to emailLog; when idempotencyKey is given and a PRIOR attempt
// under that same key already succeeded, this is a no-op that returns the
// original result instead of sending a second email (a retried Firestore
// trigger delivery is the main case this guards against).
async function sendEmail({ to, template, data, replyTo, idempotencyKey }) {
  const db = getFirestore();

  if (!to) {
    const error = 'sendEmail: "to" is required';
    console.error(error);
    return { ok: false, id: null, error };
  }
  const templateModule = TEMPLATES[template];
  if (!templateModule) {
    const error = `sendEmail: unknown template "${template}"`;
    console.error(error);
    return { ok: false, id: null, error };
  }

  // Deterministic doc ID when there's an idempotency key to key on (mirrors
  // every other .create()/deterministic-ID idempotency guard in this
  // codebase) so the "already sent?" check is a single .get(), not a query.
  // Without one, there's nothing to dedupe against, so a plain random ID.
  const logRef = idempotencyKey ? db.collection('emailLog').doc(idempotencyKey) : db.collection('emailLog').doc();

  if (idempotencyKey) {
    const existing = await logRef.get();
    if (existing.exists && existing.data().status === 'sent') {
      const prior = existing.data();
      return { ok: true, id: prior.resendId || null, error: null };
    }
    // Doesn't exist, or exists but failed — a failed send is retryable,
    // only a succeeded one blocks a re-send.
  }

  let subject, html, text;
  try {
    subject = templateModule.subject(data || {});
    html = templateModule.html(data || {});
    text = templateModule.text(data || {});
  } catch (e) {
    const error = `sendEmail: template "${template}" failed to render: ${e.message}`;
    console.error(error);
    await logRef.set({
      to, template, resendId: null, status: 'failed', attempts: 0, error,
      sentAt: null, idempotencyKey: idempotencyKey || null,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    return { ok: false, id: null, error };
  }

  const result = await sendToResendWithRetry({
    from: FROM_ADDRESS,
    to: [to],
    reply_to: replyTo || DEFAULT_REPLY_TO,
    subject,
    html,
    text,
  }, RESEND_API_KEY.value());

  await logRef.set({
    to,
    template,
    resendId: result.id || null,
    status: result.ok ? 'sent' : 'failed',
    attempts: result.attempts,
    error: result.error || null,
    sentAt: result.ok ? FieldValue.serverTimestamp() : null,
    idempotencyKey: idempotencyKey || null,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true }).catch((e) => {
    console.error(`sendEmail: failed to write emailLog for ${template} -> ${to}:`, e.message);
  });

  if (!result.ok) {
    console.error(`sendEmail: ${template} -> ${to} failed after ${result.attempts} attempt(s): ${result.error}`);
  }

  return { ok: result.ok, id: result.id || null, error: result.error || null };
}

// TEMPLATES is exported alongside sendEmail so dev/render-emails.js (a local
// preview tool, never deployed) can render every registered template
// directly from the same registry real sends use — there's no separate
// list to fall out of sync with this one.
module.exports = { sendEmail, RESEND_API_KEY, TEMPLATES };
