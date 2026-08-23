// functions/templates/referral-code-delivery.js
//
// Sent right after a successful /welcomehome submission (runGenerateReferralCode
// in functions/index.js), once the code is generated and returned to the
// client. Partner-referred visitors (apartment/agent intake) only ever see
// their code on-screen once — this is the durable copy they can find again
// later, so the code itself has to be the most visually prominent thing on
// the page rather than sitting in a sentence.
//
// Scope note: shared by BOTH code-issuing callables that hand out a
// referralCodes doc by email — /welcomehome partner intake
// (generateReferralCode) and the homepage footer email-capture form
// (generateEmailCaptureCode). getOrCreateMemberReferralCode (the portal's
// "Refer a Friend" tab) is a separate, already-authenticated flow with its
// own in-app code display — out of scope here.
//
// data: {
//   firstName: string,
//   code: string,          // e.g. 'PCLC-7X9K2M'
//   amountCents: number,   // e.g. 5000 for $50, 2000 for $20
//   expiresAt: Date|null,  // null/omitted for codes that never expire
// }

const {
  escapeHtml, NAVY, SAND, TEAM_SIGNOFF,
  renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

const GET_STARTED_URL = 'https://portcityleashclub.com';

// Math.round drops cents entirely — correct for the only two amounts that
// exist today (5000/2000, both whole dollars) but WRONG for a non-round
// amount (e.g. 1250 would render as "$13", not "$12.50"). Not reachable
// currently — nothing writes an amountCents that isn't a clean multiple of
// 100 — but if a non-round-dollar code is ever introduced, this needs to
// switch to a cents-aware format (e.g. (amountCents/100).toFixed(2), trimmed
// to a whole number only when amountCents % 100 === 0) rather than silently
// mis-rendering the promised amount in a real email.
function formatDollars(amountCents) {
  return `$${Math.round(amountCents / 100)}`;
}

function formatExpiryDate(expiresAt) {
  if (!expiresAt) return null;
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// One-off "big centered code" box, not folded into _layout's renderBlockHtml
// (label/value rows, left-aligned) since this template is the only caller —
// promote it to a shared helper if a second template ever needs the same
// treatment.
function codeBlockHtml(code) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SAND};border-radius:4px;margin:28px 0;">
      <tr>
        <td align="center" style="padding:28px 24px;">
          <p style="margin:0 0 12px;font-family:'DM Sans', Helvetica, Arial, sans-serif;font-size:12px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${NAVY};">Your code</p>
          <p style="margin:0;font-family:'DM Sans', Helvetica, Arial, sans-serif;font-size:32px;font-weight:700;letter-spacing:0.1em;color:${NAVY};">${escapeHtml(code)}</p>
        </td>
      </tr>
    </table>
  `;
}

function codeBlockText(code) {
  return ['YOUR CODE', '', code].join('\n');
}

function subject(data) {
  return `Your ${formatDollars(data.amountCents)} welcome credit`;
}

function html(data) {
  const amount = formatDollars(data.amountCents);
  const expiryStr = formatExpiryDate(data.expiresAt);
  const expiryClause = expiryStr ? ` Good through ${escapeHtml(expiryStr)}.` : '';
  const body = `
    <p style="margin:0 0 20px;font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif;font-weight:400;font-size:28px;line-height:1.25;color:${NAVY};">Your ${amount} credit is ready.</p>
    <p style="margin:0 0 20px;">Thanks for signing up, ${escapeHtml(data.firstName || 'there')}. Here's your code, ready whenever you are.</p>
    ${codeBlockHtml(data.code)}
    <p style="margin:20px 0 0;">Use this code when you sign up for a membership or book pet sitting, and you'll get ${amount} toward your first charge.${expiryClause}</p>
    ${renderButtonHtml({ href: GET_STARTED_URL, label: 'Get Started' })}
    <p style="margin:20px 0 0;">Questions? Just reply to this email.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({
    preheader: `Here's your code, save this email for later.`,
    bodyHtml: body,
  });
}

function text(data) {
  const amount = formatDollars(data.amountCents);
  const expiryStr = formatExpiryDate(data.expiresAt);
  const expiryClause = expiryStr ? ` Good through ${expiryStr}.` : '';
  const lines = [
    `Your ${amount} credit is ready.`,
    '',
    `Thanks for signing up, ${data.firstName || 'there'}. Here's your code, ready whenever you are.`,
    '',
    codeBlockText(data.code),
    '',
    `Use this code when you sign up for a membership or book pet sitting, and you'll get ${amount} toward your first charge.${expiryClause}`,
    '',
    `Get started: ${GET_STARTED_URL}`,
    '',
    `Questions? Just reply to this email.`,
    '',
    TEAM_SIGNOFF,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
