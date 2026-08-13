// functions/templates/portal-membership-confirmed.js
//
// Sent by finalizeSubmissionIfReady's membership branch once a member's
// card is confirmed on file: createMembershipSubscription,
// generateInitialWalks, and chargeCurrentMonthWalks have already run by the
// time this fires, so — unlike portal-access, which sends earlier and can't
// promise a schedule yet — this can reliably say the walks are on the
// calendar.
//
// This is the second half of what the old member-welcome said in one email.
// portal-access (fires at meet-greet completion, before any card exists)
// took the "here's your account, add a card" half; this takes the "you're
// billed, walks are scheduled" half, once that's actually true.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   tier: string,                 // 'Member'
//   frequency: string|null,       // e.g. 'Monday, Wednesday, Friday'
//   firstWalkDateStr: string|null, // 'YYYY-MM-DD', or null if none found yet
// }

const {
  escapeHtml, formatCalendarDate, joinNames, possessive, TEAM_SIGNOFF,
  renderBlockHtml, renderBlockText, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function firstWalkValue(data) {
  return formatCalendarDate(data.firstWalkDateStr) || 'To be scheduled';
}

function subject(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  return `You're all set for ${names}`;
}

function html(data) {
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;

  const block = renderBlockHtml({
    eyebrow: 'Your membership',
    heading: escapeHtml(data.tier || 'Membership'),
    rows: [
      { label: 'Schedule', value: escapeHtml(data.frequency || 'To be confirmed') },
      { label: 'First walk', value: escapeHtml(firstWalkValue(data)) },
    ],
  });

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Your membership is set, and your walks are on the calendar.</p>
    ${block}
    <p style="margin:20px 0 0;">Your walker will send photos and a note after every walk, so you'll always know how it went. You can view your schedule, adjust dates, and update your ${possessive(dogCount, 'dog', 'dogs')} profile anytime in your portal.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({ preheader: `Your membership is set, and your walks are on the calendar.`, bodyHtml: body });
}

function text(data) {
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Your membership is set, and your walks are on the calendar.`,
    '',
    renderBlockText({
      eyebrow: 'Your membership',
      heading: data.tier || 'Membership',
      rows: [
        { label: 'Schedule', value: data.frequency || 'To be confirmed' },
        { label: 'First walk', value: firstWalkValue(data) },
      ],
    }),
    '',
    `Your walker will send photos and a note after every walk, so you'll always know how it went. You can view your schedule, adjust dates, and update your ${possessive(dogCount, 'dog', 'dogs')} profile anytime in your portal.`,
    '',
    TEAM_SIGNOFF,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
