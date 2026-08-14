// functions/templates/portal-access.js
//
// Sent by completeMeetGreetAndCreateAccount the moment a portal account is
// created — after the meet and greet, before any card or billing exists.
// Replaces the old member-welcome.js, which fired at Convert-to-Member (a
// moment that used to also start billing in the same step) and assumed a
// schedule/walks already existed. Account creation is now decoupled from
// billing, so this fires earlier, and for two audiences instead of one:
// membership_request and net-new (public-form) service_request. The card-
// on-file ask is the actual point of the email, not an afterthought.
//
// overnight_request never reaches this template: it only ever comes from an
// existing member who already has portal access from an earlier request.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   kind: 'membership' | 'service',
//   portalSetupLink: string,        // generatePasswordResetLink() output
//   tier: string|null,              // membership only: 'Member'
//   frequency: string|null,         // membership only, e.g. 'Monday, Wednesday, Friday'
//   serviceLabel: string|null,      // service only, e.g. 'Standard Walk' | 'Drop-In Visit'
//   requestedDatesStr: string|null, // service only, pre-formatted (e.g. formatDateRange output); null if not set yet
// }

const {
  escapeHtml, joinNames, possessive, TEAM_SIGNOFF,
  renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function isMembership(data) {
  return data.kind === 'membership';
}

function petNamesList(data) {
  return (data.petNames || []).filter(Boolean);
}

// Plain object, not pre-rendered markup, so html() and text() can each
// render/escape it their own way rather than one leaking HTML into the
// other (the same split every other template in this directory keeps).
function detailBlock(data) {
  return isMembership(data)
    ? {
        eyebrow: 'Your membership',
        heading: data.tier || 'Membership',
        rows: [{ label: 'Schedule', value: data.frequency || 'To be confirmed' }],
      }
    : {
        eyebrow: 'Your request',
        heading: data.serviceLabel || 'Your service',
        rows: [{ label: 'Dates', value: data.requestedDatesStr || 'To be confirmed' }],
      };
}

function nextStepPhrase(data) {
  return isMembership(data) ? "get your walks on the calendar" : 'confirm your dates';
}

function subject(data) {
  const names = joinNames(petNamesList(data)) || 'your pet';
  return `Welcome to the Leash Club, ${names}`;
}

function html(data) {
  const names = joinNames(petNamesList(data)) || 'your pet';
  const petCount = petNamesList(data).length || 1;
  const metLine = `It was so good to meet ${joinNames(['you', ...petNamesList(data)])}.`;
  const block = detailBlock(data);

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">${escapeHtml(metLine)}</p>
    <p style="margin:0 0 20px;">Now that we've met, there's one thing left before we can get started: adding a card on file.</p>
    ${renderBlockHtml({
      eyebrow: block.eyebrow,
      heading: escapeHtml(block.heading),
      rows: block.rows.map(r => ({ label: r.label, value: escapeHtml(r.value) })),
    })}
    <p style="margin:20px 0 0;">Add a card in your portal and we'll ${escapeHtml(nextStepPhrase(data))}. You'll get one more email once everything's set.</p>
    ${renderButtonHtml({ href: data.portalSetupLink, label: 'Add Your Card' })}
    <p style="margin:20px 0 0;">Once you're in, you can update your ${possessive(petCount, 'pet', 'pets')} profile and check in on things anytime.</p>
    <p style="margin:20px 0 0;">We're looking forward to it.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({ preheader: `Add a card to finish setting up ${names}.`, bodyHtml: body });
}

function text(data) {
  const names = joinNames(petNamesList(data)) || 'your pet';
  const petCount = petNamesList(data).length || 1;
  const metLine = `It was so good to meet ${joinNames(['you', ...petNamesList(data)])}.`;
  const block = detailBlock(data);

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    metLine,
    '',
    `Now that we've met, there's one thing left before we can get started: adding a card on file.`,
    '',
    renderBlockText(block),
    '',
    `Add a card in your portal and we'll ${nextStepPhrase(data)}. You'll get one more email once everything's set.`,
    '',
    `Add your card: ${data.portalSetupLink}`,
    '',
    `Once you're in, you can update your ${possessive(petCount, 'pet', 'pets')} profile and check in on things anytime.`,
    '',
    `We're looking forward to it.`,
    '',
    TEAM_SIGNOFF,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
