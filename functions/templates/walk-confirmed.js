// functions/templates/walk-confirmed.js
//
// Sent when admin confirms and charges a one-time walk booking — from
// confirmServiceRequest() (when the service is walk-family: standard-walk
// or extended-walk) or confirmWalkExtension() in admin/dashboard.html.
// `walks` is an array rather than a single date/time because
// confirmWalkExtension can confirm several walks from one submission at
// once (the member can check multiple walks in portal-extend-walk.html);
// the common case is exactly one.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   walkTypeLabel: string,   // e.g. 'Standard walk' or 'Extended walk'
//   durationMinutes: number, // 30 or 45
//   walks: [{ dateStr: string, slot: string }], // 'YYYY-MM-DD' + '5:00pm', at least one
//   isNewAccount: boolean,
//   portalSetupLink: string|null, // generatePasswordResetLink() output; required when isNewAccount is true
// }

const {
  escapeHtml, formatCalendarDate, formatMeetGreetSlot, formatWalkTimeSlot, joinNames, possessive,
  SIGNOFF_NAME, renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

// A walk's slot may be a timeSlot bucket ('morning', from walk_extension /
// the walks collection) or, for a one-time walk booked with no time
// captured at all (service_request has no time-of-day field), absent
// entirely — this degrades to a date-only line rather than showing nothing
// or a raw bucket key.
function formatWalkWhen(w) {
  const dateLabel = formatCalendarDate(w.dateStr);
  if (!dateLabel) return null;
  const slotLabel = formatWalkTimeSlot(w.slot) || formatMeetGreetSlot(w.slot);
  return slotLabel ? `${dateLabel} at ${slotLabel}` : dateLabel;
}

function whenValue(data) {
  const formatted = (data.walks || []).map(formatWalkWhen).filter(Boolean);
  return formatted.join('; ') || 'Time to be confirmed';
}

function subject(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  return `You're all set for ${names}`;
}

function html(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;

  const block = renderBlockHtml({
    eyebrow: 'Your booking',
    heading: escapeHtml(`${data.walkTypeLabel || 'Walk'}, ${data.durationMinutes || 30} minutes`),
    rows: [
      { label: 'When', value: escapeHtml(whenValue(data)) },
    ],
  });

  // isNewAccount is only ever true from confirmWalkExtension now — a new
  // customer's meet-greet-to-account-creation-to-first-booking path moved
  // entirely to completeMeetGreetAndCreateAccount + portal-access, which
  // send their own portal-setup link before this template's send site
  // (sendServiceOrOvernightConfirmationEmail) is ever reached. Don't assume
  // this branch still covers a new customer's confirmation email.
  const portalSection = data.isNewAccount && data.portalSetupLink ? `
    <p style="margin:20px 0 0;">Since this is your first time booking with us, we've set up a portal account so you can see your booking, update your ${possessive(dogCount, 'dog', 'dogs')} profile, and message us anytime.</p>
    ${renderButtonHtml({ href: data.portalSetupLink, label: 'Set Up Your Portal Access' })}
  ` : '';

  // The new-account CTA paragraph directly above already tells them they
  // can update the profile — repeating that two lines later reads as
  // filler, and "has changed" presumes a baseline a brand-new client
  // doesn't have yet. Existing members keep the full line unchanged.
  const closingLine = data.isNewAccount
    ? `If you have any questions, just reply here and it'll come straight to us.`
    : `If anything about your ${possessive(dogCount, 'dog', 'dogs')} care has changed, you can update their profile anytime in the portal. And if you have any questions, just reply here and it'll come straight to us.`;

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Great news, your walk is booked and we've got ${escapeHtml(names)} covered.</p>
    ${block}
    <p style="margin:20px 0 0;">Your walker will send photos and a note afterward so you can see how it went.</p>
    ${portalSection}
    <p style="margin:20px 0 0;">${closingLine}</p>
    ${renderSignoffHtml(SIGNOFF_NAME, 'Talk soon,')}
  `;

  return wrapHtml({ preheader: `Your walk is booked. Here's everything you need to know.`, bodyHtml: body });
}

function text(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Great news, your walk is booked and we've got ${names} covered.`,
    '',
    renderBlockText({
      eyebrow: 'Your booking',
      heading: `${data.walkTypeLabel || 'Walk'}, ${data.durationMinutes || 30} minutes`,
      rows: [{ label: 'When', value: whenValue(data) }],
    }),
    '',
    `Your walker will send photos and a note afterward so you can see how it went.`,
    '',
  ];

  if (data.isNewAccount && data.portalSetupLink) {
    lines.push(
      `Since this is your first time booking with us, we've set up a portal account so you can see your booking, update your ${possessive(dogCount, 'dog', 'dogs')} profile, and message us anytime.`,
      '',
      `Set up your portal access: ${data.portalSetupLink}`,
      '',
    );
  }

  // See the html() version's comment on why this drops to a single
  // sentence for a new account rather than repeating the CTA paragraph's
  // "update your profile" point under a "has changed" framing that doesn't
  // fit a first booking.
  const closingLine = data.isNewAccount
    ? `If you have any questions, just reply here and it'll come straight to us.`
    : `If anything about your ${possessive(dogCount, 'dog', 'dogs')} care has changed, you can update their profile anytime in the portal. And if you have any questions, just reply here and it'll come straight to us.`;

  lines.push(
    closingLine,
    '',
    `Talk soon,`,
    SIGNOFF_NAME,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
