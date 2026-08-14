// functions/templates/member-welcome.js
//
// Replaces sendOnboardingEmail's old plain-text kind:'member' send. Fires
// from the same place that email always fired from — the Convert-to-Member
// flow in admin/dashboard.html, which is already gated behind the
// meetGreetCompletedAt checkbox, so this already only ever sends after the
// meet and greet is done. Intentionally warmer than the request-received
// templates: this is the "you're in" moment, not a status update.
//
// Always a genuinely new account (Convert-to-Member always creates one), so
// portalSetupLink is required, not conditional like the booking-confirmed
// templates.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   tier: string,                 // 'Member' | 'Travel'
//   frequency: string,            // e.g. 'Monday, Wednesday, Friday'
//   firstWalkDateStr: string|null, // 'YYYY-MM-DD', or null if none found yet
//   portalSetupLink: string,       // generatePasswordResetLink() output
// }

const {
  escapeHtml, formatCalendarDate, joinNames, possessive,
  SIGNOFF_NAME, renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function subject(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  return `Welcome to the Leash Club, ${names}`;
}

function firstWalkValue(data) {
  const label = formatCalendarDate(data.firstWalkDateStr);
  return label || 'To be scheduled';
}

function html(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;
  const metLine = `It was so good to meet ${joinNames(['you', ...(data.dogNames || []).filter(Boolean)])}.`;

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
    <p style="margin:0 0 20px;">${escapeHtml(metLine)} We're thrilled to have you in the Leash Club.</p>
    <p style="margin:0 0 20px;">Everything's set on our end, and your walks are on the calendar. Here's what you can look forward to:</p>
    ${block}
    <p style="margin:20px 0 0;">Your walker will send photos and a note after every walk, so you'll always know how it went. You can view your schedule, adjust dates, and update your ${possessive(dogCount, 'dog', 'dogs')} profile anytime in your portal.</p>
    ${renderButtonHtml({ href: data.portalSetupLink, label: 'Set Up Your Portal Access' })}
    <p style="margin:20px 0 0;">We're honored you've trusted us with ${escapeHtml(names)}, and we can't wait to get started.</p>
    ${renderSignoffHtml(SIGNOFF_NAME, 'Talk soon,')}
  `;

  return wrapHtml({ preheader: `Welcome to the Leash Club. Here's what happens next.`, bodyHtml: body });
}

function text(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const metLine = `It was so good to meet ${joinNames(['you', ...(data.dogNames || []).filter(Boolean)])}.`;
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `${metLine} We're thrilled to have you in the Leash Club.`,
    '',
    `Everything's set on our end, and your walks are on the calendar. Here's what you can look forward to:`,
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
    `Set up your portal access: ${data.portalSetupLink}`,
    '',
    `We're honored you've trusted us with ${names}, and we can't wait to get started.`,
    '',
    `Talk soon,`,
    SIGNOFF_NAME,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
