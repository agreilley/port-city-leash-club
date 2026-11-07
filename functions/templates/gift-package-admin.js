// functions/templates/gift-package-admin.js
//
// Internal notice to ADMIN_EMAIL: a package sold, or its delivery gave up after
// repeated failures. There's no dashboard list yet, so this is how a sale and
// its code reach Alison for applying by hand.
//
// data: { kind: 'sold' | 'delivery_failed', buyerName, buyerEmail, recipientName,
//         recipientEmail, packageLabel, amountCents, deliverOn, code, deliveryError? }

const {
  escapeHtml, formatCalendarDate, renderBlockHtml, renderBlockText, wrapHtml, wrapText,
} = require('./_layout');

function formatDollars(cents) {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function subject(data) {
  return data.kind === 'delivery_failed'
    ? `Gift package email failed: ${data.recipientName}`
    : `Gift package sold: ${data.packageLabel} (${formatDollars(data.amountCents)})`;
}

function intro(data) {
  return data.kind === 'delivery_failed'
    ? `We couldn't email this gift to the recipient after repeated tries, so they don't have their code. Check the address with the buyer, then send it by hand. Error: ${data.deliveryError || 'not recorded'}`
    : 'A gift package just sold.';
}

function rows(data) {
  return [
    { label: 'Buyer', value: `${data.buyerName} (${data.buyerEmail})` },
    { label: 'Recipient', value: `${data.recipientName} (${data.recipientEmail})` },
    { label: 'Delivery', value: formatCalendarDate(data.deliverOn) || data.deliverOn },
    { label: 'Paid', value: formatDollars(data.amountCents) },
    { label: 'Code', value: data.code },
  ];
}

function html(data) {
  const block = renderBlockHtml({
    eyebrow: 'Gift package',
    heading: escapeHtml(data.packageLabel),
    rows: rows(data).map((r) => ({ label: r.label, value: escapeHtml(r.value) })),
  });
  return wrapHtml({
    preheader: subject(data),
    bodyHtml: `<p style="margin:0;">${escapeHtml(intro(data))}</p>${block}`,
  });
}

function text(data) {
  return wrapText({
    bodyText: [
      intro(data),
      '',
      renderBlockText({ eyebrow: 'Gift package', heading: data.packageLabel, rows: rows(data) }),
    ].join('\n'),
  });
}

module.exports = { subject, html, text };
