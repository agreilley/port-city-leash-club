// functions/templates/request-declined.js
//
// Sent when admin declines a one-time service/overnight request —
// declineServiceRequest or declineOvernightRequest (functions/index.js).
// Declining previously notified nobody; the member had no way to know
// their request wasn't happening short of noticing it never got
// confirmed. Deliberately does NOT mention money — nothing was ever
// charged for a request that's declined rather than confirmed, so there's
// nothing to explain about refunds or billing.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   serviceLabel: string,      // e.g. "Drop-In Visit" | "Overnight Stay" | "Standard Walk"
//   startDateStr: string|null, // 'YYYY-MM-DD'
//   endDateStr: string|null,   // 'YYYY-MM-DD'
// }

const {
  escapeHtml, formatDateRange, joinNames, TEAM_SIGNOFF,
  renderBlockHtml, renderBlockText, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function subject(data) {
  return `An update on your request for ${joinNames(data.petNames) || 'your pets'}`;
}

function html(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const dateRange = formatDateRange(data.startDateStr, data.endDateStr);

  const block = renderBlockHtml({
    eyebrow: 'Your request',
    rows: [
      { label: 'Service', value: escapeHtml(data.serviceLabel || '') },
      ...(dateRange ? [{ label: 'Dates', value: escapeHtml(dateRange) }] : []),
    ],
  });

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">We're not able to accommodate this request for ${escapeHtml(names)}.</p>
    ${block}
    <p style="margin:20px 0 0;">Nothing was charged for this request. If you'd like to try different dates, or have any questions, just reply to this email.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({
    preheader: `We're not able to accommodate this request for ${names}.`,
    bodyHtml: body,
  });
}

function text(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const dateRange = formatDateRange(data.startDateStr, data.endDateStr);

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `We're not able to accommodate this request for ${names}.`,
    '',
    renderBlockText({
      eyebrow: 'Your request',
      rows: [
        { label: 'Service', value: data.serviceLabel || '' },
        ...(dateRange ? [{ label: 'Dates', value: dateRange }] : []),
      ],
    }),
    '',
    `Nothing was charged for this request. If you'd like to try different dates, or have any questions, just reply to this email.`,
    '',
    TEAM_SIGNOFF,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
