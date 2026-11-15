// functions/templates/gift-package-delivered.js
//
// The gift itself, sent to the recipient with their code — see
// deliverGiftPackage in functions/index.js. New clients enter the code in the
// request form's promo box, and it goes on their account at the meet & greet
// (completeMeetGreetAndCreateAccount). Existing clients reply, or use the portal.
//
// data: { recipientName, petName (may be null), buyerName, message (may be null), packageLabel, code }

const {
  escapeHtml, renderBlockHtml, renderBlockText, renderCodeBlockHtml, renderCodeBlockText,
  renderButtonHtml, TEAM_SIGNOFF, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

const SITE_URL = 'https://www.portcityleashclub.com';
const POSITIONING = "We're Wilmington's newest dog walking and pet sitting company, and we're working hard to become its most trusted pet care team.";
const UPDATES = "You'll get an update after every visit, so you'll always know how it went.";
const LINK_STYLE = 'color:#C17B6F;';

// Who we are, with the services linked to the homepage.
function aboutUsHtml() {
  const services = `<a href="${SITE_URL}/#services" style="${LINK_STYLE}">drop-in visits and overnight stays</a>`;
  const membership = `<a href="${SITE_URL}/#membership" style="${LINK_STYLE}">Leash Club membership</a>`;
  return `${escapeHtml(POSITIONING)} From ${services} to weekly dog walks with our ${membership}, our small local team gets to know your pet and their routine. ${escapeHtml(UPDATES)}`;
}

const ABOUT_US_TEXT = `${POSITIONING} From drop-in visits and overnight stays to weekly dog walks with our Leash Club membership, our small local team gets to know your pet and their routine (${SITE_URL}). ${UPDATES}`;
const REQUEST_URL = 'https://www.portcityleashclub.com/service-request';
const HOW_TO_USE = "To use it, request your first visit with the button below and enter your code in the promo code box. We'll take care of the rest.";
const SWITCH_LINE = "Want to use it for a different service? Just reply and we'll switch it for you.";
const EXISTING_CLIENTS = "Already one of our clients? Just reply to this email and we'll add it to your account.";
const TERMS = 'Your gift covers the standard price of each visit and never expires. Add-ons and holiday rates are extra. It has no cash value and can only be used for Port City Leash Club services.';

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

// "you and Biscuit" when the buyer gave the pet's name, otherwise "you and your pet".
function opening(data) {
  const pet = (data.petName || '').trim() || 'your pet';
  return `Great news for you and ${pet}! ${data.buyerName} sent you a gift card from Port City Leash Club.`;
}

function subject(data) {
  return `${data.buyerName} sent you a gift 🐾`;
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
    <p style="margin:0 0 20px;">${escapeHtml(opening(data))}</p>
    <p style="margin:0 0 20px;">${aboutUsHtml()}</p>
    ${block}
    <p style="margin:-8px 0 20px;font-size:13px;">${escapeHtml(SWITCH_LINE)}</p>
    ${renderCodeBlockHtml(data.code)}
    <p style="margin:0 0 12px;">${escapeHtml(HOW_TO_USE)}</p>
    ${renderButtonHtml({ href: REQUEST_URL, label: 'Request your first visit' })}
    <p style="margin:0 0 20px;">${escapeHtml(EXISTING_CLIENTS)}</p>
    <p style="margin:0;font-size:13px;">${escapeHtml(TERMS)}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `${data.packageLabel} for you and your pet, from ${data.buyerName}.`, bodyHtml: body });
}

function text(data) {
  const lines = [
    `Hi ${firstName(data.recipientName)},`,
    '',
    opening(data),
    '',
    ABOUT_US_TEXT,
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
    SWITCH_LINE,
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
