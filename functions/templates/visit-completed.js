// functions/templates/visit-completed.js
//
// Sent when a walker marks an individual overnight/check-in VISIT complete
// (completeVisit(), walker/dashboard.html) — one email per visit, not per
// reservation, mirroring the per-visit SMS onOvernightVisitCompleted also
// sends (functions/index.js).
//
// One shared template for both service types (overnight stay and check-in
// visit) rather than two near-identical files — the only difference between
// them is which serviceLabel string is passed in, the same reasoning
// portal-reservation-confirmed.js already uses to cover both types from one
// template. A second file would duplicate the whole layout for a one-line
// difference and give the two a chance to drift on everything else.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   serviceLabel: string,   // 'Overnight Stay' | 'Check-In Visit'
//   dateStr: string,        // 'YYYY-MM-DD'
//   slotLabel: string,      // 'Morning' | 'Midday' | 'Evening' | 'Last Out'
//   note: string,           // walker's free-text note, '' if none
//   photoUrl: string | null,
//   portalUrl: string,      // deep link back to this visit's card in the portal
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
    eyebrow: data.serviceLabel || 'Visit update',
    rows: [
      { label: 'Date', value: escapeHtml(dateLabel) },
      { label: 'Time', value: escapeHtml(data.slotLabel || '') },
    ],
  });

  const noteHtml = data.note
    ? `<p style="margin:20px 0 0;">${escapeHtml(data.note)}</p>`
    : '';
  const photoHtml = data.photoUrl
    ? `<p style="margin:20px 0 0;"><img src="${escapeHtml(data.photoUrl)}" alt="A photo from today's visit" style="max-width:100%;border-radius:8px;display:block;"></p>`
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
    preheader: `Here's an update on ${names} from today's ${(data.serviceLabel || 'visit').toLowerCase()}.`,
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
      eyebrow: data.serviceLabel || 'Visit update',
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
