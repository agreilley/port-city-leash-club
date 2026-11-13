// functions/templates/meet-greet-reminder.js
//
// Sent 24 hours before a booked meet and greet — see sendMeetGreetReminders,
// functions/index.js. A short heads-up with the time and place. Entry is
// framed as something to go over together, not "we'll take your spare key":
// many clients leave a key under the mat or similar for the first visit
// instead (Alison, 2026-11-13).
//
// Goes to every submission with a meet and greet in the next 24 hours:
// membership requests, public service requests, and the admin "+ Add meet &
// greet" placeholders (type 'meet_greet', which carry no pet names — the copy
// reads fine without them).
//
// data: {
//   firstName: string,
//   petNames: string[],            // may be empty
//   meetGreetDateStr: string,      // 'YYYY-MM-DD'
//   meetGreetSlot: string,         // '5:00pm'
//   isToday: boolean,              // true only for an admin-added/rescheduled one later the same day
//   address: string|null,
// }

const {
  escapeHtml, formatCalendarDate, formatMeetGreetSlot, joinNames, meetClosingLine,
  TEAM_SIGNOFF, renderBlockHtml, renderBlockText, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function when(data) {
  return {
    dateLabel: formatCalendarDate(data.meetGreetDateStr) || data.meetGreetDateStr,
    slotLabel: formatMeetGreetSlot(data.meetGreetSlot) || data.meetGreetSlot,
  };
}

function dayWord(data) {
  return data.isToday ? 'today' : 'tomorrow';
}

function subject(data) {
  const { slotLabel } = when(data);
  return `See you ${dayWord(data)} at ${slotLabel}`;
}

// Plain-text paragraphs, shared by html() and text() so the two can't drift.
function paragraphs(data) {
  const names = joinNames(data.petNames);
  const { slotLabel } = when(data);
  return {
    opening: `Just a reminder that your meet and greet is ${dayWord(data)} at ${slotLabel}.`,
    visit: `Alison, our founder, will come by to meet ${names || 'everyone'} and walk you through how everything works. It's also a good time to go over how we'll get in for future visits, whether that's a spare key, a lockbox, or a door code.`,
    reschedule: `If something has come up and ${data.isToday ? 'that time' : 'tomorrow'} no longer works, just reply to this email and we'll find a new time.`,
    closing: meetClosingLine(data.petNames),
  };
}

function block(data, esc) {
  const { dateLabel, slotLabel } = when(data);
  return {
    eyebrow: 'Your meet and greet',
    heading: `${esc(dateLabel)} at ${esc(slotLabel)}`,
    rows: [
      { label: 'Where', value: `your home${data.address ? ` at ${esc(data.address)}` : ''}` },
    ],
  };
}

function html(data) {
  const p = paragraphs(data);
  const { slotLabel } = when(data);
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">${escapeHtml(p.opening)}</p>
    ${renderBlockHtml(block(data, escapeHtml))}
    <p style="margin:20px 0 0;">${escapeHtml(p.visit)}</p>
    <p style="margin:20px 0 0;">${escapeHtml(p.reschedule)}</p>
    <p style="margin:20px 0 0;">${escapeHtml(p.closing)}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({
    preheader: `Your meet and greet is ${dayWord(data)} at ${slotLabel}.`,
    bodyHtml: body,
  });
}

function text(data) {
  const p = paragraphs(data);
  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    p.opening,
    '',
    renderBlockText(block(data, (s) => s)),
    '',
    p.visit,
    '',
    p.reschedule,
    '',
    p.closing,
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };
