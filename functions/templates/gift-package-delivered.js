// functions/templates/gift-package-delivered.js
//
// The gift itself, sent to the recipient with their code — see
// deliverGiftPackage in functions/index.js. The code goes on their account from
// the portal (redeemGiftPackage), or by replying so it can be applied for them.
//
// data: { recipientName, buyerName, message (may be null), packageLabel, code }

const {
  escapeHtml, renderBlockHtml, renderBlockText, renderCodeBlockHtml, renderCodeBlockText,
  renderButtonHtml, TEAM_SIGNOFF, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

const REQUEST_URL = 'https://www.portcityleashclub.com/service-request';
const STEPS = [
  "Request your first visit using the link below. We'll set up a free meet and greet so we can get to know you and your pet.",
  "After your meet and greet, we'll send you a link to set up your account. Sign in, go to Account, and enter your code under Gift Packages. If you'd rather we do it for you, just reply to this email.",
  'Your visits come off your bookings automatically when they are charged.',
];
const TERMS = 'Your gift covers the standard price of each visit on one-time bookings and does not expire. Holiday rates, extra pets, medication, and 45-minute walks are extra, and it doesn\'t apply to regular Leash Club membership walks. It has no cash value and can only be used for Port City Leash Club services.';

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

function subject(data) {
  return `${data.buyerName} sent you a gift from Port City Leash Club`;
}

function html(data) {
  const block = renderBlockHtml({
    eyebrow: 'Your gift',
    heading: escapeHtml(data.packageLabel),
    rows: [
      { label: 'From', value: escapeHtml(data.buyerName) },
      data.message ? { label: 'Message', value: escapeHtml(data.message) } : null,
    ],
  });
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(firstName(data.recipientName))},</p>
    <p style="margin:0 0 20px;">${escapeHtml(data.buyerName)} sent you pet care from Port City Leash Club, a dog walking and pet sitting team in Wilmington, NC.</p>
    ${block}
    ${renderCodeBlockHtml(data.code)}
    <p style="margin:0 0 12px;">Here's how to use it:</p>
    <ol style="margin:0;padding-left:20px;">
      ${STEPS.map((step) => `<li style="margin-bottom:8px;">${escapeHtml(step)}</li>`).join('')}
    </ol>
    ${renderButtonHtml({ href: REQUEST_URL, label: 'Request your first visit' })}
    <p style="margin:0;font-size:13px;">${escapeHtml(TERMS)}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `${data.packageLabel} from ${data.buyerName}.`, bodyHtml: body });
}

function text(data) {
  const lines = [
    `Hi ${firstName(data.recipientName)},`,
    '',
    `${data.buyerName} sent you pet care from Port City Leash Club, a dog walking and pet sitting team in Wilmington, NC.`,
    '',
    renderBlockText({
      eyebrow: 'Your gift',
      heading: data.packageLabel,
      rows: [
        { label: 'From', value: data.buyerName },
        data.message ? { label: 'Message', value: data.message } : null,
      ],
    }),
    '',
    renderCodeBlockText(data.code),
    '',
    "Here's how to use it:",
    ...STEPS.map((step, i) => `${i + 1}. ${step}`),
    '',
    `Request your first visit: ${REQUEST_URL}`,
    '',
    TERMS,
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
