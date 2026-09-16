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
  escapeHtml, NAVY, TEAM_SIGNOFF,
  renderButtonHtml, renderSignoffHtml, renderCodeBlockHtml, renderCodeBlockText, wrapHtml, wrapText,
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

// Partner intake (generateReferralCode) always has a real name. The
// homepage email-capture form (generateEmailCaptureCode) has no name field
// at all — it used to fall back to the literal string "there" here,
// rendering as the slightly odd "Thanks for signing up, there." Dropping
// the name entirely in that case reads better than any filler word would.
function greetingLine(firstName) {
  return firstName ? `Thanks for signing up, ${firstName}.` : 'Thanks for signing up!';
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
    <p style="margin:0 0 20px;">${escapeHtml(greetingLine(data.firstName))} Here's your code, ready whenever you are.</p>
    ${renderCodeBlockHtml(data.code)}
    <p style="margin:20px 0 0;">Use this code when you sign up for a membership or book pet sitting, and you'll get ${amount} toward your first charge, up to half the charge amount.${expiryClause}</p>
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
    `${greetingLine(data.firstName)} Here's your code, ready whenever you are.`,
    '',
    renderCodeBlockText(data.code),
    '',
    `Use this code when you sign up for a membership or book pet sitting, and you'll get ${amount} toward your first charge, up to half the charge amount.${expiryClause}`,
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
