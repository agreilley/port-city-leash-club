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

const REFUND_LINE = "If it turns out we can't care for their pet, for example because they live outside our service area, we'll refund you in full.";

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
  return 'Your Port City Leash Club gift is confirmed';
}

function deliveryLine(data) {
  return data.deliversToday
    ? `We've emailed ${data.recipientName} their gift and how to use it.`
    : `We'll email ${data.recipientName} their gift and how to use it on the morning of ${formatCalendarDate(data.deliverOn)}.`;
}

function html(data) {
  const block = renderBlockHtml({
    eyebrow: 'Your gift',
    heading: escapeHtml(data.packageLabel),
    rows: [
      { label: 'For', value: escapeHtml(data.recipientName) },
      { label: 'Delivery', value: escapeHtml(deliveryValue(data)) },
      { label: 'Paid', value: formatDollars(data.amountCents) },
    ],
  });
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(firstName(data.buyerName))},</p>
    <p style="margin:0 0 20px;">Thank you for your gift. ${escapeHtml(deliveryLine(data))}</p>
    ${block}
    <p style="margin:20px 0 0;">${escapeHtml(REFUND_LINE)}</p>
    <p style="margin:20px 0 0;">Questions, or need to fix an email address? Just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `${data.packageLabel} for ${data.recipientName}.`, bodyHtml: body });
}

function text(data) {
  const lines = [
    `Hi ${firstName(data.buyerName)},`,
    '',
    `Thank you for your gift. ${deliveryLine(data)}`,
    '',
    renderBlockText({
      eyebrow: 'Your gift',
      heading: data.packageLabel,
      rows: [
        { label: 'For', value: data.recipientName },
        { label: 'Delivery', value: deliveryValue(data) },
        { label: 'Paid', value: formatDollars(data.amountCents) },
      ],
    }),
    '',
    REFUND_LINE,
    '',
    "Questions, or need to fix an email address? Just reply here and it'll come straight to us.",
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
