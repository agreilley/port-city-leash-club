// functions/templates/portal-service-confirmed.js
//
// Sent when admin confirms and charges a pet sitting booking — overnight or
// drop-in, from confirmOvernight() or confirmServiceRequest() (when the
// service is pet-sitting-family) in admin/dashboard.html. Reused verbatim
// for BOTH an existing member's portal request AND a brand-new client's
// first booking after their meet and greet — the only thing that differs
// is whether a portal-access link is included, since a new client has no
// other way to ever set a password and log in. Existing members already
// have portal access, so they get no link at all rather than a redundant
// one.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   serviceLabel: string,
//   startDateStr: string,
//   endDateStr: string,
//   unitCount: number,
//   unitNoun: 'night' | 'visit',
//   isNewAccount: boolean,
//   portalSetupLink: string|null, // generatePasswordResetLink() output; required when isNewAccount is true
//   needsCard: boolean,   // true when there's no card on file yet — confirming no longer waits on one
//   addCardUrl: string,   // portal-account.html's Update Payment Method flow; required when needsCard is true
// }

const {
  escapeHtml, formatDateRange, joinNames, possessive, spellSmallNumber,
  SIGNOFF_NAME, renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function unitLine(data) {
  const word = spellSmallNumber(data.unitCount);
  const noun = data.unitCount === 1 ? data.unitNoun : `${data.unitNoun}s`;
  return `${word} ${noun}`;
}

function subject(data) {
  const names = joinNames(data.petNames) || 'your pets';
  return `You're all set for ${names}`;
}

function html(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const petCount = (data.petNames || []).filter(Boolean).length || 1;

  const block = renderBlockHtml({
    eyebrow: 'Your booking',
    rows: [
      { label: 'Service', value: escapeHtml(data.serviceLabel || '') },
      { label: 'Dates', value: escapeHtml(formatDateRange(data.startDateStr, data.endDateStr)) },
      { label: 'Length', value: escapeHtml(unitLine(data)) },
    ],
  });

  // isNewAccount is only ever true from confirmWalkExtension now — a new
  // customer's meet-greet-to-account-creation-to-first-booking path moved
  // entirely to completeMeetGreetAndCreateAccount + portal-access, which
  // send their own portal-setup link before this template's send site
  // (sendServiceOrOvernightConfirmationEmail) is ever reached. Don't assume
  // this branch still covers a new customer's confirmation email.
  const portalSection = data.isNewAccount && data.portalSetupLink ? `
    <p style="margin:20px 0 0;">Since this is your first time booking with us, we've set up a portal account so you can see your booking, update your ${possessive(petCount, 'pet', 'pets')} profile, and message us anytime.</p>
    ${renderButtonHtml({ href: data.portalSetupLink, label: 'Set Up Your Portal Access' })}
  ` : '';

  const routineLine = data.isNewAccount
    ? `We'll follow the routine we went over at your meet and greet, and we'll send you updates along the way so you can relax and enjoy your trip.`
    : `We'll follow your usual routine for feeding, walks, and any medications, and we'll send you updates along the way so you can relax and enjoy your trip.`;

  // Same fix as walk-confirmed: the CTA paragraph directly above already
  // tells a new account they can update the profile, and "has changed"
  // presumes a baseline a first-time client doesn't have. Existing members
  // keep the full line unchanged.
  const closingLine = data.isNewAccount
    ? `If you have any questions, just reply here and it'll come straight to us.`
    : `If anything about your ${possessive(petCount, 'pet', 'pets')} care has changed, you can update their profile anytime in the portal. And if you have any questions, just reply here and it'll come straight to us.`;

  const cardSection = data.needsCard ? `
    <p style="margin:20px 0 0;">We don't have a card on file for you yet — add one so we can process the charge for this booking.</p>
    ${renderButtonHtml({ href: data.addCardUrl, label: 'Add Your Card' })}
  ` : '';

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Great news, your pet sitting is booked and we've got ${escapeHtml(names)} covered.</p>
    ${block}
    <p style="margin:20px 0 0;">${routineLine}</p>
    ${portalSection}
    ${cardSection}
    <p style="margin:20px 0 0;">${closingLine}</p>
    ${renderSignoffHtml(SIGNOFF_NAME, 'Talk soon,')}
  `;

  return wrapHtml({ preheader: `Your pet sitting is booked. Here's everything you need to know.`, bodyHtml: body });
}

function text(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const petCount = (data.petNames || []).filter(Boolean).length || 1;
  const routineLine = data.isNewAccount
    ? `We'll follow the routine we went over at your meet and greet, and we'll send you updates along the way so you can relax and enjoy your trip.`
    : `We'll follow your usual routine for feeding, walks, and any medications, and we'll send you updates along the way so you can relax and enjoy your trip.`;

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Great news, your pet sitting is booked and we've got ${names} covered.`,
    '',
    renderBlockText({
      eyebrow: 'Your booking',
      rows: [
        { label: 'Service', value: data.serviceLabel || '' },
        { label: 'Dates', value: formatDateRange(data.startDateStr, data.endDateStr) },
        { label: 'Length', value: unitLine(data) },
      ],
    }),
    '',
    routineLine,
    '',
  ];

  if (data.isNewAccount && data.portalSetupLink) {
    lines.push(
      `Since this is your first time booking with us, we've set up a portal account so you can see your booking, update your ${possessive(petCount, 'pet', 'pets')} profile, and message us anytime.`,
      '',
      `Set up your portal access: ${data.portalSetupLink}`,
      '',
    );
  }

  if (data.needsCard) {
    lines.push(
      `We don't have a card on file for you yet — add one so we can process the charge for this booking.`,
      '',
      `Add your card: ${data.addCardUrl}`,
      '',
    );
  }

  // Same fix as walk-confirmed's text(): drop the profile-update sentence
  // for a new account rather than presume a baseline it doesn't have.
  const closingLine = data.isNewAccount
    ? `If you have any questions, just reply here and it'll come straight to us.`
    : `If anything about your ${possessive(petCount, 'pet', 'pets')} care has changed, you can update their profile anytime in the portal. And if you have any questions, just reply here and it'll come straight to us.`;

  lines.push(
    closingLine,
    '',
    `Talk soon,`,
    SIGNOFF_NAME,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
