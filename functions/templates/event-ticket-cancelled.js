// functions/templates/event-ticket-cancelled.js
//
// Sent when admin cancels and refunds some or all of a Puppies & Pilates
// order from the dashboard guest list — see cancelEventTicket in
// functions/index.js.
//
// data: { name: string, cancelledQuantity: number, refundCents: number,
//         remainingQuantity: number }

const {
  escapeHtml, pluralNoun, renderBlockHtml, renderBlockText,
  TEAM_SIGNOFF, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function formatDollars(cents) {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

function subject() {
  return 'Your Puppies & Pilates ticket cancellation';
}

function rows(data) {
  const r = [
    { label: 'Canceled', value: `${data.cancelledQuantity} ${pluralNoun(data.cancelledQuantity, 'ticket', 'tickets')}` },
    { label: 'Refund', value: formatDollars(data.refundCents) },
  ];
  if (data.remainingQuantity > 0) {
    r.push({ label: 'Still booked', value: `${data.remainingQuantity} ${pluralNoun(data.remainingQuantity, 'ticket', 'tickets')}` });
  }
  return r;
}

function html(data) {
  const block = renderBlockHtml({
    eyebrow: 'Puppies & Pilates',
    heading: 'Cancellation confirmed',
    rows: rows(data).map(r => ({ label: r.label, value: escapeHtml(r.value) })),
  });

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(firstName(data.name))},</p>
    <p style="margin:0 0 20px;">We've canceled your Puppies &amp; Pilates ${pluralNoun(data.cancelledQuantity, 'ticket', 'tickets')} and refunded ${formatDollars(data.refundCents)} to the card you paid with. It usually takes 5&ndash;10 business days to show up on your statement.</p>
    ${block}
    <p style="margin:20px 0 0;">Questions? Just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({
    preheader: `${formatDollars(data.refundCents)} refunded to your card.`,
    bodyHtml: body,
  });
}

function text(data) {
  const lines = [
    `Hi ${firstName(data.name)},`,
    '',
    `We've canceled your Puppies & Pilates ${pluralNoun(data.cancelledQuantity, 'ticket', 'tickets')} and refunded ${formatDollars(data.refundCents)} to the card you paid with. It usually takes 5–10 business days to show up on your statement.`,
    '',
    renderBlockText({
      eyebrow: 'Puppies & Pilates',
      heading: 'Cancellation confirmed',
      rows: rows(data),
    }),
    '',
    "Questions? Just reply here and it'll come straight to us.",
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
