// functions/templates/portal-walk-request-received.js
//
// Sent when an existing member requests an extra or extended walk through
// the portal (portal-extend-walk.html, submission type walk_extension) —
// see onNewSubmission in functions/index.js. `walks` is an array because a
// member can select several walks to extend in one request; the common
// case is exactly one.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   walkTypeLabel: string,   // e.g. 'Extended walk'
//   durationMinutes: number, // 45
//   walks: [{ dateStr: string, slot: string }],
// }

const {
  escapeHtml, formatCalendarDate, formatMeetGreetSlot, formatWalkTimeSlot, joinNames, possessive,
  SIGNOFF_NAME, renderBlockHtml, renderBlockText, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

// See walk-confirmed.js's formatWalkWhen for why this checks both a
// timeSlot bucket and an exact-time slot before falling back to date-only.
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
  return `We got your request for ${names}`;
}

function html(data) {
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;

  const block = renderBlockHtml({
    eyebrow: 'Your request',
    heading: escapeHtml(`${data.walkTypeLabel || 'Walk'}, ${data.durationMinutes || 45} minutes`),
    rows: [
      { label: 'When', value: escapeHtml(whenValue(data)) },
    ],
  });

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Thanks for your request. We've got it and we're looking over the details now.</p>
    ${block}
    <p style="margin:20px 0 0;">We'll confirm everything shortly. In the meantime, you can update your ${possessive(dogCount, 'dog', 'dogs')} routine, feeding, or any other details anytime in your ${possessive(dogCount, "dog", "dogs")} profile in the portal.</p>
    <p style="margin:20px 0 0;">If you have any questions, just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(SIGNOFF_NAME, 'Talk soon,')}
  `;

  return wrapHtml({ preheader: `We've got your request and we're looking over the details now.`, bodyHtml: body });
}

function text(data) {
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Thanks for your request. We've got it and we're looking over the details now.`,
    '',
    renderBlockText({
      eyebrow: 'Your request',
      heading: `${data.walkTypeLabel || 'Walk'}, ${data.durationMinutes || 45} minutes`,
      rows: [{ label: 'When', value: whenValue(data) }],
    }),
    '',
    `We'll confirm everything shortly. In the meantime, you can update your ${possessive(dogCount, 'dog', 'dogs')} routine, feeding, or any other details anytime in your ${possessive(dogCount, "dog", "dogs")} profile in the portal.`,
    '',
    `If you have any questions, just reply here and it'll come straight to us.`,
    '',
    `Talk soon,`,
    SIGNOFF_NAME,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
