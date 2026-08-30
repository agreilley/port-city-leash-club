// functions/templates/billing-needs-review.js
//
// Internal, admin-facing notification (the first one in this codebase —
// every other template here sends TO a member/customer, this one sends TO
// Alison via ADMIN_EMAIL, functions/lib/email.js). Fired by
// onBillingNeedsReview (functions/index.js), a Firestore trigger on
// members/{memberId}/private/billing that watches for needsReview
// transitioning false/undefined -> true. Exists so a flag doesn't sit
// invisible until Alison happens to open the admin dashboard's Members
// table or Overview stat card — see those for the only other place this
// same information already surfaces.
//
// data: {
//   memberName: string,       // member doc's `name`, or 'A member' if missing
//   memberId: string,
//   reason: string,           // billing.needsReviewReason, the raw value as written
//   flaggedAt: string,        // ISO timestamp (the triggering event's own time)
// }

const {
  escapeHtml, wrapHtml, wrapText, renderBlockHtml, renderBlockText,
} = require('./_layout');

// Duplicated from NEEDS_REVIEW_LABELS in admin/dashboard.html:2012-2063 —
// that's the source of truth (it's what the Members table badge actually
// renders), this is a plain-language copy for the email body so the two
// never need to be read as the same file. Keep in sync by hand: any new
// needsReviewReason value added at a write site should get an entry here
// too, alongside its dashboard.html entry. label matches the badge text
// exactly; blurb is a fuller sentence (dashboard.html's `title` tooltip,
// lightly reworded for standalone reading rather than a hover) so Alison
// can triage from the email alone, without opening the dashboard.
const REASON_INFO = {
  possible_self_referral: {
    label: 'Possible self-referral',
    blurb: "This member's first payment looked like a possible self-referral, the same phone number as whoever referred them. No credit was issued automatically.",
  },
  single_use_code_already_redeemed: {
    label: 'Duplicate referral code',
    blurb: 'This member used a single-use referral code (a partner apartment/agent code or a homepage email-capture code) that was already redeemed by a different member. No credit was issued automatically.',
  },
  // Legacy value only, retained so an old flagged doc still renders a label
  // if it's ever re-flagged or inspected. functions/index.js has not
  // written this value since it was renamed to single_use_code_already_redeemed.
  partner_code_already_redeemed: {
    label: 'Duplicate referral code',
    blurb: 'This member used a partner (apartment/agent) referral code that was already redeemed by a different member. No credit was issued automatically.',
  },
  walk_extension_credit_failed: {
    label: 'Extension credit failed',
    blurb: 'A walk extension credit (owed after a schedule change dropped a paid extension) failed to issue. Issue the credit manually in Stripe.',
  },
  credit_issuance_failed: {
    label: 'Credit issuance failed',
    blurb: "This member's first-payment referral credit failed to calculate. No credit was issued, and the referral code was never marked redeemed, so it's still available.",
  },
  subscription_creation_failed: {
    label: 'Subscription not started',
    blurb: "This member's subscription wasn't created, so they're unbilled, no recurring charge and no walks auto-generated. Start the subscription manually in Stripe once the underlying issue is fixed.",
  },
  overnight_payout_calc_failed: {
    label: 'Payout calc failed',
    blurb: 'A completed overnight or check-in for this member failed to calculate a walker payout. Fix the underlying overnight record, then stamp its payout manually.',
  },
  reservation_charge_failed: {
    label: 'Reservation charge failed',
    blurb: "A confirmed pet sitting reservation's scheduled charge failed. Charge manually in Stripe once resolved.",
  },
  finalize_charge_failed: {
    label: 'Finalize failed',
    blurb: "This member's card and dates were both confirmed, but something failed while starting billing or sending the confirmation. See the Requests view for the specific failure.",
  },
  stale_payment_method_detach_failed: {
    label: 'Old card not removed',
    blurb: "This member replaced their saved card, but detaching the old one from Stripe failed. Detach the stale card manually in Stripe.",
  },
  multiple_payment_methods_attached: {
    label: 'Multiple cards attached',
    blurb: "This member's Stripe customer has more than one card attached. Detach the extra card(s) manually in Stripe, leaving only the one that should stay on file.",
  },
  renewal_payment_failed: {
    label: 'Renewal payment failed',
    blurb: "This member's monthly renewal charge failed (billingStatus is now 'past_due' on their billing record). Nothing in the app blocks them from continuing to book while past due, and Stripe's own retry schedule may still resolve this on its own. Check Stripe for the failure reason.",
  },
};

// A reason with no entry above (a brand-new value added at a write site
// with no matching update here, or any other unrecognized string) must
// still send, not fail silently — this is exactly the kind of thing the
// email exists to surface. Falls back to the raw reason string, lightly
// formatted (underscores to spaces, capitalized) rather than the bare
// machine value.
function reasonInfo(reason) {
  const known = REASON_INFO[reason];
  if (known) return known;
  const readable = typeof reason === 'string' && reason
    ? reason.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
    : 'Unknown reason';
  return { label: readable, blurb: null };
}

// ISO timestamp -> "August 25, 2026 at 3:42 PM" in the business's own time
// zone, same America/New_York convention every date/time display in
// functions/index.js already uses.
function formatFlaggedAt(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function subject(data) {
  const info = reasonInfo(data.reason);
  const name = data.memberName || 'a member';
  return `Needs review: ${info.label} for ${name}`;
}

function html(data) {
  const info = reasonInfo(data.reason);
  const name = escapeHtml(data.memberName || 'A member');
  const whenLabel = formatFlaggedAt(data.flaggedAt);

  const block = renderBlockHtml({
    eyebrow: 'Needs review',
    heading: escapeHtml(info.label),
    rows: [
      { label: 'Member', value: name },
      { label: 'Flagged', value: escapeHtml(whenLabel || 'Just now') },
    ],
  });

  const blurbHtml = info.blurb
    ? `<p style="margin:20px 0 0;">${escapeHtml(info.blurb)}</p>`
    : '';

  const body = `
    <p style="margin:0 0 20px;">A member's billing record was just flagged for review.</p>
    ${block}
    ${blurbHtml}
    <p style="margin:20px 0 0;">Open the Members table in the admin dashboard to see the full record and resolve this.</p>
  `;

  return wrapHtml({ preheader: `${info.label} for ${data.memberName || 'a member'}`, bodyHtml: body });
}

function text(data) {
  const info = reasonInfo(data.reason);
  const name = data.memberName || 'A member';
  const whenLabel = formatFlaggedAt(data.flaggedAt);

  const lines = [
    `A member's billing record was just flagged for review.`,
    '',
    renderBlockText({
      eyebrow: 'Needs review',
      heading: info.label,
      rows: [
        { label: 'Member', value: name },
        { label: 'Flagged', value: whenLabel || 'Just now' },
      ],
    }),
  ];
  if (info.blurb) { lines.push(''); lines.push(info.blurb); }
  lines.push('');
  lines.push('Open the Members table in the admin dashboard to see the full record and resolve this.');

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
