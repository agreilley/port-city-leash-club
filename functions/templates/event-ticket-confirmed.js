// functions/templates/event-ticket-confirmed.js
//
// Sent when a Puppies & Pilates ticket purchase is confirmed (the Stripe
// PaymentIntent is verified succeeded server-side) — see confirmEventTicket
// in functions/index.js.
//
// data: { name: string, quantity: number, amountCents: number }

const {
  escapeHtml, pluralNoun, renderBlockHtml, renderBlockText,
  SIGNOFF_NAME, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function formatDollars(cents) {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

function subject() {
  return "You're in! Puppies & Pilates tickets confirmed";
}

function html(data) {
  const ticketWord = pluralNoun(data.quantity, 'ticket', 'tickets');
  const block = renderBlockHtml({
    eyebrow: 'Your tickets',
    heading: `${data.quantity} ${ticketWord}`,
    rows: [
      { label: 'Event', value: 'Puppies &amp; Pilates' },
      { label: 'When', value: 'Saturday, October 10 &middot; 9&ndash;11 AM' },
      { label: 'Where', value: 'Alcove Beer Garden' },
      { label: 'Paid', value: formatDollars(data.amountCents) },
    ],
  });

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(firstName(data.name))},</p>
    <p style="margin:0 0 20px;">You're all set for Puppies &amp; Pilates! We can't wait to see you for a morning of mat Pilates, puppies from paws4people, and coffee from Azalea Station.</p>
    ${block}
    <p style="margin:20px 0 0;">A few things to know before Saturday:</p>
    <ul style="margin:12px 0 0;padding-left:20px;">
      <li style="margin-bottom:8px;">Doors open at 9:00 AM for check-in &mdash; class starts at 9:15.</li>
      <li style="margin-bottom:8px;">Pilates mats are provided by Empower Method, so there's no need to bring your own.</li>
      <li style="margin-bottom:0;">For the comfort and safety of our paws4people guests, we ask that you leave your own dog at home &mdash; only paws4people dogs will be at the event.</li>
    </ul>
    <p style="margin:20px 0 0;">Questions in the meantime? Just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(SIGNOFF_NAME)}
  `;

  return wrapHtml({
    preheader: `${data.quantity} ${ticketWord} confirmed for Saturday, October 10.`,
    bodyHtml: body,
  });
}

function text(data) {
  const ticketWord = pluralNoun(data.quantity, 'ticket', 'tickets');
  const lines = [
    `Hi ${firstName(data.name)},`,
    '',
    `You're all set for Puppies & Pilates! We can't wait to see you for a morning of mat Pilates, puppies from paws4people, and coffee from Azalea Station.`,
    '',
    renderBlockText({
      eyebrow: 'Your tickets',
      heading: `${data.quantity} ${ticketWord}`,
      rows: [
        { label: 'Event', value: 'Puppies & Pilates' },
        { label: 'When', value: 'Saturday, October 10 · 9–11 AM' },
        { label: 'Where', value: 'Alcove Beer Garden' },
        { label: 'Paid', value: formatDollars(data.amountCents) },
      ],
    }),
    '',
    'A few things to know before Saturday:',
    '- Doors open at 9:00 AM for check-in — class starts at 9:15.',
    "- Pilates mats are provided by Empower Method, so there's no need to bring your own.",
    '- For the comfort and safety of our paws4people guests, we ask that you leave your own dog at home — only paws4people dogs will be at the event.',
    '',
    "Questions in the meantime? Just reply here and it'll come straight to us.",
    '',
    SIGNOFF_NAME,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
