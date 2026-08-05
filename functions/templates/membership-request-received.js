// functions/templates/membership-request-received.js
//
// Sent the moment a membership_request submission is created (see
// onNewSubmission in functions/index.js). Confirms the request landed and
// hands over everything needed to show up for the meet and greet, since
// it's booked at submission time via the same form. If no meet and greet is
// on file (the calendar picker had no availability, or the requester
// skipped it), that section is dropped for a plain "we'll be in touch" line
// rather than rendering broken/blank details.
//
// data: {
//   firstName: string,
//   dogNames: string[],            // may be empty
//   tier: string|null,             // 'Essential' | 'Standard' | 'Daily' | 'Not sure yet'
//   meetGreetDateStr: string|null, // 'YYYY-MM-DD', from the submission's meetGreetDateTime
//   meetGreetSlot: string|null,    // '5:00pm', from the same field
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

function planPhrase(tier) {
  return tier && tier !== 'Not sure yet' ? `a ${tier} membership` : 'a membership';
}

function subject(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  return `We got your request for ${names}`;
}

function html(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const namesEsc = escapeHtml(names);
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
    <p style="margin:0 0 20px;">Thanks so much for reaching out about ${planPhrase(data.tier)} for ${namesEsc}. We've got your request and we're looking over the details now.</p>
    <p style="margin:0 0 20px;">The next step is your meet and greet, a quick, friendly visit before your walks begin.</p>
    ${meetGreetBlock}
    <p style="margin:20px 0 0;">Alison, our founder, will come by to meet ${namesEsc} and walk you through how everything works. It's a great time to ask any questions you have. Please have a spare key or entry details ready, and Alison will take those with her for future walks.</p>
    <p style="margin:20px 0 0;">We won't start your membership or any billing until after we've met. From there, we'll get your walks on the calendar and you'll be all set.</p>
    <p style="margin:20px 0 0;">${escapeHtml(meetClosingLine(data.dogNames))} Questions in the meantime? Just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(SIGNOFF_NAME)}
  `;

  return wrapHtml({
    preheader: mg ? `Your meet and greet is set for ${mg.dateLabel} at ${mg.slotLabel}.` : `We've got your membership request and we're looking it over now.`,
    bodyHtml: body,
  });
}

function text(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const mg = buildMeetGreet(data);

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Thanks so much for reaching out about ${planPhrase(data.tier)} for ${names}. We've got your request and we're looking over the details now.`,
    '',
    `The next step is your meet and greet, a quick, friendly visit before your walks begin.`,
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
    `Alison, our founder, will come by to meet ${names} and walk you through how everything works. It's a great time to ask any questions you have. Please have a spare key or entry details ready, and Alison will take those with her for future walks.`,
    '',
    `We won't start your membership or any billing until after we've met. From there, we'll get your walks on the calendar and you'll be all set.`,
    '',
    `${meetClosingLine(data.dogNames)} Questions in the meantime? Just reply here and it'll come straight to us.`,
    '',
    SIGNOFF_NAME,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
