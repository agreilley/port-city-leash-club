// functions/templates/gift-package-delivered.js
//
// The gift itself, sent to the recipient with their code — see
// deliverGiftPackage in functions/index.js. New clients enter the code in the
// request form's promo box, and it goes on their account at the meet & greet
// (completeMeetGreetAndCreateAccount). Existing clients reply, or use the portal.
//
// data: { recipientName, buyerName, message (may be null), packageLabel, code }

const {
  escapeHtml, renderBlockHtml, renderBlockText, renderCodeBlockHtml, renderCodeBlockText,
  renderButtonHtml, TEAM_SIGNOFF, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

const REQUEST_URL = 'https://www.portcityleashclub.com/service-request';
const HOW_TO_USE = "To use it, request your first visit with the button below and enter your code in the promo code box. We'll take care of the rest.";
const EXISTING_CLIENTS = "Already one of our clients? Just reply to this email and we'll add it to your account.";
const TERMS = 'Your gift covers the standard price of each visit and never expires. Add-ons and holiday rates are extra. It has no cash value and can only be used for Port City Leash Club services.';

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

function subject(data) {
  return `A gift for you from ${data.buyerName}`;
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
    <p style="margin:0 0 20px;">${escapeHtml(data.buyerName)} bought you a gift from Port City Leash Club! We're a small dog walking and pet sitting team in Wilmington, NC, and we can't wait to meet you and your pet.</p>
    ${block}
    ${renderCodeBlockHtml(data.code)}
    <p style="margin:0 0 12px;">${escapeHtml(HOW_TO_USE)}</p>
    ${renderButtonHtml({ href: REQUEST_URL, label: 'Request your first visit' })}
    <p style="margin:0 0 20px;">${escapeHtml(EXISTING_CLIENTS)}</p>
    <p style="margin:0;font-size:13px;">${escapeHtml(TERMS)}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `${data.packageLabel} from ${data.buyerName}.`, bodyHtml: body });
}

function text(data) {
  const lines = [
    `Hi ${firstName(data.recipientName)},`,
    '',
    `${data.buyerName} bought you a gift from Port City Leash Club! We're a small dog walking and pet sitting team in Wilmington, NC, and we can't wait to meet you and your pet.`,
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
    HOW_TO_USE,
    '',
    `Request your first visit: ${REQUEST_URL}`,
    '',
    EXISTING_CLIENTS,
    '',
    TERMS,
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
