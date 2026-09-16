// functions/templates/waitlist-area-accepted.js
//
// Sent by the admin "Accept their area" action on a 'waitlist' submission
// (runAcceptWaitlistArea in functions/index.js) — a waitlist signup whose
// address originally fell outside the service area, where admin has just
// expanded coverage to include it. Unlike referral-code-delivery's "Thanks
// for signing up!" opener (fits the anonymous homepage offer this isn't),
// the lead here is that we came back for them specifically — the $20 code
// is a bonus on top of that news, not the headline.
//
// data: {
//   address: string|null,  // the waitlist entry's address, for reference in copy
//   code: string,          // e.g. 'PCLC-7X9K2M'
//   amountCents: number,   // 2000 for $20
//   expiresAt: Date,       // always set — 90-day window, same as email_capture
// }

const {
  escapeHtml, NAVY, TEAM_SIGNOFF,
  renderButtonHtml, renderSignoffHtml, renderCodeBlockHtml, renderCodeBlockText, wrapHtml, wrapText,
} = require('./_layout');

const GET_STARTED_URL = 'https://portcityleashclub.com';

// Same rounding caveat as referral-code-delivery's formatDollars — only
// ever called with 2000 today.
function formatDollars(amountCents) {
  return `$${Math.round(amountCents / 100)}`;
}

function formatExpiryDate(expiresAt) {
  if (!expiresAt) return null;
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function subject() {
  return "Good news, we've expanded to reach you";
}

function html(data) {
  const amount = formatDollars(data.amountCents);
  const expiryStr = formatExpiryDate(data.expiresAt);
  const addressClause = data.address ? ` at ${escapeHtml(data.address)}` : '';
  const body = `
    <p style="margin:0 0 20px;font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif;font-weight:400;font-size:28px;line-height:1.25;color:${NAVY};">We've expanded to reach you.</p>
    <p style="margin:0 0 20px;">A little while back you joined our waitlist${addressClause}. We took another look, and we've grown our coverage area to include your address.</p>
    <p style="margin:0 0 20px;">As a thank you for waiting, here's ${amount} toward your first charge.</p>
    ${renderCodeBlockHtml(data.code)}
    <p style="margin:20px 0 0;">Use it toward a new membership or a pet sitting reservation, up to half the charge amount. Good through ${escapeHtml(expiryStr)}.</p>
    ${renderButtonHtml({ href: GET_STARTED_URL, label: 'Get Started' })}
    <p style="margin:20px 0 0;">If you have any questions, just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({
    preheader: `We've grown our coverage area to include you, plus a ${amount} code.`,
    bodyHtml: body,
  });
}

function text(data) {
  const amount = formatDollars(data.amountCents);
  const expiryStr = formatExpiryDate(data.expiresAt);
  const addressClause = data.address ? ` at ${data.address}` : '';
  const lines = [
    "We've expanded to reach you.",
    '',
    `A little while back you joined our waitlist${addressClause}. We took another look, and we've grown our coverage area to include your address.`,
    '',
    `As a thank you for waiting, here's ${amount} toward your first charge.`,
    '',
    renderCodeBlockText(data.code),
    '',
    `Use it toward a new membership or a pet sitting reservation, up to half the charge amount. Good through ${expiryStr}.`,
    '',
    `Get started: ${GET_STARTED_URL}`,
    '',
    `If you have any questions, just reply here and it'll come straight to us.`,
    '',
    TEAM_SIGNOFF,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
