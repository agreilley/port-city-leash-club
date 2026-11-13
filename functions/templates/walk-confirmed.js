// functions/templates/walk-confirmed.js
//
// Sent when admin confirms and charges a one-time walk booking — from
// confirmServiceRequest() (when the service is walk-family: standard-walk
// or extended-walk) or confirmWalkExtension() in admin/dashboard.html.
// `walks` is an array rather than a single date/time because
// confirmWalkExtension can confirm several walks from one submission at
// once (the member can check multiple walks in portal-extend-walk.html);
// the common case is exactly one.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   walkTypeLabel: string,   // e.g. 'Standard walk' or 'Extended walk'
//   durationMinutes: number, // 30 or 45
//   walks: [{ dateStr: string, slot: string }], // 'YYYY-MM-DD' + '5:00pm', at least one
//   isNewAccount: boolean,
//   portalSetupLink: string|null, // generatePasswordResetLink() output; required when isNewAccount is true
//   needsCard: boolean|undefined, // true when there's no card on file yet (sendServiceOrOvernightConfirmationEmail
//     // only); confirmWalkExtension's own calls never pass this, so it degrades to no note, which is
//     // correct there — an extension is already charged by the time this email sends.
//   addCardUrl: string|undefined, // portal-account.html's Update Payment Method flow; required when needsCard is true
//   chargeDateStr: string|null|undefined, // 'YYYY-MM-DD' the scheduled charge runs (24h after confirming);
//     // only sendServiceOrOvernightConfirmationEmail passes it. Absent → no charge line.
//   chargeAmountDollars: number|undefined, // what that charge takes, after credits
// }

