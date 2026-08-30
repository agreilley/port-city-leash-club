// functions/templates/vacation-hold-resumed.js
//
// Internal, admin-facing notification — same posture as vacation-hold.js and
// billing-needs-review.js (sends TO Alison via ADMIN_EMAIL). Fired inline
// from resumePausedMemberships (functions/index.js) when a member's hold
// window ends and their status flips back to 'active'. Before this template
// existed, the resume side of a vacation hold had NO admin-visible signal at
// all — no submission, no flag, nothing — unlike the pause side, which at
// least leaves an unread row in the Requests tab.
//
// This email exists specifically to close the manual-Stripe loop: nothing in
// this codebase ever calls pause_collection on a subscription (submitVacationHold
// doesn't touch Stripe, and resumePausedMemberships doesn't either), so if
// Alison paused collection manually in Stripe when the hold started, nothing
// will ever clear it for her. Same reasoning for the mid-month flag: quantity
// resyncs only run monthly (syncMonthlyWalkQuantities, 1st of the month), so a
// hold ending anywhere but the last day of the month leaves real billable days
// this month that no automated job will catch, and chargeCurrentMonthWalks is
// the existing manual tool for exactly that gap.
//
// data: {
//   memberName: string,     // member doc's `name`, or 'A member' if missing
//   memberId: string,
//   startDateStr: string,   // 'YYYY-MM-DD'
//   endDateStr: string,     // 'YYYY-MM-DD' — the hold's actual end date
//   endedMidMonth: boolean, // true when endDateStr isn't the last day of its month
// }

const {
  escapeHtml, formatDateRange, renderBlockHtml, renderBlockText, wrapHtml, wrapText,
} = require('./_layout');

function subject(data) {
  const name = data.memberName || 'A member';
  return `Vacation hold ended: ${name}`;
}

function html(data) {
  const name = escapeHtml(data.memberName || 'A member');
  const range = escapeHtml(formatDateRange(data.startDateStr, data.endDateStr));

  const block = renderBlockHtml({
    eyebrow: 'Vacation hold ended',
    heading: name,
    rows: [
      { label: 'Member', value: name },
      { label: 'Hold window', value: range },
    ],
  });

  const midMonthHtml = data.endedMidMonth
    ? `<p style="margin:20px 0 0;"><strong>This hold ended mid-month.</strong> The monthly Stripe quantity sync only runs on the 1st, so this member's subscription quantity won't reflect their resumed walks until next month on its own. Run <strong>chargeCurrentMonthWalks</strong> for this member to catch up the rest of this month's billing.</p>`
    : '';

  const body = `
    <p style="margin:0 0 20px;">A member's vacation hold just ended and their status flipped back to active. Their walks for the rest of this month have already been regenerated.</p>
    ${block}
    <p style="margin:20px 0 0;"><strong>If you paused collection on this member's Stripe subscription when the hold started, clear it now</strong> — nothing in the app does this automatically. Set <code>pause_collection</code> back to <code>null</code> on the subscription.</p>
    ${midMonthHtml}
  `;

  return wrapHtml({ preheader: `${name}'s vacation hold ended, ${range}`, bodyHtml: body });
}

function text(data) {
  const name = data.memberName || 'A member';
  const range = formatDateRange(data.startDateStr, data.endDateStr);

  const lines = [
    "A member's vacation hold just ended and their status flipped back to active. Their walks for the rest of this month have already been regenerated.",
    '',
    renderBlockText({
      eyebrow: 'Vacation hold ended',
      heading: name,
      rows: [
        { label: 'Member', value: name },
        { label: 'Hold window', value: range },
      ],
    }),
    '',
    'If you paused collection on this member\'s Stripe subscription when the hold started, clear it now, nothing in the app does this automatically. Set pause_collection back to null on the subscription.',
  ];

  if (data.endedMidMonth) {
    lines.push('');
    lines.push('This hold ended mid-month. The monthly Stripe quantity sync only runs on the 1st, so this member\'s subscription quantity won\'t reflect their resumed walks until next month on its own. Run chargeCurrentMonthWalks for this member to catch up the rest of this month\'s billing.');
  }

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
