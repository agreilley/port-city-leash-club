// functions/templates/password-setup.js
//
// Sent by requestPasswordSetupEmail when someone taps "Send Link" on
// portal-password-reset.html. Replaces Google's own password-reset email,
// whose template Firebase locked for this project on 2026-11-13 (subject,
// wording and reply-to could no longer be changed). Worded for both a new
// client setting a password for the first time and a member who forgot
// theirs, matching the page's "Set or reset your password" heading.
//
// data: {
//   firstName: string|null,
//   link: string,        // createPasswordSetupLink() output
//   validForText: string, // e.g. '24 hours'
//   role: 'member'|'walker'|'admin'|undefined // which sign-in page to point at
// }

const {
  escapeHtml, TEAM_SIGNOFF,
  renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function subject() {
  return 'Set or reset your Port City Leash Club password';
}

// Walkers and admins have their own sign-in pages, each with a
// "Forgot password?" link; members use the portal's "Set Your Password".
const PLACES = {
  member: { what: 'portal password', retry: 'go to the portal sign-in page and tap "Set Your Password"' },
  walker: { what: 'walker portal password', retry: 'go to the walker sign-in page and tap "Forgot password?"' },
  admin: { what: 'admin password', retry: 'go to the admin sign-in page and tap "Forgot password?"' },
};
const place = (data) => PLACES[data.role] || PLACES.member;

function validLine(data) {
  return `This link works for ${data.validForText || '24 hours'} and can be used once. If it has expired, ${place(data).retry} for a new one.`;
}

const IGNORE_LINE = `If you didn't ask for this, you can ignore this email. Your password won't change.`;

function html(data) {
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Tap below to set or reset your Port City Leash Club ${escapeHtml(place(data).what)}.</p>
    ${renderButtonHtml({ href: data.link, label: 'Set Your Password' })}
    <p style="margin:20px 0 0;">${escapeHtml(validLine(data))}</p>
    <p style="margin:20px 0 0;">${escapeHtml(IGNORE_LINE)}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: 'Choose a password for your portal.', bodyHtml: body });
}

function text(data) {
  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Tap the link below to set or reset your Port City Leash Club ${place(data).what}.`,
    '',
    `Set your password: ${data.link}`,
    '',
    validLine(data),
    '',
    IGNORE_LINE,
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