const {
  escapeHtml, formatCalendarDate, formatMeetGreetSlot, formatWalkTimeSlot, joinNames, possessive,
  TEAM_SIGNOFF, renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

// A walk's slot may be a timeSlot bucket ('morning', from walk_extension /
// the walks collection) or, for a one-time walk booked with no time
// captured at all (service_request has no time-of-day field), absent
// entirely — this degrades to a date-only line rather than showing nothing
// or a raw bucket key.
//
// async because formatWalkTimeSlot now is (see _layout.js) — this ripples
// up through whenValue/html/text below, all the way to sendEmail's already-
// async template dispatch, and no further; subject() never touches this at
// all and stays synchronous.
async function formatWalkWhen(w) {
  const dateLabel = formatCalendarDate(w.dateStr);
  if (!dateLabel) return null;
  // A time-slot bucket reads as "Saturday, October 17, late afternoon"; an
  // exact clock time keeps "at" ("Saturday, October 17 at 5:00 PM").
  const bucket = await formatWalkTimeSlot(w.slot);
  if (bucket) return `${dateLabel}, ${bucket.toLowerCase()}`;
  const clock = formatMeetGreetSlot(w.slot);
  return clock ? `${dateLabel} at ${clock}` : dateLabel;
}

// "Your card will be charged $30.00 on Saturday, November 14." Only when a
// charge date was passed and there's a card to charge; the no-card note
// covers the other case. A walk fully covered by credit says so instead of
// "$0.00".
function chargeLine(data) {
  if (data.needsCard || !data.chargeDateStr) return null;
  const date = formatCalendarDate(data.chargeDateStr) || data.chargeDateStr;
  if (!(data.chargeAmountDollars > 0)) return `Your account credit covers this walk, so your card won't be charged.`;
  return `Your card will be charged $${data.chargeAmountDollars.toFixed(2)} on ${date}.`;
}

// The portal / card section, shared by html() and text(). null = nothing to show.
//   New client, no card: one button that sets their password, then lands on Add Card.
//   New client with a card (or a walk extension): a portal-setup button.
//   Existing client, no card: Add Your Card, plus how to get in without a password.
function cardCopy(data, dogCount) {
  const expired = `If the link has expired, go to the portal sign-in page and tap "Set Your Password" for a new one.`;
  if (data.isNewAccount && data.portalSetupLink) {
    return data.needsCard ? {
      paragraphs: [`Since this is your first booking with us, we've set up a portal account for you. Set your password, then add a card so we can process the charge for this walk.`],
      href: data.portalSetupLink, label: 'Set Up Your Portal', after: expired,
    } : {
      paragraphs: [`Since this is your first time booking with us, we've set up a portal account so you can see your booking, update your ${possessive(dogCount, 'dog', 'dogs')} profile, and message us anytime.`],
      href: data.portalSetupLink, label: 'Set Up Your Portal', after: null,
    };
  }
  if (!data.needsCard) return null;
  return {
    paragraphs: [`We don't have a card on file for you yet. Add one so we can process the charge for this walk.`],
    href: data.addCardUrl, label: 'Add Your Card',
    after: `You'll sign in to your portal first. If you haven't set a password yet, tap "Set Your Password" on the sign-in page.`,
  };
}

async function whenValue(data) {
  const formatted = (await Promise.all((data.walks || []).map(formatWalkWhen))).filter(Boolean);
  return formatted.join('; ') || 'Time to be confirmed';
}

function subject(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  return `You're all set for ${names}`;
}

async function html(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;
  const whenStr = await whenValue(data);

  const block = renderBlockHtml({
    eyebrow: 'Your booking',
    heading: escapeHtml(`${data.walkTypeLabel || 'Walk'}, ${data.durationMinutes || 30} minutes`),
    rows: [
      { label: 'When', value: escapeHtml(whenStr) },
    ],
  });

  // One portal/card section (cardCopy): a new client's set-password button
  // replaces Add Your Card, so there's never two buttons that do different
  // things. sendServiceOrOvernightConfirmationEmail sets isNewAccount for a
  // client who has never signed in (portalSetupForMember).
  const card = cardCopy(data, dogCount);
  const portalSection = card ? `
    ${card.paragraphs.map(p => `<p style="margin:20px 0 0;">${escapeHtml(p)}</p>`).join('')}
    ${renderButtonHtml({ href: card.href, label: card.label })}
    ${card.after ? `<p style="margin:20px 0 0;">${escapeHtml(card.after)}</p>` : ''}
  ` : '';

  // The new-account CTA paragraph directly above already tells them they
  // can update the profile — repeating that two lines later reads as
  // filler, and "has changed" presumes a baseline a brand-new client
  // doesn't have yet. Existing members keep the full line unchanged.
  const closingLine = data.isNewAccount
    ? `If you have any questions, just reply here and it'll come straight to us.`
    : `If anything about your ${possessive(dogCount, 'dog', 'dogs')} care has changed, you can update their profile anytime in the portal. And if you have any questions, just reply here and it'll come straight to us.`;

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Great news, your walk is booked and we've got ${escapeHtml(names)} covered.</p>
    ${block}
    <p style="margin:20px 0 0;">Your walker will send photos and a note afterward so you can see how it went.</p>
    ${chargeLine(data) ? `<p style="margin:20px 0 0;">${escapeHtml(chargeLine(data))}</p>` : ''}
    ${portalSection}
    <p style="margin:20px 0 0;">${closingLine}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({ preheader: `Your walk is booked. Here's everything you need to know.`, bodyHtml: body });
}

async function text(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const dogCount = (data.dogNames || []).filter(Boolean).length || 1;
  const whenStr = await whenValue(data);

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Great news, your walk is booked and we've got ${names} covered.`,
    '',
    renderBlockText({
      eyebrow: 'Your booking',
      heading: `${data.walkTypeLabel || 'Walk'}, ${data.durationMinutes || 30} minutes`,
      rows: [{ label: 'When', value: whenStr }],
    }),
    '',
    `Your walker will send photos and a note afterward so you can see how it went.`,
    '',
    ...(chargeLine(data) ? [chargeLine(data), ''] : []),
  ];

  const card = cardCopy(data, dogCount);
  if (card) {
    lines.push(
      ...card.paragraphs.flatMap(p => [p, '']),
      `${card.label}: ${card.href}`,
      '',
      ...(card.after ? [card.after, ''] : []),
    );
  }

  // See the html() version's comment on why this drops to a single
  // sentence for a new account rather than repeating the CTA paragraph's
  // "update your profile" point under a "has changed" framing that doesn't
  // fit a first booking.
  const closingLine = data.isNewAccount
    ? `If you have any questions, just reply here and it'll come straight to us.`
    : `If anything about your ${possessive(dogCount, 'dog', 'dogs')} care has changed, you can update their profile anytime in the portal. And if you have any questions, just reply here and it'll come straight to us.`;

  lines.push(
    closingLine,
    '',
    TEAM_SIGNOFF,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
