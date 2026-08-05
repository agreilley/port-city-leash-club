// functions/templates/service-request-received.js
//
// Sent when a NEW (public-form, no account yet) service_request submission
// is created — see onNewSubmission in functions/index.js. Covers both
// service families the public form can produce: pet sitting (drop-in
// visits, overnight stays) and a one-time walk. The given copy for this
// template was pet-sitting-specific throughout; serviceFamily drives which
// phrasing renders, walk-flavored copy modeled on
// membership-request-received's already-approved language, since a
// brand-new client can request a standalone walk through this same form
// with its own meet and greet.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   serviceFamily: 'walk' | 'pet-sitting', // resolved server-side from pricing.js's SERVICE_PRICES[key].unit
//   meetGreetDateStr: string|null,
//   meetGreetSlot: string|null,
//   address: string|null,
// }

const {
  escapeHtml, formatCalendarDate, formatMeetGreetSlot, joinNames, meetClosingLine,
  NAVY, SAND, SIGNOFF_NAME, renderBlockHtml, renderBlockText, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function buildMeetGreet(data) {
  const dateLabel = formatCalendarDate(data.meetGreetDateStr);
  const slotLabel = formatMeetGreetSlot(data.meetGreetSlot);
  return dateLabel && slotLabel ? { dateLabel, slotLabel } : null;
}

function isWalk(data) {
  return data.serviceFamily === 'walk';
}

function subject(data) {
  const names = joinNames(data.petNames) || (isWalk(data) ? 'your dog' : 'your pets');
  return `We got your request for ${names}`;
}

function copy(data) {
  const walk = isWalk(data);
  const names = joinNames(data.petNames) || (walk ? 'your dog' : 'your pets');
  return {
    names,
    reachedOutAbout: walk ? `a walk for ${names}` : `pet sitting for ${names}`,
    lookingOverWhat: walk ? 'the details' : 'the dates',
    nextStepFraming: walk ? 'before your first walk' : "before your pets' first day",
    visitPurpose: walk
      ? 'walk you through how everything works'
      : "go over the details of their care, their routine, feeding, any medications, and the little things that keep them comfortable",
    futureVisitsNoun: walk ? 'future walks' : 'future visits',
    confirmLine: walk
      ? "We'll confirm your booking and everything else once we've met, and then you're all set."
      : "We'll confirm your dates and everything else once we've met, and then you're all set.",
  };
}

function html(data) {
  const c = copy(data);
  const mg = buildMeetGreet(data);

  const meetGreetBlock = mg ? renderBlockHtml({
    eyebrow: 'Your meet and greet',
    heading: `${escapeHtml(mg.dateLabel)} at ${escapeHtml(mg.slotLabel)}`,
    rows: [
      { label: 'Where', value: `your home${data.address ? ` at ${escapeHtml(data.address)}` : ''}` },
    ],
  }) : `
    <p style="margin:24px 0;padding:20px 24px;background-color:${SAND};border-radius:4px;font-size:14px;color:${NAVY};">
      We don't have a meet and greet on the calendar yet. We'll reach out shortly to find a time that works.
    </p>
  `;

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Thanks so much for reaching out about ${escapeHtml(c.reachedOutAbout)}. We've got your request and we're looking over ${c.lookingOverWhat} now.</p>
    <p style="margin:0 0 20px;">The next step is your meet and greet, a quick, friendly visit ${c.nextStepFraming}.</p>
    ${meetGreetBlock}
    <p style="margin:20px 0 0;">Alison, our founder, will come by to meet ${escapeHtml(c.names)} and ${c.visitPurpose}. It's a great time to ask any questions you have. Please have a spare key or entry details ready, and Alison will take those with her for ${c.futureVisitsNoun}.</p>
    <p style="margin:20px 0 0;">${c.confirmLine}</p>
    <p style="margin:20px 0 0;">${escapeHtml(meetClosingLine(data.petNames))} Questions in the meantime? Just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(SIGNOFF_NAME)}
  `;

  return wrapHtml({
    preheader: mg ? `Your meet and greet is set for ${mg.dateLabel} at ${mg.slotLabel}.` : `We've got your request and we're looking it over now.`,
    bodyHtml: body,
  });
}

function text(data) {
  const c = copy(data);
  const mg = buildMeetGreet(data);

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Thanks so much for reaching out about ${c.reachedOutAbout}. We've got your request and we're looking over ${c.lookingOverWhat} now.`,
    '',
    `The next step is your meet and greet, a quick, friendly visit ${c.nextStepFraming}.`,
    '',
  ];

  if (mg) {
    lines.push(renderBlockText({
      eyebrow: 'Your meet and greet',
      heading: `${mg.dateLabel} at ${mg.slotLabel}`,
      rows: [
        { label: 'Where', value: `your home${data.address ? ` at ${data.address}` : ''}` },
      ],
    }), '');
  } else {
    lines.push(`We don't have a meet and greet on the calendar yet. We'll reach out shortly to find a time that works.`, '');
  }

  lines.push(
    `Alison, our founder, will come by to meet ${c.names} and ${c.visitPurpose}. It's a great time to ask any questions you have. Please have a spare key or entry details ready, and Alison will take those with her for ${c.futureVisitsNoun}.`,
    '',
    c.confirmLine,
    '',
    `${meetClosingLine(data.petNames)} Questions in the meantime? Just reply here and it'll come straight to us.`,
    '',
    SIGNOFF_NAME,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
