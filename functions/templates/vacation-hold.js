// functions/templates/vacation-hold.js
//
// Internal, admin-facing notification — same posture as billing-needs-review.js
// (sends TO Alison via ADMIN_EMAIL, not to the member). Fired inline from
// submitVacationHold (functions/index.js) right after the pause_membership
// submission is written. That submission is status: 'applied' (informational,
// not actionable) and only surfaces as an unread badge in the admin dashboard's
// Requests tab — nothing pushes it to Alison otherwise. This email is that push.
//
// data: {
//   memberName: string,   // member doc's `name`, or 'A member' if missing
//   memberId: string,
//   startDateStr: string, // 'YYYY-MM-DD'
//   endDateStr: string,   // 'YYYY-MM-DD'
// }

const {
  escapeHtml, formatDateRange, renderBlockHtml, renderBlockText, wrapHtml, wrapText,
} = require('./_layout');

function subject(data) {
  const name = data.memberName || 'A member';
  return `Vacation hold: ${name}`;
}

function html(data) {
  const name = escapeHtml(data.memberName || 'A member');
  const range = escapeHtml(formatDateRange(data.startDateStr, data.endDateStr));

  const block = renderBlockHtml({
    eyebrow: 'Vacation hold',
    heading: name,
    rows: [
      { label: 'Member', value: name },
      { label: 'Hold window', value: range },
    ],
  });

  const body = `
    <p style="margin:0 0 20px;">A member just placed themselves on a vacation hold. This took effect immediately, no approval needed, and their scheduled walks in this window have already been removed.</p>
    ${block}
    <p style="margin:20px 0 0;">If a refund is owed for already-billed walks in the current period, a separate "Hold Refund" request will follow in the admin dashboard. This email is just the heads-up that a hold happened at all.</p>
  `;

  return wrapHtml({ preheader: `${name} placed a vacation hold, ${range}`, bodyHtml: body });
}

function text(data) {
  const name = data.memberName || 'A member';
  const range = formatDateRange(data.startDateStr, data.endDateStr);

  const lines = [
    'A member just placed themselves on a vacation hold. This took effect immediately, no approval needed, and their scheduled walks in this window have already been removed.',
    '',
    renderBlockText({
      eyebrow: 'Vacation hold',
      heading: name,
      rows: [
        { label: 'Member', value: name },
        { label: 'Hold window', value: range },
      ],
    }),
    '',
    'If a refund is owed for already-billed walks in the current period, a separate "Hold Refund" request will follow in the admin dashboard. This email is just the heads-up that a hold happened at all.',
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
