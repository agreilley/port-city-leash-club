// functions/templates/walk-completed.js
//
// Sent when a walker marks a recurring WALK complete (completeWalk(),
// walker/dashboard.html). Recurring walks previously had no email
// notification at all — only the SMS onWalkCompleted sends (functions/
// index.js), which silently no-ops (logs pending_credentials) while Twilio
// stays unconfigured. This is the email-side counterpart, modeled directly
// on visit-completed.js (same layout, same photo/note handling) so a
// completed walk and a completed overnight/check-in visit read the same
// way in a member's inbox.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   dateStr: string,        // 'YYYY-MM-DD'
//   slotLabel: string,      // 'Morning' | 'Early Afternoon' | 'Late Afternoon'
//   note: string,           // walker's free-text note, '' if none
//   photoUrl: string | null,
//   portalUrl: string,      // deep link back to this walk's card in the portal
// }

const {
  escapeHtml, formatCalendarDate, joinNames, TEAM_SIGNOFF,
  renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml,
  wrapHtml, wrapText,
} = require('./_layout');

function subject(data) {
  return `An update on ${joinNames(data.petNames) || 'your pets'}`;
}

function html(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const dateLabel = formatCalendarDate(data.dateStr) || data.dateStr;

  const detailBlock = renderBlockHtml({
    eyebrow: 'Walk update',
    rows: [
      { label: 'Date', value: escapeHtml(dateLabel) },
      { label: 'Time', value: escapeHtml(data.slotLabel || '') },
    ],
  });

  const noteHtml = data.note
    ? `<p style="margin:20px 0 0;">${escapeHtml(data.note)}</p>`
    : '';
  const photoHtml = data.photoUrl
    ? `<p style="margin:20px 0 0;"><img src="${escapeHtml(data.photoUrl)}" alt="A photo from today's walk" style="max-width:100%;border-radius:8px;display:block;"></p>`
    : '';

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Here's an update on ${escapeHtml(names)}.</p>
    ${detailBlock}
    ${noteHtml}
    ${photoHtml}
    ${renderButtonHtml({ href: data.portalUrl, label: 'View in your portal' })}
    <p style="margin:20px 0 0;">If you have any questions, just reply to this email.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({
    preheader: `Here's an update on ${names} from today's walk.`,
    bodyHtml: body,
  });
}

function text(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const dateLabel = formatCalendarDate(data.dateStr) || data.dateStr;

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Here's an update on ${names}.`,
    '',
    renderBlockText({
      eyebrow: 'Walk update',
      rows: [
        { label: 'Date', value: dateLabel },
        { label: 'Time', value: data.slotLabel || '' },
      ],
    }),
    '',
  ];

  if (data.note) lines.push(data.note, '');
  if (data.photoUrl) lines.push(`Photo: ${data.photoUrl}`, '');

  lines.push(
    `View in your portal: ${data.portalUrl}`,
    '',
    'If you have any questions, just reply to this email.',
    '',
    TEAM_SIGNOFF,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
