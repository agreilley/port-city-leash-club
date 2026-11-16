// functions/templates/gift-package-purchased.js
//
// Receipt to the person who bought a gift package — see fulfillGiftPackage in
// functions/index.js. Deliberately leaves out the code, which only goes to the
// recipient.
//
// data: { buyerName, recipientName, packageLabel, amountCents, deliverOn, deliversToday }

const {
  escapeHtml, formatCalendarDate, renderBlockHtml, renderBlockText,
  TEAM_SIGNOFF, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function formatDollars(cents) {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

function deliveryValue(data) {
  return data.deliversToday ? 'Sent today' : formatCalendarDate(data.deliverOn);
}

function subject() {
  return 'Your gift is all set 🐾';
}

function deliveryLine(data) {
  return data.deliversToday
    ? `We've sent ${firstName(data.recipientName)} their gift.`
    : `We'll send ${firstName(data.recipientName)} their gift on the morning of ${formatCalendarDate(data.deliverOn)}.`;
}

function html(data) {
  const block = renderBlockHtml({
    eyebrow: 'Your gift',
    heading: escapeHtml(capitalize(data.packageLabel)),
    rows: [
      { label: 'For', value: escapeHtml(data.recipientName) },
      { label: 'Delivery', value: escapeHtml(deliveryValue(data)) },
      { label: 'Paid', value: formatDollars(data.amountCents) },
    ],
  });
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(firstName(data.buyerName))},</p>
    <p style="margin:0 0 20px;">Thanks so much for your order. ${escapeHtml(deliveryLine(data))}</p>
    ${block}
    <p style="margin:20px 0 0;">Questions, or need to fix an email address? Just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `${capitalize(data.packageLabel)} for ${data.recipientName}.`, bodyHtml: body });
}

function text(data) {
  const lines = [
    `Hi ${firstName(data.buyerName)},`,
    '',
    `Thanks so much for your order. ${deliveryLine(data)}`,
    '',
    renderBlockText({
      eyebrow: 'Your gift',
      heading: capitalize(data.packageLabel),
      rows: [
        { label: 'For', value: data.recipientName },
        { label: 'Delivery', value: deliveryValue(data) },
        { label: 'Paid', value: formatDollars(data.amountCents) },
      ],
    }),
    '',
    "Questions, or need to fix an email address? Just reply here and it'll come straight to us.",
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
